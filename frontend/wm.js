import { el, button } from "./ui.js";
export function constrain(g, b, min = { w: 350, h: 250 }) {
  const width = Math.max(Math.min(min.w, b.w), Math.min(g.w, b.w));
  const height = Math.max(Math.min(min.h, b.h), Math.min(g.h, b.h));
  return {
    x: Math.max(0, Math.min(g.x, b.w - width)),
    y: Math.max(0, Math.min(g.y, b.h - height)),
    w: width,
    h: height,
  };
}
export class WindowManager {
  constructor(host, onchange) {
    this.host = host;
    this.onchange = onchange;
    this.windows = new Map();
    this.z = 10;
    this.snap = true;
    this.observer = new ResizeObserver(() => {
      for (const w of this.windows.values()) {
        const bounds = this.bounds();
        w.g = w.maximized
          ? { x: 0, y: 0, w: bounds.w, h: bounds.h }
          : constrain(w.g, bounds, w.min);
        this.paint(w);
      }
    });
    this.observer.observe(host);
  }
  bounds() {
    return { w: this.host.clientWidth, h: this.host.clientHeight };
  }
  paint(w) {
    Object.assign(w.node.style, {
      left: w.g.x + "px",
      top: w.g.y + "px",
      width: w.g.w + "px",
      height: w.g.h + "px",
    });
    w.node.hidden = w.minimized;
  }
  focus(w) {
    if (this.z > 5000) {
      this.z = 10;
      for (const item of [...this.windows.values()].sort(
        (a, b) => Number(a.node.style.zIndex) - Number(b.node.style.zIndex),
      ))
        item.node.style.zIndex = ++this.z;
    }
    for (const o of this.windows.values())
      o.node.classList.toggle("focused", o === w);
    w.node.style.zIndex = ++this.z;
    w.minimized = false;
    this.paint(w);
    this.onchange();
  }
  create(app, saved = {}) {
    const b = this.bounds(),
      n = this.windows.size;
    const w = {
      id: crypto.randomUUID(),
      app,
      g: constrain(
        saved.g || {
          x: 60 + n * 28,
          y: 45 + n * 26,
          w: app.window.width,
          h: app.window.height,
        },
        b,
      ),
      min: { w: app.window.minWidth, h: app.window.minHeight },
      minimized: false,
      maximized: false,
      state: saved.state || {},
      title: app.name,
      cleanup: () => {},
      beforeClose: null,
    };
    const controls = el("div", { class: "window-controls" });
    const header = el(
      "header",
      { class: "window-titlebar" },
      el("span", { class: "window-app-icon", text: app.icon }),
      el("span", { class: "window-caption", text: app.name }),
      controls,
    );
    w.content = el("div", { class: "window-content" });
    w.node = el(
      "section",
      { class: "desktop-window", role: "region", "aria-label": app.name },
      header,
      w.content,
    );
    const control = (text, label, fn) => {
      const e = button(text, fn, "window-control");
      e.setAttribute("aria-label", label);
      e.title = label;
      return e;
    };
    controls.append(
      control("—", "Minimize", () => {
        w.minimized = true;
        this.paint(w);
        this.onchange();
      }),
      control("□", "Maximize or restore", () => this.maximize(w)),
      control("×", "Close", () => this.close(w)),
    );
    w.node.addEventListener("pointerdown", () => {
      if (!w.node.classList.contains("focused")) this.focus(w);
    });
    header.addEventListener("dblclick", (e) => {
      if (!e.target.closest("button")) this.maximize(w);
    });
    const drag = (e, edge) => {
      if (e.button !== 0 || e.target.closest("button") || w.maximized) return;
      e.preventDefault();
      this.focus(w);
      const start = { ...w.g },
        sx = e.clientX,
        sy = e.clientY;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const move = (v) => {
        const dx = v.clientX - sx,
          dy = v.clientY - sy;
        let g = { ...start };
        if (!edge) {
          g.x += dx;
          g.y += dy;
        } else {
          if (edge.includes("e")) g.w += dx;
          if (edge.includes("s")) g.h += dy;
          if (edge.includes("w")) {
            g.x += dx;
            g.w -= dx;
          }
          if (edge.includes("n")) {
            g.y += dy;
            g.h -= dy;
          }
        }
        w.g = constrain(g, this.bounds(), w.min);
        this.paint(w);
      };
      const done = (v) => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", done);
        target.removeEventListener("pointercancel", done);
        if (!edge && this.snap) {
          const r = this.host.getBoundingClientRect();
          if (v.clientY < r.top + 14) this.maximize(w);
          else if (v.clientX < r.left + 18 || v.clientX > r.right - 18) {
            const b = this.bounds();
            w.restore = { ...start };
            w.g = {
              x: v.clientX < r.left + 18 ? 0 : b.w / 2,
              y: 0,
              w: b.w / 2,
              h: b.h,
            };
            this.paint(w);
          }
        }
        this.onchange();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", done);
      target.addEventListener("pointercancel", done);
    };
    header.addEventListener("pointerdown", (e) => drag(e, ""));
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = el("div", {
        class: "resize-handle " + edge,
        "aria-hidden": "true",
      });
      handle.addEventListener("pointerdown", (e) => drag(e, edge));
      w.node.append(handle);
    }
    this.windows.set(w.id, w);
    this.host.append(w.node);
    this.paint(w);
    this.focus(w);
    return w;
  }
  maximize(w) {
    if (w.maximized) {
      w.g = w.restore;
      w.maximized = false;
    } else {
      w.restore = { ...w.g };
      const b = this.bounds();
      w.g = { x: 0, y: 0, w: b.w, h: b.h };
      w.maximized = true;
    }
    this.paint(w);
    this.onchange();
  }
  setTitle(w, title) {
    if (!this.windows.has(w.id)) return;
    if (w.title === String(title).slice(0, 160)) return;
    w.title = String(title).slice(0, 160);
    w.node.querySelector(".window-caption").textContent = w.title;
    this.onchange();
  }
  arrange() {
    const windows = [...this.windows.values()].filter((w) => !w.minimized),
      b = this.bounds();
    const columns = b.w < 700 ? 1 : Math.ceil(Math.sqrt(windows.length));
    const rows = Math.ceil(windows.length / columns);
    windows.forEach((w, i) => {
      w.maximized = false;
      w.restore = null;
      w.g = constrain(
        {
          x: ((i % columns) * b.w) / columns,
          y: (Math.floor(i / columns) * b.h) / rows,
          w: b.w / columns,
          h: b.h / rows,
        },
        b,
        w.min,
      );
      this.paint(w);
    });
    this.onchange();
  }
  async close(w) {
    if (w.beforeClose && !(await w.beforeClose())) return;
    w.cleanup();
    w.node.remove();
    this.windows.delete(w.id);
    this.onchange();
  }
  snapshot() {
    return [...this.windows.values()].map((w) => ({
      app: w.app.id,
      g: w.g,
      state: w.state,
      minimized: w.minimized,
    }));
  }
}

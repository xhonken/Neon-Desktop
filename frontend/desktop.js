import "bootstrap/dist/css/bootstrap.min.css";
import "./desktop.css";
import { foundation } from "./foundation.js";
import { t, setLanguage } from "./i18n.js";
import { createWallpaper } from "./wallpaper.js";
import { el, button } from "./ui.js";
import { WindowManager } from "./wm.js";
import { connection, sessionPicker } from "./connection.js";
const loaders = {
  "org.neon.codex": () => import("./apps/coding.js"),
  "org.neon.qwen-coder": () => import("./apps/coding.js"),
  "org.neon.administration": () => import("./apps/administration.js"),
  "org.neon.trash": () => import("./apps/trash.js"),
  "org.neon.jobs": () => import("./apps/jobs.js"),
  "org.neon.connections": () => import("./apps/connections.js"),
  "org.neon.files": () => import("./apps/files.js"),
  "org.neon.terminal": () => import("./apps/terminal.js"),
  "org.neon.code": () => import("./apps/code.js"),
  "org.neon.browser": () => import("./apps/browser.js"),
  "org.neon.text-browser": () => import("./apps/terminal.js"),
  "org.neon.settings": () => import("./apps/settings.js"),
  "org.neon.applications": () => import("./apps/applications.js"),
};
export async function start(identity) {
  document.title = "Neon Desktop";
  document.documentElement.dataset.bsTheme = "dark";
  const css = el("link", { rel: "stylesheet", href: "/assets/desktop.css" });
  document.head.append(css);
  const root = document.querySelector("#root");
  root.replaceChildren();
  const apps = new Map(identity.apps.map((a) => [a.id, a]));
  let config = {},
    timer,
    restoring = true;
  let desktopTools;
  const storageKey = "neon-device-" + identity.uid;
  let device = localStorage.getItem(storageKey);
  if (!/^[a-f0-9-]{36}$/.test(device || "")) {
    device = crypto.randomUUID();
    localStorage.setItem(storageKey, device);
  }
  const client = crypto.randomUUID();
  const deviceName =
    localStorage.getItem(storageKey + "-name") ||
    "Browser " + device.slice(0, 6);
  const link = connection(identity, notify);
  let pendingSave = false,
    saveQueue = Promise.resolve();
  async function api(path, body) {
    let r;
    try {
      r = await fetch("/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": identity.csrf,
          "X-Neon-Background": body?.background ? "1" : "0",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      link.disconnected();
      throw e;
    }
    if (r.status === 401) {
      link.requireLogin();
      throw Error("Sign in to reconnect. Server jobs are still running.");
    }
    const text = await r.text();
    let b;
    try {
      b = JSON.parse(text);
    } catch {
      b = { error: "Request failed" };
    }
    if (!r.ok) throw Error(b.error || "Request failed");
    return b;
  }
  const rpc = (app, action, args = {}) =>
    api("rpc", { device, client, ...args, app, action });
  config = await rpc("org.neon.settings", "config.get");
  setLanguage(config.language || "en");
  config.pins ??= [];
  config.shortcuts ??= [];
  const toastArea = el("div", { class: "toast-area", "aria-live": "polite" });
  function notify(message, options = {}) {
    desktopTools?.notify(message, options);
    const t = el("div", { class: "neon-toast", text: message });
    toastArea.append(t);
    setTimeout(() => t.remove(), 5500);
  }
  const top = el("nav", { class: "topbar", "aria-label": "Menu bar" });
  const pins = el("div", { class: "pinned-apps" }),
    right = el("div", { class: "topbar-right" }),
    clock = el("time");
  const menu = el("aside", { class: "launcher", hidden: "" });
  const host = el("main", { class: "desktop-surface" });
  const tasks = el("div", { class: "taskbar", "aria-label": "Open windows" });
  const wallpaper = createWallpaper(
    host,
    config,
    device,
    (action, args) => rpc("org.neon.settings", action, args),
    notify,
  );
  root.append(top, menu, host, tasks, toastArea);
  const wm = new WindowManager(host, changed);
  function changed() {
    tasks.replaceChildren(
      ...[...wm.windows.values()].map((w) =>
        button(
          w.app.icon + " " + (w.title || w.app.name),
          () => wm.focus(w),
          w.minimized ? "task minimized" : "task",
        ),
      ),
    );
    if (!restoring) save();
  }
  function save() {
    pendingSave = true;
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), 350);
  }
  async function flush() {
    clearTimeout(timer);
    config.windows = config.recovery === false ? [] : wm.snapshot();
    const value = JSON.parse(JSON.stringify(config));
    const task = saveQueue
      .catch(() => {})
      .then(() => rpc("org.neon.settings", "config.save", { value }));
    saveQueue = task;
    try {
      await task;
      if (saveQueue === task) pendingSave = false;
    } catch (e) {
      pendingSave = true;
      throw e;
    }
  }
  link.onReconnect(() => {
    if (pendingSave && !restoring) flush().catch(() => {});
  });
  const context = {
    identity,
    device,
    client,
    deviceName,
    apps,
    api,
    rpc,
    notify,
    config,
    wallpaper,
    wm,
    save,
    apply,
    open,
    renderPins,
    renderShortcuts,
    refreshApps,
    closeApp: async (id) => {
      for (const w of [...wm.windows.values()])
        if (w.app.id === id) await wm.close(w);
    },
    flush,
    ensureConnection: link.check,
    onReconnect: link.onReconnect,
  };
  async function refreshApps() {
    const me = await api("me");
    apps.clear();
    for (const app of me.apps) apps.set(app.id, app);
    identity.apps = me.apps;
    renderPins();
    renderShortcuts();
    renderApps();
    return me.apps;
  }
  async function open(id, saved = {}) {
    if (
      !apps.has(id) &&
      saved.state?.terminal &&
      ["org.neon.codex", "org.neon.qwen-coder"].includes(id)
    )
      id = "org.neon.terminal";
    const app = apps.get(id);
    if (!app) return;
    const w = wm.create(app, saved);
    w.content.append(
      el("div", { class: "loading", text: "Opening " + app.name + "…" }),
    );
    try {
      if (app.runtime === "core") {
        const module = await loaders[id]();
        w.content.replaceChildren();
        await module.mount(w, {
          ...context,
          app,
          call: (action, args) => rpc(id, action, args),
        });
      } else {
        w.content.replaceChildren();
        const sandbox = await import("./sandbox.js");
        await sandbox.mount(w, { ...context, app });
      }
      if (saved.minimized) {
        w.minimized = true;
        wm.paint(w);
      }
      changed();
    } catch (e) {
      w.content.replaceChildren(
        el("div", { class: "app-error", text: e.message }),
      );
      notify(app.name + ": " + e.message);
    }
    return w;
  }
  function appContext(event, app) {
    event.preventDefault();
    document.querySelector(".app-context")?.remove();
    const m = el("div", { class: "app-context", role: "menu" });
    m.style.left = Math.min(event.clientX, innerWidth - 230) + "px";
    m.style.top = Math.min(event.clientY, innerHeight - 220) + "px";
    const item = (name, fn) =>
      button(
        name,
        () => {
          fn();
          m.remove();
        },
        "context-item",
      );
    m.append(
      item("Open", () => open(app.id)),
      item("Open New Window", () => open(app.id)),
      item(
        config.pins.includes(app.id)
          ? "Unpin from Menu Bar"
          : "Pin to Menu Bar",
        () => {
          if (!app.pinnable) return;
          config.pins = config.pins.includes(app.id)
            ? config.pins.filter((x) => x !== app.id)
            : [...config.pins, app.id];
          renderPins();
          save();
        },
      ),
      item("Add to Desktop", () => {
        if (!config.shortcuts.includes(app.id)) config.shortcuts.push(app.id);
        renderShortcuts();
        save();
      }),
      item("App Information", () =>
        open("org.neon.applications", { state: { selected: app.id } }),
      ),
    );
    document.body.append(m);
    setTimeout(
      () =>
        document.addEventListener(
          "pointerdown",
          (e) => {
            if (!m.contains(e.target)) m.remove();
          },
          { once: true },
        ),
      0,
    );
  }
  function renderPins() {
    pins.replaceChildren();
    for (const id of config.pins) {
      const a = apps.get(id);
      if (!a) continue;
      const b = button(a.icon, () => open(id), "pin");
      b.title = a.name;
      b.setAttribute("aria-label", a.name);
      b.draggable = true;
      b.ondragstart = (e) => e.dataTransfer.setData("text/neon-pin", id);
      b.ondragover = (e) => e.preventDefault();
      b.ondrop = (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData("text/neon-pin");
        if (!config.pins.includes(from)) return;
        config.pins = config.pins.filter((x) => x !== from);
        config.pins.splice(config.pins.indexOf(id), 0, from);
        renderPins();
        save();
      };
      b.oncontextmenu = (e) => appContext(e, a);
      pins.append(b);
    }
  }
  const shortcuts = el("div", { class: "desktop-shortcuts" });
  host.append(shortcuts);
  function renderShortcuts() {
    shortcuts.replaceChildren(
      ...config.shortcuts
        .map((id) => apps.get(id))
        .filter(Boolean)
        .map((a) => {
          const b = button("", () => open(a.id), "desktop-shortcut");
          b.append(
            el("span", { class: "shortcut-icon", text: a.icon }),
            el("span", { text: a.name }),
          );
          b.oncontextmenu = (e) => appContext(e, a);
          return b;
        }),
    );
  }
  const search = el("input", {
    class: "launcher-search",
    placeholder: "Find an application…",
    "aria-label": "Find an application",
  });
  const listing = el("div", { class: "launcher-list" });
  menu.append(
    el("div", { class: "launcher-heading", text: "APPLICATIONS" }),
    search,
    listing,
    el("div", {
      class: "launcher-footer",
      text: "NEON / " + identity.username,
    }),
  );
  function renderApps() {
    listing.replaceChildren();
    if (
      ![...apps.values()].some((a) =>
        a.name.toLowerCase().includes(search.value.toLowerCase()),
      )
    )
      listing.append(el("p", { text: t("No applications found") }));
    for (const category of [
      ...new Set([...apps.values()].map((a) => a.category)),
    ]) {
      const matched = [...apps.values()].filter(
        (a) =>
          a.category === category &&
          a.name.toLowerCase().includes(search.value.toLowerCase()),
      );
      if (!matched.length) continue;
      listing.append(el("h3", { text: category.replaceAll("-", " ") }));
      for (const a of matched) {
        const b = button(
          "",
          () => {
            menu.hidden = true;
            open(a.id);
          },
          "launcher-app",
        );
        b.append(
          el("span", { class: "app-symbol", text: a.icon }),
          el("span", { text: a.name }),
        );
        b.oncontextmenu = (e) => appContext(e, a);
        listing.append(b);
      }
    }
  }
  search.oninput = renderApps;
  renderApps();
  top.append(
    button(
      "◈  Applications",
      () => {
        menu.hidden = !menu.hidden;
        if (!menu.hidden) search.focus();
      },
      "launcher-toggle",
    ),
    el("span", { class: "top-divider" }),
    pins,
    right,
  );
  right.append(
    button("Jobs", () => open("org.neon.jobs"), "top-icon"),
    link.badge,
    button(
      "Sessions",
      () => sessionPicker(context).catch((e) => notify(e.message)),
      "top-icon",
    ),
    button(
      identity.username,
      () => open("org.neon.settings", { state: { section: "Account" } }),
      "user-menu",
    ),
    clock,
    button(
      "↪",
      async () => {
        try {
          // Save app recovery state before revoking access. Neither action stops workers.
          for (const w of wm.windows.values()) await w.flush?.();
          await flush();
          await api("logout", {});
          link.stop();
          desktopTools.stop();
          for (const w of wm.windows.values()) w.cleanup();
          location.reload();
        } catch (e) {
          notify(
            "Sign out could not finish: " +
              e.message +
              ". Your desktop remains open.",
          );
        }
      },
      "top-icon",
    ),
  );
  for (const b of right.querySelectorAll("button"))
    if (["Jobs", "Sessions"].includes(b.textContent))
      b.dataset.i18n = b.textContent;
  right.lastChild.title = "Sign out — keep server sessions running";
  right.lastChild.setAttribute("aria-label", "Sign out");
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target) && !e.target.closest(".launcher-toggle"))
      menu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.hidden = true;
  });
  desktopTools = foundation(context, host, top, right);
  function apply() {
    setLanguage(config.language || "en");
    desktopTools?.labels();
    document
      .querySelectorAll("[data-i18n]")
      .forEach((e) => (e.textContent = t(e.dataset.i18n)));
    top.querySelector(".launcher-toggle").textContent =
      "◈  " + t("Applications");
    wallpaper.update();
    const style = document.documentElement.style;
    style.setProperty(
      "--accent",
      config.accent || desktopTools?.defaultAccent || "#65e6ad",
    );
    style.setProperty("--ui-scale", String(config.scale || 1));
    style.setProperty("--glass-blur", config.blur === false ? "0px" : "14px");
    document.body.classList.toggle("reduce-motion", !!config.reducedMotion);
    document.body.classList.toggle("high-contrast", !!config.highContrast);
    wm.snap = config.snapping !== false;
  }
  apply();
  renderPins();
  renderShortcuts();
  function tick() {
    clock.textContent = new Intl.DateTimeFormat(config.language || "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: !!config.clock12,
    }).format(new Date());
    clock.title = new Date().toLocaleDateString();
  }
  tick();
  setInterval(tick, 1000);
  if (config.recovery !== false)
    for (const saved of (config.windows || []).slice(0, 20))
      await open(saved.app, saved);
  restoring = false;
  changed();
}

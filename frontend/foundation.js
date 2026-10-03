import { el, button } from "./ui.js";
import { t } from "./i18n.js";
export function foundation(c, host, top, right) {
  const hostname = c.identity.hostname || location.hostname;
  const colors = ["#65e6ad", "#55cce6", "#efbb68", "#b29af5"];
  const defaultAccent =
    colors[
      [...hostname].reduce((n, ch) => (n + ch.charCodeAt(0)) % colors.length, 0)
    ];
  const brand = button("N/ · " + hostname, () => menu(), "host-brand");
  brand.title = hostname + " · " + location.origin;
  top.prepend(brand);
  const topSize = new ResizeObserver(() => {
    host.style.top = top.offsetHeight + "px";
  });
  topSize.observe(top);
  let notices = [],
    notifyDialog,
    unread = 0,
    jobBusy = false,
    stopped = false;
  const seenJobs = new Map();
  const openedAt = Date.now() / 1000;
  const bell = button(
    "",
    () => notifications(),
    "top-icon notifications-toggle",
  );
  const searchButton = button("", () => quick(), "top-icon quick-toggle");
  right.prepend(searchButton, bell);
  function labels() {
    bell.textContent = t("Notifications") + (unread ? ` (${unread})` : "");
    bell.setAttribute(
      "aria-label",
      t("Notifications") + (unread ? ` (${unread})` : ""),
    );
    searchButton.textContent = t("Quick open");
    searchButton.title = "Ctrl+K";
    brand.setAttribute("aria-label", t("Show desktop menu"));
  }
  labels();
  function notify(message, options = {}) {
    if (options.key && notices.some((n) => n.key === options.key)) return;
    notices.unshift({
      message: String(message).slice(0, 2000),
      time: new Date(),
      ...options,
    });
    notices = notices.slice(0, 100);
    unread = Math.min(100, unread + 1);
    labels();
    if (notifyDialog?.isConnected) renderNotices();
  }
  function dialog(title, cls) {
    const d = el("dialog", {
      class: "neon-dialog " + cls,
      "aria-label": t(title),
    });
    const close = () => {
      d.close();
      d.remove();
    };
    d.append(el("h3", { text: t(title) }));
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    d.addEventListener("close", () => d.remove());
    document.body.append(d);
    return { d, close };
  }
  function renderNotices() {
    const list = notifyDialog.querySelector(".notice-list");
    list.replaceChildren();
    if (!notices.length) list.append(el("p", { text: t("No notifications") }));
    for (const n of notices) {
      const row = el(
        "article",
        { class: "notice " + (n.level === "error" ? "notice-error" : "") },
        el("time", { text: n.time.toLocaleTimeString() }),
        el("p", { text: n.message }),
      );
      if (n.action)
        row.append(
          button(t("Open"), async () => {
            notifyDialog.close();
            try {
              await n.action();
            } catch (e) {
              c.notify(e.message);
            }
          }),
        );
      list.append(row);
    }
  }
  function notifications() {
    if (notifyDialog?.isConnected) {
      notifyDialog.close();
      return;
    }
    const { d, close } = dialog("Notifications", "notification-center");
    notifyDialog = d;
    d.append(
      el("div", { class: "notice-list" }),
      button(t("Clear notifications"), () => {
        notices = [];
        unread = 0;
        labels();
        renderNotices();
      }),
      button(t("Close"), close),
    );
    unread = 0;
    labels();
    renderNotices();
    d.showModal();
  }
  async function quick(onlyApps = false) {
    if (document.querySelector(".quick-open")) return;
    const { d, close } = dialog(
      onlyApps ? "Create shortcut" : "Quick open",
      "quick-open",
    );
    const input = el("input", {
      class: "form-control",
      placeholder: t("Search apps, windows, SSH and sessions…"),
      "aria-label": t("Quick open"),
    });
    const list = el("div", { class: "quick-results" });
    const status = el("p", { role: "status" });
    let entries = [...c.apps.values()].map((a) => ({
      name: a.name,
      kind: t("App"),
      run: () => {
        if (onlyApps) {
          if (!c.config.shortcuts.includes(a.id)) c.config.shortcuts.push(a.id);
          c.renderShortcuts();
          c.save();
        } else return c.open(a.id);
      },
    }));
    if (!onlyApps)
      entries.push(
        ...[...c.wm.windows.values()].map((w) => ({
          name: w.title || w.app.name,
          kind: t("Window"),
          run: () => c.wm.focus(w),
        })),
      );
    function render() {
      const q = input.value.trim().toLocaleLowerCase();
      const matches = entries
        .filter((x) => (x.name + " " + x.kind).toLocaleLowerCase().includes(q))
        .slice(0, 60);
      list.replaceChildren(
        ...matches.map((x) =>
          button(
            `${x.kind} · ${x.name}`,
            async () => {
              close();
              try {
                await x.run();
              } catch (e) {
                c.notify(e.message);
              }
            },
            "quick-result",
          ),
        ),
      );
      if (!matches.length) list.append(el("p", { text: t("No results") }));
    }
    input.oninput = render;
    d.onkeydown = (e) => {
      const buttons = [...list.querySelectorAll("button")];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        buttons[
          (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }
      if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        buttons[0]?.click();
      }
    };
    d.append(input, list, status, button(t("Close"), close));
    render();
    d.showModal();
    input.focus();
    if (!onlyApps) {
      const results = await Promise.allSettled([
        c.rpc("org.neon.connections", "ssh.list"),
        c.rpc("org.neon.terminal", "terminal.list"),
      ]);
      if (!d.isConnected) return;
      if (results[0].status === "fulfilled")
        entries.push(
          ...results[0].value.hosts.map((p) => ({
            name: `${p.name} · ${p.username}@${p.host}`,
            kind: "SSH",
            run: () =>
              c.open("org.neon.terminal", {
                state: { kind: "ssh", profile: p.id },
              }),
          })),
        );
      if (results[1].status === "fulfilled")
        entries.push(
          ...results[1].value.terminals
            .filter((x) => x.alive)
            .map((s) => ({
              name: `${s.name || "Terminal"} · ${s.host || hostname} · ${s.id.slice(-8)}`,
              kind: t("Session"),
              run: () => {
                const w = [...c.wm.windows.values()].find(
                  (w) => w.state.terminal === s.id,
                );
                return w
                  ? c.wm.focus(w)
                  : c.open(
                      { codex: "org.neon.codex", qwen: "org.neon.qwen-coder" }[
                        s.kind
                      ] || "org.neon.terminal",
                      { state: { terminal: s.id } },
                    );
              },
            })),
        );
      if (results.some((r) => r.status === "rejected"))
        status.textContent =
          "Some server results are unavailable. Try again when connected.";
      render();
    }
  }
  function menu(event) {
    event?.preventDefault();
    document.querySelector(".desktop-context")?.remove();
    const m = el("div", {
      class: "app-context desktop-context",
      role: "menu",
      "aria-label": t("Show desktop menu"),
    });
    for (const [name, fn] of [
      ["New terminal", () => c.open("org.neon.terminal")],
      ["Open home folder", () => c.open("org.neon.files")],
      ["Create shortcut", () => quick(true)],
      [
        "Change background",
        () => c.open("org.neon.settings", { state: { section: "Appearance" } }),
      ],
      ["Arrange windows", () => c.wm.arrange()],
    ])
      m.append(
        button(
          t(name),
          () => {
            remove();
            Promise.resolve()
              .then(fn)
              .catch((e) => c.notify(e.message));
          },
          "context-item",
        ),
      );
    function remove() {
      m.remove();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keys);
    }
    function outside(e) {
      if (!m.contains(e.target)) remove();
    }
    function keys(e) {
      const bs = [...m.querySelectorAll("button")],
        i = bs.indexOf(document.activeElement);
      if (e.key === "Escape") {
        remove();
        brand.focus();
      }
      if (["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        bs[
          (i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length
        ].focus();
      }
    }
    document.body.append(m);
    m.style.left =
      Math.max(
        8,
        Math.min(event?.clientX || 8, innerWidth - m.offsetWidth - 8),
      ) + "px";
    m.style.top =
      Math.max(
        8,
        Math.min(event?.clientY || 48, innerHeight - m.offsetHeight - 8),
      ) + "px";
    m.firstChild.focus();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keys);
  }
  host.addEventListener("contextmenu", (e) => {
    if (!e.target.closest(".desktop-window,.desktop-shortcut")) menu(e);
  });
  document.addEventListener("keydown", (e) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "k" &&
      !document.querySelector("dialog[open]")
    ) {
      e.preventDefault();
      quick();
    }
    if (e.shiftKey && e.key === "F10" && document.activeElement === host) {
      e.preventDefault();
      menu();
    }
  });
  host.tabIndex = 0;
  async function pollJobs() {
    if (stopped || jobBusy) return;
    jobBusy = true;
    try {
      const { jobs } = await c.rpc("org.neon.jobs", "jobs.list", {
        background: true,
      });
      for (const job of jobs) {
        if (
          (seenJobs.has(job.id)
            ? seenJobs.get(job.id) !== job.status
            : job.created >= openedAt) &&
          ["completed", "failed", "interrupted"].includes(job.status)
        )
          c.notify(job.name + " · " + job.status, {
            key: job.id + ":" + job.status,
            level: job.status === "completed" ? "info" : "error",
            action: () =>
              c.open("org.neon.jobs", { state: { selected: job.id } }),
          });
        seenJobs.set(job.id, job.status);
      }
      for (const id of seenJobs.keys())
        if (!jobs.some((j) => j.id === id)) seenJobs.delete(id);
    } catch {
    } finally {
      jobBusy = false;
    }
  }
  pollJobs();
  const timer = setInterval(pollJobs, 10000);
  return {
    notify,
    quick,
    labels,
    defaultAccent,
    stop() {
      stopped = true;
      clearInterval(timer);
      topSize.disconnect();
    },
  };
}

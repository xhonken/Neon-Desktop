import { el, button, field, bytes, confirmAction } from "../ui.js";
export async function mount(w, c) {
  const nav = el("nav", {
      class: "settings-nav",
      "aria-label": "Settings sections",
    }),
    main = el("div", { class: "settings-main" });
  w.content.append(el("div", { class: "settings-layout" }, nav, main));
  const sections = [
    "Appearance",
    "Desktop",
    "Menu Bar",
    "Account",
    "Security",
    "SSH & Keys",
    "Storage",
    "Terminal",
    "Code Editor",
    "Applications",
    "Notifications",
    "Language & Region",
    "Accessibility",
    "Session & Recovery",
  ];
  function set(key, value) {
    c.config[key] = value;
    c.apply();
    c.save();
  }
  function toggle(label, key, fallback = true) {
    const input = el("input", { type: "checkbox", class: "form-check-input" });
    input.checked = c.config[key] ?? fallback;
    input.onchange = () => set(key, input.checked);
    main.append(
      el("label", { class: "field" }, el("span", { text: label }), input),
    );
  }
  function numeric(label, key, value, min, max) {
    const f = field(label, c.config[key] ?? value, "number");
    f.input.min = min;
    f.input.max = max;
    f.input.onchange = () => {
      const v = Number(f.input.value);
      if (v >= min && v <= max) set(key, v);
    };
    main.append(f.row);
  }
  function note(text) {
    main.append(el("p", { class: "muted", text }));
  }
  async function show(section) {
    w.state.section = section;
    c.save();
    for (const b of nav.children)
      b.classList.toggle("active", b.textContent === section);
    main.replaceChildren(
      el("div", { class: "section-kicker", text: "PERSONAL WORKSPACE" }),
      el("h2", { text: section }),
    );
    if (section === "Appearance") {
      note("A quiet workspace. Color where it matters.");
      const swatches = el("div", { class: "swatches" });
      for (const [name, color] of [
        ["Matrix Green", "#65e6ad"],
        ["Cyber Cyan", "#55cce6"],
        ["Terminal Amber", "#efbb68"],
        ["Electric Purple", "#b29af5"],
      ]) {
        const b = button("", () => set("accent", color), "swatch");
        b.style.background = color;
        b.title = name;
        b.setAttribute("aria-label", name);
        swatches.append(b);
      }
      main.append(swatches);
      toggle("Translucent blur", "blur");
      numeric("UI scale", "scale", 1, 0.8, 1.5);
      note(
        "Background and additional theme controls are scheduled for the next desktop refinement.",
      );
    } else if (section === "Desktop" || section === "Session & Recovery") {
      toggle("Snap windows to screen edges", "snapping");
      toggle("Restore windows after sign-in", "recovery");
      main.append(
        button("Reset saved window layout", async () => {
          if (
            await confirmAction(
              "Clear the saved layout? Current running processes will not be stopped.",
            )
          ) {
            c.config.windows = [];
            c.config.recovery = false;
            c.save();
            c.notify("Recovery disabled and saved layout cleared");
          }
        }),
      );
      note(
        "Disconnecting, signing out or closing a window leaves terminal and Chromium processes running. Use Server sessions to reattach even with layout recovery disabled. Stop process / End session explicitly terminates a session. Editor drafts are recovered separately; server restart or power loss cannot preserve running processes.",
      );
    } else if (section === "Menu Bar") {
      note(
        "Right-click an application to pin it. Drag pinned icons to reorder, or use the controls below.",
      );
      for (const id of c.config.pins) {
        const a = c.apps.get(id);
        if (!a) continue;
        main.append(
          el(
            "div",
            { class: "field" },
            el("span", { text: a.name }),
            el(
              "div",
              {},
              button("↑", () => {
                const i = c.config.pins.indexOf(id);
                if (i > 0)
                  [c.config.pins[i - 1], c.config.pins[i]] = [
                    id,
                    c.config.pins[i - 1],
                  ];
                c.renderPins();
                c.save();
                show(section);
              }),
              button("Unpin", () => {
                c.config.pins = c.config.pins.filter((x) => x !== id);
                c.renderPins();
                c.save();
                show(section);
              }),
            ),
          ),
        );
      }
    } else if (section === "Account") {
      for (const key of ["username", "uid", "home", "shell"])
        main.append(
          el(
            "div",
            { class: "field" },
            el("span", { text: key.toUpperCase() }),
            el("code", { text: String(c.identity[key]) }),
          ),
        );
      note(
        "Your Linux account is authoritative. Password changes currently use passwd over SSH; a dedicated PAM password-change flow is not yet enabled.",
      );
    } else if (section === "Security") {
      const b = await c.api("security");
      note("Active sessions belong to your Linux account.");
      for (const s of b.sessions)
        main.append(
          el(
            "div",
            { class: "settings-card" },
            el("strong", { text: s.current ? "This session" : "Web session" }),
            el("p", {
              class: "muted",
              text:
                s.peer + " · " + new Date(s.created * 1000).toLocaleString(),
            }),
          ),
        );
      main.append(
        button("Terminate other web sessions", async () => {
          await c.api("security", {});
          await show(section);
        }),
      );
      main.append(el("h3", { class: "h6 mt-4", text: "Recent sign-ins" }));
      for (const e of b.events)
        note(
          new Date(e[0] * 1000).toLocaleString() + " · " + e[1] + " · " + e[2],
        );
    } else if (section === "SSH & Keys") {
      note(
        "Remote terminal profiles use OpenSSH host-key verification. New keys require interactive confirmation; changed keys fail verification. Passwords are entered only into the terminal and are not saved in profiles.",
      );
      note(
        "Manage keys with ssh-keygen, authorized_keys and known_hosts through SSH. A dedicated key-management UI is not enabled in this alpha.",
      );
      main.append(button("Open Terminal", () => c.open("org.neon.terminal")));
    } else if (section === "Storage") {
      const b = await c.call("storage.info");
      main.append(
        el(
          "div",
          { class: "settings-card" },
          el("h3", { text: bytes(b.available) + " available", class: "h4" }),
          el("p", {
            class: "muted",
            text: bytes(b.total) + " filesystem capacity · " + b.home,
          }),
        ),
      );
      note(
        "This is filesystem free space, not a measured HOME-directory total. Directory usage analysis and Trash are planned.",
      );
    } else if (section === "Terminal") {
      numeric("Font size", "terminalFontSize", 13, 10, 24);
      const select = el(
        "select",
        { class: "form-select form-select-sm" },
        ...["block", "bar", "underline"].map((v) =>
          el("option", { value: v, text: v }),
        ),
      );
      select.value = c.config.cursor || "block";
      select.onchange = () => set("cursor", select.value);
      main.append(
        el("label", { class: "field" }, el("span", { text: "Cursor" }), select),
      );
      note("Terminal preferences apply to new windows.");
    } else if (section === "Code Editor") {
      numeric("Tab width", "tabWidth", 4, 1, 8);
      toggle("Word wrap", "wordWrap", false);
      note(
        "UTF-8 encoding · explicit save · Ctrl+S. Preferences apply to new editor windows. Autosave, LSP, split editing and Git integration are not enabled.",
      );
    } else if (section === "Applications") {
      main.append(
        button("Open Application Manager", () =>
          c.open("org.neon.applications"),
        ),
      );
      note(
        "Core application capabilities are validated server-side. Third-party installation is gated until isolation and user-consent handling are verified.",
      );
    } else if (section === "Notifications") {
      note(
        "In-desktop notifications are available. Per-application notification preferences will arrive with third-party permission grants.",
      );
    } else if (section === "Language & Region") {
      toggle("12-hour clock", "clock12", false);
      note(
        "English UI in this alpha. Locale-aware formatting follows the browser; full translation and timezone controls are planned.",
      );
    } else if (section === "Accessibility") {
      toggle("Reduced motion", "reducedMotion", false);
      toggle("High contrast", "highContrast", false);
      numeric("UI scale", "scale", 1, 0.8, 1.5);
      note(
        "Keyboard focus indicators and system reduced-motion preferences are respected.",
      );
    }
  }
  for (const s of sections)
    nav.append(
      button(
        s,
        () => show(s).catch((e) => c.notify(e.message)),
        "settings-item",
      ),
    );
  await show(w.state.section || "Appearance");
}

import { el, button, confirmAction, bytes } from "../ui.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    search = el("input", {
      class: "form-control form-control-sm",
      "aria-label": "Search apps",
      placeholder: "Search apps…",
    }),
    tabs = el("div", { class: "toolbar" }),
    grid = el("div", { class: "app-grid" }),
    status = el("div", { class: "app-status", role: "status" });
  w.content.append(toolbar, tabs, grid, status);
  let data = { apps: [], installed: [] },
    scope = "catalog",
    busy = false;
  const run = (fn) => async () => {
    if (busy) return;
    busy = true;
    status.textContent = "Working…";
    try {
      await fn();
    } catch (e) {
      status.textContent = e.message;
      c.notify(e.message);
    } finally {
      busy = false;
    }
  };
  async function refresh() {
    data = await c.call("apps.catalog");
    await c.refreshApps();
    render();
    status.textContent = "App catalog ready · installs use a fixed Git commit";
  }
  async function install(entry, current) {
    status.textContent = "Downloading and checking " + entry.name + "…";
    const prepared = await c.call("apps.prepare", { target: entry.id });
    const m = prepared.manifest;
    const accepted = await confirmAction(
      `${current ? "Update" : "Install"} ${m.name} ${m.version} for your account?\n${m.description}\nPermissions: ${m.permissions.join(", ") || "none"}\nDownload: ${bytes(prepared.bytes)}\nSource: ${prepared.source.repository}\nCommit: ${prepared.source.commit}\n${current ? "Open windows for this app will close. Permissions must be approved again." : ""}`,
    );
    if (!accepted) {
      await c.call("apps.cancel", { token: prepared.token });
      status.textContent = "Installation cancelled";
      return;
    }
    if (current) await c.closeApp(entry.id);
    await c.call("apps.install", {
      target: entry.id,
      token: prepared.token,
      expected: current?.revision || null,
    });
    await refresh();
    c.notify(m.name + " " + m.version + " installed for your account");
  }
  function render() {
    grid.replaceChildren();
    const installed = new Map(data.installed.map((a) => [a.id, a]));
    const entries =
      scope === "catalog"
        ? data.apps
        : data.installed.filter(
            (a) =>
              scope === "all" ||
              (scope === "personal" ? a.scope === "user" : a.scope !== "user"),
          );
    const matching = entries.filter((a) =>
      (a.name + " " + (a.description || "") + " " + a.category)
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    );
    if (!matching.length)
      grid.append(
        el(
          "div",
          { class: "app-empty" },
          el("h2", {
            text:
              scope === "catalog"
                ? "No apps in this catalog yet"
                : "No matching apps",
          }),
          el("p", {
            class: "muted",
            text:
              scope === "catalog"
                ? "Your administrator can connect the project’s Git app catalog. Published apps will appear here."
                : "Try another search or browse the catalog.",
          }),
        ),
      );
    for (const a of matching) {
      const current = installed.get(a.id),
        entry = data.apps.find((e) => e.id === a.id),
        update =
          current?.scope === "user" &&
          entry &&
          current.source?.commit !== entry.commit;
      const card = el(
        "article",
        { class: "application-card", "data-app": a.id },
        el("span", { class: "app-symbol", text: a.icon || "◇" }),
        el("h3", { text: a.name }),
        el("p", { class: "muted", text: a.description || a.category }),
        el("p", { text: "Version " + a.version }),
        el("span", {
          class: "permission",
          text: current
            ? current.scope === "user"
              ? "Installed for me"
              : current.scope === "core"
                ? "Built in"
                : "Installed for everyone"
            : a.installation === "system"
              ? "Requires administrator"
              : "Personal app",
        }),
      );
      if (a.permissions)
        card.append(
          el("p", {
            class: "muted",
            text: "Permissions: " + (a.permissions.join(", ") || "none"),
          }),
        );
      if (current) card.append(button("Open", () => c.open(current.id)));
      if (!current && entry?.installation === "user")
        card.append(
          button(
            "Install for me",
            run(() => install(entry, null)),
          ),
        );
      if (update)
        card.append(
          button(
            "Update to " + entry.version,
            run(() => install(entry, current)),
          ),
        );
      if (current?.scope === "user")
        card.append(
          button(
            "Uninstall",
            run(async () => {
              if (
                !(await confirmAction(
                  "Uninstall " +
                    current.name +
                    " for your account? Its windows will close. Your documents and saved app data will remain.",
                ))
              )
                return;
              await c.closeApp(current.id);
              await c.call("apps.remove", {
                target: current.id,
                expected: current.revision,
              });
              await refresh();
              c.notify(current.name + " uninstalled");
            }),
          ),
        );
      if (current?.runtime === "sandbox")
        card.append(
          button(
            "Revoke permissions",
            run(async () => {
              await c.api("permissions", {
                app: current.id,
                revision: current.revision,
                permissions: [],
              });
              await c.closeApp(current.id);
              await refresh();
              c.notify("Permissions revoked");
            }),
          ),
        );
      if (entry?.installation === "system")
        card.append(
          el("p", {
            class: "muted",
            text: "An administrator installs this once for all users:",
          }),
          el("code", { text: "sudo neon-apps install " + entry.id }),
        );
      if (entry)
        card.append(
          el(
            "details",
            {},
            el("summary", { text: "Git source" }),
            el("p", { text: entry.repository }),
            el("code", { text: entry.commit }),
          ),
        );
      grid.append(card);
    }
  }
  toolbar.append(search, button("Refresh catalog", run(refresh)));
  search.oninput = render;
  for (const [key, label] of [
    ["catalog", "Catalog"],
    ["personal", "My apps"],
    ["system", "System apps"],
    ["all", "All installed"],
  ])
    tabs.append(
      button(label, () => {
        scope = key;
        render();
      }),
    );
  await refresh();
}

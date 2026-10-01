import { el, button } from "../ui.js";
export async function mount(w, c) {
  const grid = el("div", { class: "app-grid" });
  for (const a of c.apps.values()) {
    grid.append(
      el(
        "article",
        { class: "application-card" },
        el("span", { class: "app-symbol", text: a.icon }),
        el("h3", { text: a.name }),
        el("p", { class: "muted", text: a.version + " · " + a.runtime }),
        el("p", { class: "muted", text: a.id }),
        el(
          "div",
          {},
          ...a.permissions.map((p) =>
            el("span", { class: "permission", text: p }),
          ),
        ),
        button("Open", () => c.open(a.id)),
        ...(a.runtime === "sandbox"
          ? [
              button("Revoke permissions", async () => {
                await c.api("permissions", { app: a.id, permissions: [] });
                a.granted = [];
                c.notify("Permissions revoked for " + a.name);
              }),
            ]
          : []),
      ),
    );
  }
  w.content.append(
    el(
      "div",
      { class: "toolbar" },
      el("span", {
        class: "muted",
        text: "Installed applications · manifests verified by the server",
      }),
    ),
    grid,
    el("div", {
      class: "app-status",
      text: "Third-party frontend packages use an isolated sandbox. Installation is administrator-controlled; backend plugins remain disabled.",
    }),
  );
}

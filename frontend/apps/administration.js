import { el, button, ask, bytes } from "../ui.js";
import { credentialsDialog } from "../account-ui.js";
import { t } from "../i18n.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    main = el("div", { class: "admin-users" }),
    status = el("p", { role: "status" });
  w.content.append(
    toolbar,
    el("p", {
      class: "muted",
      text: t(
        "Linux accounts. New users have no sudo rights. Sensitive changes require your current password.",
      ),
    }),
    status,
    main,
  );
  let busy = false;
  async function change(operation, username, title, newPassword = false) {
    if (busy) return;
    const secret = await credentialsDialog(
      title + " · " + username,
      newPassword,
    );
    if (!secret) return;
    busy = true;
    status.textContent = t("Applying change…");
    try {
      await c.api("administration", { operation, username, ...secret });
      c.notify(t("Account updated"));
      await refresh();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      secret.password = "";
      if (secret.newPassword) secret.newPassword = "";
      busy = false;
    }
  }
  async function refresh() {
    const { users } = await c.api("administration", { operation: "list" });
    main.replaceChildren();
    status.textContent = "";
    for (const u of users) {
      const row = el(
        "article",
        { class: "settings-card" },
        el("h3", { class: "h5", text: u.username }),
        el("p", {
          text: `UID ${u.uid} · ${t(u.available ? "Active" : "Locked or expired")} · ${u.sudo ? "sudo" : t("Standard user")}`,
        }),
      );
      const actions = el("div", { class: "toolbar" });
      const reset = button(t("Reset password"), () =>
        change("reset", u.username, t("Reset password"), true),
      );
      const lock = button(
        t(u.lockedByNeon ? "Unlock account" : "Lock account"),
        () =>
          change(
            u.lockedByNeon ? "unlock" : "lock",
            u.username,
            t(u.lockedByNeon ? "Unlock account" : "Lock account"),
          ),
      );
      const sudo = button(t(u.sudo ? "Remove sudo" : "Grant sudo"), () =>
        change(
          u.sudo ? "sudo.revoke" : "sudo.grant",
          u.username,
          t(u.sudo ? "Remove sudo" : "Grant sudo"),
        ),
      );
      reset.disabled = lock.disabled = sudo.disabled = u.self;
      const usage = button(t("Measure storage"), async () => {
        usage.disabled = true;
        usage.textContent = t("Measuring…");
        try {
          const result = await c.api("administration", {
            operation: "usage",
            username: u.username,
          });
          usage.textContent = bytes(result.bytes);
        } catch (e) {
          usage.textContent = e.message;
        } finally {
          usage.disabled = false;
        }
      });
      actions.append(reset, lock, sudo, usage);
      row.append(actions);
      if (u.self)
        row.append(
          el("p", {
            class: "muted",
            text: t(
              "Your administrator account is protected. Change your password in My account.",
            ),
          }),
        );
      main.append(row);
    }
  }
  toolbar.append(
    button(t("Create user"), async () => {
      const name = await ask(t("Linux username"));
      if (name) await change("create", name, t("Create standard user"), true);
    }),
    button(t("Refresh"), () => refresh().catch((e) => c.notify(e.message))),
  );
  w.content.append(
    el("p", {
      class: "muted",
      text: t(
        "Sudo changes affect new administrative logins. Existing SSH processes retain their groups. External SSH access is configured separately.",
      ),
    }),
  );
  await refresh();
}

import { el, button, field, confirmAction } from "./ui.js";
import { t } from "./i18n.js";
export function credentialsDialog(title, change = false) {
  return new Promise((resolve) => {
    const d = el("dialog", { class: "neon-dialog credential-dialog" }),
      form = el("form");
    const current = field(t("Your current password"), "", "password");
    current.input.autocomplete = "current-password";
    current.input.required = true;
    const fresh = field(t("New password"), "", "password"),
      repeat = field(t("Repeat new password"), "", "password");
    for (const f of [fresh, repeat]) {
      f.input.autocomplete = "new-password";
      f.input.minLength = 12;
      f.input.required = change;
    }
    const error = el("p", { role: "alert", class: "text-warning" });
    const finish = (value) => {
      for (const f of [current, fresh, repeat]) f.input.value = "";
      d.close();
      d.remove();
      resolve(value);
    };
    form.append(
      el("h3", { text: title }),
      el("p", {
        text: t(
          "Confirm with your own password. Running jobs will not be stopped.",
        ),
      }),
      current.row,
    );
    if (change)
      form.append(
        fresh.row,
        repeat.row,
        el("p", { class: "muted", text: t("Use at least 12 characters.") }),
      );
    form.append(
      error,
      el(
        "div",
        { class: "dialog-actions" },
        button(t("Cancel"), () => finish(null)),
        el("button", {
          type: "submit",
          class: "btn btn-primary",
          text: t("Confirm"),
        }),
      ),
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      if (change && fresh.input.value !== repeat.input.value) {
        error.textContent = t("Passwords do not match");
        return;
      }
      finish({
        password: current.input.value,
        ...(change ? { newPassword: fresh.input.value } : {}),
      });
    };
    d.append(form);
    d.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    document.body.append(d);
    d.showModal();
    current.input.focus();
  });
}
function browserLabel(agent) {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome|Chromium/.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : t("Web session");
  const os = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return browser + (os ? " · " + os : "");
}
export async function accountSessions(main, c) {
  const data = await c.api("security");
  main.append(
    el("h3", { class: "h5", text: t("Signed-in browsers") }),
    el("p", {
      class: "muted",
      text: t(
        "Revoking web access leaves terminal sessions and background jobs running.",
      ),
    }),
  );
  for (const s of data.sessions) {
    const row = el(
      "article",
      { class: "settings-card" },
      el("strong", { text: t(s.current ? "This session" : "Web session") }),
      el("p", { text: browserLabel(s.device), title: s.device }),
      el("p", {
        class: "muted",
        text:
          s.peer +
          " · " +
          t("Last activity") +
          ": " +
          new Date(s.last * 1000).toLocaleString(),
      }),
    );
    row.dataset.current = String(s.current);
    row.append(
      button(t("Sign out this browser"), async () => {
        if (
          !(await confirmAction(
            t("Revoke this browser login? Running jobs will continue."),
          ))
        )
          return;
        try {
          await c.api("security", { id: s.id });
          row.remove();
          if (s.current) await c.api("me");
        } catch (e) {
          c.notify(e.message);
        }
      }),
    );
    main.append(row);
  }
  main.append(
    button(t("Sign out other browsers"), async () => {
      if (
        !(await confirmAction(
          t("Revoke other browser logins? Running jobs will continue."),
        ))
      )
        return;
      try {
        await c.api("security", {});
        main
          .querySelectorAll('article[data-current="false"]')
          .forEach((x) => x.remove());
        c.notify(t("Other browser logins revoked"));
      } catch (e) {
        c.notify(e.message);
      }
    }),
  );
}

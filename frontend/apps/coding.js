import { el, button } from "../ui.js";
import { mount as terminal } from "./terminal.js";
import { t } from "../i18n.js";

export async function mount(w, c) {
  const kind = c.app.id === "org.neon.codex" ? "codex" : "qwen";
  if (w.state.terminal) return terminal(w, c);
  const panel = el("div", { class: "coding-start" });
  const status = el("p", { class: "app-status", role: "status" });
  const path = el("input", {
    class: "form-control",
    value: w.state.cwd || ".",
    "aria-label": t("Project folder"),
    placeholder: t("Folder inside your home directory"),
  });
  const folders = el("div", { class: "coding-folders" });
  const error = el("p", { role: "alert", class: "text-warning" });
  let info,
    opening = false,
    disposed = false;
  w.cleanup = () => {
    disposed = true;
  };
  async function browse() {
    try {
      const result = await c.call("files.list", { path: path.value || "." });
      folders.replaceChildren();
      const current = path.value.replace(/\/$/, "") || ".";
      if (current !== ".")
        folders.append(
          button("..", () => {
            path.value = current.split("/").slice(0, -1).join("/") || ".";
            browse();
          }),
        );
      for (const item of result.entries.filter(
        (e) => e.type === "directory" || e.kind === "directory" || e.directory,
      )) {
        folders.append(
          button(
            item.name,
            () => {
              path.value =
                current === "." ? item.name : current + "/" + item.name;
              browse();
            },
            "btn btn-sm btn-outline-light",
          ),
        );
      }
      error.textContent = "";
    } catch (e) {
      error.textContent = e.message;
    }
  }
  async function start(mode) {
    if (opening || disposed) return;
    opening = true;
    controls.querySelectorAll("button").forEach((b) => {
      b.disabled = true;
    });
    try {
      const cwd = path.value.trim() || ".";
      const session = await c.call("terminal.create", { kind, mode, cwd });
      if (disposed) {
        c.notify(t("Session started. Reopen it from Server sessions."));
        return;
      }
      Object.assign(w.state, { terminal: session.id, kind, mode, cwd });
      c.save();
      await c.flush();
      w.content.replaceChildren();
      await terminal(w, c);
    } catch (e) {
      if (!disposed) error.textContent = e.message;
      controls.querySelectorAll("button").forEach((b) => {
        b.disabled = false;
      });
    } finally {
      opening = false;
    }
  }
  const controls = el(
    "div",
    { class: "toolbar" },
    button(t("Start new session"), () => start("start")),
    button(t("Resume saved session"), () => start("resume")),
  );
  if (kind === "codex")
    controls.append(button(t("Sign in to Codex"), () => start("login")));
  panel.append(
    el("h2", { text: c.app.name }),
    el("p", {
      text:
        kind === "codex"
          ? t(
              "Code with Codex in your own Linux account. Sign in with your personal ChatGPT account.",
            )
          : t(
              "Code with Qwen Coder using our configured Qwen3-Coder-Next server.",
            ),
    }),
    status,
    el("label", { text: t("Project folder") }, path),
    el(
      "div",
      { class: "toolbar" },
      button(t("Browse folders"), browse),
      button(t("New folder"), async () => {
        try {
          await c.call("files.mkdir", { path: path.value.trim() });
          await browse();
        } catch (e) {
          error.textContent = e.message;
        }
      }),
    ),
    folders,
    controls,
    error,
    el("p", {
      class: "text-secondary",
      text: t(
        "Closing the window or signing out keeps the session running. Use Stop process to end it.",
      ),
    }),
  );
  if (kind === "codex")
    panel.append(
      el("p", {
        class: "text-secondary",
        text: t(
          "Codex credentials use your encrypted OS keyring. On first use, choose its password in the terminal. Device sign-in is completed in your browser.",
        ),
      }),
    );
  w.content.append(panel);
  try {
    info = await c.call("coding.info", { kind });
    if (disposed) return;
    status.textContent = info.ready
      ? `${c.app.name} ${info.version || ""} · ${info.model || t("Ready")}`
      : info.message;
    if (!info.ready)
      controls.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
      });
  } catch (e) {
    if (!disposed) status.textContent = e.message;
  }
}

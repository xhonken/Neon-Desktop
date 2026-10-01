import { el, button, confirmAction } from "./ui.js";
export async function mount(w, c) {
  const app = c.app;
  const supported = app.permissions.filter((p) =>
    ["user-files", "notifications"].includes(p),
  );
  const unsupported = app.permissions.filter((p) => !supported.includes(p));
  const granted = new Set(app.granted || []);
  const missing = supported.filter((p) => !granted.has(p));
  if (missing.length) {
    const description = missing.includes("user-files")
      ? "This application requests access to read and modify files in your HOME. Only grant this to an application you trust."
      : "This application requests desktop notifications.";
    if (
      !(await confirmAction(
        `${app.name}: ${description}\nPermissions: ${missing.join(", ")}`,
      ))
    ) {
      w.content.append(
        el("p", {
          class: "p-4",
          text: "Permission not granted. Close and reopen to retry.",
        }),
      );
      return;
    }
    await c.api("permissions", { app: app.id, permissions: supported });
    app.granted = supported;
  }
  const launch = await c.api("app-launch", { app: app.id });
  const iframe = el("iframe", {
    sandbox: "allow-scripts",
    src: launch.src,
    title: app.name,
    referrerpolicy: "no-referrer",
  });
  iframe.style.cssText = "border:0;width:100%;flex:1;min-height:0";
  const receive = async (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== "null")
      return;
    const data = event.data;
    if (
      !data ||
      data.channel !== "neon-sdk-v1" ||
      typeof data.id !== "string" ||
      data.id.length > 64
    )
      return;
    const reply = (value) =>
      iframe.contentWindow.postMessage(
        { channel: "neon-sdk-v1", id: data.id, ...value },
        "*",
      );
    try {
      let result;
      if (data.action === "theme")
        result = {
          accent: c.config.accent || "#65e6ad",
          background: "#0c151b",
          foreground: "#dce6eb",
        };
      else if (data.action === "notify") {
        if (!app.granted?.includes("notifications"))
          throw Error("Permission denied");
        c.notify(
          app.name + ": " + String(data.args?.message || "").slice(0, 200),
        );
        result = { ok: true };
      } else if (data.action?.startsWith("files.")) {
        result = await c.rpc(app.id, data.action, data.args || {});
      } else throw Error("Unsupported SDK action");
      reply({ result });
    } catch (error) {
      reply({ error: error.message });
    }
  };
  window.addEventListener("message", receive);
  w.cleanup = () => window.removeEventListener("message", receive);
  w.content.append(iframe);
  if (unsupported.length)
    c.notify(
      app.name +
        ": unsupported permissions remain denied: " +
        unsupported.join(", "),
    );
}

import { el, button, bytes } from "./ui.js";
import { t } from "./i18n.js";
export async function fileTask(c, kind, entries) {
  const d = el("dialog", { class: "neon-dialog file-progress" }),
    status = el("p", { role: "status" }),
    progress = el("progress", { max: entries.length, value: 0 });
  d.append(
    el("h3", { text: t("File operation") }),
    status,
    progress,
    el("p", {
      class: "muted",
      text: t(
        "You can hide this progress window. The operation continues on the server.",
      ),
    }),
    button(t("Hide"), () => d.close()),
  );
  d.onclose = () => d.remove();
  document.body.append(d);
  d.showModal();
  try {
    const { id } = await c.call("files.operation.start", { kind, entries });
    for (;;) {
      const s = await c.call("files.operation.status", {
        id,
        background: true,
      });
      progress.value = s.done;
      status.textContent = `${s.done} / ${s.total} · ${s.entries} ${t("entries")} · ${bytes(s.bytes)}`;
      if (s.status === "failed")
        throw Error(s.error + ` (${s.done}/${s.total} ${t("completed")})`);
      if (s.status === "completed") return s;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  } finally {
    d.close();
    d.remove();
  }
}

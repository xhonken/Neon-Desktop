import { el, button, confirmAction, ask } from "../ui.js";
import { fileTask } from "../file-task.js";
import { t } from "../i18n.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    main = el("div", { class: "trash-list" });
  w.content.append(
    toolbar,
    el("p", {
      class: "muted",
      text: t(
        "Deleted files stay here until you permanently delete them. They still use storage.",
      ),
    }),
    main,
  );
  let entries = [];
  const run = (fn) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      c.notify(e.message);
    }
  };
  async function refresh() {
    entries = (await c.call("files.trash.list")).entries;
    main.replaceChildren();
    if (!entries.length) main.append(el("p", { text: t("Trash is empty") }));
    for (const e of entries) {
      const row = el(
        "article",
        { class: "settings-card" },
        el("strong", { text: e.path }),
        el("p", {
          class: "muted",
          text: new Date(e.deleted * 1000).toLocaleString(),
        }),
      );
      row.append(
        el(
          "div",
          { class: "toolbar" },
          button(
            t("Restore"),
            run(async () => {
              try {
                await fileTask(c, "restore", [{ id: e.id }]);
              } catch (error) {
                const target = await ask(
                  error.message +
                    " · " +
                    t("Restore to another HOME-relative path"),
                  e.path,
                );
                if (target)
                  await fileTask(c, "restore", [{ id: e.id, target }]);
              }
            }),
          ),
          button(
            t("Delete permanently"),
            run(async () => {
              if (
                await confirmAction(
                  t("Permanently delete this item? This cannot be undone."),
                )
              )
                await fileTask(c, "purge", [{ id: e.id }]);
            }),
          ),
        ),
      );
      main.append(row);
    }
  }
  toolbar.append(
    button(t("Refresh"), run(refresh)),
    button(
      t("Empty trash"),
      run(async () => {
        if (
          entries.length &&
          (await confirmAction(
            t("Permanently delete everything in your trash?"),
          ))
        )
          await fileTask(
            c,
            "purge",
            entries.map((e) => ({ id: e.id })),
          );
      }),
    ),
  );
  await refresh();
}

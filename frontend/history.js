import { el, button, unbase64, confirmAction } from "./ui.js";
export async function show(path, c, restored) {
  const d = el("dialog", { class: "neon-dialog history-dialog" });
  d.style.width = "min(1000px,95vw)";
  const body = el("div");
  d.append(
    el("h3", { text: "File history" + (path ? " · " + path : "") }),
    body,
    button("Close", () => {
      d.close();
      d.remove();
    }),
  );
  document.body.append(d);
  d.showModal();
  d.addEventListener("cancel", () => d.remove());
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      c.notify(e.message);
    }
  };
  async function settings() {
    const cfg = await c.call("history.settings");
    const enabled = el("input", {
      type: "checkbox",
      "aria-label": "Enable file history",
    });
    enabled.checked = cfg.enabled;
    const exclude = el("textarea", {
      class: "form-control",
      rows: "5",
      "aria-label": "Excluded file patterns",
    });
    exclude.value = cfg.exclude.join("\n");
    body.replaceChildren(
      el("p", {
        text: "Up to 10 versions per file by default, 4MiB per version and 64 MiB total. Oldest versions are pruned. Internal config/cache files are excluded. This history is on the same disk and is not a backup.",
      }),
      el(
        "label",
        { class: "field" },
        el("span", { text: "Enable history" }),
        enabled,
      ),
      el("p", { text: "Exclude sensitive files (one pattern per line)" }),
      exclude,
      button(
        "Save preferences",
        run(async () => {
          await c.call("history.settings", {
            value: {
              ...cfg,
              enabled: enabled.checked,
              exclude: exclude.value.split("\n").filter(Boolean),
            },
          });
          await listing();
        }),
      ),
    );
  }
  async function listing() {
    body.replaceChildren(
      button("History preferences / exclusions", run(settings)),
    );
    if (!path) {
      body.append(
        el("p", { text: "Save or open a named file to view its history." }),
      );
      return;
    }
    const b = await c.call("history.list", { path });
    if (!b.versions.length)
      body.append(
        el("p", {
          text: "No previous versions. Versions are captured before a file is overwritten.",
        }),
      );
    for (const v of b.versions)
      body.append(
        button(
          new Date(v.time * 1000).toLocaleString() + " · " + v.size + " bytes",
          run(async () => {
            const [old, current] = await Promise.all([
              c.call("history.read", { path, id: v.id }),
              c.call("files.read", { path }),
            ]);
            const decode = (s) =>
              new TextDecoder("utf-8", { fatal: true }).decode(unbase64(s));
            body.replaceChildren(
              button("Back", run(listing)),
              el("p", {
                text: "Previous version (left) / current file (right). Preview limited to 2000 lines.",
              }),
              el(
                "div",
                { class: "history-comparison" },
                el("pre", {
                  class: "workbench-log",
                  text: decode(old.data).split("\n").slice(0, 2000).join("\n"),
                }),
                el("pre", {
                  class: "workbench-log",
                  text: decode(current.data)
                    .split("\n")
                    .slice(0, 2000)
                    .join("\n"),
                }),
              ),
              button(
                "Restore this version",
                run(async () => {
                  if (
                    await confirmAction(
                      "Restore this version? Unsaved edits in this editor will be replaced. The current saved file is preserved in history first.",
                    )
                  ) {
                    await c.call("history.restore", {
                      path,
                      id: v.id,
                      expected: current.revision,
                      client: c.client,
                    });
                    await restored();
                    d.close();
                    d.remove();
                  }
                }),
              ),
            );
          }),
          "settings-item",
        ),
      );
  }
  await listing();
}

import { t } from "../i18n.js";
import {
  el,
  button,
  ask,
  confirmAction,
  base64,
  unbase64,
  download,
  bytes,
} from "../ui.js";
export async function mount(w, c) {
  let path = w.state.path || ".",
    entries = [],
    selected = new Set(),
    clipboard = null;
  const toolbar = el("div", { class: "toolbar" }),
    input = el("input", {
      class: "form-control form-control-sm path-input",
      "aria-label": "Directory",
      value: path,
    });
  const table = el("table", { class: "files-table" }),
    tbody = el("tbody"),
    status = el("div", { class: "app-status" });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ...["Name", "Size", "Modified"].map((text) => el("th", { text })),
      ),
    ),
    tbody,
  );
  const side = el("aside", { class: "files-sidebar" });
  const join = (name) => (path === "." ? name : path + "/" + name);
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      c.notify(e.message);
    }
  };
  async function refresh() {
    const b = await c.call("files.list", { path });
    entries = b.entries;
    selected.clear();
    input.value = path;
    w.state.path = path;
    c.wm.setTitle(w, "Files · " + (path === "." ? "Home" : path));
    c.save();
    render();
  }
  function render() {
    tbody.replaceChildren(
      ...entries.map((e) => {
        const row = el("tr", {
          tabindex: "0",
          class: selected.has(e.name) ? "selected" : "",
        });
        row.append(
          el(
            "td",
            { class: "file-name" },
            el("span", {
              class: "file-kind",
              text: e.symlink ? "↗" : e.directory ? "▰" : "▤",
            }),
            e.name,
          ),
          el("td", { text: e.directory ? "—" : bytes(e.size) }),
          el("td", { text: new Date(e.modified * 1000).toLocaleDateString() }),
        );
        row.onclick = (v) => {
          if (!v.ctrlKey && !v.metaKey && !v.shiftKey) selected.clear();
          selected.has(e.name) ? selected.delete(e.name) : selected.add(e.name);
          render();
        };
        const open = async () => {
          try {
            if (e.symlink) throw Error("Symlinks are not followed");
            if (e.directory) {
              path = join(e.name);
              await refresh();
            } else
              await c.open("org.neon.code", {
                state: { paths: [join(e.name)] },
              });
          } catch (err) {
            c.notify(err.message);
          }
        };
        row.oncontextmenu = (event) => {
          event.preventDefault();
          event.stopPropagation();
          document.querySelector(".file-context")?.remove();
          const menu = el("div", { class: "app-context file-context" });
          menu.append(
            button(
              t("Open terminal here"),
              () => {
                menu.remove();
                terminalHere(e.directory ? join(e.name) : path).catch((err) =>
                  c.notify(err.message),
                );
              },
              "context-item",
            ),
          );
          document.body.append(menu);
          menu.style.left =
            Math.max(
              0,
              Math.min(event.clientX, innerWidth - menu.offsetWidth),
            ) + "px";
          menu.style.top =
            Math.max(
              0,
              Math.min(event.clientY, innerHeight - menu.offsetHeight),
            ) + "px";
          const dismiss = (v) => {
            if (!menu.contains(v.target)) {
              menu.remove();
              document.removeEventListener("pointerdown", dismiss);
            }
          };
          document.addEventListener("pointerdown", dismiss);
        };
        row.ondblclick = open;
        row.onkeydown = (v) => {
          if (v.key === "Enter") open();
        };
        row.draggable = true;
        row.ondragstart = (v) => {
          v.dataTransfer.setData(
            "text/neon-file",
            JSON.stringify(
              [...(selected.size ? selected : [e.name])].map(join),
            ),
          );
        };
        if (e.directory) {
          row.ondragover = (v) => v.preventDefault();
          row.ondrop = async (v) => {
            v.preventDefault();
            v.stopPropagation();
            try {
              const files = JSON.parse(
                v.dataTransfer.getData("text/neon-file"),
              );
              for (const source of files)
                await c.call("files.rename", {
                  path: source,
                  target: join(e.name) + "/" + source.split("/").at(-1),
                });
              await refresh();
            } catch (err) {
              c.notify(err.message);
            }
          };
        }
        return row;
      }),
    );
    status.textContent =
      entries.length + " items · " + selected.size + " selected · HOME";
  }
  toolbar.append(
    button(
      "↑",
      run(async () => {
        path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
        await refresh();
      }),
    ),
    input,
    button("↻", run(refresh)),
  );
  input.onkeydown = (e) => {
    if (e.key === "Enter")
      run(async () => {
        path = input.value || ".";
        await refresh();
      })();
  };
  const actions = el("div", { class: "toolbar" });
  function terminalHere(target = path) {
    return c.open("org.neon.terminal", { state: { cwd: target } });
  }
  actions.append(
    button(
      t("Open terminal here"),
      run(() => terminalHere()),
    ),
    button(
      "New file",
      run(async () => {
        const name = await ask("New file");
        if (name) {
          await c.call("files.write", {
            path: join(name),
            data: "",
            exclusive: true,
          });
          await refresh();
        }
      }),
    ),
    button(
      "New folder",
      run(async () => {
        const name = await ask("New folder");
        if (name) {
          await c.call("files.mkdir", { path: join(name) });
          await refresh();
        }
      }),
    ),
    button(
      "Rename",
      run(async () => {
        if (selected.size !== 1) throw Error("Select one item");
        const old = [...selected][0],
          name = await ask("Rename", old);
        if (name) {
          await c.call("files.rename", { path: join(old), target: join(name) });
          await refresh();
        }
      }),
    ),
    button("Copy", () => {
      clipboard = { paths: [...selected].map(join), cut: false };
      c.notify("Copied selection");
    }),
    button("Cut", () => {
      clipboard = { paths: [...selected].map(join), cut: true };
    }),
    button(
      "Paste",
      run(async () => {
        if (!clipboard) return;
        for (const source of clipboard.paths)
          await c.call(clipboard.cut ? "files.rename" : "files.copy", {
            path: source,
            target: join(source.split("/").at(-1)),
          });
        clipboard = null;
        await refresh();
      }),
    ),
    button(
      "Delete",
      run(async () => {
        if (
          !selected.size ||
          !(await confirmAction(
            "Permanently delete " +
              selected.size +
              " selected item(s)? Directories must be empty.",
          ))
        )
          return;
        for (const name of selected)
          await c.call("files.delete", { path: join(name) });
        await refresh();
      }),
    ),
    button(
      "Download",
      run(async () => {
        for (const name of selected) {
          const b = await c.call("files.read", { path: join(name) });
          download(name, unbase64(b.data));
        }
      }),
    ),
    button("Properties", () => {
      const e = entries.find((e) => selected.has(e.name));
      if (e)
        c.notify(
          `${e.name} · ${e.mode} · UID ${e.uid} · GID ${e.gid} · ${bytes(e.size)}`,
        );
    }),
  );
  const upload = el("input", { type: "file", multiple: "", hidden: "" });
  upload.onchange = () => sendFiles(upload.files);
  actions.append(
    button("Upload", () => upload.click()),
    upload,
    button(
      "ZIP",
      run(async () => {
        const target = await ask("Archive name", "archive.zip");
        if (target) {
          await c.call("files.zip", {
            paths: [...selected].map(join),
            target: join(target),
          });
          await refresh();
        }
      }),
    ),
    button(
      "Extract",
      run(async () => {
        if (selected.size !== 1) throw Error("Select one ZIP archive");
        const target = await ask("New destination folder", "extracted");
        if (target) {
          await c.call("files.extract", {
            path: join([...selected][0]),
            target: join(target),
          });
          await refresh();
        }
      }),
    ),
  );
  async function sendFiles(files) {
    try {
      for (const file of files) {
        if (file.size > 16 * 1024 * 1024)
          throw Error("Upload limit is 16 MiB per file");
        await c.call("files.write", {
          path: join(file.name),
          data: base64(new Uint8Array(await file.arrayBuffer())),
          exclusive: true,
        });
      }
      await refresh();
      const target = path;
      c.notify("Upload complete · " + files.length + " file(s)", {
        action: () => c.open("org.neon.files", { state: { path: target } }),
      });
    } catch (e) {
      c.notify(e.message, { level: "error" });
    }
  }
  w.content.ondragover = (e) => e.preventDefault();
  w.content.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
  };
  for (const [name, target] of [
    ["⌂ Home", "."],
    ["Documents", "Documents"],
    ["Downloads", "Downloads"],
    ["Pictures", "Pictures"],
    ["Projects", "Projects"],
  ])
    side.append(
      button(
        name,
        run(async () => {
          path = target;
          await refresh();
        }),
        "sidebar-link",
      ),
    );
  w.content.append(
    toolbar,
    actions,
    el(
      "div",
      { class: "files-body" },
      side,
      el("div", { class: "files-table-wrap" }, table),
    ),
    status,
  );
  await refresh();
}

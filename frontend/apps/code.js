import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { el, button, ask, confirmAction, base64, unbase64 } from "../ui.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    tabs = el("div", { class: "editor-tabs" }),
    tree = el("aside", { class: "project-tree" }),
    area = el("div", { class: "editor-area" }),
    status = el("div", { class: "app-status", text: "UTF-8 · CodeMirror 6" });
  const docs = [];
  const previousPaths = [...(w.state.paths || [])];
  const previousRecovery = w.state.editorRecovery;
  if (!/^[a-f0-9-]{36}$/.test(w.state.editorRecovery || ""))
    w.state.editorRecovery = crypto.randomUUID();
  const recoveryPath =
    ".config/neon-desktop/editor-" + w.state.editorRecovery + ".json";
  let draftTimer,
    draftQueue = Promise.resolve(),
    ready = false,
    closed = false,
    draftPending = false;

  let active,
    view,
    root = w.state.root || ".",
    switching = false;
  const encoder = new TextEncoder(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  function language(path) {
    if (path.endsWith(".py")) return python();
    if (/\.[cm]?[jt]sx?$/.test(path))
      return javascript({ typescript: /\.tsx?$/.test(path) });
    if (path.endsWith(".json")) return json();
    if (/\.html?$/.test(path)) return html();
    if (path.endsWith(".css")) return css();
    return [];
  }
  function makeState(doc) {
    return EditorState.create({
      doc: doc.text,
      extensions: [
        basicSetup,
        oneDark,
        language(doc.path),
        indentUnit.of(" ".repeat(c.config.tabWidth || 4)),
        ...(c.config.wordWrap ? [EditorView.lineWrapping] : []),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              save().catch((e) => c.notify(e.message));
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !switching && active) {
            active.dirty = true;
            active.state = update.state;
            renderTabs();
            persist();
          }
          if (update.selectionSet) {
            const sel = update.state.selection.main;
            status.textContent = `Ln ${update.state.doc.lineAt(sel.head).number} · UTF-8 · ${active?.path || "Untitled"}`;
          }
        }),
      ],
    });
  }
  function renderTabs() {
    tabs.replaceChildren(
      ...docs.map((doc) => {
        const b = button(
          (doc.dirty ? "● " : "") + (doc.path?.split("/").at(-1) || "Untitled"),
          () => select(doc),
          "editor-tab" + (doc === active ? " active" : ""),
        );
        b.draggable = true;
        b.ondragstart = (e) =>
          e.dataTransfer.setData("text/neon-tab", String(docs.indexOf(doc)));
        b.ondragover = (e) => e.preventDefault();
        b.ondrop = (e) => {
          e.preventDefault();
          const index = Number(e.dataTransfer.getData("text/neon-tab"));
          if (!Number.isInteger(index) || index < 0 || index >= docs.length)
            return;
          const moving = docs.splice(index, 1)[0];
          docs.splice(docs.indexOf(doc), 0, moving);
          renderTabs();
          persist();
        };
        b.onauxclick = async (e) => {
          if (e.button === 1) {
            e.preventDefault();
            await close(doc);
          }
        };
        return b;
      }),
    );
  }
  function persist() {
    w.state.paths = docs.filter((d) => d.path).map((d) => d.path);
    w.state.root = root;
    c.save();
    if (ready && !closed) {
      draftPending = true;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(
        () =>
          flushDraft().catch(() => {
            status.textContent =
              "Draft not yet saved to server — keep this page open until reconnected.";
          }),
        700,
      );
    }
  }
  async function flushDraft() {
    if (!ready || closed) return;
    clearTimeout(draftTimer);
    const draft = {
      version: 1,
      root,
      active: docs.indexOf(active),
      documents: docs.map((d) => ({
        path: d.path,
        dirty: d.dirty,
        revision: d.revision,
        text:
          d.dirty || !d.path
            ? ((d === active && view ? view.state : d.state)?.doc.toString() ??
              d.text)
            : "",
      })),
    };
    const data = encoder.encode(JSON.stringify(draft));
    if (data.length > 14 * 1024 * 1024)
      throw Error(
        "Editor recovery exceeds 14 MiB. Save documents before signing out.",
      );
    draftPending = true;
    const task = draftQueue
      .catch(() => {})
      .then(() =>
        c.call("files.write", { path: recoveryPath, data: base64(data) }),
      );
    draftQueue = task;
    await task;
    if (draftQueue === task) draftPending = false;
  }
  w.flush = flushDraft;
  const reconnectOff = c.onReconnect(() => {
    if (draftPending && !closed) flushDraft().catch(() => {});
  });
  function select(doc) {
    if (active && view) active.state = view.state;
    active = doc;
    switching = true;
    if (view) view.setState(doc.state || makeState(doc));
    else
      view = new EditorView({
        state: doc.state || makeState(doc),
        parent: area,
      });
    switching = false;
    renderTabs();
    view.focus();
    persist();
  }
  async function open(path) {
    const found = docs.find((d) => d.path === path);
    if (found) {
      select(found);
      return;
    }
    const b = await c.call("files.read", { path });
    const doc = {
      path,
      text: decoder.decode(unbase64(b.data)),
      dirty: false,
      revision: b.revision,
    };
    docs.push(doc);
    select(doc);
  }
  async function save(as = false) {
    if (!active) return;
    const newFile = as || !active.path;
    let path = active.path;
    if (newFile) {
      path = await ask(
        "Save as — path relative to HOME",
        active.path || "Documents/untitled.txt",
      );
      if (!path) return;
    }
    const result = await c.call("files.write", {
      path,
      data: base64(encoder.encode(view.state.doc.toString())),
      exclusive: newFile,
      expected: newFile ? null : active.revision,
    });
    active.path = path;
    active.revision = result.revision;
    active.dirty = false;
    renderTabs();
    persist();
    status.textContent = "Saved · " + path;
  }

  async function close(doc) {
    if (
      doc.dirty &&
      !(await confirmAction(
        "Discard unsaved changes in " + (doc.path || "Untitled") + "?",
      ))
    )
      return;
    const i = docs.indexOf(doc);
    docs.splice(i, 1);
    if (doc === active) {
      active = null;
      if (docs.length) select(docs[Math.max(0, i - 1)]);
      else {
        view?.destroy();
        view = null;
        area.replaceChildren();
      }
    }
    renderTabs();
    persist();
  }
  async function project(path = root, container = tree) {
    if (container === tree) {
      tree.replaceChildren(
        el("div", { class: "project-label", text: "PROJECT / HOME" }),
      );
      root = path;
      persist();
    }
    const b = await c.call("files.list", { path });
    for (const e of b.entries.filter((x) => !x.name.startsWith("."))) {
      const p = path === "." ? e.name : path + "/" + e.name;
      const row = button(
        (e.directory ? "▸ " : "  ") + e.name,
        async () => {
          try {
            if (e.directory) {
              let nested = row.nextElementSibling;
              if (nested?.classList.contains("tree-nested")) nested.remove();
              else {
                nested = el("div", { class: "tree-nested" });
                nested.style.paddingLeft = "10px";
                row.after(nested);
                await project(p, nested);
              }
            } else await open(p);
          } catch (err) {
            c.notify(err.message);
          }
        },
        "tree-item",
      );
      container.append(row);
    }
  }
  const run = (fn) => () => fn().catch((e) => c.notify(e.message));
  toolbar.append(
    button("New", () => {
      const doc = { path: "", text: "", dirty: false };
      docs.push(doc);
      select(doc);
    }),
    button(
      "Open",
      run(async () => {
        const path = await ask("Open file — relative to HOME", "Documents/");
        if (path) await open(path);
      }),
    ),
    button(
      "Save",
      run(() => save()),
    ),
    button(
      "Save As",
      run(() => save(true)),
    ),
    button(
      "Close tab",
      run(async () => {
        if (active) await close(active);
      }),
    ),
    button(
      "Project",
      run(async () => {
        const p = await ask("Project folder — relative to HOME", root);
        if (p) await project(p);
      }),
    ),
    el("span", {
      class: "muted",
      text: "Ctrl+F search · Ctrl+H replace · Ctrl+S save",
    }),
  );
  w.content.append(
    toolbar,
    el(
      "div",
      { class: "editor-layout" },
      tree,
      el("div", { class: "editor-main" }, tabs, area),
    ),
    status,
  );
  let recovered;
  if (previousRecovery) {
    try {
      const b = await c.call("files.read", { path: recoveryPath });
      const draft = JSON.parse(decoder.decode(unbase64(b.data)));
      if (
        draft.version !== 1 ||
        !Array.isArray(draft.documents) ||
        draft.documents.length > 100 ||
        draft.documents.some(
          (d) => typeof d.path !== "string" || typeof d.text !== "string",
        )
      )
        throw Error("Invalid editor recovery data");
      recovered = draft;
    } catch (e) {
      c.notify("Editor recovery unavailable: " + e.message);
    }
  }
  try {
    await project();
  } catch (e) {
    c.notify("Project folder unavailable: " + e.message);
    root = ".";
    await project();
  }
  if (recovered) {
    for (const d of recovered.documents) {
      // Clean documents follow the real filesystem; unsaved changes retain their original revision.
      if (!d.dirty && d.path) {
        try {
          await open(d.path);
          continue;
        } catch (e) {
          c.notify("Could not reopen " + d.path + ": " + e.message);
          continue;
        }
      }
      docs.push({ ...d, dirty: !!d.dirty });
    }
    if (docs.length)
      select(
        docs[Math.max(0, Math.min(recovered.active || 0, docs.length - 1))],
      );
    status.textContent =
      "Recovered editor draft · unsaved documents still require Save";
  } else
    for (const path of previousPaths) {
      try {
        await open(path);
      } catch (e) {
        c.notify(path + ": " + e.message);
      }
    }
  if (!docs.length) {
    const doc = { path: "", text: "", dirty: false };
    docs.push(doc);
    select(doc);
  }
  ready = true;
  persist();
  const unload = (e) => {
    if (draftPending) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", unload);
  w.beforeClose = async () => {
    if (
      docs.some((d) => d.dirty) &&
      !(await confirmAction("Discard unsaved editor changes?"))
    )
      return false;
    clearTimeout(draftTimer);
    closed = true;
    await draftQueue.catch(() => {});
    try {
      await c.call("files.delete", { path: recoveryPath });
    } catch (e) {
      c.notify("The recovery draft could not be removed: " + e.message);
    }
    return true;
  };
  w.cleanup = () => {
    closed = true;
    clearTimeout(draftTimer);
    reconnectOff();
    window.removeEventListener("beforeunload", unload);
    view?.destroy();
  };
}

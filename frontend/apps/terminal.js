import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el, button, ask, confirmAction } from "../ui.js";
import { reconnectingStream, sessionPicker } from "../connection.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    host = el("div", { class: "terminal-host" }),
    status = el("div", {
      class: "app-status",
      text: "Connecting to your Linux session…",
    });
  w.content.append(toolbar, host, status);
  const term = new Terminal({
    fontSize: c.config.terminalFontSize || 13,
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    cursorBlink: true,
    cursorStyle: c.config.cursor || "block",
    theme: {
      background: "#080e13",
      foreground: "#b9d4c7",
      cursor: "#65e6ad",
      selectionBackground: "#214d40",
    },
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  let id = w.state.terminal,
    stream;
  if (!id) {
    const b = await c.call("terminal.create", {
      kind:
        c.app.id === "org.neon.text-browser" ? "text" : w.state.kind || "shell",
      profile: w.state.profile,
    });
    id = b.id;
    w.state.terminal = id;
    c.save();
    await c.flush();
  }
  stream = reconnectingStream(c, `terminal/${id}`, {
    async beforeConnect() {
      const b = await c.call("terminal.list");
      if (!b.terminals.some((t) => t.id === id)) {
        status.textContent =
          "This process no longer exists. The server or its worker may have restarted. Open a new terminal to start a new process.";
        return false;
      }
      return true;
    },
    open() {
      term.reset(); // The server replays its retained tail on every attachment.
      fit.fit();
      stream.send({ type: "resize", cols: term.cols, rows: term.rows });
      status.textContent =
        "Connected · " +
        c.identity.username +
        " · " +
        id.slice(0, 8) +
        " · kept running after sign-out";
    },
    message(e) {
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
      else {
        const b = JSON.parse(e.data);
        if (b.alive === false)
          status.textContent =
            "Process ended · retained output · " + id.slice(0, 8);
        if (b.error) c.notify(b.error);
      }
    },
    close() {
      status.textContent = "Reconnecting to the same server session…";
    },
    error(e) {
      status.textContent = "Waiting to reconnect · " + e.message;
    },
  });
  term.onData((data) => stream.send({ type: "input", data }));
  term.onResize(({ cols, rows }) =>
    stream.send({ type: "resize", cols, rows }),
  );
  const observer = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  observer.observe(host);
  toolbar.append(
    button("Reconnect", () => stream.reconnect()),
    button("Server sessions", () =>
      sessionPicker(c).catch((e) => c.notify(e.message)),
    ),
    button("Copy selection", () =>
      navigator.clipboard
        .writeText(term.getSelection())
        .catch(() => c.notify("Clipboard permission denied")),
    ),
    button("Paste", async () => {
      try {
        term.paste(await navigator.clipboard.readText());
      } catch {
        c.notify("Use your browser paste shortcut");
      }
    }),
    button("Stop process", async () => {
      if (await confirmAction("Terminate this terminal and its shell?")) {
        await c.call("terminal.stop", { id });
        status.textContent = "Process terminated";
      }
    }),
  );
  if (c.app.id === "org.neon.terminal") {
    toolbar.append(
      button("SSH profiles", async () => {
        try {
          let { hosts } = await c.call("ssh.list");
          const name = await ask("Profile name (new or existing)");
          if (!name) return;
          let i = hosts.findIndex((h) => h.name === name);
          if (i < 0) {
            const host = await ask("Host");
            if (!host) return;
            const username = await ask("SSH username", c.identity.username);
            if (!username) return;
            const port = await ask("SSH port", "22");
            if (!port) return;
            const group = await ask("Group", "Servers");
            if (group === null) return;
            hosts.push({ name, host, username, port: Number(port), group });
            await c.call("ssh.save", { hosts });
            i = hosts.length - 1;
          }
          await c.open(c.app.id, { state: { kind: "ssh", profile: i } });
        } catch (e) {
          c.notify(e.message);
        }
      }),
    );
  }
  w.cleanup = () => {
    stream.dispose();
    observer.disconnect();
    term.dispose();
  };
  await stream.connect();
}

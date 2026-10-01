import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el, button, ask, confirmAction } from "../ui.js";
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
  let ws,
    id = w.state.terminal,
    alive = false,
    disposed = false;
  const connect = async () => {
    if (!id) {
      const b = await c.call("terminal.create", {
        kind:
          c.app.id === "org.neon.text-browser"
            ? "text"
            : w.state.kind || "shell",
        profile: w.state.profile,
      });
      id = b.id;
      w.state.terminal = id;
      c.save();
    }
    ws = new WebSocket(
      `${location.origin.replace("https:", "wss:")}/api/v1/stream/terminal/${id}?app=${encodeURIComponent(c.app.id)}&csrf=${encodeURIComponent(c.identity.csrf)}`,
    );
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      fit.fit();
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
      status.textContent =
        "Connected · " + c.identity.username + " · " + id.slice(0, 8);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
      else {
        const b = JSON.parse(e.data);
        if ("alive" in b) {
          alive = b.alive;
          if (!alive)
            status.textContent =
              "Process ended — this terminal is not running.";
        }
        if (b.error) c.notify(b.error);
      }
    };
    ws.onclose = () => {
      if (!disposed)
        status.textContent =
          "Disconnected. Reconnect to check whether the process still exists.";
    };
  };
  term.onData((data) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws?.readyState === 1)
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
  const observer = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  observer.observe(host);
  toolbar.append(
    button("Reconnect", () => {
      ws?.close();
      term.clear();
      connect().catch((e) => c.notify(e.message));
    }),
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
    disposed = true;
    ws?.close();
    observer.disconnect();
    term.dispose();
  };
  await connect();
}

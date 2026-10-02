import { el, button } from "./ui.js";

// Keep the document and its unsaved state while connectivity/authentication recovers.
export function connection(identity, notify) {
  let checking,
    loginDialog,
    retryTimer,
    stopped = false;
  const listeners = new Set();
  const badge = el("span", {
    class: "connection-state",
    role: "status",
    text: "Connected",
  });
  function recovered(me) {
    if (me.uid !== identity.uid || me.username !== identity.username)
      throw Error(
        "Sign in with the original Linux account to resume this desktop.",
      );
    Object.assign(identity, me);
    badge.textContent = "Connected";
    clearTimeout(retryTimer);
    for (const fn of listeners) fn();
  }
  async function check() {
    if (stopped) return false;
    if (checking) return checking;
    checking = (async () => {
      try {
        const r = await fetch("/api/v1/me", {
          headers: { "X-Neon-Background": "1" },
          signal: AbortSignal.timeout(8000),
        });
        if (r.status === 401) {
          requireLogin();
          return false;
        }
        if (!r.ok) throw Error("Connection unavailable");
        recovered(await r.json());
        return true;
      } catch {
        disconnected();
        return false;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }
  function disconnected() {
    if (stopped) return;
    badge.textContent = "Reconnecting · server jobs continue";
    clearTimeout(retryTimer);
    retryTimer = setTimeout(check, 5000);
  }
  function requireLogin() {
    if (loginDialog || stopped) return;
    badge.textContent = "Sign in to reconnect · server jobs continue";
    const d = el("dialog", { class: "neon-dialog reconnect-login" });
    loginDialog = d;
    const user = el("input", {
      class: "form-control",
      value: identity.username,
      readonly: "",
      autocomplete: "username",
      "aria-label": "Username",
    });
    const password = el("input", {
      class: "form-control",
      type: "password",
      autocomplete: "current-password",
      required: "",
      "aria-label": "Password",
    });
    const error = el("p", { role: "alert" });
    const submit = el("button", {
      class: "btn btn-primary",
      type: "submit",
      text: "Sign in and reconnect",
    });
    const form = el(
      "form",
      {},
      el("h3", { text: "Sign in to reconnect" }),
      el("p", {
        text: "Your server sessions remain running. Sign in to resume this desktop.",
      }),
      user,
      password,
      error,
      submit,
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      try {
        const result = await fetch("/api/v1/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: identity.username,
            password: password.value,
          }),
          signal: AbortSignal.timeout(15000),
        });
        password.value = "";
        if (!result.ok) throw Error();
        const r = await fetch("/api/v1/me");
        if (!r.ok) throw Error();
        recovered(await r.json());
        d.close();
        d.remove();
        loginDialog = null;
      } catch {
        password.value = "";
        error.textContent = "Sign in failed.";
      } finally {
        submit.disabled = false;
      }
    };
    d.append(form);
    document.body.append(d);
    d.addEventListener("cancel", (e) => e.preventDefault());
    d.showModal();
    password.focus();
  }
  window.addEventListener("online", check);
  window.addEventListener("offline", disconnected);
  return {
    badge,
    check,
    disconnected,
    requireLogin,
    onReconnect(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
    },
  };
}

// A transport is disposable. Closing it must never terminate the server process.
export function reconnectingStream(c, path, handlers) {
  let socket,
    timer,
    disposed = false,
    attempt = 0;
  async function connect() {
    if (disposed || socket?.readyState === 0 || socket?.readyState === 1)
      return;
    clearTimeout(timer);
    try {
      if (!(await c.ensureConnection())) {
        schedule();
        return;
      }
      if (handlers.beforeConnect && !(await handlers.beforeConnect())) return;
      if (disposed) return;
      const current = new WebSocket(
        `${location.origin.replace("https:", "wss:")}/api/v1/stream/${path}?app=${encodeURIComponent(c.app.id)}&csrf=${encodeURIComponent(c.identity.csrf)}&view=${encodeURIComponent(c.client || "legacy")}`,
      );
      socket = current;
      current.binaryType = handlers.binaryType || "arraybuffer";
      current.onopen = () => {
        if (disposed || socket !== current) {
          current.close();
          return;
        }
        attempt = 0;
        handlers.open?.();
      };
      current.onmessage = (e) => {
        if (socket === current && !disposed) handlers.message?.(e);
      };
      current.onclose = () => {
        if (socket !== current || disposed) return;
        socket = null;
        handlers.close?.();
        schedule();
      };
    } catch (e) {
      if (!disposed) {
        handlers.error?.(e);
        schedule();
      }
    }
  }
  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(
      connect,
      Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)),
    );
  }
  const off = c.onReconnect(() => {
    if (!socket) schedule();
  });
  return {
    connect,
    send(value) {
      if (socket?.readyState === 1) socket.send(JSON.stringify(value));
    },
    reconnect() {
      if (socket) {
        const old = socket;
        socket = null;
        old.close();
      }
      attempt = 0;
      connect();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      off();
      socket?.close();
      socket = null;
    },
  };
}

export async function sessionPicker(c) {
  const { terminals } = await c.rpc("org.neon.terminal", "terminal.list");
  const d = el("dialog", { class: "neon-dialog session-picker" });
  const list = el("div", { class: "session-list" });
  const empty = el("p", { text: "No running terminal sessions." });
  const error = el("p", { role: "status", class: "text-warning" });
  const rows = new Map(),
    stopped = new Set();
  let timer,
    disposed = false,
    refreshing = false;
  function close() {
    disposed = true;
    clearTimeout(timer);
    d.close();
    d.remove();
  }
  function render(terminals) {
    const active = terminals.filter((t) => t.alive && !stopped.has(t.id));
    const ids = new Set(active.map((t) => t.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        const focused = row.node.contains(document.activeElement);
        row.node.remove();
        rows.delete(id);
        if (focused) closeButton.focus();
      }
    }
    for (const t of active) {
      let row = rows.get(t.id);
      if (!row) {
        const open = button(
          "",
          async () => {
            const existing = [...c.wm.windows.values()].find(
              (w) => w.state.terminal === t.id,
            );
            close();
            try {
              if (existing) c.wm.focus(existing);
              else
                await c.open("org.neon.terminal", {
                  state: { terminal: t.id },
                });
            } catch (e) {
              c.notify(e.message);
            }
          },
          "btn btn-neon session-open",
        );
        const stop = button(
          "Stop",
          async () => {
            stop.disabled = true;
            open.disabled = true;
            stop.textContent = "Stopping…";
            try {
              await c.rpc("org.neon.terminal", "terminal.stop", { id: t.id });
              stopped.add(t.id);
              if (!disposed) {
                render([...rows.values()].map((r) => r.terminal));
                error.textContent = "";
              }
            } catch (e) {
              if (!disposed)
                error.textContent = "Could not stop session: " + e.message;
            } finally {
              stop.disabled = false;
              open.disabled = false;
              stop.textContent = "Stop";
            }
          },
          "btn btn-sm btn-outline-danger",
        );
        const node = el(
          "div",
          { class: "session-row", "data-session-id": t.id },
          open,
          stop,
        );
        row = { node, open, stop };
        rows.set(t.id, row);
        list.append(node);
      }
      row.terminal = t;
      const name = `${t.name || "Terminal"} · ${t.host || "Local"} · ${t.id.slice(-8)}`;
      row.open.textContent = name;
      row.open.title = "Open running session";
      row.stop.setAttribute("aria-label", "Stop " + name);
      row.stop.title = "End this terminal session and its shell";
    }
    empty.hidden = active.length > 0;
  }
  async function refresh() {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const { terminals } = await c.rpc("org.neon.terminal", "terminal.list", {
        background: true,
      });
      if (!disposed) {
        render(terminals);
        error.textContent = "";
      }
    } catch (e) {
      if (!disposed)
        error.textContent = "Could not refresh sessions: " + e.message;
    } finally {
      refreshing = false;
      if (!disposed) timer = setTimeout(refresh, 2000);
    }
  }
  const closeButton = button("Close", close);
  d.append(
    el("h3", { text: "Running sessions" }),
    el("p", {
      text: "Open a session to reconnect. Closing a window keeps it running. Stop ends the selected terminal session and its shell.",
    }),
    list,
    empty,
    error,
    closeButton,
  );
  render(terminals);
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  d.addEventListener("close", () => {
    disposed = true;
    clearTimeout(timer);
    d.remove();
  });
  document.body.append(d);
  d.showModal();
  timer = setTimeout(refresh, 2000);
}

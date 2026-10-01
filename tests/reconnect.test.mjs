import test from "node:test";
import assert from "node:assert/strict";
import { reconnectingStream } from "../frontend/connection.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(t, overrides = {}) {
  const originals = {
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
  };
  const sockets = [];
  globalThis.location = { origin: "https://desktop.example" };
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    send(data) {
      this.lastSent = data;
    }
  };
  let listener;
  const context = {
    identity: { csrf: "first" },
    app: { id: "org.neon.terminal" },
    ensureConnection: async () => true,
    onReconnect(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    ...overrides,
  };
  t.after(() => {
    globalThis.WebSocket = originals.WebSocket;
    globalThis.location = originals.location;
  });
  return { context, sockets, hasListener: () => !!listener };
}
test("a transport reconnects to the same terminal with rotated authentication", async (t) => {
  const f = fixture(t);
  let opens = 0;
  const stream = reconnectingStream(f.context, "terminal/existing-id", {
    open() {
      opens++;
    },
  });
  t.after(() => stream.dispose());
  await stream.connect();
  f.sockets[0].open();
  stream.send({ type: "input", data: "hello" });
  assert.equal(
    f.sockets[0].lastSent,
    JSON.stringify({ type: "input", data: "hello" }),
  );
  f.context.identity.csrf = "rotated";
  f.sockets[0].close();
  await sleep(1150);
  assert.equal(f.sockets.length, 2);
  assert.match(f.sockets[1].url, /terminal\/existing-id\?/);
  assert.match(f.sockets[1].url, /csrf=rotated/);
  f.sockets[1].open();
  assert.equal(opens, 2);
});
test("a missing process does not get replaced by a new transport", async (t) => {
  const f = fixture(t);
  const stream = reconnectingStream(f.context, "terminal/missing", {
    beforeConnect: async () => false,
  });
  await stream.connect();
  assert.equal(f.sockets.length, 0);
  stream.dispose();
  assert.equal(f.hasListener(), false);
});
test("closing a window during authentication cancels attachment", async (t) => {
  let release;
  const f = fixture(t, {
    ensureConnection: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const stream = reconnectingStream(f.context, "terminal/retained", {});
  const pending = stream.connect();
  stream.dispose();
  release(true);
  await pending;
  assert.equal(f.sockets.length, 0);
  assert.equal(f.hasListener(), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { connection } from "../frontend/connection.js";

class Target {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}
class Element extends Target {
  children = [];
  value = "";
  constructor(tag) {
    super();
    this.tag = tag;
    this.attributes = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "value") this.value = value;
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  remove() {
    this.parent.children = this.parent.children.filter(
      (child) => child !== this,
    );
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {}
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function response(status, value) {
  return { status, ok: status === 200, json: async () => value };
}
function fixture(t) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const document = Object.assign(new Target(), {
    hidden: false,
    body: new Element("body"),
    createElement: (tag) => new Element(tag),
  });
  const window = new Target();
  const identity = { username: "test", uid: 1000, csrf: "first" };
  const requests = [];
  let respond = async () => response(200, { ...identity });
  globalThis.document = document;
  globalThis.window = window;
  globalThis.fetch = async (path, options) => {
    requests.push({ path, ...options });
    return respond(path, options);
  };
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 100000,
  });
  const link = connection(identity, () => {});
  t.after(() => {
    link.stop();
    Object.assign(globalThis, saved);
  });
  return {
    document,
    window,
    identity,
    requests,
    link,
    respond(fn) {
      respond = fn;
    },
    async tick(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
    dialog() {
      return document.body.children.find(
        (node) => node.className === "neon-dialog reconnect-login",
      );
    },
    async signIn() {
      const form = this.dialog().children[0];
      const password = form.children.find(
        (node) => node.attributes.type === "password",
      );
      password.value = "synthetic-password";
      await form.onsubmit({ preventDefault() {} });
      assert.equal(password.value, "");
      assert.equal(form.children.at(-1).disabled, false);
    },
  };
}

test("idle polling does not extend access; only visible trusted input does", async (t) => {
  const f = fixture(t);
  await f.tick(30000);
  assert.equal(f.requests.at(-1).headers["X-Neon-Background"], "1");
  f.document.fire("keydown", { isTrusted: false });
  f.document.hidden = true;
  f.document.fire("pointerdown", { isTrusted: true });
  f.document.hidden = false;
  await f.tick(30000);
  assert.equal(f.requests.at(-1).headers["X-Neon-Background"], "1");
  f.document.fire("keydown", { isTrusted: true });
  await settle();
  assert.equal(f.requests.at(-1).headers["X-Neon-Background"], "0");
  const count = f.requests.length;
  for (let i = 0; i < 20; i++) f.document.fire("keydown", { isTrusted: true });
  await settle();
  assert.equal(f.requests.length, count);
  await f.tick(30000);
  assert.equal(f.requests.at(-1).headers["X-Neon-Background"], "0");
  await f.tick(30000);
  assert.equal(f.requests.at(-1).headers["X-Neon-Background"], "1");
});

test("an expired idle desktop locks without a stream and resumes with fresh CSRF", async (t) => {
  const f = fixture(t);
  f.respond(async () => response(401));
  await f.tick(30000);
  assert.ok(f.dialog()?.open);
  let cancelled = false;
  f.dialog().fire("cancel", {
    preventDefault() {
      cancelled = true;
    },
  });
  assert.equal(cancelled, true);
  const pending = f.link.ready({ verify: true });
  let resumed = 0;
  f.link.onReconnect(() => resumed++);
  f.respond(async (path, options) => {
    if (path.endsWith("login")) {
      assert.equal(JSON.parse(options.body).username, "test");
      return response(200);
    }
    return response(200, { username: "test", uid: 1000, csrf: "new" });
  });
  await f.signIn();
  assert.equal(await pending, true);
  assert.equal(f.dialog(), undefined);
  assert.equal(f.identity.csrf, "new");
  assert.equal(resumed, 1);
  await f.tick(30000);
  assert.equal(resumed, 1);
});

test("another Linux account cannot replace the identity of a retained desktop", async (t) => {
  const f = fixture(t);
  f.respond(async (path) =>
    path.endsWith("login")
      ? response(200)
      : response(200, { username: "other", uid: 2000, csrf: "other" }),
  );
  assert.equal(await f.link.check(), false);
  assert.ok(f.dialog());
  await f.signIn();
  assert.ok(f.dialog()?.open);
  assert.deepEqual(f.identity, { username: "test", uid: 1000, csrf: "first" });
});

test("a failed PAM login keeps the page locked and can be retried", async (t) => {
  const f = fixture(t);
  f.link.requireLogin();
  f.respond(async () => response(401));
  await f.signIn();
  assert.ok(f.dialog()?.open);
  assert.equal(
    f.dialog().children[0].children.at(-2).textContent,
    "Sign in failed.",
  );
  f.respond(async () => response(200, { ...f.identity, csrf: "second" }));
  await f.signIn();
  assert.equal(f.dialog(), undefined);
});

test("a stale successful check cannot unlock a newer authentication barrier", async (t) => {
  const f = fixture(t);
  let release;
  f.respond(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const checking = f.link.check();
  f.link.requireLogin();
  const waiting = f.link.ready();
  release(response(200, { ...f.identity, csrf: "stale" }));
  assert.equal(await checking, false);
  assert.ok(f.dialog()?.open);
  assert.equal(f.identity.csrf, "first");
  f.link.stop();
  assert.equal(await waiting, false);
});

test("offline recovery preserves the page and stopping removes polling/listeners", async (t) => {
  const f = fixture(t);
  f.window.fire("offline");
  const pending = f.link.ready();
  await f.tick(5000);
  assert.equal(await pending, true);
  assert.equal(f.link.badge.textContent, "Connected");
  f.link.stop();
  const count = f.requests.length;
  await f.tick(60000);
  f.window.fire("online");
  f.document.fire("keydown", { isTrusted: true });
  await settle();
  assert.equal(f.requests.length, count);
  assert.equal(await f.link.ready({ verify: true }), false);
});

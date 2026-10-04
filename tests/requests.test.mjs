import test from "node:test";
import assert from "node:assert/strict";
import { sessionRequest } from "../frontend/requests.js";

test("an unauthorized request waits for login before retrying with fresh CSRF", async (t) => {
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  const identity = { csrf: "old" };
  const requests = [];
  let unlock,
    locked = false;
  const resumed = new Promise((resolve) => {
    unlock = resolve;
  });
  const link = {
    ready: () => (locked ? resumed : Promise.resolve(true)),
    requireLogin: () => {
      locked = true;
    },
    disconnected: () => assert.fail("No network failure occurred"),
  };
  globalThis.fetch = async (path, options) => {
    requests.push(options);
    return { status: requests.length === 1 ? 401 : 200 };
  };
  const body = { action: "files.write", data: "unchanged", background: true };
  const pending = sessionRequest(link, identity, "rpc", body);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(requests.length, 1);
  identity.csrf = "new";
  unlock(true);
  assert.equal((await pending).status, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[1].headers["X-CSRF-Token"], "new");
  assert.equal(requests[1].headers["X-Neon-Background"], "1");
});

test("a timed-out mutation is never replayed", async (t) => {
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  let calls = 0,
    disconnected = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new DOMException("Timeout", "TimeoutError");
  };
  await assert.rejects(
    sessionRequest(
      { ready: async () => true, disconnected: () => disconnected++ },
      { csrf: "test" },
      "rpc",
      { action: "terminal.create" },
    ),
    { name: "TimeoutError" },
  );
  assert.equal(calls, 1);
  assert.equal(disconnected, 1);
});

test("permission denial is preserved and repeated expiry cannot loop requests", async (t) => {
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  let calls = 0,
    logins = 0;
  const link = { ready: async () => true, requireLogin: () => logins++ };
  globalThis.fetch = async () => {
    calls++;
    return { status: 403 };
  };
  assert.equal(
    (await sessionRequest(link, { csrf: "test" }, "rpc", {})).status,
    403,
  );
  assert.equal(logins, 0);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { status: 401 };
  };
  await assert.rejects(
    sessionRequest(link, { csrf: "test" }, "rpc", {}),
    /Sign in to reconnect/,
  );
  assert.equal(calls, 2);
  assert.equal(logins, 2);
});

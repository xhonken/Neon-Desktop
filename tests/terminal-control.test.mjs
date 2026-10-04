import test from "node:test";
import assert from "node:assert/strict";
import { terminalControl } from "../frontend/terminal-control.js";

test("a click claims control and preserves the first characters typed during the claim", async () => {
  let release,
    claims = 0;
  const sent = [];
  const control = terminalControl({
    claim: () => {
      claims++;
      return new Promise((r) => {
        release = r;
      });
    },
    ready: () => true,
    send: (value) => sent.push(value.data),
    acquired: () => {},
    error: (e) => {
      throw e;
    },
  });
  control.readonly(true);
  const clicked = control.acquire(true);
  control.input("p");
  const typed = control.input("wd\r");
  assert.deepEqual(sent, []);
  release();
  await clicked;
  await typed;
  assert.equal(claims, 1);
  assert.deepEqual(sent, ["p", "wd\r"]);
  // A fresh click reclaims ownership even if another old worker view took it.
  const again = control.acquire(true);
  release();
  await again;
  assert.equal(claims, 2);
});

test("disconnect cancels pending terminal input and does not replay it after reconnect", async () => {
  let release,
    online = true,
    calls = 0;
  const sent = [];
  const control = terminalControl({
    claim: () =>
      ++calls === 1
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(),
    ready: () => online,
    send: (value) => sent.push(value.data),
    acquired: () => {},
    error: (e) => {
      throw e;
    },
  });
  const click = control.acquire(true);
  const pending = control.input("old command\r");
  online = false;
  control.reset();
  control.input("offline command\r");
  release();
  await click;
  await pending;
  online = true;
  await control.input("new command\r");
  assert.deepEqual(sent, ["new command\r"]);
});

test("failed claim leaves the PTY untouched", async () => {
  const errors = [],
    sent = [];
  const control = terminalControl({
    claim: async () => {
      throw Error("Sign in to reconnect");
    },
    ready: () => true,
    send: (value) => sent.push(value),
    acquired: () => {},
    error: (e) => errors.push(e.message),
  });
  await control.input("whoami\r");
  assert.deepEqual(sent, []);
  assert.deepEqual(errors, ["Sign in to reconnect"]);
});

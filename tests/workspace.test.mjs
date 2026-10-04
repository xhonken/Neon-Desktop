import test from "node:test";
import assert from "node:assert/strict";
import { windowChanges } from "../frontend/workspace.js";

test("an unchanged view does not republish its stale window list", () => {
  const windows = [{ id: "a", state: { terminal: "retained" } }];
  assert.deepEqual(windowChanges(windows, structuredClone(windows)), {
    open: [],
    upsert: [],
    remove: [],
  });
});

test("only local opens, closes and geometry changes are published", () => {
  const a = { id: "a", g: { x: 0 } },
    b = { id: "b", g: { x: 20 } };
  const moved = { ...a, g: { x: 40 } },
    opened = { id: "c", minimized: true };
  assert.deepEqual(windowChanges([a, b], [moved, opened]), {
    open: ["c"],
    upsert: [moved, opened],
    remove: ["b"],
  });
});

test("moving or minimizing an existing window does not declare a new open", () => {
  const before = [{ id: "a", g: { x: 0 } }];
  const changes = windowChanges(before, [
    { id: "a", g: { x: 40 }, minimized: true },
  ]);
  assert.deepEqual(changes.open, []);
  assert.equal(changes.upsert[0].id, "a");
});

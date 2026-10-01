import { test } from "node:test";
import assert from "node:assert/strict";
import { constrain } from "../frontend/wm.js";
test("windows remain reachable when viewport shrinks", () => {
  const g = constrain(
    { x: 1200, y: 900, w: 1400, h: 1000 },
    { w: 600, h: 400 },
  );
  assert(g.x <= 250);
  assert(g.y <= 360);
  assert(g.w <= 600);
  assert(g.h <= 400);
});
test("minimum dimensions adapt to small screens", () => {
  const g = constrain({ x: -1, y: -1, w: 1, h: 1 }, { w: 300, h: 200 });
  assert.deepEqual(g, { x: 0, y: 0, w: 300, h: 200 });
});

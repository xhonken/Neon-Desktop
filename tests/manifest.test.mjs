import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("all core manifests are complete and identities unique", () => {
  const ids = new Set();
  for (const d of fs.readdirSync("apps")) {
    const a = JSON.parse(fs.readFileSync(`apps/${d}/manifest.json`));
    assert.equal(a.id, d);
    assert(!ids.has(a.id));
    ids.add(a.id);
    assert(a.window.resizable);
    assert(a.window.minWidth >= 350);
    assert(Array.isArray(a.permissions));
  }
  assert.equal(ids.size, 9);
});

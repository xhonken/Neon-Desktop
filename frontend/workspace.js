// Publish only local window changes so another open device cannot erase them.
export function windowChanges(before, after) {
  const previous = new Map(before.map((w) => [w.id, JSON.stringify(w)]));
  const current = new Set(after.map((w) => w.id));
  return {
    open: after.filter((w) => !previous.has(w.id)).map((w) => w.id),
    upsert: after.filter((w) => previous.get(w.id) !== JSON.stringify(w)),
    remove: before.filter((w) => !current.has(w.id)).map((w) => w.id),
  };
}

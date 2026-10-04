// Claim without replacing the transport, retaining only input typed during a claim.
export function terminalControl({ claim, ready, send, acquired, error }) {
  let owned = false,
    pending,
    epoch = 0,
    disposed = false;
  let tail = Promise.resolve(),
    queued = { size: 0 };
  async function acquire(force = false) {
    if (disposed || !ready()) return false;
    if (pending) return pending;
    if (owned && !force) return true;
    const current = epoch;
    const task = (async () => {
      await claim();
      if (disposed || epoch !== current || !ready()) return false;
      owned = true;
      acquired();
      return true;
    })();
    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) pending = null;
    }
  }
  return {
    acquire,
    readonly(value) {
      owned = !value;
    },
    input(data) {
      if (disposed || !ready() || queued.size + data.length > 32768) return;
      const current = epoch,
        queue = queued;
      queue.size += data.length;
      tail = tail
        .then(async () => {
          if (disposed || current !== epoch || !ready()) return;
          if ((await acquire()) && current === epoch && ready())
            send({ type: "input", data });
        })
        .catch(error)
        .finally(() => {
          queue.size -= data.length;
        });
      return tail;
    },
    reset() {
      owned = false;
      epoch++;
      pending = null;
      queued = { size: 0 };
      tail = Promise.resolve();
    },
    dispose() {
      disposed = true;
      epoch++;
    },
  };
}

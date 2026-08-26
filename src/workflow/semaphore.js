// Bullswarm workflow Semaphore — a counting semaphore with async waiters.
//
// Used as the global concurrency cap across all in-flight dispatches inside
// a single workflow run. Per-fanout worker pools must `acquire()` before
// running a dispatch and `release()` in a `finally` so a thrown error never
// leaks a permit.
//
// Public API:
//   const sem = new Semaphore(4);
//   await sem.acquire();
//   try { ... } finally { sem.release(); }
//   sem.runWith(fn)   — convenience wrapper that handles the try/finally.
//
// The "blocked" UX event is emitted by the caller when the queue depth
// grows (not from inside the semaphore itself, which has no UI dependency).

export class Semaphore {
  #permits;
  #waiters = [];

  constructor(permits) {
    const n = Math.max(1, Math.floor(Number(permits) || 1));
    this.#permits = n;
  }

  get permits() { return this.#permits; }
  get available() { return this.#permits; }
  get queueDepth() { return this.#waiters.length; }

  acquire() {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release() {
    const next = this.#waiters.shift();
    if (next) {
      // Hand the permit directly to the next waiter; available stays at 0.
      next();
    } else {
      this.#permits += 1;
    }
  }

  async runWith(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

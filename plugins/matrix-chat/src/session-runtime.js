export function sessionEndedError() {
  return new DOMException('The Matrix session has changed.', 'AbortError');
}

/** Owns everything whose lifetime is one account connection. */
export class SessionRuntime {
  constructor(client) {
    this.client = client;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.cleanups = new Set();
    this.resources = new Map();
  }
  assertCurrent() {
    if (this.signal.aborted) throw sessionEndedError();
  }
  listen(event, listener) {
    const guarded = (...args) => {
      if (!this.signal.aborted) listener(...args);
    };
    this.client.on(event, guarded);
    const off = () => this.client.removeListener(event, guarded);
    this.cleanups.add(off);
    return off;
  }
  dispose() {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    for (const resource of this.resources.values()) resource.clear?.();
    this.resources.clear();
    this.client.stopClient();
  }
}

/**
 * Serialize initialization; a newer intent immediately retires old work.
 * Retiring work doesn't wait for the work it retires (a stalled start of
 * one account would hold up switching to another): that stops at its next
 * check and can't take over. Work on one account's store still runs one
 * after another (claim()).
 */
export class SessionCoordinator {
  constructor() {
    this.generation = 0;
    this.current = null;
    this.tail = Promise.resolve();
    this.claims = new Map(); // store key -> settles when the work holding it has
  }
  clear() {
    this.generation++;
    this.current?.dispose();
    this.current = null;
    // Nothing before this is waited for any more (a sign-in after logging
    // out of a stuck start); it stops at its next check.
    this.tail = Promise.resolve();
  }
  require() {
    if (!this.current) throw new Error('matrix-chat: no active client');
    this.current.assertCurrent();
    return this.current;
  }
  run(work, { retire = true } = {}) {
    if (retire) this.clear();
    else this.generation++;
    const generation = this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation) throw sessionEndedError();
    };
    let settled;
    const done = new Promise(resolve => { settled = resolve; });
    // A sign-in alongside the current account (retire: false) still waits
    // its turn; retiring work starts now.
    const result = (retire ? Promise.resolve() : this.tail).then(async () => {
      assertCurrent();
      const value = await work({
        assertCurrent,
        attach: client => {
          assertCurrent();
          this.current?.dispose();
          return (this.current = new SessionRuntime(client));
        },
        // Wait for earlier work on this store (an account's encryption
        // database), and hold it until this work settles.
        claim: async key => {
          const before = this.claims.get(key) || Promise.resolve();
          this.claims.set(key, done);
          done.then(() => { if (this.claims.get(key) === done) this.claims.delete(key); });
          await before;
          assertCurrent();
        },
      });
      assertCurrent();
      return value;
    });
    result.then(settled, settled);
    this.tail = result.catch(() => {});
    return result;
  }
}

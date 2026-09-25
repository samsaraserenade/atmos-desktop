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

/** Serialize initialization; a newer intent immediately retires old work. */
export class SessionCoordinator {
  constructor() {
    this.generation = 0;
    this.current = null;
    this.tail = Promise.resolve();
  }
  clear() {
    this.generation++;
    this.current?.dispose();
    this.current = null;
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
    const result = this.tail.then(async () => {
      assertCurrent();
      const value = await work({
        assertCurrent,
        attach: client => {
          assertCurrent();
          this.current?.dispose();
          return (this.current = new SessionRuntime(client));
        },
      });
      assertCurrent();
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

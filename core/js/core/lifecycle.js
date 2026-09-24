import { createEventScope } from './events.js';
import { CORE_API_VERSION, hasCapability, listCapabilities } from './capabilities.js';

/**
 * Build a disposable resource scope for a mounted contribution. Existing
 * lifecycle signatures stay valid; registries pass `context` as an additive
 * final argument. New plugins can avoid hand-written listener/timer teardown.
 */
export function createLifecycleScope(id, surface, additions = {}) {
  const controller = new AbortController();
  const cleanups = new Set();
  let disposed = false;

  const onCleanup = fn => {
    if (typeof fn !== 'function') throw new TypeError('lifecycle: cleanup must be a function');
    if (disposed) { fn(); return () => {}; }
    cleanups.add(fn);
    return () => cleanups.delete(fn);
  };

  // Registry-specific additions stay convenient, but the core-owned fields
  // below always win so extensions cannot replace cancellation or cleanup.
  const context = Object.freeze({
    ...additions,
    id,
    surface,
    signal: controller.signal,
    apiVersion: CORE_API_VERSION,
    capabilities: Object.freeze({ has: hasCapability, list: listCapabilities }),
    events: createEventScope(id, { signal: controller.signal }),
    onCleanup,
    listen(target, type, handler, options = {}) {
      if (!target?.addEventListener) throw new TypeError('lifecycle: target is not an EventTarget');
      target.addEventListener(type, handler, options);
      return onCleanup(() => target.removeEventListener(type, handler, options));
    },
    setTimeout(fn, delay, ...args) {
      const handle = globalThis.setTimeout(fn, delay, ...args);
      onCleanup(() => globalThis.clearTimeout(handle));
      return handle;
    },
    setInterval(fn, delay, ...args) {
      const handle = globalThis.setInterval(fn, delay, ...args);
      onCleanup(() => globalThis.clearInterval(handle));
      return handle;
    },
    requestAnimationFrame(fn) {
      const handle = globalThis.requestAnimationFrame(fn);
      onCleanup(() => globalThis.cancelAnimationFrame(handle));
      return handle;
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const cleanup of [...cleanups].reverse()) {
      try { cleanup(); } catch (error) { console.error(`[lifecycle] cleanup failed for ${surface} '${id}':`, error); }
    }
    cleanups.clear();
  }

  return { context, dispose };
}



const listeners = new Map(); // event name → Set<fn>

function _assertEvent(event) {
  if (typeof event !== 'string' || !event.trim()) throw new TypeError('events: event must be a non-empty string');
}

/**
 * Subscribe to an event.
 * Returns an unsubscribe function.
 */
export function on(event, fn, { signal } = {}) {
  _assertEvent(event);
  if (typeof fn !== 'function') throw new TypeError('events: listener must be a function');
  if (signal?.aborted) return () => {};
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  const unsubscribe = () => {
    off(event, fn);
    signal?.removeEventListener?.('abort', unsubscribe);
  };
  signal?.addEventListener?.('abort', unsubscribe, { once: true });
  return unsubscribe;
}

/** Subscribe for one emission, with the same optional AbortSignal support. */
export function once(event, fn, options) {
  let unsubscribe = () => {};
  unsubscribe = on(event, payload => { unsubscribe(); fn(payload); }, options);
  return unsubscribe;
}

/** Unsubscribe a previously-registered handler. */
export function off(event, fn) {
  const set = listeners.get(event);
  set?.delete(fn);
  if (set?.size === 0) listeners.delete(event);
}

/** Emit an event to all current subscribers. Errors in one handler don't block others. */
export function emit(event, payload) {
  _assertEvent(event);
  [...(listeners.get(event) || [])].forEach(fn => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[events] handler for "${event}" threw:`, err);
    }
  });
}

/**
 * Create a collision-free event facade for one extension or subsystem.
 * Names are stored as `<namespace>:<event>`; consumers never construct the
 * prefix themselves, and lifecycle scopes can supply a shared signal.
 */
export function createEventScope(namespace, { signal } = {}) {
  _assertEvent(namespace);
  const name = event => { _assertEvent(event); return `${namespace}:${event}`; };
  return Object.freeze({
    on:   (event, fn, options = {}) => on(name(event), fn, { ...options, signal: options.signal ?? signal }),
    once: (event, fn, options = {}) => once(name(event), fn, { ...options, signal: options.signal ?? signal }),
    off:  (event, fn) => off(name(event), fn),
    emit: (event, payload) => emit(name(event), payload),
  });
}

export function listenerCount(event) { return listeners.get(event)?.size ?? 0; }

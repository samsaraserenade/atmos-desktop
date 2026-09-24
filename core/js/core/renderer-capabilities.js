/** Runtime capability exchange for independently installed renderer extensions. */

const providers = new Map(); // name -> { owner, value }
const listeners = new Map(); // name -> Set<fn>

function assertName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
    throw new TypeError('renderer-capabilities: name must be lowercase letters, numbers, dots, or hyphens');
  }
}

function notify(name, value) {
  for (const listener of [...(listeners.get(name) || [])]) {
    try { listener(value); }
    catch (error) { console.error(`[renderer-capabilities] listener for '${name}' failed:`, error); }
  }
}

/** Publish an optional renderer API. Returns an idempotent revocation function. */
export function provideCapability(name, value, { owner } = {}) {
  assertName(name);
  if (value == null) throw new TypeError('renderer-capabilities: value is required');
  if (providers.has(name)) {
    throw new Error(`renderer-capabilities: '${name}' is already provided by '${providers.get(name).owner}'`);
  }
  const entry = { owner: owner || 'anonymous', value };
  providers.set(name, entry);
  notify(name, value);
  let active = true;
  return () => {
    if (!active || providers.get(name) !== entry) return;
    active = false;
    providers.delete(name);
    notify(name, null);
  };
}

/** Read an optional renderer API. Missing providers intentionally return null. */
export function getCapability(name) {
  assertName(name);
  return providers.get(name)?.value ?? null;
}

/** Observe provider installation/removal, with the current value delivered immediately. */
export function onCapabilityChange(name, listener, { signal, immediate = true } = {}) {
  assertName(name);
  if (typeof listener !== 'function') throw new TypeError('renderer-capabilities: listener must be a function');
  if (signal?.aborted) return () => {};
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(listener);
  const unsubscribe = () => {
    listeners.get(name)?.delete(listener);
    if (listeners.get(name)?.size === 0) listeners.delete(name);
    signal?.removeEventListener?.('abort', unsubscribe);
  };
  signal?.addEventListener?.('abort', unsubscribe, { once: true });
  if (immediate) listener(getCapability(name));
  return unsubscribe;
}

export function listProvidedCapabilities() {
  return [...providers.entries()].map(([name, entry]) => ({ name, owner: entry.owner }));
}

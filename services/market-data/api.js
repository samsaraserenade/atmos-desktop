/**
 * Market-data client: a library (ATMOS_CORE_INTEGRATION.md § 19). It runs
 * in the consumer's document and reaches this service's main process only
 * through the route the consumer passes to setBridge():
 *
 *   // From a frame (declare "invokes": ["service:market-data"]):
 *   market.setBridge({
 *     invoke: (channel, ...args) => atmos.invoke('service:market-data', channel, ...args),
 *     listen: (channel, fn) => atmos.listen('service:market-data', channel, fn),
 *   });
 *
 * From the Atmos page, pass Core's extension bridge the same way.
 */

const listeners = new Map();
const subscriptions = new Map();
let removeBridgeListener = null;
let nextId = 0;
let bridge = null;

/** Route this module's main-process calls: { invoke(channel, ...args), listen(channel, fn) → unsubscribe }. */
export function setBridge(value) {
  if (typeof value?.invoke !== 'function' || typeof value?.listen !== 'function') {
    throw new TypeError('market-data: setBridge needs { invoke, listen }');
  }
  bridge = value;
}

function assertBridge() {
  if (!bridge) throw new Error('market-data: no route to the main process; call setBridge()');
}

function ensureBridgeListener() {
  if (removeBridgeListener) return;
  assertBridge();
  removeBridgeListener = bridge.listen('event', envelope => {
    const subscription = subscriptions.get(envelope.subscriptionId);
    try { subscription?.listener?.(envelope); } catch (error) { console.error('[market-data] subscription listener failed:', error); }
    for (const listener of listeners.get(envelope.event) || []) {
      try { listener(envelope.payload, envelope); } catch (error) { console.error(`[market-data] ${envelope.event} listener failed:`, error); }
    }
  });
}

function releaseBridgeListenerIfIdle() {
  if (subscriptions.size || [...listeners.values()].some(set => set.size)) return;
  removeBridgeListener?.();
  removeBridgeListener = null;
}

export async function subscribe(symbol, options = {}, listener) {
  ensureBridgeListener();
  const subscriptionId = `market-${Date.now().toString(36)}-${(++nextId).toString(36)}`;
  subscriptions.set(subscriptionId, { listener });
  let result;
  try {
    result = await bridge.invoke('subscribe', { subscriptionId, symbol, options });
  } catch (error) {
    subscriptions.delete(subscriptionId);
    releaseBridgeListenerIfIdle();
    throw error;
  }
  let active = true;
  return Object.freeze({
    ...result,
    subscriptionId,
    async unsubscribe() {
      if (!active) return false;
      active = false;
      subscriptions.delete(subscriptionId);
      const removed = await bridge.invoke('unsubscribe', subscriptionId);
      releaseBridgeListenerIfIdle();
      return removed;
    },
  });
}

export function on(event, listener, { signal } = {}) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  ensureBridgeListener();
  const eventName = event.startsWith('market-data:') ? event : `market-data:${event}`;
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(listener);
  const unsubscribe = () => {
    listeners.get(eventName)?.delete(listener);
    if (!listeners.get(eventName)?.size) listeners.delete(eventName);
    signal?.removeEventListener?.('abort', unsubscribe);
    releaseBridgeListenerIfIdle();
  };
  if (signal?.aborted) unsubscribe();
  else signal?.addEventListener?.('abort', unsubscribe, { once: true });
  return unsubscribe;
}

const call = (channel, ...args) => { assertBridge(); return bridge.invoke(channel, ...args); };
export const getStatus = () => call('status');
export const getSnapshot = (symbol, options = {}) => call('snapshot', { symbol, options });
export const getHistory = (symbol, options = {}) => call('history', { symbol, options });
export const getProviders = () => call('providers');

export const market = Object.freeze({ setBridge, subscribe, on, getStatus, getSnapshot, getHistory, getProviders });
export default market;

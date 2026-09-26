/**
 * Where Charting keeps shared chart preferences and named charts' view
 * state: storage the consumer hands in. Charting is a library (see
 * ATMOS_CORE_INTEGRATION.md § 19), so it never picks a store itself.
 * Until a consumer calls configureChartStorage(), everything stays in
 * memory for the life of the document.
 *
 *   configureChartStorage({
 *     get: key => string | null,        // synchronous
 *     set: (key, value: string) => {},
 *   });
 *
 * Keys are 'charting-settings:v1' and 'charting-instance:<stateKey>'.
 */

let store = null;
const listeners = new Set();

export function configureChartStorage(value) {
  if (value !== null && (typeof value?.get !== 'function' || typeof value?.set !== 'function')) {
    throw new TypeError('configureChartStorage needs { get(key), set(key, value) } or null');
  }
  if (value === store) return;
  store = value;
  for (const listener of [...listeners]) listener();
}

/** Called when a consumer configures storage (preferences reload then). */
export function onChartStorageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readStored(key) {
  if (!store) return null;
  try {
    const raw = store.get(key);
    return raw == null ? null : JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

export function writeStored(key, value) {
  if (!store) return;
  try { store.set(key, JSON.stringify(value)); } catch (_error) { /* in-memory state still applies */ }
}

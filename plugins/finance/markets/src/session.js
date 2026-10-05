let pendingQuery = null;
let pendingInterval = null;
const listeners = new Set();

/**
 * The main market chart's next query (a watchlist symbol, rev/chart), and
 * with `interval` a timeframe asked for with it. A chart showing runs it at
 * once; one still to open takes both as it mounts.
 */
export function queueMarketQuery(query, { interval = null } = {}) {
  const value = String(query || '').trim() || 'BTCUSDT overview';
  // A chart showing takes it now; it's kept for the next one only otherwise.
  pendingQuery = listeners.size ? null : value;
  pendingInterval = listeners.size ? null : interval || null;
  for (const listener of [...listeners]) listener(value, interval || null);
}

export function consumePendingQuery(fallback) {
  const value = pendingQuery || fallback;
  pendingQuery = null;
  return value;
}

/** The timeframe queued with the query, once. */
export function consumePendingInterval() {
  const value = pendingInterval;
  pendingInterval = null;
  return value;
}

export function onMarketQuery(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

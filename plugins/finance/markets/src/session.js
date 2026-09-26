let pendingQuery = null;
const listeners = new Set();

export function queueMarketQuery(query) {
  pendingQuery = String(query || '').trim() || 'BTCUSDT overview';
  for (const listener of [...listeners]) listener(pendingQuery);
}

export function consumePendingQuery(fallback) {
  const value = pendingQuery || fallback;
  pendingQuery = null;
  return value;
}

export function onMarketQuery(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

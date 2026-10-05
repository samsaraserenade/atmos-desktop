/**
 * Market symbols as Finance's charts take them, shared by the query engine
 * (query-engine.js) and the rev/ commands (../../src/commands.js). Nothing
 * here loads Charting, so both can use it before the chart service is up.
 */
export const KNOWN_EXCHANGES = Object.freeze(['binance', 'bybit', 'kraken', 'coinbase']);

/** "btc" → "BTCUSDT", "eth/usdt" → "ETHUSDT"; longer names or with digits as they are ("1INCH"); null for nothing. */
export function normalizeSymbol(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  if (/^[A-Z]{2,6}$/.test(compact) && !['USD', 'USDT', 'USDC', 'EUR', 'GBP'].includes(compact)) return `${compact}USDT`;
  return compact;
}

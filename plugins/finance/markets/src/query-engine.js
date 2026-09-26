export { parseIntervalMs, formatIntervalMs } from '../../src/chart-service.js';
// Keep this module on the plugin protocol's supported `.js` module route.
const KNOWN_EXCHANGES = Object.freeze(['binance', 'bybit', 'kraken', 'coinbase']);
const INTENTS = Object.freeze(['overview', 'price', 'trades', 'orderbook', 'liquidations', 'candles', 'analytics', 'providers', 'raw']);
function normalizeSymbol(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  if (/^[A-Z]{2,6}$/.test(compact) && !['USD', 'USDT', 'USDC', 'EUR', 'GBP'].includes(compact)) return `${compact}USDT`;
  return compact;
}

export function parseMarketQuery(input, fallbackSymbol = 'BTCUSDT') {
  const raw = String(input || '').trim();
  const lower = raw.toLowerCase();
  const exchanges = KNOWN_EXCHANGES.filter(exchange => new RegExp(`\\b${exchange}\\b`, 'i').test(raw));
  const interval = lower.match(/\b(1m|5m|15m|30m|1h|4h|1d)\b/)?.[1] || '1m';
  let intent = 'overview';
  if (/\b(raw|json|snapshot)\b/.test(lower)) intent = 'raw';
  else if (/\b(provider|connection|health|status)\b/.test(lower)) intent = 'providers';
  else if (/\b(liq|liquidation)s?\b/.test(lower)) intent = 'liquidations';
  else if (/\b(order ?book|depth|spread|imbalance|bid|ask)s?\b/.test(lower)) intent = 'orderbook';
  else if (/\b(candle|ohlc|heiken|chart)s?\b/.test(lower)) intent = 'candles';
  else if (/\b(cvd|delta|volume|flow|analytics?)\b/.test(lower)) intent = 'analytics';
  else if (/\b(trade|tape|prints?)s?\b/.test(lower)) intent = 'trades';
  else if (/\b(price|quote|last)\b/.test(lower)) intent = 'price';

  const ignored = new Set([
    ...INTENTS, ...KNOWN_EXCHANGES,
    'market', 'show', 'get', 'for', 'on', 'from', 'the', 'me', 'of', interval,
    'provider', 'connection', 'health', 'status', 'order', 'book', 'depth',
    'spread', 'imbalance', 'bid', 'ask', 'candle', 'ohlc', 'heiken', 'chart',
    'trade', 'tape', 'print', 'liq', 'liquidation', 'cvd', 'delta', 'volume',
    'flow', 'analytic', 'analytics', 'price', 'quote', 'last', 'snapshot', 'json',
  ]);
  const candidates = raw.toUpperCase().match(/\b[A-Z0-9][A-Z0-9/._-]{1,14}\b/g) || [];
  const token = candidates.find(value => !ignored.has(value.toLowerCase()) && !/^\d+[MHD]$/.test(value));
  return Object.freeze({
    raw,
    intent,
    symbol: normalizeSymbol(token || fallbackSymbol),
    interval,
    exchanges: exchanges.length ? exchanges : null,
  });
}

/**
 * A short label for a chart query: "BTC", or "BTC · Coinbase" when the query
 * names exchanges. Remembered queries ("BTCUSDT coinbase 1m candles") carry
 * words the label doesn't need.
 */
export function chartLabel(query) {
  const parsed = parseMarketQuery(query);
  if (!parsed.symbol) return '—';
  const base = parsed.symbol.replace(/USDT$/, '') || parsed.symbol;
  const names = (parsed.exchanges || []).map(exchange => exchange[0].toUpperCase() + exchange.slice(1));
  return names.length ? `${base} · ${names.join(', ')}` : base;
}

const finite = value => Number.isFinite(Number(value));

export function formatPrice(value) {
  if (!finite(value)) return '—';
  const number = Number(value);
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: number >= 1_000 ? 2 : number >= 1 ? 4 : 8,
  }).format(number);
}

export { KNOWN_EXCHANGES };

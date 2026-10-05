'use strict';

const { toCoinbase } = require('./exchanges/coinbase');
const { toKraken } = require('./exchanges/kraken');
const { CALENDAR_MONTHS, DAY_MS, bucketEnd } = require('./bucket-time');

const INTERVALS = Object.freeze({
  '1m': { ms: 60_000, binance: '1m', bybit: '1', coinbase: 60, kraken: 1 },
  '3m': { ms: 180_000, binance: '3m', bybit: '3' },
  '5m': { ms: 300_000, binance: '5m', bybit: '5', coinbase: 300, kraken: 5 },
  '15m': { ms: 900_000, binance: '15m', bybit: '15', coinbase: 900, kraken: 15 },
  '30m': { ms: 1_800_000, binance: '30m', bybit: '30', kraken: 30 },
  '1h': { ms: 3_600_000, binance: '1h', bybit: '60', coinbase: 3600, kraken: 60 },
  '2h': { ms: 7_200_000, binance: '2h', bybit: '120' },
  '4h': { ms: 14_400_000, binance: '4h', bybit: '240', kraken: 240 },
  '6h': { ms: 21_600_000, binance: '6h', bybit: '360', coinbase: 21600 },
  '8h': { ms: 28_800_000, binance: '8h' },
  '12h': { ms: 43_200_000, binance: '12h', bybit: '720' },
  '1d': { ms: 86_400_000, binance: '1d', bybit: 'D', coinbase: 86400, kraken: 1440 },
  '3d': { ms: 3 * DAY_MS, binance: '3d' },
  // Weeks open on Monday, months on the 1st (bucket-time.js). Kraken's
  // weekly candles are left out: they open on Thursday.
  '1w': { ms: 7 * DAY_MS, binance: '1w', bybit: 'W' },
  '1mo': { ms: 30 * DAY_MS, binance: '1M', bybit: 'M' },
  // No exchange serves these: they're fetched as the longest candle above
  // that fits into them evenly (2W as weeks, 3M as months, 10m as 5m...),
  // for the chart to merge.
  '10m': { ms: 600_000 },
  '2d': { ms: 2 * DAY_MS },
  '5d': { ms: 5 * DAY_MS },
  '2w': { ms: 14 * DAY_MS },
  '3mo': { ms: 90 * DAY_MS },
  '6mo': { ms: 180 * DAY_MS },
  '1y': { ms: 365 * DAY_MS },
});

// Exchanges with REST history, in the order getHistory() prefers them when
// the caller doesn't name one. Binance and Bybit refuse some regions (the
// US among them); Coinbase and Kraken are the fallbacks.
const HISTORY_EXCHANGES = Object.freeze(['binance', 'bybit', 'coinbase', 'kraken']);

// A cheap unauthenticated request per exchange that some regions are refused
// (HTTP 451 from Binance, 403 from Bybit). Used to tell a region block from
// an ordinary outage when a WebSocket fails before opening.
const REGION_PROBES = Object.freeze({
  binance: 'https://fapi.binance.com/fapi/v1/ping',
  bybit: 'https://api.bybit.com/v5/market/time',
});

function isRegionBlock(status) { return status === 451 || status === 403; }

/** Whether the exchange serves candles of exactly this interval. */
function supportsInterval(exchange, interval) {
  return Boolean(INTERVALS[interval]?.[exchange]);
}

const anchorOf = ms => (ms % (7 * DAY_MS) === 0 ? 4 * DAY_MS : ms === 3 * DAY_MS ? DAY_MS : 0);

/** Whether every `target` candle is made of whole `base` candles. */
function fitsInto(base, target) {
  const baseMonths = CALENDAR_MONTHS[base.ms];
  const targetMonths = CALENDAR_MONTHS[target.ms];
  if (targetMonths) return baseMonths ? targetMonths % baseMonths === 0 : DAY_MS % base.ms === 0 && anchorOf(base.ms) === 0;
  if (baseMonths) return false;
  return target.ms % base.ms === 0 && (anchorOf(target.ms) - anchorOf(base.ms)) % base.ms === 0;
}

/**
 * The interval to fetch from an exchange for a chart of `interval`: that
 * one when the exchange serves it, otherwise the longest one it serves that
 * fits into it evenly. null when there's none.
 */
function fetchIntervalFor(exchange, interval) {
  const target = INTERVALS[interval];
  if (!target) return null;
  if (target[exchange]) return interval;
  let best = null;
  for (const [key, value] of Object.entries(INTERVALS)) {
    if (value[exchange] && value.ms < target.ms && fitsInto(value, target) && (!best || value.ms > INTERVALS[best].ms)) best = key;
  }
  return best;
}

function normalizeSymbol(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) throw new TypeError('market symbol cannot be empty');
  return normalized;
}

// A name, or milliseconds. A length with no name of its own (a chart's
// custom 45m, say) gets the longest named one that fits into it evenly (15m),
// for the chart to merge; one nothing fits into, 5m.
function resolveInterval(options = {}) {
  if (INTERVALS[options.interval]) return options.interval;
  const intervalMs = Number(options.intervalMs);
  const exact = Object.entries(INTERVALS).find(([, value]) => value.ms === intervalMs)?.[0];
  if (exact) return exact;
  if (!(intervalMs > 0)) return '5m';
  const fitting = Object.entries(INTERVALS).filter(([, value]) => fitsInto(value, { ms: intervalMs }))
    .sort(([, a], [, b]) => b.ms - a.ms)[0];
  return fitting?.[0] || '5m';
}

function finite(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`invalid historical candle ${field}`);
  return result;
}

function normalizeCandle(row, intervalMs) {
  const start = finite(row[0], 'start');
  return Object.freeze({
    start, end: bucketEnd(start, intervalMs),
    open: finite(row[1], 'open'), high: finite(row[2], 'high'),
    low: finite(row[3], 'low'), close: finite(row[4], 'close'),
    volume: finite(row[5], 'volume'),
  });
}

async function fetchJson(fetchImpl, url) {
  if (typeof fetchImpl !== 'function') throw new Error('Historical market data requires fetch support.');
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response?.ok) {
    const error = new Error(`Historical market data request failed (${response?.status || 'network error'}).`);
    if (response?.status) error.status = response.status;
    throw error;
  }
  return response.json();
}

// `exact: true` refuses to fetch a shorter interval than the one asked for
// (market-data's own backfill files candles under the interval it asked).
// Otherwise the result's `interval`/`intervalMs` say what was fetched, and
// `requestedInterval`/`requestedIntervalMs` what was asked for.
async function getMarketHistory(symbol, options = {}, fetchImpl = globalThis.fetch) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const requestedInterval = resolveInterval(options);
  // What was asked for: a name's length, or the length given (a custom one
  // resolves to a shorter name, which `exact` doesn't accept).
  const askedMs = INTERVALS[options.interval]?.ms ?? (Number(options.intervalMs) > 0 ? Number(options.intervalMs) : INTERVALS[requestedInterval].ms);
  const limit = Math.max(2, Math.min(1_000, Math.floor(Number(options.limit) || 500)));
  const requested = Array.isArray(options.exchanges) ? options.exchanges.map(value => String(value).toLowerCase()) : [];
  const exchange = String(options.exchange || HISTORY_EXCHANGES.find(id => requested.includes(id)) || 'binance').toLowerCase();
  const interval = options.exact
    ? (supportsInterval(exchange, requestedInterval) && INTERVALS[requestedInterval].ms === askedMs ? requestedInterval : null)
    : fetchIntervalFor(exchange, requestedInterval);
  if (!interval && HISTORY_EXCHANGES.includes(exchange)) throw new Error(`Historical candles are unavailable for ${exchange} at ${options.exact && INTERVALS[requestedInterval].ms !== askedMs ? `${askedMs} ms` : requestedInterval}.`);
  const intervalMs = INTERVALS[interval]?.ms;
  let rows;

  if (exchange === 'bybit') {
    const url = new URL('https://api.bybit.com/v5/market/kline');
    url.searchParams.set('category', 'linear');
    url.searchParams.set('symbol', normalizedSymbol);
    url.searchParams.set('interval', INTERVALS[interval].bybit);
    url.searchParams.set('limit', String(limit));
    const payload = await fetchJson(fetchImpl, url);
    if (Number(payload?.retCode) !== 0 || !Array.isArray(payload?.result?.list)) throw new Error(payload?.retMsg || 'Bybit returned invalid historical data.');
    rows = payload.result.list;
  } else if (exchange === 'binance') {
    const url = new URL('https://fapi.binance.com/fapi/v1/klines');
    url.searchParams.set('symbol', normalizedSymbol);
    url.searchParams.set('interval', INTERVALS[interval].binance);
    url.searchParams.set('limit', String(limit));
    rows = await fetchJson(fetchImpl, url);
    if (!Array.isArray(rows)) throw new Error('Binance returned invalid historical data.');
  } else if (exchange === 'coinbase') {
    // Coinbase serves 1m, 5m, 15m, 1h, 6h and 1d, at most 300 bars, newest
    // first, as [time (s), low, high, open, close, volume].
    // Candles fetched for a chart to merge (daily ones for 1W or 1M) come
    // in up to four pages, going back, so long timeframes get more than a
    // few candles.
    const granularity = INTERVALS[interval].coinbase;
    if (!granularity) throw new Error(`Historical candles are unavailable for coinbase at ${interval}.`);
    const pages = interval === requestedInterval ? 1 : Math.min(4, Math.ceil(limit / 300));
    const pageMs = 299 * granularity * 1000;
    const byTime = new Map();
    let end = Math.floor(Number(options.now ?? Date.now()) / (granularity * 1000)) * granularity * 1000 + granularity * 1000;
    for (let page = 0; page < pages; page += 1, end -= pageMs) {
      const url = new URL(`https://api.exchange.coinbase.com/products/${toCoinbase(normalizedSymbol)}/candles`);
      url.searchParams.set('granularity', String(granularity));
      if (pages > 1) {
        url.searchParams.set('start', new Date(end - pageMs).toISOString());
        url.searchParams.set('end', new Date(end).toISOString());
      }
      const payload = await fetchJson(fetchImpl, url);
      if (!Array.isArray(payload)) throw new Error(payload?.message || 'Coinbase returned invalid historical data.');
      for (const [time, low, high, open, close, volume] of payload) byTime.set(Number(time) * 1000, [Number(time) * 1000, open, high, low, close, volume]);
      if (!payload.length) break; // nothing older
    }
    rows = [...byTime.values()];
  } else if (exchange === 'kraken') {
    // Kraken spot OHLC: up to 720 bars as [time (s), open, high, low, close,
    // vwap, volume, count], keyed by Kraken's own pair name (XXBTZUSD).
    const minutes = INTERVALS[interval].kraken;
    if (!minutes) throw new Error(`Historical candles are unavailable for kraken at ${interval}.`);
    const url = new URL('https://api.kraken.com/0/public/OHLC');
    url.searchParams.set('pair', toKraken(normalizedSymbol).replace('/', '').replace(/^BTC/, 'XBT'));
    url.searchParams.set('interval', String(minutes));
    const payload = await fetchJson(fetchImpl, url);
    if (payload?.error?.length) throw new Error(`Kraken: ${payload.error.join(', ')}`);
    const key = Object.keys(payload?.result || {}).find(name => name !== 'last');
    if (!key || !Array.isArray(payload.result[key])) throw new Error('Kraken returned invalid historical data.');
    rows = payload.result[key].map(([time, open, high, low, close, , volume]) => [Number(time) * 1000, open, high, low, close, volume]);
  } else {
    throw new Error(`Historical candles are unavailable for ${exchange}.`);
  }

  const candles = rows.map(row => normalizeCandle(row, intervalMs)).sort((a, b) => a.start - b.start).slice(-limit);
  return Object.freeze({
    symbol: normalizedSymbol, exchange, interval, intervalMs,
    requestedInterval, requestedIntervalMs: askedMs,
    candles: Object.freeze(candles),
  });
}

module.exports = { getMarketHistory, resolveInterval, supportsInterval, fetchIntervalFor, isRegionBlock, INTERVALS, HISTORY_EXCHANGES, REGION_PROBES };

'use strict';

const { toCoinbase } = require('./exchanges/coinbase');
const { toKraken } = require('./exchanges/kraken');

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
  '12h': { ms: 43_200_000, binance: '12h', bybit: '720' },
  '1d': { ms: 86_400_000, binance: '1d', bybit: 'D', coinbase: 86400, kraken: 1440 },
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

function supportsInterval(exchange, interval) {
  return Boolean(INTERVALS[interval]?.[exchange]);
}

function normalizeSymbol(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) throw new TypeError('market symbol cannot be empty');
  return normalized;
}

function resolveInterval(options = {}) {
  if (INTERVALS[options.interval]) return options.interval;
  const intervalMs = Number(options.intervalMs);
  return Object.entries(INTERVALS).find(([, value]) => value.ms === intervalMs)?.[0] || '5m';
}

function finite(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`invalid historical candle ${field}`);
  return result;
}

function normalizeCandle(row, intervalMs) {
  const start = finite(row[0], 'start');
  return Object.freeze({
    start, end: start + intervalMs,
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

async function getMarketHistory(symbol, options = {}, fetchImpl = globalThis.fetch) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const interval = resolveInterval(options);
  const intervalMs = INTERVALS[interval].ms;
  const limit = Math.max(2, Math.min(1_000, Math.floor(Number(options.limit) || 500)));
  const requested = Array.isArray(options.exchanges) ? options.exchanges.map(value => String(value).toLowerCase()) : [];
  const exchange = String(options.exchange || HISTORY_EXCHANGES.find(id => requested.includes(id)) || 'binance').toLowerCase();
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
    const granularity = INTERVALS[interval].coinbase;
    if (!granularity) throw new Error(`Historical candles are unavailable for coinbase at ${interval}.`);
    const url = new URL(`https://api.exchange.coinbase.com/products/${toCoinbase(normalizedSymbol)}/candles`);
    url.searchParams.set('granularity', String(granularity));
    const payload = await fetchJson(fetchImpl, url);
    if (!Array.isArray(payload)) throw new Error(payload?.message || 'Coinbase returned invalid historical data.');
    rows = payload.map(([time, low, high, open, close, volume]) => [Number(time) * 1000, open, high, low, close, volume]);
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
  return Object.freeze({ symbol: normalizedSymbol, exchange, interval, intervalMs, candles: Object.freeze(candles) });
}

module.exports = { getMarketHistory, resolveInterval, supportsInterval, isRegionBlock, INTERVALS, HISTORY_EXCHANGES, REGION_PROBES };

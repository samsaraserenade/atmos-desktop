import { onStateLoaded, registerStateNamespace, save } from '../src/host/persist.js';

const DEFAULT_TICKERS = ['BTC', 'ETH'];
const objectCopy = value => value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
const CHART_DEFAULTS = Object.freeze({
  dataSource: 'history', chartType: 'candlestick', interval: '5m', customIntervalMs: null,
  timelineMode: 'gapless', bridgeEnabled: false, indicatorEnabled: true,
  followLatest: true, refreshMs: 100, activeRange: null,
});
const CHART_TYPES = new Set(['line', 'candlestick', 'heiken-ashi']);
const INTERVALS = new Set(['auto', '1m', '5m', '15m', '1h', '4h', '1d', 'custom']);
const RANGES = new Set(['1d', '1w', '1m', 'ytd', 'all']);

function normalizeChartSettings(value = {}) {
  const chart = objectCopy(value);
  const customIntervalMs = Number(chart.customIntervalMs);
  const refreshMs = Number(chart.refreshMs);
  const interval = INTERVALS.has(chart.interval) && (chart.interval !== 'custom' || (Number.isFinite(customIntervalMs) && customIntervalMs >= 1_000))
    ? chart.interval
    : CHART_DEFAULTS.interval;
  return {
    dataSource: chart.dataSource === 'live' ? 'live' : CHART_DEFAULTS.dataSource,
    chartType: CHART_TYPES.has(chart.chartType) ? chart.chartType : CHART_DEFAULTS.chartType,
    interval,
    customIntervalMs: Number.isFinite(customIntervalMs) && customIntervalMs >= 1_000 ? customIntervalMs : null,
    timelineMode: chart.timelineMode === 'gaps' ? 'gaps' : CHART_DEFAULTS.timelineMode,
    bridgeEnabled: chart.bridgeEnabled === true,
    indicatorEnabled: chart.indicatorEnabled !== false,
    followLatest: chart.followLatest !== false,
    refreshMs: [0, 50, 100, 250, 500, 1_000].includes(refreshMs) ? refreshMs : CHART_DEFAULTS.refreshMs,
    activeRange: RANGES.has(chart.activeRange) ? chart.activeRange : null,
  };
}

function readLegacyWatchlistState() {
  try {
    const raw = localStorage.getItem('samsara_v4') || localStorage.getItem('samsara_v3');
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.extensionState?.watchlist) return null;
    if (!Array.isArray(saved?.tickers) && !saved?.tickerSource && !saved?.cgIdCache) return null;
    const tickers = Array.isArray(saved.tickers) && saved.tickers.length
      ? saved.tickers.map(value => String(value).trim().toUpperCase()).filter(Boolean)
      : [...DEFAULT_TICKERS];
    return {
      tickers,
      activeT: tickers.includes(saved.activeT) ? saved.activeT : tickers[0] || null,
      tickerSource: { ...objectCopy(saved.tickerSource), XMR: 'coingecko' },
      cgIdCache: objectCopy(saved.cgIdCache),
    };
  } catch (error) {
    console.warn('[markets] unable to read legacy watchlist state:', error);
    return null;
  }
}

function readLegacyMarketState() {
  try {
    const raw = localStorage.getItem('samsara_v4') || localStorage.getItem('samsara_v3');
    if (!raw) return null;
    const extensionState = JSON.parse(raw)?.extensionState;
    if (extensionState?.markets || !extensionState?.['market-query']) return null;
    const saved = extensionState['market-query'];
    return {
      lastQuery: String(saved.lastQuery || 'BTCUSDT overview'),
      exchanges: Array.isArray(saved.exchanges) ? [...saved.exchanges] : ['binance', 'bybit', 'kraken'],
      recentQueries: Array.isArray(saved.recentQueries) ? [...saved.recentQueries] : [],
    };
  } catch (error) {
    console.warn('[markets] unable to read legacy market state:', error);
    return null;
  }
}

const legacyMarketState = readLegacyMarketState();
export const marketQueryState = registerStateNamespace('markets', {
  version: 2,
  defaults: {
    lastQuery: 'BTCUSDT overview',
    exchanges: ['binance', 'bybit', 'kraken'],
    recentQueries: [],
    chart: { ...CHART_DEFAULTS },
    ...(legacyMarketState || {}),
  },
  migrate(data, fromVersion) {
    if (fromVersion < 2) data.chart ??= { ...CHART_DEFAULTS };
    return data;
  },
  hydrate(namespace, saved = {}) {
    namespace.lastQuery = String(saved.lastQuery || 'BTCUSDT overview');
    namespace.exchanges = Array.isArray(saved.exchanges) && saved.exchanges.length ? [...new Set(saved.exchanges)] : ['binance', 'bybit', 'kraken'];
    namespace.recentQueries = Array.isArray(saved.recentQueries) ? saved.recentQueries.map(String).slice(0, 8) : [];
    namespace.chart = normalizeChartSettings(saved.chart);
  },
});

const legacyWatchlistState = readLegacyWatchlistState();
export const watchlistState = registerStateNamespace('watchlist', {
  version: 1,
  defaults: legacyWatchlistState || {
    tickers: [...DEFAULT_TICKERS], activeT: 'BTC', tickerSource: { XMR: 'coingecko' }, cgIdCache: {},
  },
  hydrate(namespace, saved) {
    const tickers = Array.isArray(saved.tickers) && saved.tickers.length
      ? saved.tickers.map(value => String(value).trim().toUpperCase()).filter(Boolean)
      : [...DEFAULT_TICKERS];
    namespace.tickers = tickers;
    namespace.activeT = tickers.includes(saved.activeT) ? saved.activeT : tickers[0] || null;
    namespace.tickerSource = objectCopy(saved.tickerSource);
    namespace.cgIdCache = objectCopy(saved.cgIdCache);
    namespace.tickerSource.XMR = 'coingecko';
  },
});
watchlistState.tickerSource.XMR = 'coingecko';
if (legacyMarketState || legacyWatchlistState) onStateLoaded(save);

const queryListeners = new Set();
/** Called with the new query whenever the main chart's query changes. */
export function onQueryRemembered(listener) {
  queryListeners.add(listener);
  return () => queryListeners.delete(listener);
}

export function rememberQuery(query) {
  const value = String(query || '').trim();
  if (!value) return;
  const recentQueries = [
    value,
    ...marketQueryState.recentQueries.filter(item => item !== value),
  ].slice(0, 8);
  if (marketQueryState.lastQuery === value && JSON.stringify(marketQueryState.recentQueries) === JSON.stringify(recentQueries)) return;
  marketQueryState.lastQuery = value;
  marketQueryState.recentQueries = recentQueries;
  save();
  for (const listener of [...queryListeners]) listener(value);
}

export function persistChartSettings(patch = {}) {
  const next = normalizeChartSettings({ ...marketQueryState.chart, ...patch });
  if (JSON.stringify(next) === JSON.stringify(marketQueryState.chart)) return;
  marketQueryState.chart = next;
  save();
}

export function setExchanges(exchanges) {
  marketQueryState.exchanges = [...new Set(exchanges)].filter(Boolean);
  save();
}

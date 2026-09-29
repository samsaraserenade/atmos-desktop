import { onStateLoaded, registerStateNamespace, save } from '../src/host/persist.js';

const DEFAULT_TICKERS = ['BTC', 'ETH'];
const objectCopy = value => value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
const CHART_DEFAULTS = Object.freeze({
  dataSource: 'history', chartType: 'candlestick', interval: '5m', customIntervalMs: null,
  timelineMode: 'gapless', bridgeEnabled: false, indicatorEnabled: false,
  followLatest: true, refreshMs: 100, activeRange: null,
});
let chartDefaultsReset = false;
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
    indicatorEnabled: chart.indicatorEnabled === true,
    followLatest: chart.followLatest !== false,
    refreshMs: [0, 50, 100, 250, 500, 1_000].includes(refreshMs) ? refreshMs : CHART_DEFAULTS.refreshMs,
    activeRange: RANGES.has(chart.activeRange) ? chart.activeRange : null,
  };
}

export const marketQueryState = registerStateNamespace('markets', {
  version: 3,
  defaults: {
    lastQuery: 'BTCUSDT overview',
    exchanges: ['binance', 'bybit', 'kraken'],
    recentQueries: [],
    chart: { ...CHART_DEFAULTS },
  },
  migrate(data, fromVersion) {
    if (fromVersion < 2) data.chart ??= { ...CHART_DEFAULTS };
    // Version 3 turned the indicator off by default; drop the old "on".
    if (fromVersion < 3) {
      if (data.chart) delete data.chart.indicatorEnabled;
      chartDefaultsReset = true;
    }
    return data;
  },
  hydrate(namespace, saved = {}) {
    namespace.lastQuery = String(saved.lastQuery || 'BTCUSDT overview');
    namespace.exchanges = Array.isArray(saved.exchanges) && saved.exchanges.length ? [...new Set(saved.exchanges)] : ['binance', 'bybit', 'kraken'];
    namespace.recentQueries = Array.isArray(saved.recentQueries) ? saved.recentQueries.map(String).slice(0, 8) : [];
    namespace.chart = normalizeChartSettings(saved.chart);
  },
});

// Write the migrated chart settings (and the namespace version) back.
if (chartDefaultsReset) onStateLoaded(save);

export const watchlistState = registerStateNamespace('watchlist', {
  version: 1,
  defaults: {
    tickers: [...DEFAULT_TICKERS], activeT: 'BTC', tickerSource: {}, cgIdCache: {},
  },
  hydrate(namespace, saved) {
    const tickers = Array.isArray(saved.tickers) && saved.tickers.length
      ? saved.tickers.map(value => String(value).trim().toUpperCase()).filter(Boolean)
      : [...DEFAULT_TICKERS];
    namespace.tickers = tickers;
    namespace.activeT = tickers.includes(saved.activeT) ? saved.activeT : tickers[0] || null;
    namespace.tickerSource = objectCopy(saved.tickerSource);
    namespace.cgIdCache = objectCopy(saved.cgIdCache);
    // Monero used to be pinned to CoinGecko (Binance delisted it). It is
    // probed like any other symbol now: a pair Binance no longer trades
    // doesn't count (watchlist-data.js), so it still ends up elsewhere.
  },
});

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

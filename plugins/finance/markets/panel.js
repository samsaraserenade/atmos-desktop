import { useFinanceChartStorage } from '../src/chart-storage.js';
import { chartAxisOptions } from '../src/chart-axes.js';
import { bindChartResetMeasurement } from '../src/chart-reset.js';
import { CHART_INTERVALS, chartControlMarkup, formatIntervalMs, bindIntervalInput } from '../src/chart-service.js';
import { portfolioState } from '../persist.js';
import * as priceColors from '../src/host/semantic-colors.js';
import { getServiceFileUrl } from '../src/host/service-loader.js';
import { atmos } from '../src/host/frame.js';
import { marketQueryState, persistChartSettings, rememberQuery } from './persist.js';
import { parseMarketQuery, formatPrice, KNOWN_EXCHANGES } from './src/query-engine.js';
import { consumePendingQuery, onMarketQuery } from './src/session.js';
import { watchlistState } from './persist.js';
import { updateTickerActive, onTickerRemoved } from './src/watchlist-data.js';

const styleUrl = new URL('./styles.css', import.meta.url).href;
const INTERVAL_MS = Object.freeze(Object.fromEntries(CHART_INTERVALS.filter(item => item.ms != null).map(item => [item.value, item.ms])));
const MAX_POINTS = 20_000;
const historyBySymbol = new Map();
// historyBySymbol is module-scoped (spans every mount/unmount of the panel
// itself), so this eviction hook is registered once here rather than per
// mount -- a symbol dropped from the watchlist (and not held) should free
// its buffered candle/line history right away instead of sitting in memory
// until the app restarts, same as watchlist-data.js already does for its
// own tickerData/tickerSource/cgIdCache entries.
onTickerRemoved(symbol => { historyBySymbol.delete(symbol); });

async function loadServices() {
  const [marketUrl, chartUrl] = await Promise.all([
    getServiceFileUrl('market-data', 'api.js'),
    getServiceFileUrl('charting', 'api.js'),
  ]);
  if (!marketUrl) throw new Error("The 'market-data' service is not installed or enabled.");
  if (!chartUrl) throw new Error("The 'charting' service is not installed or enabled.");
  const [{ market }, charting] = await Promise.all([import(marketUrl), import(chartUrl)]);
  // Market Data's client library reaches its main process through the route we hand it.
  market.setBridge({
    invoke: (channel, ...args) => atmos.invoke('service:market-data', channel, ...args),
    listen: (channel, fn) => atmos.listen('service:market-data', channel, fn),
  });
  const { createTimeSeriesChart, lineColorForTrend } = useFinanceChartStorage(charting);
  return { market, createTimeSeriesChart, lineColorForTrend, ...priceColors };
}

export function mountMarketsPanel(contentEl, context, options = {}) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = styleUrl;
  document.head.appendChild(link);
  context.onCleanup(() => link.remove());
  contentEl.innerHTML = panelMarkup();
  mountMarketChart(contentEl, context, options);
}

function panelMarkup() {
  return `<main class="mq-market">
    <div class="mq-chart-surface"><div class="mq-chart" aria-label="Live interactive market chart"></div></div>
    <div class="mq-toolbar finance-portfolio-toolbar atmos-chart-controls" role="toolbar" aria-label="Chart options">
      <div class="finance-toolbar-scroll">
        <form class="mq-ticker-form" aria-label="Choose ticker">
          <input class="mq-ticker-input" autocomplete="off" spellcheck="false" aria-label="Ticker symbol" placeholder="BTCUSDT" maxlength="40" title="A symbol, optionally with an exchange: BTC coinbase">
        </form>
        <button type="button" class="mq-tool is-active" data-source aria-pressed="true" title="Use exchange candle history instead of a live trade stream">History</button>
        ${chartControlMarkup('timeline', { buttonClass: 'mq-tool' })}
        ${chartControlMarkup('bridge', { buttonClass: 'mq-tool' })}
        ${chartControlMarkup('scale', { buttonClass: 'mq-tool' })}
                <div class="mq-tool-group" role="group" aria-label="Chart type">${chartControlMarkup('type', { buttonClass: 'mq-tool' })}</div>
        <div class="mq-tool-group mq-timeframes" role="group" aria-label="Candle timeframe">
          ${chartControlMarkup('timeframe', { buttonClass: 'mq-tool' })}
          <form class="mq-custom-interval-form" aria-label="Custom candle timeframe">
            <input class="mq-custom-interval-input" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="8" placeholder="Custom" aria-label="Custom timeframe" title="Enter 1s, 30s, 2m, 3h, etc.">
          </form>
        </div>
        <label class="mq-refresh-control is-hidden" title="How often live trades are painted">
          <span>Refresh</span>
          <select class="mq-refresh-select" aria-label="Chart refresh rate">
            <option value="0">0ms</option>
            <option value="50">50ms</option>
            <option value="100" selected>100ms</option>
            <option value="250">250ms</option>
            <option value="500">500ms</option>
            <option value="1000">1s</option>
          </select>
        </label>
        <div class="mq-tool-group mq-ranges" role="group" aria-label="Visible range">
          ${chartControlMarkup('range', { buttonClass: 'mq-tool' })}
        </div>
      </div>
    </div>
  </main>`;
}

function mountMarketChart(root, context, mountOptions = {}) {
  const isolated = mountOptions.isolated === true;
  const persistSettings = settings => {
    if (isolated) mountOptions.onSettings?.(settings); else persistChartSettings(settings);
  };
  const remember = query => {
    if (isolated) mountOptions.onQuery?.(query); else rememberQuery(query);
  };
  // The symbol plus any exchange the user named ("BTCUSDT coinbase"), so
  // re-running the query (interval, History/Stream) keeps that exchange and
  // the ticker box shows which one the chart is drawn from.
  const queryText = () => [activeQuery.symbol, ...(activeQuery.namedExchanges || [])].join(' ');
  context.onCleanup(() => { queryGeneration++; });
  const chartHost = root.querySelector('.mq-chart');
  bindChartResetMeasurement(root.querySelector('.mq-chart-surface'), () => chart, context);
  const input = root.querySelector('.mq-ticker-input');
  const customIntervalInput = root.querySelector('.mq-custom-interval-input');
  const refreshSelect = root.querySelector('.mq-refresh-select');
  let services = null;
  let subscription = null;
  let chart = null;
  let activeQuery = null;
  const savedChart = (isolated ? mountOptions.settings : marketQueryState.chart) || {};
  let dataSource = savedChart.dataSource || 'history';
  let chartType = savedChart.chartType || 'candlestick';
  let timelineMode = savedChart.timelineMode || 'gapless';
  let bridgeEnabled = savedChart.bridgeEnabled === true;
  let priceScale = savedChart.priceScale || 'linear';
  let followLatest = savedChart.followLatest !== false;
  let activeInterval = savedChart.interval || '5m';
  let customIntervalMs = savedChart.customIntervalMs || null;
  let historicalCandles = [];
  // Deliberately NOT restoring savedChart.activeRange here -- whatever range
  // button (1D/1W/1M/All) was last active would otherwise override
  // targetCandles (see viewport.js's candleLayout: an activeRangeKey always
  // wins over candleDefaultCount) and reopen showing the full history
  // instead of the intended 250-candle default. A user's later click on a
  // range button during this session still applies and persists as before;
  // only the *next app launch* starts fresh at the candle-count default.
  let activeRange = null;
  let queryGeneration = 0;
  let stopColorListener = null;
  let currentLineColor = null;
  let refreshMs = Number.isFinite(Number(savedChart.refreshMs)) ? Number(savedChart.refreshMs) : 100;
  let updateTimer = null;
  let pendingPoints = [];
  let snapshotTimer = null;
  let snapshotInFlight = false;
  let historyExchange = null;
  let historyIntervalMs = null;
  let historyExchangeConfirmedLive = false;
  let historySnapshotTimer = null;
  let historySnapshotInFlight = false;

  context.listen(root, 'finance:refresh-chart-sizing', () => {
    chart?.resize();
  });

  const syncToolbarState = () => {
    const sourceButton = root.querySelector('[data-source]');
    sourceButton.textContent = dataSource === 'history' ? 'History' : 'Stream';
    sourceButton.classList.toggle('is-active', dataSource === 'history');
    sourceButton.setAttribute('aria-pressed', String(dataSource === 'history'));
    // Timeline/scale/bridge/chart-type/interval/range button state (is-active,
    // aria-pressed, the Gapless/Gaps and Linear/Log labels) used to be
    // re-derived here too, from this panel's own mirrored chartType/
    // activeInterval/activeRange/etc variables. All of that is chart-next.js's
    // job now -- its own internal syncToolbar() already runs automatically
    // on every settings change for a toolbar passed as options.toolbar.element
    // (.mq-toolbar, wired up in ensureChart() below), so re-deriving it a
    // second time here was pure duplicate paint work. [data-source] stays
    // here because History/Stream isn't a charting-engine concept at all.
    root.querySelector('.mq-timeframes').classList.toggle('is-hidden', chartType === 'line');
    root.querySelector('.mq-refresh-control').classList.toggle('is-hidden', dataSource === 'history');
    refreshSelect.value = String(refreshMs);
    if (activeInterval === 'custom' && customIntervalMs) customIntervalInput.value = formatIntervalMs(customIntervalMs);
    customIntervalInput.classList.toggle('is-active', activeInterval === 'custom');
  };
  syncToolbarState();

  context.onCleanup(() => subscription?.unsubscribe());
  context.onCleanup(() => chart?.destroy());
  context.onCleanup(() => stopColorListener?.());
  context.onCleanup(() => clearTimeout(updateTimer));
  context.onCleanup(() => clearTimeout(snapshotTimer));
  context.onCleanup(() => clearTimeout(historySnapshotTimer));

  const pointsForSymbol = symbol => {
    if (!historyBySymbol.has(symbol)) historyBySymbol.set(symbol, []);
    return historyBySymbol.get(symbol);
  };

  context.listen(document, 'finance:axes-change', () => chart?.setOptions(chartAxisOptions()));

  const chartData = () => {
    if (dataSource !== 'history') return activeQuery ? pointsForSymbol(activeQuery.symbol) : [];
    return historicalCandles;
  };

  const paintPendingPoints = () => {
    updateTimer = null;
    if (!pendingPoints.length) return;
    const batch = pendingPoints;
    pendingPoints = [];
    const paint = () => {
      if (chart?.appendMany) chart.appendMany(batch);
      else for (const point of batch) chart?.append(point);
      const points = chartData();
      if (services && chartType === 'line' && points.length > 1) {
        const { up, down } = services.getPriceColors();
        const nextLineColor = services.lineColorForTrend(points, { up, down }, point => point.value);
        if (nextLineColor !== currentLineColor) {
          currentLineColor = nextLineColor;
          chart?.setOptions({ lineColor: nextLineColor });
        }
      }
      };
    if (chart) chart.batch(paint);
  };

  const schedulePaint = () => {
    if (updateTimer != null) return;
    updateTimer = context.setTimeout(paintPendingPoints, refreshMs);
  };

  const clearPendingPoints = () => {
    clearTimeout(updateTimer);
    updateTimer = null;
    pendingPoints = [];
  };

  const scheduleSnapshotPoll = () => {
    if (dataSource !== 'live' || snapshotTimer != null || !services || !activeQuery) return;
    snapshotTimer = context.setTimeout(pollSnapshot, Math.max(100, refreshMs));
  };

  const pollSnapshot = async () => {
    snapshotTimer = null;
    if (!services || !activeQuery || snapshotInFlight) { scheduleSnapshotPoll(); return; }
    const generation = queryGeneration;
    const query = activeQuery;
    snapshotInFlight = true;
    try {
      const snapshot = await services.market.getSnapshot(query.symbol, { exchanges: query.exchanges });
      if (generation !== queryGeneration || query.symbol !== activeQuery?.symbol) return;
      const price = snapshot?.price;
      const time = Number(price?.timestamp);
      const value = Number(price?.value);
      const last = pointsForSymbol(query.symbol).at(-1);
      if (Number.isFinite(time) && Number.isFinite(value) && (!last || time > last.time || (time === last.time && value !== last.value))) {
        addPoint({ time, value });
      }
      root.classList.toggle('is-offline', snapshot?.status === 'stale' || snapshot?.status === 'empty');
    } catch (_error) {
      // The live subscription remains primary; a failed watchdog poll retries quietly.
    } finally {
      snapshotInFlight = false;
      scheduleSnapshotPoll();
    }
  };

  const addPoint = point => {
    if (dataSource !== 'live' || !activeQuery || !Number.isFinite(Number(point?.time)) || !Number.isFinite(Number(point?.value))) return;
    const points = pointsForSymbol(activeQuery.symbol);
    const normalized = { time: Number(point.time), value: Number(point.value) };
    const last = points.at(-1);
    if (last && last.time === normalized.time && last.value === normalized.value) return;
    points.push(normalized);
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    pendingPoints.push(normalized);
    schedulePaint();
  };

  const ensureChart = () => {
    if (!services || !activeQuery) return;
    const { up, down } = services.getPriceColors();
    const nextData = chartData();
    const lineColor = services.lineColorForTrend(nextData, { up, down }, item => item.value ?? item.close);
    currentLineColor = lineColor;
    const options = {
      type: chartType,
      bucketMs: activeInterval === 'auto' ? null : (activeInterval === 'custom' ? customIntervalMs : INTERVAL_MS[activeInterval]),
      targetCandles: 250,
      maxPoints: MAX_POINTS,
      lineColor,
      upColor: up,
      downColor: down,
      gridColor: 'transparent',
      textColor: 'rgba(var(--ink-rgb),.36)',
      indicator: {},
      timelineMode,
      priceScale,
      bridgeFromPreviousClose: bridgeEnabled,
      followLatest,
      activeRangeKey: activeRange,
      showTooltip: false,
      ...chartAxisOptions(),
      priceLabelRight: -20,
      candleAnimation: false,
      
      formatValue: formatPrice,
      // chart-next.js auto-zeros its default bottom edgeInset whenever an
      // external toolbar element (below) is supplied, so this no longer
      // needs its own override -- .mq-toolbar is a sibling of
      // .mq-chart-surface, not chart-next.js's internally-docked toolbar,
      // so that reserved strip was never clearing anything real here.
      toolbar: {
        element: root.querySelector('.mq-toolbar'),
        intervals: CHART_INTERVALS,
      },
      stateKey: mountOptions.stateKey || 'markets',
      surface: root.querySelector('.mq-chart-surface'),
    };
    if (chart) {
      chart.batch(() => { chart.setOptions(options); chart.setData(nextData); });
    } else {
      chart = services.createTimeSeriesChart(chartHost, { ...options, signal: context.signal, data: nextData });
      // Restore the shared Indicators switch even if the retired toolbar switch was off.
      chart.setOptions({ indicator: {} });
      const syncFromChart = (state, refetch = true) => {
        const nextType = state.type;
        const nextTimeline = state.timelineMode;
        const nextPriceScale = state.priceScale;
        const nextBridge = state.bridgeFromPreviousClose;
        const nextFollow = state.followLatest;
        const nextRange = state.viewport.activeRangeKey;
        const nextInterval = state.bucketMs == null
          ? 'auto'
          : Object.entries(INTERVAL_MS).find(([, ms]) => ms === state.bucketMs)?.[0] || activeInterval;
        const intervalChanged = nextInterval !== activeInterval;
        chartType = nextType;
        timelineMode = nextTimeline;
        priceScale = nextPriceScale;
        bridgeEnabled = nextBridge;
        followLatest = nextFollow;
        activeRange = nextRange;
        activeInterval = nextInterval;
        if (intervalChanged) persistSettings({ interval: activeInterval });
        syncToolbarState();
        if (refetch && intervalChanged && dataSource === 'history' && activeQuery) runQuery(queryText());
      };
      chart.on('settings', syncFromChart);
      syncFromChart(chart.getState(), false);
    }
    clearPendingPoints();
  };

  const setOffline = error => {
    root.classList.add('is-offline');
    input.title = error?.message || 'Market data unavailable';
  };

  const handleEnvelope = envelope => {
    if (envelope.event !== 'market-data:trade') return;
    const trade = envelope.payload;
    addPoint({ time: trade?.timestamp, value: trade?.price });
    root.classList.remove('is-offline');
  };

  // market-data's live candle engine starts a brand-new in-memory candle
  // the instant it sees its first trade for a still-open bar -- it has no
  // memory of what happened in that bar before it started watching. Our own
  // REST fetch usually already knows the bar's real open/high/low up to
  // that point, so a live update for a bar we already have must be merged
  // (widen the range, keep the true open, only let close/volume move
  // forward), never swapped in wholesale -- a wholesale swap is what was
  // snapping the currently-forming candle's wicks back down to nothing the
  // moment live data started touching it.
  const mergeBar = (existing, incoming) => existing ? {
    start: incoming.start, end: incoming.end,
    open: existing.open,
    high: Math.max(existing.high, incoming.high),
    low: Math.min(existing.low, incoming.low),
    close: incoming.close,
    volume: Math.max(existing.volume || 0, incoming.volume || 0),
  } : incoming;

  const applyHistoryBar = bar => {
    const last = historicalCandles.at(-1);
    if (last && last.start === bar.start) {
      const merged = mergeBar(last, bar);
      historicalCandles[historicalCandles.length - 1] = merged;
      chart?.updateLatest(merged);
    } else {
      historicalCandles.push(bar);
      if (historicalCandles.length > MAX_POINTS) historicalCandles.splice(0, historicalCandles.length - MAX_POINTS);
      chart?.append(bar);
    }
    root.classList.remove('is-offline');
  };

  // Keeps "History" mode's candlestick buffer live instead of static.
  // market-data now backfills the same REST history on subscribe() and
  // keeps emitting market-data:candle for every closed/forming bar after
  // that (see market-data's README, "Combining live and historical
  // candles") -- this just has to paint what arrives, the same way
  // handleEnvelope() above already does for Stream mode's trade tape.
  const handleHistoryEnvelope = envelope => {
    if (envelope.event !== 'market-data:candle') return;
    const candle = envelope.payload;
    console.debug('[markets/history] candle event', { symbol: candle?.symbol, exchange: candle?.exchange, intervalMs: candle?.intervalMs, close: candle?.close, wanted: { symbol: activeQuery?.symbol, exchange: historyExchange, intervalMs: historyIntervalMs } });
    if (dataSource !== 'history' || !activeQuery || candle?.symbol !== activeQuery.symbol) return;
    if (candle.intervalMs !== historyIntervalMs) return;
    if (candle.exchange !== historyExchange) {
      // getHistory()'s preferred exchange (binance, usually) is what the
      // REST backfill just painted, so we prefer to keep matching it. But
      // if that exchange never actually produces a live tick -- blocked,
      // unsupported pair, regional restriction, whatever -- sitting there
      // waiting forever is worse than showing data from whichever exchange
      // *is* live, same as Stream mode already does (it doesn't care which
      // exchange a trade comes from either).
      if (historyExchangeConfirmedLive) return;
      console.debug('[markets/history] preferred exchange silent, adopting', candle.exchange, 'instead of', historyExchange);
      historyExchange = candle.exchange;
    }
    historyExchangeConfirmedLive = true;
    applyHistoryBar({ start: candle.start, end: candle.end, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
  };

  const scheduleHistorySnapshotPoll = () => {
    if (dataSource !== 'history' || historySnapshotTimer != null || !services || !activeQuery) return;
    historySnapshotTimer = context.setTimeout(pollHistorySnapshot, 10_000);
  };

  // Belt-and-suspenders watchdog, same shape as Stream mode's
  // scheduleSnapshotPoll/pollSnapshot below: push events (handleHistoryEnvelope)
  // are primary, but this reconciles the on-screen buffer against
  // getSnapshot()'s combined view every 10s in case a push was ever missed
  // or filtered wrong, and it's what actually diagnoses/fixes a stuck
  // preferred exchange even before a live tick ever arrives for it.
  const pollHistorySnapshot = async () => {
    historySnapshotTimer = null;
    if (!services || !activeQuery || dataSource !== 'history' || historySnapshotInFlight) { scheduleHistorySnapshotPoll(); return; }
    const generation = queryGeneration;
    const query = activeQuery;
    historySnapshotInFlight = true;
    try {
      const snapshot = await services.market.getSnapshot(query.symbol, { exchanges: query.exchanges });
      if (generation !== queryGeneration || query.symbol !== activeQuery?.symbol) return;
      const byExchange = snapshot?.candlesByExchange || {};
      let exchange = historyExchange;
      let candle = byExchange[historyExchange] && Object.values(byExchange[historyExchange]).find(item => item.intervalMs === historyIntervalMs);
      if (!candle) {
        for (const [otherExchange, intervals] of Object.entries(byExchange)) {
          const match = Object.values(intervals || {}).find(item => item.intervalMs === historyIntervalMs);
          if (match) { exchange = otherExchange; candle = match; break; }
        }
      }
      console.debug('[markets/history] watchdog poll', { exchange, found: !!candle, close: candle?.close, historyLength: candle?.history?.length, onScreenLength: historicalCandles.length });
      if (candle) {
        historyExchange = exchange;
        historyExchangeConfirmedLive = true;
        // Merge, never replace wholesale: market-data's own backfill (kicked
        // off by the same subscribe() call) runs in the background and can
        // still be mid-flight when this poll fires, so `candle.history` can
        // easily be thinner right now than what the direct getHistory() load
        // already painted. A wholesale chart.setData(remoteSeries) would then
        // yank the chart down to whatever partial state market-data has at
        // that instant -- a couple of giant, badly-offset candles -- until a
        // later poll/push catches back up. Merging by bar start can only add
        // or correct bars, never lose ones we already have.
        const remoteSeries = [...candle.history, candle];
        const merged = new Map(historicalCandles.map(bar => [bar.start, bar]));
        let changed = false;
        for (const bar of remoteSeries) {
          const existing = merged.get(bar.start);
          const next = mergeBar(existing, bar);
          if (!existing || existing.close !== next.close || existing.high !== next.high || existing.low !== next.low || existing.open !== next.open) {
            merged.set(bar.start, next);
            changed = true;
          }
        }
        if (changed) {
          historicalCandles = [...merged.values()].sort((a, b) => a.start - b.start).slice(-MAX_POINTS);
          chart?.setData(historicalCandles);
        }
      }
      root.classList.toggle('is-offline', snapshot?.status === 'stale' || snapshot?.status === 'empty');
    } catch (error) {
      console.debug('[markets/history] watchdog poll failed', error);
    } finally {
      historySnapshotInFlight = false;
      scheduleHistorySnapshotPoll();
    }
  };

  const runQuery = async value => {
    const parsed = parseMarketQuery(value, activeQuery?.symbol || 'BTCUSDT');
    if (!parsed.symbol) return;
    clearPendingPoints();
    const generation = ++queryGeneration;
    const requestedInterval = /\b(?:1m|5m|15m|30m|1h|4h|1d)\b/i.test(String(value || ''))
      ? parsed.interval
      : (activeQuery?.interval || parsed.interval);
    activeQuery = Object.freeze({ ...parsed, interval: requestedInterval, namedExchanges: parsed.exchanges, exchanges: parsed.exchanges || [...KNOWN_EXCHANGES] });
    remember(`${queryText()} ${activeQuery.interval} candles`);
    input.value = queryText();
    const baseSymbol = activeQuery.symbol.replace(/USDT$/, '');
    if (!isolated && watchlistState.tickers.includes(baseSymbol)) updateTickerActive(baseSymbol);
    root.querySelectorAll('[data-interval]').forEach(button => button.classList.toggle('is-active', button.dataset.interval === activeInterval));
    root.classList.add('is-loading');
    try {
      services ||= await loadServices();
      if (generation !== queryGeneration || context.signal?.aborted) return;
      if (!stopColorListener) stopColorListener = services.onPriceColorChange(({ up, down }) => {
        const nextData = chartData();
        const lineColor = services.lineColorForTrend(nextData, { up, down }, item => item.value ?? item.close);
        currentLineColor = lineColor;
        chart?.setOptions({ upColor: up, downColor: down, lineColor });
      });
      const previousSubscription = subscription;
      subscription = null;
      await previousSubscription?.unsubscribe();
      if (generation !== queryGeneration) return;
      if (dataSource === 'history') {
        const history = await services.market.getHistory(activeQuery.symbol, {
          interval: activeInterval === 'auto' ? '5m' : activeInterval,
          intervalMs: activeInterval === 'custom' ? customIntervalMs : INTERVAL_MS[activeInterval],
          limit: 1_000,
          exchanges: activeQuery.exchanges,
        });
        if (generation !== queryGeneration) return;
        // Read back what the fetch actually resolved to rather than
        // re-guessing it here -- "auto" (and any future fallback in
        // history.js's resolveInterval) has no entry in INTERVAL_MS, so
        // guessing left historyIntervalMs undefined and handleHistoryEnvelope's
        // `candle.intervalMs !== historyIntervalMs` check silently dropped
        // every live candle for that query.
        historyIntervalMs = history.intervalMs;
        historyExchange = history.exchange;
        historyExchangeConfirmedLive = false;
        historicalCandles = history.candles.slice(-MAX_POINTS);
        console.debug('[markets/history] initial load', { symbol: activeQuery.symbol, exchange: historyExchange, intervalMs: historyIntervalMs, candles: historicalCandles.length });
        ensureChart();
        root.classList.remove('is-loading', 'is-offline');
        // The REST call above paints instantly; subscribing keeps that same
        // buffer live afterwards instead of going static until the next
        // manual reload (handleHistoryEnvelope paints each bar as it
        // arrives). market-data dedupes/caches its own backfill fetch for
        // this symbol/exchange/interval, so this doesn't double the load.
        // Only the interval on screen: market-data sends nothing else, and
        // backfills only this interval.
        const nextSubscription = await services.market.subscribe(activeQuery.symbol, {
          candles: true,
          intervals: [historyIntervalMs],
          exchanges: activeQuery.exchanges,
        }, envelope => { if (generation === queryGeneration) handleHistoryEnvelope(envelope); });
        if (generation !== queryGeneration) { await nextSubscription.unsubscribe(); return; }
        subscription = nextSubscription;
        clearTimeout(historySnapshotTimer);
        historySnapshotTimer = null;
        scheduleHistorySnapshotPoll();
        return;
      }
      // Stream mode plots trades and buckets them itself, so it takes no
      // candle events (and triggers no candle backfill).
      const nextSubscription = await services.market.subscribe(activeQuery.symbol, {
        trades: true,
        exchanges: activeQuery.exchanges,
      }, envelope => { if (generation === queryGeneration) handleEnvelope(envelope); });
      if (generation !== queryGeneration) { await nextSubscription.unsubscribe(); return; }
      subscription = nextSubscription;
      const seed = nextSubscription.snapshot?.price;
      const points = pointsForSymbol(activeQuery.symbol);
      if (!points.length && seed && Number.isFinite(Number(seed.timestamp)) && Number.isFinite(Number(seed.value))) {
        points.push({ time: Number(seed.timestamp), value: Number(seed.value) });
      }
      ensureChart();
      scheduleSnapshotPoll();
      root.classList.remove('is-loading', 'is-offline');
    } catch (error) {
      if (generation === queryGeneration) setOffline(error);
    }
  };

  const setInterval = (interval, bucketMs = null) => {
    if (!activeQuery || (interval === activeInterval && (interval !== 'custom' || bucketMs === customIntervalMs))) return;
    activeInterval = interval;
    if (interval === 'custom') customIntervalMs = bucketMs;
    persistSettings({ interval: activeInterval, customIntervalMs });
    root.querySelectorAll('[data-interval]').forEach(button => button.classList.toggle('is-active', button.dataset.interval === activeInterval));
    customIntervalInput.classList.toggle('is-active', activeInterval === 'custom');
    if (dataSource === 'history') runQuery(queryText());
    else {
      chart?.batch(() => { chart.setOptions({ bucketMs: activeInterval === 'auto' ? null : (activeInterval === 'custom' ? customIntervalMs : INTERVAL_MS[activeInterval]) });
      chart.setData(pointsForSymbol(activeQuery.symbol)); });
    }
    if (activeInterval !== 'auto' && activeInterval !== 'custom') remember(`${queryText()} ${activeInterval} candles`);
  };

  const submitTicker = () => {
    const symbol = input.value.trim().toUpperCase();
    if (symbol) runQuery(symbol);
  };
  const setDataSource = source => {
    if (source === dataSource) return;
    dataSource = source;
    persistSettings({ dataSource });
    const button = root.querySelector('[data-source]');
    button.textContent = dataSource === 'history' ? 'History' : 'Stream';
    button.classList.toggle('is-active', dataSource === 'history');
    button.setAttribute('aria-pressed', String(dataSource === 'history'));
    root.querySelector('.mq-refresh-control').classList.toggle('is-hidden', dataSource === 'history');
    if (activeQuery) runQuery(queryText());
  };
  context.listen(root.querySelector('.mq-ticker-form'), 'submit', event => { event.preventDefault(); submitTicker(); });
  context.onCleanup(bindIntervalInput(customIntervalInput, root.querySelector('.mq-custom-interval-form'), ms => setInterval('custom', ms)));
  context.listen(input, 'keydown', event => {
    event.stopPropagation();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitTicker();
  });
  context.listen(refreshSelect, 'change', () => {
    const selectedRefreshMs = Number(refreshSelect.value);
    refreshMs = Number.isFinite(selectedRefreshMs) ? Math.max(0, selectedRefreshMs) : 100;
    persistSettings({ refreshMs });
    if (pendingPoints.length) {
      clearTimeout(updateTimer);
      updateTimer = null;
      schedulePaint();
    }
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    scheduleSnapshotPoll();
  });
  context.listen(root.querySelector('.mq-toolbar'), 'click', event => {
    if (event.target.closest('[data-source]')) setDataSource(dataSource === 'history' ? 'live' : 'history');
  });
  context.listen(root, 'keydown', event => {
    if (event.key === '/' && event.target !== input) { event.preventDefault(); input.focus(); input.select(); }
    if (event.key === 'Escape' && event.target === input) input.blur();
  });

  if (!isolated) context.onCleanup(onMarketQuery(query => runQuery(query)));
  runQuery(isolated ? (mountOptions.query || 'BTCUSDT') : consumePendingQuery(marketQueryState.lastQuery));
}

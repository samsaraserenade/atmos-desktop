import { isPrivate, MASK, masked, onPrivacyChange } from './privacy.js';
import { isPortfolioSection, sectionCoin } from './chart-sections.js';
import { coinHistory, useCoinHistory } from './coin-history.js';
import { chartAxisOptions } from './chart-axes.js';
import { bindChartResetMeasurement } from './chart-reset.js';
import { splitPortfolio } from './portfolio-sections.js';
import { scopedPortfolioData } from './portfolio-scope.js';
import { getAllPortfolios, getServerConnection } from './registry.js';
/** Portfolio chart data adapter. Rendering and chart behavior live in the charting service. */
import {
  onPortfolioUpdate, getAllPortfolioHistories, getRemoteTotalHistory,
  isRemotePortfolioMode, onRemoteTotalHistoryUpdate, recordPortfolioHistoryFrame,
} from './registry.js';
import { getTotal, onCurrencyChange, onRatesChange, convertToGbp, convertFromGbp } from './totals.js';
import { getPriceColors, onPriceColorChange } from './host/semantic-colors.js';
import { indexAtOrAfter } from './history-change.js';
import { onStateLoaded, save as saveState } from './host/persist.js';
import { saveChartHistory, loadChartHistory, saveChartHidden, loadChartHidden } from './storage.js';
import { portfolioState } from '../persist.js';
import {
  initBalanceWidget, updateBalanceDisplay, refreshMiniChartLayout,
  setBalanceVisible as applyBalanceVisible,
  getBalanceAnimMs, resetBalanceAnim,
  showHistoricalComposition, clearHistoricalComposition, balanceHistoryReplaced,
} from './balance.js';
import { activatePanelPlugin, activateDefaultPanelPlugin, getActivePanelPluginId } from './host/panel-registry.js';
import { atmos, role } from './host/frame.js';
import { MAX_HISTORY_POINTS } from './history-constants.js';
import { createTimeSeriesChart, setChartSettings, lineColorForTrend, CHART_INTERVALS, chartControlMarkup } from './chart-service.js';
import { createCashInvestedPane, CASH_INVESTED_PANE_ID, prepareCashInvestedData, extendCashInvestedData } from './indicators/cash-invested-pane.js';

// Every timeframe; Ctrl+click on one shows that much time (no range buttons).
const PORTFOLIO_INTERVALS = CHART_INTERVALS;
const POLL_MS = 15_000;
const STARTUP_COLLECTION_BUFFER_MS = 0;
const VIEW_TYPES = Object.freeze({ line: 'line', candles: 'candlestick', heiken: 'heiken-ashi' });
const totalHistory = [];
const legacyTotalHistory = [];
let history = totalHistory;
// totalHistory is the VPS history, point for point, converted at the current
// rates. False while it holds this computer's own samples (no VPS).
let mirrorsVps = false;
// What the main chart shows (src/chart-sections.js); chosen in the picker.
let section = 'total';
let remoteSections = [];
let sectionsPairing = null; // the paired server (main.cjs's id) remoteSections are from
let releaseCoin = null;
const sectionListeners = new Set();

function currentSplit() {
  let spot = 0, perp = 0;
  for (const [id, data] of getAllPortfolios()) {
    if (!data || data.lastUpdate === null) continue;
    const split = splitPortfolio(scopedPortfolioData(data, id), id, convertToGbp);
    if (split.spot === null) return { spot: null, perp: null };
    spot += split.spot; perp += split.perp;
  }
  return { spot, perp };
}

export function portfolioSectionHistory(selected) {
  if (selected === 'total') return totalHistory;
  const coin = sectionCoin(selected);
  if (coin) return coinHistory(coin).points.map(chartPointFromVps);
  const points = new Map(remoteSections.map(point => [point.t, point]));
  for (const point of totalHistory) if (point[selected] != null) points.set(point.t, point);
  return [...points.values()].filter(point => Number.isFinite(point[selected]))
    .sort((a, b) => a.t - b.t).map(point => ({ ...point, g: point[selected], v: convertFromGbp(point[selected]) }));
}
const extraPortfolioViews = new Set();
/** `appended`: points just added to the end of totalHistory, nothing else changed. */
function refreshExtraPortfolioViews(presentationOnly = false, appended = null) { for (const refresh of extraPortfolioViews) refresh(presentationOnly, appended); }

export function mountPortfolioSection(host, context, selected = 'total', stateKey = 'portfolio-extra') {
  host.innerHTML = '<div class="finance-portfolio-chart"><div class="finance-plot-surface"><div class="portfolio-chart-host"></div></div><div class="finance-portfolio-toolbar atmos-chart-controls"><div class="finance-toolbar-scroll">' + '<div role="group" aria-label="Timeline">' + chartControlMarkup('timeline') + chartControlMarkup('bridge') + chartControlMarkup('scale') + '</div><div role="group" aria-label="Chart type">' + chartControlMarkup('type') + '</div><div role="group" aria-label="Candle timeframe">' + chartControlMarkup('timeframe', { intervals: PORTFOLIO_INTERVALS }) + '</div>' + '</div></div></div>';
  const data = portfolioSectionHistory(selected);
  const options = currentOptions();
  const view = createTimeSeriesChart(host.querySelector('.portfolio-chart-host'), {
    ...options, panes: [], stateKey, data, signal: context.signal,
    surface: host.querySelector('.finance-plot-surface'),
    toolbar: { element: host.querySelector('.finance-portfolio-toolbar'), intervals: PORTFOLIO_INTERVALS },
  });
  context.listen(host, 'finance:refresh-chart-sizing', () => {
    view.resize();
  });
  bindChartResetMeasurement(host.querySelector('.finance-plot-surface'), () => view, context);
  view.on('hiddenRanges', updateHiddenRanges);
  let displayedData = data;
  const refresh = (presentationOnly = false, appended = null) => {
    const append = !presentationOnly && appended && selected === 'total';
    if (!presentationOnly) displayedData = portfolioSectionHistory(selected);
    const data = displayedData;
    view.batch(() => {
      view.setOptions(presentationOptions(selected, data));
      if (append) view.appendMany(appended);
      else if (!presentationOnly) view.setData(data, { preserveViewport: true });
    });
  };
  extraPortfolioViews.add(refresh);
  context.onCleanup(() => { extraPortfolioViews.delete(refresh); view.destroy(); });
  const coin = sectionCoin(selected);
  if (coin) context.onCleanup(useCoinHistory(coin, () => refresh()));
  refresh();
}

function selectSectionHistory() {
  history = portfolioSectionHistory(section);
}

/** What the main chart shows: 'total', 'spot', 'perp' or 'coin:SOL'. */
export const getPortfolioSection = () => section;

/** fn() after the main chart changed what it shows. */
export function onPortfolioSectionChange(fn) {
  sectionListeners.add(fn);
  return () => sectionListeners.delete(fn);
}

/** What the picker calls a section: "Portfolio", "Portfolio · Spot", "Portfolio · SOL" (masked in private mode). */
export function portfolioSectionLabel(value) {
  const coin = sectionCoin(value);
  if (coin) return `Portfolio · ${isPrivate() ? MASK : coin}`;
  return value === 'spot' ? 'Portfolio · Spot' : value === 'perp' ? 'Portfolio · Perp' : 'Portfolio';
}

/**
 * What a section is worth now, in the display currency, as the picker
 * lists it: the live total, or Spot's or Perp's share of it. Null while
 * unknown. (A coin's: coin-history.js coinValue.)
 */
export function latestSectionValue(selected) {
  const total = getTotal();
  if (!total.ready || !(total.liveCount > 0)) return null;
  if (selected === 'total') return Number.isFinite(total.value) ? total.value : null;
  const split = currentSplit();
  return split[selected] == null ? null : convertFromGbp(split[selected]);
}

/** Show a section on the main chart (the picker, rev/portfolio). Saved, so it's there after a restart. */
export function setPortfolioSection(value) {
  const next = isPortfolioSection(value) ? value : 'total';
  if (next === section) return;
  section = next;
  updateLegacyChartSetting('section', section, false);
  applySection();
}

function applySection() {
  followSectionCoin();
  replaceChartData();
  applyCashInvestedPaneVisibility();
  for (const fn of [...sectionListeners]) {
    try { fn(section); } catch (error) { console.error('[finance] section listener failed:', error); }
  }
}

/** While the main chart shows a coin, redraw it as its history arrives. */
function followSectionCoin() {
  releaseCoin?.();
  releaseCoin = null;
  const coin = sectionCoin(section);
  if (coin && chart) releaseCoin = useCoinHistory(coin, () => replaceChartData());
}

let hiddenRanges = [];
let collectAfter = Infinity;
let chart = null;
let mounted = false;
let balanceVisible = true;

// ── Cash/invested indicator pane (below the price chart, RSI-style) ────
// A real secondary pane inside the shared charting engine itself (see
// src/indicators/cash-invested-pane.js and chart-next.js's options.panes
// contract) -- not a plugin-local <div> bolted under the chart. The engine
// owns the pane's layout, resize, and pan/zoom-synced rendering; this file
// only feeds it data (chart.setPaneData) and reads its element back
// (chart.getPaneElement) to wire up the point-in-time hover lookup.
let cashInvestedPaneEl = null;
let cashInvestedData = [];
let cashInvestedVisible = true;

function applyCashInvestedPaneVisibility() {
  // chart.setPaneVisible hides the pane's own svg AND its resize handle
  // together -- a handle with no pane beneath it to resize is a dangling
  // control, so this must not go back to setting cashInvestedPaneEl.style
  // directly (that's exactly the bug this replaced).
  chart?.setPaneVisible(CASH_INVESTED_PANE_ID, cashInvestedVisible && section === 'total');
}

function buildCombinedHistoryFromConnectors() {
  const events = [];
  for (const [id, points] of getAllPortfolioHistories()) for (const point of points) events.push({ id, ...point });
  events.sort((a, b) => a.ts - b.ts);
  const latest = new Map(), combined = [];
  for (let index = 0; index < events.length;) {
    const timestamp = events[index].ts;
    let settled = false;
    while (index < events.length && events[index].ts === timestamp) {
      const event = events[index++];
      if (event.settled !== false) settled = true;
      if (event.active === false) latest.delete(event.id); else latest.set(event.id, event);
    }
    if (!settled || !latest.size) continue;
    let gbp = 0, errorCount = 0, spot = 0, perp = 0, known = true;
    for (const [id, point] of latest) {
      const scoped = scopedPortfolioData(point.snapshot, id);
      const split = splitPortfolio(scoped, id, convertToGbp);
      known &&= split.spot !== null;
      spot += split.spot ?? 0; perp += split.perp ?? 0;
      gbp += convertToGbp(scoped?.value ?? point.value ?? 0, scoped?.currency ?? point.currency ?? '$');
      errorCount += Math.max(0, Number(point.snapshot?.errorCount) || 0);
    }
    combined.push({ spot: known ? spot : null, perp: known ? perp : null, t: timestamp, v: convertFromGbp(gbp), g: gbp, liveCount: latest.size, errorCount });
  }
  if (!isRemotePortfolioMode()) return combined;
  return getRemoteTotalHistory().map(chartPointFromVps);
}

/** A VPS history point as the chart and balance widgets draw it. */
function chartPointFromVps(point) {
  const gbp = convertToGbp(point.value ?? 0, point.currency ?? 'USD');
  return { spot: point.spot == null ? null : convertToGbp(point.spot, point.currency ?? 'USD'), perp: point.perp == null ? null : convertToGbp(point.perp, point.currency ?? 'USD'), t: point.t, v: convertFromGbp(gbp), g: gbp, liveCount: 1, errorCount: Math.max(0, Number(point.errorCount) || 0) };
}

// A coin's chart says why it's empty (never which coin: private mode may be on).
const COIN_STATUS = {
  loading: { value: 'Reading its history…', color: 'rgba(var(--ink-rgb),.5)', title: 'Reading this coin’s history from your portfolio server' },
  none: { value: 'Nothing counted', color: 'rgba(var(--ink-rgb),.5)', title: 'Not held now, or its holdings are hidden or part of a group (a perp position’s collateral, say) that’s only counted whole' },
  failed: { value: 'History unavailable', color: '#f87171', title: 'Your portfolio server didn’t answer. Finance tries again with its next sample.' },
  unavailable: { value: 'Needs a portfolio server', color: 'rgba(var(--ink-rgb),.5)', title: 'A coin’s history comes from your portfolio server' },
};

function chartStatus(selected = section) {
  const count = Math.max(0, Number(getTotal().errorCount) || 0);
  const status = count ? [{ key: 'unavailable', value: String(count), color: '#f87171', title: count === 1
    ? '1 value unavailable — using the last confirmed value'
    : `${count} values unavailable — using their last confirmed values` }] : [];
  const coin = sectionCoin(selected);
  const coinStatus = coin && COIN_STATUS[coinHistory(coin).status];
  if (coinStatus) status.push({ key: 'coin', ...coinStatus });
  return status;
}

function currentOptions() {
  const saved = portfolioState.portfolioChartSettings || {};
  // Core's semantic colors; the fallback only guards an unexpected empty palette.
  const colors = getPriceColors() || { up: '#34d399', down: '#f87171' };
  return {
    type: VIEW_TYPES[saved.viewMode] || 'line', timelineMode: saved.timelineMode === 'gaps' ? 'gaps' : 'gapless',
    // Not restoring saved.activeRangeKey here -- same reasoning as the
    // markets panel: an activeRangeKey always overrides targetCandles in
    // viewport.js's candleLayout, so restoring e.g. "All" would reopen
    // showing the full history instead of the intended candle-count
    // default. Selecting a range during this session still works and
    // persists as before; only the next app launch starts fresh.
    bucketMs: saved.candleTfMs ?? null, activeRangeKey: null,
    bridgeFromPreviousClose: saved.candleBridgeEnabled === true, indicator: {},
    lineColor: lineColorForTrend(history, colors, point => point.v),
    upColor: colors.up, downColor: colors.down, maxPoints: MAX_HISTORY_POINTS,
    ...chartAxisOptions(),
    hiddenRanges, status: chartStatus(), showTooltip: false, followLatest: true,
    candleAnimation: false, candleAnimationDuration: getBalanceAnimMs(),
    // toolbar gets overridden below in mount() to { element: ... } (this
    // plugin's own .finance-portfolio-toolbar, laid out as a flex sibling
    // rather than chart-next.js's internally-docked one) -- chart-next.js
    // now auto-zeros its default bottom edgeInset whenever an external
    // toolbar element is supplied, so this no longer needs to say so itself.
     toolbar: true, stateKey: 'portfolio',
    panes: [createCashInvestedPane(() => getPriceColors?.(), portfolioState.cashInvestedPaneHeight)],
    textColor: 'rgba(var(--ink-rgb),.36)',
    formatValue: formatChartValue,
  };
}

// Private mode masks the value axis, crosshair and hover labels; the line stays.
const formatChartValue = masked(value => `${getTotal().symbol}${Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** `selected` and `data`: an extra chart's section and points (else the main chart's). */
function presentationOptions(selected = section, data = history) {
  // Same fallback pair as currentOptions() — kept identical to the
  // price-color service's defaults, not an independent guess.
  const colors = getPriceColors?.() || { up: '#34d399', down: '#f87171' };
  return {
    lineColor: lineColorForTrend(data, colors, point => point.v),
    upColor: colors.up, downColor: colors.down, hiddenRanges, status: chartStatus(selected),
    ...chartAxisOptions(),
    candleAnimationDuration: getBalanceAnimMs(),
    formatValue: formatChartValue,
  };
}

function applyHiddenRanges(ranges) {
  hiddenRanges = [...ranges];
  chart?.setOptions({ hiddenRanges });
  refreshExtraPortfolioViews(true);
  updateBalanceDisplay();
}

function updateHiddenRanges(ranges) {
  hiddenRanges = [...ranges];
  saveChartHidden(hiddenRanges);
  atmos.events.emit('chart-hidden', hiddenRanges).catch(() => {}); // the other Finance frames' balance figures
  chart?.setOptions({ hiddenRanges });
  refreshExtraPortfolioViews(true);
  updateBalanceDisplay();
}
/** `appended`: points just added to the end of totalHistory, nothing else changed. */
function replaceChartData(appended = null) {
  refreshExtraPortfolioViews(false, appended);
  // Only a chart draws the selected section; a widget frame has none.
  if (!chart) return;
  if (appended && section === 'total') {
    history = totalHistory;
    chart.batch(() => {
      chart.setOptions(presentationOptions());
      chart.appendMany(appended);
      chart.setPaneData(CASH_INVESTED_PANE_ID, cashInvestedData);
    });
    return;
  }
  selectSectionHistory();
  chart.batch(() => {
    chart.setOptions(presentationOptions());
    chart.setData(history, { preserveViewport: true });
    chart.setPaneData(CASH_INVESTED_PANE_ID, cashInvestedData);
  });
}

/**
 * Keep the Spot/Perp split of every point seen, so a section chart keeps
 * points the VPS later stops sending split (portfolioSectionHistory).
 */
function rememberSections(points) {
  const split = points.filter(point => point.spot != null);
  if (!split.length) return;
  if (!remoteSections.length || split[0].t > remoteSections.at(-1).t) {
    for (const point of split) remoteSections.push(point);
  } else {
    const byTime = new Map(remoteSections.map(point => [point.t, point]));
    for (const point of split) byTime.set(point.t, point);
    remoteSections = [...byTime.values()].sort((a, b) => a.t - b.t);
  }
  if (remoteSections.length > MAX_HISTORY_POINTS) remoteSections = remoteSections.slice(-MAX_HISTORY_POINTS);
}

/**
 * The VPS history changed (registry.js onRemoteTotalHistoryUpdate).
 * `change` ({ from, points }) replaces only the points at or after `from`;
 * new samples at the end are appended to the chart rather than redrawn.
 * Without it, the whole history was replaced.
 */
function replaceHistoryFromVps(change) {
  if (!isRemotePortfolioMode()) { mirrorsVps = false; return; }
  // A change applies to the VPS history; anything else here is rebuilt from it.
  if (!mirrorsVps) change = undefined;
  const previousLength = totalHistory.length;
  const keep = change ? indexAtOrAfter(totalHistory, change.from) : 0;
  const fresh = (change ? change.points : getRemoteTotalHistory()).map(chartPointFromVps);
  if (!change) legacyTotalHistory.length = 0;
  // Another server's section points aren't this one's history (R13).
  const pairing = getServerConnection()?.id ?? null;
  if (pairing !== sectionsPairing) {
    remoteSections = [];
    sectionsPairing = pairing;
  } else {
    rememberSections(totalHistory.slice(keep)); // the points about to go, as before
  }
  totalHistory.length = keep;
  for (const point of fresh) totalHistory.push(point);
  if (totalHistory.length > MAX_HISTORY_POINTS) totalHistory.splice(0, totalHistory.length - MAX_HISTORY_POINTS);
  rememberSections(fresh);
  mirrorsVps = true;
  history = totalHistory;
  balanceHistoryReplaced();
  updateBalanceDisplay();
  // The cash/invested pane is drawn only with the chart (the panel).
  if (chart) {
    cashInvestedData = change
      ? extendCashInvestedData(cashInvestedData, change)
      : prepareCashInvestedData(getRemoteTotalHistory());
  }
  const appendedOnly = !!change && keep === previousLength && totalHistory.length === previousLength + fresh.length;
  replaceChartData(appendedOnly ? fresh : null);
}

function restoreRuntimeSettings() {
  const savedSection = portfolioState.portfolioChartSettings?.section;
  const restored = isPortfolioSection(savedSection) ? savedSection : 'total';
  if (restored !== section) { section = restored; applySection(); }
  else replaceChartData();
  const saved = portfolioState.portfolioChartSettings || {};
  balanceVisible = saved.balanceVisible !== false;
  applyBalanceVisible(balanceVisible);
  cashInvestedVisible = portfolioState.cashInvestedPaneVisible !== false;
  applyCashInvestedPaneVisibility();
  publishSharedSettings();
  if (chart) chart.setOptions(presentationOptions());
}

function publishSharedSettings() {
  const saved = portfolioState.portfolioChartSettings || {};
  setChartSettings({
    smoothing: 0,
    lineOpacity: .85,
    showCurrentPriceLine: saved.priceTagVisible ?? portfolioState.priceTagVisible ?? false,
    candleAnimation: false,
    samsara: {
      overlayEnabled: portfolioState.samsaraOverlayEnabled !== false,
      movingAveragesEnabled: portfolioState.samsaraMaEnabled !== false,
      movingAverageEnabled: Array.from({ length: 5 }, (_, index) => portfolioState[`samsaraMa${index + 1}Enabled`] !== false),
      movingAverageOpacity: Math.max(0, Math.min(1, Number(portfolioState.samsaraMaOpacity ?? 58) / 100)),
      rsiEnabled: portfolioState.samsaraRsiEnabled !== false,
      sessionsEnabled: portfolioState.samsaraSessionsEnabled !== false,
      candleColoringEnabled: portfolioState.samsaraCandleColoringEnabled !== false,
      candleColorBasis: /^(session|consensus|ma[1-5])$/.test(portfolioState.samsaraCandleColorBasis || '') ? portfolioState.samsaraCandleColorBasis : 'session',
    },
  });
}

export async function initTotalChart(context) {
  collectAfter = Date.now() + STARTUP_COLLECTION_BUFFER_MS;
  initBalanceWidget({ history: totalHistory, isHidden, getColors: getPriceColors });
  // The price chart and the sidebar balance widget (tiles, ATH, Movers,
  // Portfolio Change) are two independent pieces of UI that both read
  // colors from this same service -- updating the chart's options does
  // nothing for the widget's own DOM, so both need their own refresh on
  // every color change, not one OR the other depending on whether the
  // chart happens to be mounted right now.
  context.onCleanup(onPriceColorChange(() => {
    refreshExtraPortfolioViews(true);
    if (chart) chart.setOptions(presentationOptions());
    updateBalanceDisplay();
  }));
  // Private mode masks the charts' value labels and the balance: redrawn
  // at once, as nothing else about the chart changed.
  context.onCleanup(onPrivacyChange(() => {
    refreshExtraPortfolioViews(true);
    if (chart) chart.setOptions(presentationOptions());
    updateBalanceDisplay();
  }));
  const [savedHistory, savedHidden] = await Promise.all([loadChartHistory(), loadChartHidden()]);
  const remote = isRemotePortfolioMode(), rebuilt = buildCombinedHistoryFromConnectors(), splitStart = rebuilt[0]?.t ?? Infinity;
  const legacy = remote ? [] : savedHistory.filter(point => point.t < splitStart);
  legacyTotalHistory.push(...legacy.slice(-MAX_HISTORY_POINTS));
  totalHistory.push(...legacy.concat(rebuilt).slice(-MAX_HISTORY_POINTS));
  if (remote) {
    sectionsPairing = getServerConnection()?.id ?? null;
    rememberSections(totalHistory);
  }
  mirrorsVps = remote;
  history = totalHistory;
  hiddenRanges = savedHidden;
  context.onCleanup(atmos.events.on('chart-hidden', ranges => { if (Array.isArray(ranges)) applyHiddenRanges(ranges); }));
  updateBalanceDisplay();
  replaceChartData();
  // Every Finance frame derives this history; only the panel, where the
  // chart and its hidden ranges are edited, writes it back.
  if (role === 'panel') context.listen(window, 'pagehide', () => { saveChartHistory([...legacyTotalHistory]); saveChartHidden([...hiddenRanges]); });
  context.listen(window, 'resize', refreshMiniChartLayout);
  context.onCleanup(onPortfolioUpdate(sample));
  context.onCleanup(onRemoteTotalHistoryUpdate(replaceHistoryFromVps));
  // Each point is converted from the VPS's currency when it arrives: new
  // rates convert the whole history again.
  context.onCleanup(onRatesChange(() => replaceHistoryFromVps()));
  context.onCleanup(onCurrencyChange(reconvertHistoryForCurrencyChange));
  context.setInterval(sample, POLL_MS);
  context.setTimeout(sample, Math.max(0, collectAfter - Date.now()));
  restoreRuntimeSettings();
  const stop = onStateLoaded(restoreRuntimeSettings);
  if (typeof stop === 'function') context.onCleanup(stop);
}

export function mount(contentEl, context) {
  contentEl.innerHTML = `<div id="total-chart-card" class="finance-portfolio-chart">
    <div class="finance-portfolio-toolbar atmos-chart-controls" role="toolbar" aria-label="Portfolio chart options">
      <div class="finance-toolbar-scroll">
        <div role="group" aria-label="Timeline">${chartControlMarkup('timeline')}${chartControlMarkup('bridge')}${chartControlMarkup('scale')}</div>
        <div role="group" aria-label="Chart type">${chartControlMarkup('type')}</div>
        <div class="mq-timeframes" role="group" aria-label="Candle timeframe">${chartControlMarkup('timeframe', { intervals: PORTFOLIO_INTERVALS })}</div>
      </div>
    </div><div class="finance-plot-surface"><div class="portfolio-chart-host"></div></div></div>`;
  // Total, Spot, Perp and your coins are chosen in the picker (panel.js).
  selectSectionHistory();
  const surface = contentEl.querySelector('.finance-plot-surface');
  const host = contentEl.querySelector('.portfolio-chart-host');
  bindChartResetMeasurement(surface, () => chart, context);
  chart = createTimeSeriesChart(host, { ...currentOptions(), surface, data: history, signal: context.signal,
    toolbar: { element: contentEl.querySelector('.finance-portfolio-toolbar'), intervals: PORTFOLIO_INTERVALS },
  });
  context.listen(contentEl, 'finance:refresh-chart-sizing', () => {
    chart?.resize();
  });
  // The Indicators panel is the only enable switch; discard the retired per-chart switch.
  chart.setOptions({ indicator: {} });
  cashInvestedPaneEl = chart.getPaneElement(CASH_INVESTED_PANE_ID);
  cashInvestedData = prepareCashInvestedData(getRemoteTotalHistory());
  chart.setPaneData(CASH_INVESTED_PANE_ID, cashInvestedData);
  cashInvestedVisible = portfolioState.cashInvestedPaneVisible !== false;
  applyCashInvestedPaneVisibility();
  // No local toolbar-sync handler here anymore -- chart-next.js already
  // runs its own internal syncToolbar() on every settings change for a
  // toolbar passed as options.toolbar.element (this plugin's own
  // .finance-portfolio-toolbar, wired up above), covering exactly the same
  // is-active/aria-pressed/label state (chart type, interval, range,
  // bridge, scale, timeline) this function used to re-derive a second time.
  chart.on('hiddenRanges', updateHiddenRanges);
  chart.on('paneResize', ({ id, height }) => {
    if (id !== CASH_INVESTED_PANE_ID) return;
    portfolioState.cashInvestedPaneHeight = height;
    saveState();
  });
  if (cashInvestedPaneEl) {
    chart.on('paneHover', ({ id, time }) => {
      if (id === CASH_INVESTED_PANE_ID && cashInvestedData.length >= 2)
        showHistoricalComposition(time);
    });
    chart.on('paneLeave', ({ id }) => { if (id === CASH_INVESTED_PANE_ID) clearHistoricalComposition(); });
  }
  mounted = true;
  followSectionCoin();
}

export function unmount() {
  releaseCoin?.();
  releaseCoin = null;
  chart?.destroy();
  chart = null;
  mounted = false;
  cashInvestedPaneEl = null;
  cashInvestedData = [];
}

/**
 * Reapply the saved chart settings to the chart and Charting (what Finance's
 * boot hook did in the page): after start-up and after another Finance
 * frame changed them. Values that didn't change save nothing.
 */
export function applySavedChartSettings() {
  setChartSmoothing(portfolioState.chartSmoothing);
  setChartLineOpacity(portfolioState.chartLineOpacity / 100);
  setBalanceVisible(true);
  setPriceTagVisible(portfolioState.priceTagVisible);
  publishSharedSettings();
}

export function setTotalChartVisible(on) {
  if (on) {
    activatePanelPlugin('portfolio-tracker');
    // Deliberately NOT dispatching atmos:chart-mode:portfolio here anymore.
    // This only means "make the finance panel visible"; callers just want
    // the panel shown, not to force the chart sub-view back to Portfolio.
    // panel.js's own mount()/restoreMode() already restores whichever of
    // Portfolio/Markets was last active, and this dispatch was stomping on
    // that: every boot snapped straight back to Portfolio regardless of
    // what the user had last been viewing.
  } else if (getActivePanelPluginId() === 'portfolio-tracker') activateDefaultPanelPlugin();
}

export function setChartSmoothing(value) { updateLegacyChartSetting('smoothing', Math.max(0, Math.min(100, Number(value) || 0))); }
function refreshChartAxes() {
  chart?.setOptions(chartAxisOptions());
  refreshExtraPortfolioViews(true);
  saveState();
  document.dispatchEvent(new CustomEvent('finance:axes-change'));
}
export function setTimeAxisVisible(value) {
  portfolioState.timeAxisVisible = !!value;
  refreshChartAxes();
}
export function setPriceAxisVisible(value) {
  portfolioState.priceAxisVisible = !!value;
  refreshChartAxes();
}
export function setChartLineOpacity(value) { updateLegacyChartSetting('lineOpacity', Math.max(0, Math.min(1, Number(value) || 0))); }
export function setPriceTagVisible(value) { portfolioState.priceTagVisible = !!value; updateLegacyChartSetting('priceTagVisible', !!value); }
export function setBalanceVisible(value) { balanceVisible = !!value; applyBalanceVisible(balanceVisible); updateLegacyChartSetting('balanceVisible', balanceVisible, false); }
export function setCashInvestedPaneVisible(value) {
  cashInvestedVisible = value !== false;
  portfolioState.cashInvestedPaneVisible = cashInvestedVisible;
  saveState();
  applyCashInvestedPaneVisibility();
}

function updateLegacyChartSetting(key, value, publish = true) {
  portfolioState.portfolioChartSettings = { ...(portfolioState.portfolioChartSettings || {}), [key]: value };
  saveState();
  if (publish) publishSharedSettings();
}

function updateSamsara(key, value) { portfolioState[key] = value; saveState(); publishSharedSettings(); }
export function setSamsaraOverlayEnabled(value) { updateSamsara('samsaraOverlayEnabled', !!value); }
export function setSamsaraMaEnabled(value) { updateSamsara('samsaraMaEnabled', !!value); }
export function setSamsaraIndividualMaEnabled(index, value) { updateSamsara(`samsaraMa${Math.max(0, Math.min(4, Math.floor(Number(index)))) + 1}Enabled`, !!value); }
export function setSamsaraMaOpacity(value) { updateSamsara('samsaraMaOpacity', Math.max(0, Math.min(100, Number(value) || 0))); }
export function setSamsaraRsiEnabled(value) { updateSamsara('samsaraRsiEnabled', !!value); }
export function setSamsaraSessionsEnabled(value) { updateSamsara('samsaraSessionsEnabled', !!value); }
export function setSamsaraCandleColoringEnabled(value) { updateSamsara('samsaraCandleColoringEnabled', !!value); }
export function setSamsaraCandleColorBasis(value) { updateSamsara('samsaraCandleColorBasis', /^(session|ma[1-5])$/.test(String(value)) ? String(value) : 'session'); }

function reconvertHistoryForCurrencyChange() {
  for (const point of totalHistory) if (point.g != null) point.v = convertFromGbp(point.g);
  balanceHistoryReplaced(); resetBalanceAnim(); updateBalanceDisplay(); saveChartHistory([...legacyTotalHistory]); replaceChartData();
}
function isHidden(point) { return hiddenRanges.some(range => point.t >= range.tStart && point.t <= range.tEnd); }

function sample() {
  const now = Date.now(), total = getTotal();
  if (!Number.isFinite(total.value) || total.liveCount === 0) return;
  // In VPS mode the server's itemized history is the chart's single source
  // of truth. Appending a second, locally reconstructed point here creates a
  // race when portfolio scope changes: filtered history can be followed by
  // one point calculated with the previous scope, leaving a visible spike.
  // Keep the live widgets responsive, but let replaceHistoryFromVps() own
  // every historical chart point.
  if (isRemotePortfolioMode()) {
    updateBalanceDisplay();
    // The history itself changes only when the engine sends a change.
    refreshExtraPortfolioViews(true);
    if (chart) chart.setStatus(chartStatus());
    return;
  }
  const settled = now >= collectAfter;
  recordPortfolioHistoryFrame(now, { settled });
  if (!settled) { updateBalanceDisplay(); return; }
  const split = currentSplit();
  const last = totalHistory.at(-1), coalesced = !!last && now - last.t < 1_000;
  if (coalesced) Object.assign(last, { ...split, v: total.value, g: total.gbp, liveCount: total.liveCount ?? 0, errorCount: total.errorCount ?? 0 });
  else totalHistory.push({ ...split, t: now, v: total.value, g: total.gbp, liveCount: total.liveCount ?? 0, errorCount: total.errorCount ?? 0 });
  if (totalHistory.length > MAX_HISTORY_POINTS) totalHistory.shift();
  updateBalanceDisplay();
  if (section !== 'total') { replaceChartData(); return; }
  refreshExtraPortfolioViews();
  if (chart) {
    chart.batch(() => {
      chart.setStatus(chartStatus());
      if (coalesced) chart.updateLatest(last); else chart.append(totalHistory.at(-1));
    });
  }
}

export function getChartDiagnostics() {
  let minimum = Infinity, maximum = -Infinity, hiddenPoints = 0;
  for (const point of history) { minimum = Math.min(minimum, point.v); maximum = Math.max(maximum, point.v); if (isHidden(point)) hiddenPoints++; }
  return { points: history.length, hiddenPoints, firstTime: history.length ? new Date(history[0].t).toISOString() : null, lastTime: history.length ? new Date(history.at(-1).t).toISOString() : null, minimum: history.length ? minimum : null, maximum: history.length ? maximum : null, lastValue: history.at(-1)?.v ?? null, liveTotal: getTotal(), buffering: Date.now() < collectAfter, mounted };
}

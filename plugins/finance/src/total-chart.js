import { masked } from './privacy.js';
import { chartAxisOptions } from './chart-axes.js';
import { bindChartResetMeasurement } from './chart-reset.js';
import { splitPortfolio } from './portfolio-sections.js';
import { scopedPortfolioData } from './portfolio-scope.js';
import { getAllPortfolios } from './registry.js';
/** Portfolio chart data adapter. Rendering and chart behavior live in the charting service. */
import {
  onPortfolioUpdate, getAllPortfolioHistories, getRemoteTotalHistory,
  isRemotePortfolioMode, onRemoteTotalHistoryUpdate, recordPortfolioHistoryFrame,
} from './registry.js';
import { getTotal, onCurrencyChange, convertToGbp, convertFromGbp } from './totals.js';
import { getPriceColors, setPriceColorUp, setPriceColorDown, onPriceColorChange } from './host/semantic-colors.js';
import { onStateLoaded, save as saveState } from './host/persist.js';
import { saveChartHistory, loadChartHistory, saveChartHidden, loadChartHidden } from './storage.js';
import { portfolioState } from '../persist.js';
import {
  initBalanceWidget, updateBalanceDisplay, refreshMiniChartLayout,
  setBalanceVisible as applyBalanceVisible,
  getBalanceAnimMs, resetBalanceAnim,
  showHistoricalComposition, clearHistoricalComposition,
} from './balance.js';
import { activatePanelPlugin, activateDefaultPanelPlugin, getActivePanelPluginId } from './host/panel-registry.js';
import { atmos, role } from './host/frame.js';
import { MAX_HISTORY_POINTS } from './history-constants.js';
import { createTimeSeriesChart, setChartSettings, lineColorForTrend, CHART_INTERVALS, CHART_RANGES, chartControlMarkup } from './chart-service.js';
import { createCashInvestedPane, CASH_INVESTED_PANE_ID, prepareCashInvestedData } from './indicators/cash-invested-pane.js';

const PORTFOLIO_INTERVALS = CHART_INTERVALS.filter(item => item.value !== '4h');
const PORTFOLIO_RANGES = CHART_RANGES.filter(item => item.value !== 'ytd');
const POLL_MS = 15_000;
const STARTUP_COLLECTION_BUFFER_MS = 0;
const VIEW_TYPES = Object.freeze({ line: 'line', candles: 'candlestick', heiken: 'heiken-ashi' });
const totalHistory = [];
const legacyTotalHistory = [];
let history = totalHistory;
let section = 'total';
let sectionButtons = [];
let remoteSections = [];

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
  const points = new Map(remoteSections.map(point => [point.t, point]));
  for (const point of totalHistory) if (point[selected] != null) points.set(point.t, point);
  return [...points.values()].filter(point => Number.isFinite(point[selected]))
    .sort((a, b) => a.t - b.t).map(point => ({ ...point, g: point[selected], v: convertFromGbp(point[selected]) }));
}
const extraPortfolioViews = new Set();
function refreshExtraPortfolioViews(presentationOnly = false) { for (const refresh of extraPortfolioViews) refresh(presentationOnly); }

export function mountPortfolioSection(host, context, selected = 'total', stateKey = 'portfolio-extra') {
  host.innerHTML = '<div class="finance-portfolio-chart"><div class="finance-plot-surface"><div class="portfolio-chart-host"></div></div><div class="finance-portfolio-toolbar atmos-chart-controls"><div class="finance-toolbar-scroll">' + '<div role="group" aria-label="Timeline">' + chartControlMarkup('timeline') + chartControlMarkup('bridge') + chartControlMarkup('scale') + '</div><div role="group" aria-label="Chart type">' + chartControlMarkup('type') + '</div><div role="group" aria-label="Candle timeframe">' + chartControlMarkup('timeframe', { intervals: PORTFOLIO_INTERVALS }) + '</div><div role="group" aria-label="Visible range">' + chartControlMarkup('range', { ranges: PORTFOLIO_RANGES }) + '</div>' + '</div></div></div>';
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
  const refresh = (presentationOnly = false) => {
    if (!presentationOnly) displayedData = portfolioSectionHistory(selected);
    const data = displayedData;
    view.batch(() => {
      view.setOptions({ ...presentationOptions(), lineColor: lineColorForTrend(data, getPriceColors?.() || { up: '#34d399', down: '#f87171' }, point => point.v) });
      if (!presentationOnly) view.setData(data, { preserveViewport: true });
    });
  };
  extraPortfolioViews.add(refresh);
  context.onCleanup(() => { extraPortfolioViews.delete(refresh); view.destroy(); });
  refresh();
}

function selectSectionHistory() {
  if (section === 'total') { history = totalHistory; return; }
  const points = new Map(remoteSections.map(point => [point.t, point]));
  for (const point of totalHistory) if (point[section] != null) points.set(point.t, point);
  history = [...points.values()].filter(point => Number.isFinite(point[section]))
    .sort((a, b) => a.t - b.t).map(point => ({ ...point, g: point[section], v: convertFromGbp(point[section]) }));
}

function syncSectionButtons() {
  for (const button of sectionButtons) {
    const active = button.dataset.portfolioSection === section;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
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
  return getRemoteTotalHistory().map(point => {
    const gbp = convertToGbp(point.value ?? 0, point.currency ?? 'USD');
    return { spot: point.spot == null ? null : convertToGbp(point.spot, point.currency ?? 'USD'), perp: point.perp == null ? null : convertToGbp(point.perp, point.currency ?? 'USD'), t: point.t, v: convertFromGbp(gbp), g: gbp, liveCount: 1, errorCount: Math.max(0, Number(point.errorCount) || 0) };
  });
}

function chartStatus() {
  const count = Math.max(0, Number(getTotal().errorCount) || 0);
  return count ? [{ key: 'unavailable', value: String(count), color: '#f87171', title: count === 1
    ? '1 value unavailable — using the last confirmed value'
    : `${count} values unavailable — using their last confirmed values` }] : [];
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

function presentationOptions() {
  // Same fallback pair as currentOptions() — kept identical to the
  // price-color service's defaults, not an independent guess.
  const colors = getPriceColors?.() || { up: '#34d399', down: '#f87171' };
  return {
    lineColor: lineColorForTrend(history, colors, point => point.v),
    upColor: colors.up, downColor: colors.down, hiddenRanges, status: chartStatus(),
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
function replaceChartData() {
  refreshExtraPortfolioViews();
  selectSectionHistory();
  if (!chart) return;
  chart.batch(() => {
    chart.setOptions(presentationOptions());
    chart.setData(history, { preserveViewport: true });
    chart.setPaneData(CASH_INVESTED_PANE_ID, cashInvestedData);
  });
}

function replaceHistoryFromVps() {
  if (!isRemotePortfolioMode()) return;
  const splits = new Map(remoteSections.map(point => [point.t, point]));
  for (const point of totalHistory) if (point.spot != null) splits.set(point.t, point);
  remoteSections = [...splits.values()].sort((a, b) => a.t - b.t).slice(-MAX_HISTORY_POINTS);
  const remote = buildCombinedHistoryFromConnectors().slice(-MAX_HISTORY_POINTS);
  legacyTotalHistory.length = 0;
  totalHistory.length = 0;
  for (const point of remote) totalHistory.push(point);
  history = totalHistory;
  updateBalanceDisplay();
  cashInvestedData = prepareCashInvestedData(getRemoteTotalHistory());
  replaceChartData();
}

function restoreRuntimeSettings() {
  section = ['spot', 'perp'].includes(portfolioState.portfolioChartSettings?.section) ? portfolioState.portfolioChartSettings.section : 'total';
  replaceChartData(); syncSectionButtons();
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
  const [savedHistory, savedHidden] = await Promise.all([loadChartHistory(), loadChartHidden()]);
  const remote = isRemotePortfolioMode(), rebuilt = buildCombinedHistoryFromConnectors(), splitStart = rebuilt[0]?.t ?? Infinity;
  const legacy = remote ? [] : savedHistory.filter(point => point.t < splitStart);
  legacyTotalHistory.push(...legacy.slice(-MAX_HISTORY_POINTS));
  totalHistory.push(...legacy.concat(rebuilt).slice(-MAX_HISTORY_POINTS));
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
        <div role="group" aria-label="Portfolio section"><button type="button" data-portfolio-section="spot">Spot</button><button type="button" data-portfolio-section="perp">Perp</button><button type="button" data-portfolio-section="total">Total</button></div>
        <div role="group" aria-label="Timeline">${chartControlMarkup('timeline')}${chartControlMarkup('bridge')}${chartControlMarkup('scale')}</div>
        <div role="group" aria-label="Chart type">${chartControlMarkup('type')}</div>
        <div class="mq-timeframes" role="group" aria-label="Candle timeframe">${chartControlMarkup('timeframe', { intervals: PORTFOLIO_INTERVALS })}</div>
        <div role="group" aria-label="Visible range">${chartControlMarkup('range', { ranges: PORTFOLIO_RANGES })}</div>
      </div>
    </div><div class="finance-plot-surface"><div class="portfolio-chart-host"></div></div></div>`;
  sectionButtons = [...contentEl.querySelectorAll('[data-portfolio-section]')];
  for (const button of sectionButtons) context.listen(button, 'click', () => {
    section = button.dataset.portfolioSection;
    updateLegacyChartSetting('section', section, false);
    syncSectionButtons(); replaceChartData(); applyCashInvestedPaneVisibility();
  });
  selectSectionHistory(); syncSectionButtons();
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
        showHistoricalComposition(time, { from: cashInvestedData[0]?.t, to: cashInvestedData.at(-1)?.t });
    });
    chart.on('paneLeave', ({ id }) => { if (id === CASH_INVESTED_PANE_ID) clearHistoricalComposition(); });
  }
  mounted = true;
}

export function unmount() {
  chart?.destroy();
  chart = null;
  sectionButtons = [];
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
    // This only means "make the finance panel visible" -- both call sites
    // (boot.js's initial-visibility check, and boot.js's ']' panel-toggle
    // shortcut) just want the panel shown/hidden, not to force the chart
    // sub-view back to Portfolio. panel.js's own mount()/restoreMode()
    // already restores whichever of Portfolio/Markets was last active, and
    // this dispatch was stomping on that -- every boot (and every ']'
    // toggle) snapped straight back to Portfolio regardless of what the
    // user had last been viewing.
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
export function setChartLineColorUp(value) { setPriceColorUp(value); }
export function setChartLineColorDown(value) { setPriceColorDown(value); }
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
  resetBalanceAnim(); updateBalanceDisplay(); saveChartHistory([...legacyTotalHistory]); replaceChartData();
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
    refreshExtraPortfolioViews();
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

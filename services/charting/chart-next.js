import { CHART_INTERVALS, CHART_RANGES } from './toolbar.js';
import { nearestSampleTime } from './series.js';
import { appendCandleSample, bucketHistory, heikenAshi, heikenAshiStep, pickBucketMs, renderCandlesSVG, renderCandlesCanvas } from './candlesticks.js';
import { renderSamsaraOverlayCanvas, renderSamsaraOverlaySVG, SAMSARA_DEFAULTS, mergedUtcSession, movingAverage, buildSamsaraStudy } from './indicators.js';
import { smoothValues } from './smoothing.js';
import { createChartViewport } from './viewport.js';
import { getChartSettings, onChartSettingsChange } from './preferences.js';
import { readStored, writeStored } from './storage.js';
export { configureChartStorage } from './storage.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TYPES = new Set(['line', 'candlestick', 'heiken-ashi']);
// Double-click restores a readable density based on the actual plot width.
// It deliberately differs from targetCandles: that option governs the first
// view and automatic OHLC bucketing, while this is an interaction reset.
const SNAP_CANDLE_WIDTH_PX = 6;
const SNAP_LINE_POINT_SPACING_PX = 3;
const DEFAULT_INTERVALS = CHART_INTERVALS;
const DEFAULT_RANGES = CHART_RANGES;
const DEFAULTS = Object.freeze({
  type: 'line', timelineMode: 'gapless', lineColor: '#72a7ff', upColor: '#39d98a', downColor: '#ff647c',
  gridColor: 'transparent', textColor: 'rgba(var(--ink-rgb),.68)', background: 'transparent',
  smoothing: 0, bucketMs: null, targetCandles: 250, maxPoints: 5_000, lineOpacity: .85,
  showTimeAxis: false, showPriceAxis: true, axisEdgeOffset: null, showPointCount: true, showLiveMarker: true,
  priceScale: 'linear',
  showTimeHoverLabel: true, priceLabelRight: null, statsOffset: null,
  showHoverLabels: true, showTooltip: true, showCrosshair: true, showCurrentPriceLine: true,
  bridgeFromPreviousClose: false, followLatest: true, candleAnimation: true, candleAnimationDuration: 650,
  activeRangeKey: null, hiddenRanges: Object.freeze([]), status: Object.freeze([]), toolbar: false,
  padding: Object.freeze({ top: 8, right: 56, bottom: 24, left: 4 }),
  formatValue: value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 }),
  formatTime: time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  indicator: null,
});

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const pointTime = point => finite(point?.t0 ?? point?.start ?? point?.time ?? point?.t ?? point?.timestamp);

function normalizeLinePoint(point) {
  const time = pointTime(point);
  const value = finite(point?.value ?? point?.v ?? point?.price ?? point?.close ?? point?.c);
  return time == null || value == null ? null : Object.freeze({ ...point, time, value });
}

function normalizeCandle(point) {
  const t0 = pointTime(point);
  const t1 = finite(point?.t1 ?? point?.end) ?? t0;
  const o = finite(point?.o ?? point?.open);
  const h = finite(point?.h ?? point?.high);
  const l = finite(point?.l ?? point?.low);
  const c = finite(point?.c ?? point?.close);
  return [t0, o, h, l, c].some(value => value == null) ? null : Object.freeze({ ...point, t0, t1, o, h, l, c });
}

function normalizeRanges(ranges) {
  return Object.freeze((Array.isArray(ranges) ? ranges : []).map(range => {
    const tStart = finite(range?.tStart ?? range?.from);
    const tEnd = finite(range?.tEnd ?? range?.to);
    return tStart == null || tEnd == null ? null : Object.freeze({ tStart: Math.min(tStart, tEnd), tEnd: Math.max(tStart, tEnd) });
  }).filter(Boolean).sort((a, b) => a.tStart - b.tStart));
}

function normalizeStatus(status) {
  if (status == null) return Object.freeze([]);
  const items = Array.isArray(status) ? status : Object.entries(status).map(([key, value]) => ({ key, value }));
  return Object.freeze(items.filter(item => item && item.value != null).map(item => Object.freeze({
    key: String(item.key ?? ''), value: String(item.value), title: String(item.title ?? ''), color: String(item.color ?? '#f87171'),
  })));
}

function normalizeOptions(current, patch = {}) {
  const next = { ...current, ...patch, padding: { ...current.padding, ...(patch.padding || {}) } };
  if (!TYPES.has(next.type)) throw new TypeError(`Unsupported chart type: ${next.type}`);
  next.maxPoints = Math.max(2, Math.floor(Number(next.maxPoints) || DEFAULTS.maxPoints));
  next.smoothing = Math.max(0, Math.min(100, Number(next.smoothing) || 0));
  next.candleAnimationDuration = Math.max(0, Number(next.candleAnimationDuration) || 0);
  if ('hiddenRanges' in patch) next.hiddenRanges = normalizeRanges(patch.hiddenRanges);
  if ('status' in patch) next.status = normalizeStatus(patch.status);
  return next;
}

function samsaraConfig(shared) {
  return {
    ...SAMSARA_DEFAULTS, showMovingAverages: shared.samsara.movingAveragesEnabled,
    movingAverageOpacity: shared.samsara.movingAverageOpacity,
    movingAverages: SAMSARA_DEFAULTS.movingAverages.map((setting, index) => ({ ...setting, enabled: shared.samsara.movingAverageEnabled[index] })),
    showRsi: shared.samsara.rsiEnabled, showSessions: shared.samsara.sessionsEnabled,
    colorCandles: shared.samsara.candleColoringEnabled, candleColorBasis: shared.samsara.candleColorBasis,
  };
}

function loadInstanceState(key) {
  if (!key) return {};
  const saved = readStored(`charting-instance:${key}`);
  return saved && typeof saved === 'object' ? saved : {};
}

export function createTimeSeriesChart(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError('container must be a DOM Element');
  let localIndicatorEnabled;
  let explicitPriceAxis = options.showPriceAxis != null;
  const sharedAtCreation = getChartSettings();
  let axisPadding = { ...DEFAULTS.padding, ...(options.padding || {}) };
  const paddingForAxis = visible => visible ? { ...axisPadding } : { ...axisPadding, left: 0, right: 0 };
  const restored = loadInstanceState(options.stateKey);
  // A stateKey identifies one chart instance across panel unmount/remount.
  // Restore its viewport as well as its presentation settings so switching
  // panels does not silently fit the complete history again.
  const hasRestoredViewport = restored.activeRangeKey != null
    || restored.lineWindow != null || restored.lineOffset != null
    || restored.candleSpanMs != null || restored.candleOffsetMs != null;
  const restoredOptions = { ...options, ...restored,
    indicator: restored.indicatorEnabled === false ? null : options.indicator,
  };
  if (restored.showPriceAxis != null) explicitPriceAxis = true;
  localIndicatorEnabled = restoredOptions.indicator !== null;
  let settings = normalizeOptions(DEFAULTS, {
    ...restoredOptions, padding: paddingForAxis(restoredOptions.showPriceAxis ?? sharedAtCreation.showCurrentPriceLine),
    smoothing: options.smoothing ?? sharedAtCreation.smoothing,
    lineOpacity: options.lineOpacity ?? sharedAtCreation.lineOpacity,
    candleAnimation: options.candleAnimation ?? sharedAtCreation.candleAnimation,
    showCurrentPriceLine: options.showCurrentPriceLine ?? sharedAtCreation.showCurrentPriceLine,
    showPriceAxis: restoredOptions.showPriceAxis ?? sharedAtCreation.showCurrentPriceLine,
    indicator: localIndicatorEnabled && sharedAtCreation.samsara.overlayEnabled ? { ...samsaraConfig(sharedAtCreation), ...(restoredOptions.indicator || {}) } : null,
  });
  let sourceData = [], data = [], candleSamples = null;
  let effectiveBucketMs = settings.bucketMs || 60_000;
  let destroyed = false, drag = null, selection = null, hover = null, measuredAxisEdgeOffset = 0;
  let responsiveDefaultDensity = false, responsivePlotWidth = 0;
  // Data refreshes may ask for a fresh viewport, but an explicit range,
  // timeframe, pan, or zoom chosen by the user outranks that request. The
  // preference remains live (the newest candle still updates and range-based
  // views still advance) until double-click explicitly restores the optimal
  // responsive view.
  let userViewportPreference = hasRestoredViewport;
  let dataRevision = 0, heikenCache = { revision: -1, data: null }, animation = null, animationFrame = null;
  let indicatorStudyCache = null;
  // Cache the indicator bitmap, with SVG fallback when canvas is unavailable.
  let indicatorMarkupCache = null;
  function cachedIndicatorOverlay(args, key) {
    const cached = indicatorMarkupCache;
    if (cached && cached.source === key.source && cached.warm === key.warm && cached.end === key.end
      && cached.layout === key.layout && cached.indicator === key.indicator
      && cached.upColor === key.upColor && cached.downColor === key.downColor && cached.intervalMs === key.intervalMs) {
      return cached.markup;
    }
    let markup = '';
    if (indicatorContext) {
      indicatorContext.clearRect(0, 0, settings.width, settings.height);
      renderSamsaraOverlayCanvas(indicatorContext, { ...args, inkColor: indicatorInk });
    } else markup = renderSamsaraOverlaySVG(args);
    indicatorMarkupCache = { ...key, markup };
    return markup;
  }
  // Reuse the candle bitmap (or fallback SVG) while geometry and colours match.
  let candleMarkupCache = null;
  const listeners = new Map();

  // A pane is a strip stacked below the price plot with its own y-scale,
  // rendered by consumer-supplied markup -- this service stays data-
  // agnostic (see the module README): it only reserves the space, resizes
  // it, and hands the pane's render() the same xOfTime the price chart
  // itself uses, so a caller's series lines up with the price candles/line
  // without knowing anything about what that series *is*.
  //   { id: string, height: number, render(ctx) => htmlString,
  //     resizable?: boolean, minHeight?: number, maxHeight?: number }
  //   ctx: { data, xOfTime, width, height, domain, textColor, gridColor }
  // WHICH panes exist is fixed at creation -- only pane *data*, and (for a
  // pane marked resizable) its *height*, are live afterward: height starts
  // at the spec's own `height` and can change via a drag on the pane's own
  // resize handle, or programmatically via chart.setPaneHeight(id, height).
  const paneSpecs = Array.isArray(options.panes)
    ? options.panes.filter(pane => pane && pane.id && Number(pane.height) > 0 && typeof pane.render === 'function')
    : [];
  const PANE_MIN_HEIGHT = 24, PANE_MAX_HEIGHT = 400;
  const paneHeights = new Map(paneSpecs.map(pane => [pane.id, Math.max(1, Math.round(pane.height))]));
  const paneVisibility = new Map(paneSpecs.map(pane => [pane.id, true]));
  const paneData = new Map();
  const paneElements = new Map();
  const paneHandleElements = new Map();

  const host = document.createElement('div');
  host.className = 'atmos-chart';
  host.style.cssText = `position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:80px;overflow:visible;touch-action:none;background:${settings.background};user-select:none`;
  // The same panel surface is used by both consumers, including its outer margins.
  const surface = options.surface || container;
  const previousSurfaceBackground = surface.style.background;
  // `container` sits flush against `surface`'s edges, reserving room for the
  // price axis (right) and the toolbar dock (bottom) -- this used to be a
  // `position:absolute;inset:...` rule each consumer hand-wrote in its own
  // CSS. That let the two copies drift (the markets panel kept a stray 16px
  // top / 20px left gap the portfolio chart never had), so it now lives here
  // once, applied inline, and a caller only needs to override it via
  // `options.edgeInset` for a genuinely different layout.
  //
  // The 14px default bottom inset assumes this chart is docking its own
  // internally-built toolbar (buildToolbar()'s non-`config.element` branch)
  // inside that reserved strip. A caller supplying its own external toolbar
  // element (`options.toolbar.element`, bound in buildToolbar() below) is
  // laying that toolbar out itself -- nothing here needs the strip -- so
  // that case defaults to 0 instead. Every consumer that passes a custom
  // toolbar element used to have to know and repeat `edgeInset: { bottom: 0
  // }` itself; an explicit `options.edgeInset` still overrides either
  // default for a genuinely different layout.
  const previousContainerCssText = container.style.cssText;
  if (container !== surface) {
    const defaultBottomInset = options.toolbar?.element ? 0 : 14;
    const edgeInset = { top: 0, right: 20, bottom: defaultBottomInset, left: 0, ...(options.edgeInset || {}) };
    container.style.position = 'absolute';
    container.style.inset = `${edgeInset.top}px ${edgeInset.right}px ${edgeInset.bottom}px ${edgeInset.left}px`;
    container.style.minHeight = '0';
    container.style.overflow = 'visible';
  }
  function applyBackground(shared = getChartSettings()) {
    surface.style.background = `rgba(var(--surface-rgb),${shared.backgroundOpacity})`;
  }
  applyBackground();
  const priceHost = document.createElement('div');
  priceHost.className = 'atmos-chart__price-host';
  priceHost.style.cssText = 'position:relative;flex:1;min-height:0;';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'atmos-chart__svg'); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  svg.setAttribute('aria-label', settings.ariaLabel || 'Time series chart'); svg.setAttribute('role', 'img');
  // Keep pointer graphics on a separate surface so their paint invalidations
  // do not include the candle and indicator SVG.
  const interactionSvg = document.createElementNS(SVG_NS, 'svg');
  interactionSvg.setAttribute('class', 'atmos-chart__interaction');
  interactionSvg.setAttribute('width', '100%');
  interactionSvg.setAttribute('height', '100%');
  interactionSvg.setAttribute('aria-hidden', 'true');
  interactionSvg.style.cssText = 'position:absolute;inset:0;pointer-events:none;transform:translateZ(0);';
  const contentGroup = document.createElementNS(SVG_NS, 'g');
  contentGroup.setAttribute('class', 'atmos-chart__content');
  const crosshairH = document.createElementNS(SVG_NS, 'line');
  crosshairH.setAttribute('class', 'atmos-chart__crosshair-h');
  crosshairH.setAttribute('stroke', 'rgba(var(--ink-rgb),.28)');
  crosshairH.setAttribute('stroke-dasharray', '3,3');
  crosshairH.style.display = 'none';
  const crosshairV = document.createElementNS(SVG_NS, 'line');
  crosshairV.setAttribute('class', 'atmos-chart__crosshair-v');
  crosshairV.setAttribute('stroke', 'rgba(var(--ink-rgb),.24)');
  crosshairV.setAttribute('stroke-dasharray', '3,3');
  crosshairV.style.display = 'none';
  const selectionRectEl = document.createElementNS(SVG_NS, 'rect');
  selectionRectEl.setAttribute('class', 'atmos-chart__selection');
  selectionRectEl.setAttribute('fill', 'rgba(248,113,113,.14)');
  selectionRectEl.setAttribute('stroke', '#f87171');
  selectionRectEl.style.display = 'none';
  const candleLayer = document.createElementNS(SVG_NS, 'foreignObject');
  candleLayer.setAttribute('class', 'atmos-chart__candle-layer');
  candleLayer.setAttribute('x', '0'); candleLayer.setAttribute('y', '0');
  candleLayer.style.pointerEvents = 'none';
  const candleCanvas = document.createElement('canvas');
  candleCanvas.setAttribute('aria-hidden', 'true');
  candleCanvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
  const candleContext = candleCanvas.getContext?.('2d') || null;
  candleLayer.append(candleCanvas);
  const axisGroup = document.createElementNS(SVG_NS, 'g');
  // Axes get their own surface that may draw past the plot's right edge, so
  // price labels can run to the screen edge like the crosshair's label. The
  // main SVG clips at its box, which cut them off after a digit or two.
  const axisSvg = document.createElementNS(SVG_NS, 'svg');
  axisSvg.setAttribute('class', 'atmos-chart__axes-layer');
  axisSvg.setAttribute('width', '100%'); axisSvg.setAttribute('height', '100%');
  axisSvg.setAttribute('aria-hidden', 'true');
  axisSvg.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;';
  axisSvg.append(axisGroup);
  let lastAxisMarkup = null;
  const indicatorLayer = document.createElementNS(SVG_NS, 'foreignObject');
  indicatorLayer.setAttribute('class', 'atmos-chart__indicator-layer');
  indicatorLayer.setAttribute('x', '0'); indicatorLayer.setAttribute('y', '0');
  indicatorLayer.style.pointerEvents = 'none';
  const indicatorCanvas = document.createElement('canvas');
  indicatorCanvas.setAttribute('aria-hidden', 'true');
  indicatorCanvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
  const indicatorContext = indicatorCanvas.getContext?.('2d') || null;
  indicatorLayer.append(indicatorCanvas);
  let indicatorInk = '#ffffff';
  // Put the bitmap beneath the price line, candles and axes.
  svg.append(indicatorLayer, contentGroup, candleLayer);
  interactionSvg.append(crosshairH, crosshairV, selectionRectEl);
  let lastContentMarkup = null;
  const tooltip = document.createElement('div');
  tooltip.className = 'atmos-chart__tooltip';
  tooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;padding:5px 7px;border-radius:6px;background:rgba(var(--surface-rgb),.88);color:rgb(var(--ink-rgb));font:11px/1.35 var(--app-font-family, system-ui, sans-serif);white-space:nowrap;transform:translate(8px,-50%);z-index:12';
  const priceLabel = document.createElement('div');
  const measurementLabel = document.createElement('div');
  measurementLabel.className = 'atmos-chart__measurement';
  measurementLabel.style.cssText = 'position:absolute;display:none;pointer-events:none;padding:6px 8px;border-radius:5px;background:rgba(var(--surface-rgb),.96);color:rgb(var(--ink-rgb));font:600 11px/1.4 var(--app-font-family,system-ui,sans-serif);white-space:pre-line;box-sizing:border-box;z-index:13';
  priceLabel.className = 'atmos-chart__price-label';
  priceLabel.style.cssText = "position:absolute;right:0;display:none;pointer-events:none;transform:translateY(-50%);padding:2px 6px;border-radius:2px;color:#fff;font:600 9px/1.35 var(--app-font-family, 'Segoe UI', Roboto, monospace);letter-spacing:.3px;white-space:nowrap;z-index:3";
  const stats = document.createElement('div');
  stats.className = 'atmos-chart__stats';
  stats.style.cssText = "position:absolute;top:0;left:0;display:flex;align-items:center;gap:6px;pointer-events:none;font:600 9px/1.35 'Segoe UI',Roboto,monospace;letter-spacing:.02em;z-index:3";
  const pointCount = document.createElement('span'); pointCount.className = 'atmos-chart__point-count'; pointCount.style.color = 'rgba(var(--ink-rgb),.4)'; stats.append(pointCount);
  const hoverValueLabel = document.createElement('div'); hoverValueLabel.className = 'atmos-chart__hover-value';
  hoverValueLabel.style.cssText = "position:absolute;right:0;display:none;pointer-events:none;transform:translateY(-50%);padding:2px 6px;border-radius:2px;background:rgba(var(--surface-rgb),.96);color:rgba(var(--ink-rgb),.9);font:600 9px/1.35 var(--app-font-family, 'Segoe UI', Roboto, monospace);z-index:4";
  const hoverTimeLabel = document.createElement('div'); hoverTimeLabel.className = 'atmos-chart__hover-time';
  hoverTimeLabel.style.cssText = "position:absolute;bottom:0;display:none;pointer-events:none;transform:translateX(-50%);padding:2px 6px;border-radius:3px;background:rgba(var(--surface-rgb),.96);color:rgba(var(--ink-rgb),.9);font:600 9px/1.35 var(--app-font-family, 'Segoe UI', Roboto, monospace);z-index:4";
  priceHost.append(svg, interactionSvg, axisSvg, tooltip, priceLabel, stats, hoverValueLabel, hoverTimeLabel, measurementLabel);
  const paneHostEls = [];
  for (const pane of paneSpecs) {
    if (pane.resizable) {
      const handle = document.createElement('div');
      handle.className = `atmos-chart__pane-handle atmos-chart__pane-handle--${pane.id}`;
      handle.style.cssText = 'flex:0 0 auto;height:6px;cursor:ns-resize;touch-action:none;position:relative;display:flex;align-items:center;justify-content:center;';
      const grip = document.createElement('div');
      grip.style.cssText = 'width:28px;height:2px;border-radius:1px;background:rgba(var(--ink-rgb),.18);pointer-events:none;';
      handle.append(grip);
      paneHandleElements.set(pane.id, handle);
      paneHostEls.push(handle);
    }
    const paneEl = document.createElementNS(SVG_NS, 'svg');
    paneEl.setAttribute('class', `atmos-chart__pane atmos-chart__pane--${pane.id}`);
    paneEl.setAttribute('width', '100%'); paneEl.setAttribute('height', '100%');
    paneEl.setAttribute('preserveAspectRatio', 'none');
    paneEl.style.cssText = `display:block;flex:0 0 auto;width:100%;height:${paneHeights.get(pane.id)}px;touch-action:none;`;
    paneElements.set(pane.id, paneEl);
    paneHostEls.push(paneEl);
  }
  host.append(priceHost, ...paneHostEls); container.replaceChildren(host);

  const viewport = createChartViewport({
    mode: settings.type, timelineMode: settings.timelineMode, bucketMs: settings.bucketMs || 60_000,
    padding: settings.padding, candleDefaultCount: settings.targetCandles, activeRangeKey: settings.activeRangeKey,
    ...(restoredOptions.lineWindow != null ? { lineWindow: restoredOptions.lineWindow } : {}),
    lineOffset: restoredOptions.lineOffset,
    candleSpanMs: restoredOptions.candleSpanMs, candleOffsetMs: restoredOptions.candleOffsetMs,
    priceScale: settings.priceScale,
  });
  function emit(name, detail) { for (const listener of listeners.get(name) || []) listener(detail); }
  function persistInstanceState() {
    if (!options.stateKey) return;
    const viewportState = viewport.getState();
    writeStored(`charting-instance:${options.stateKey}`, {
      type: settings.type, timelineMode: settings.timelineMode, bucketMs: settings.bucketMs,
      priceScale: settings.priceScale,
      showTimeAxis: settings.showTimeAxis, showPriceAxis: settings.showPriceAxis,
      bridgeFromPreviousClose: settings.bridgeFromPreviousClose, followLatest: settings.followLatest,
      activeRangeKey: viewportState.activeRangeKey, indicatorEnabled: localIndicatorEnabled,
      lineWindow: viewportState.lineWindow, lineOffset: viewportState.lineOffset,
      candleSpanMs: viewportState.candleSpanMs, candleOffsetMs: viewportState.candleOffsetMs,
    });
  }
  function hidden(time) { return settings.hiddenRanges.some(range => time >= range.tStart && time <= range.tEnd); }
  function capped(items) { return items.length > settings.maxPoints ? items.slice(-settings.maxPoints) : items; }

  function rebuildData({ resetViewport = false } = {}) {
    stopAnimation();
    const visibleSource = sourceData.filter(point => !hidden(pointTime(point)));
    if (settings.type === 'line') {
      data = capped(visibleSource.map(normalizeLinePoint).filter(Boolean).sort((a, b) => a.time - b.time)); candleSamples = null;
    } else {
      const candles = visibleSource.map(normalizeCandle).filter(Boolean);
      if (candles.length === visibleSource.length && candles.length) {
        candleSamples = null; data = capped(candles.sort((a, b) => a.t0 - b.t0)); effectiveBucketMs = settings.bucketMs || Math.max(1, data[0].t1 - data[0].t0);
      } else {
        candleSamples = capped(visibleSource.map(normalizeLinePoint).filter(Boolean).sort((a, b) => a.time - b.time));
        const samples = candleSamples.map(point => ({ ...point, t: point.time, v: point.value }));
        effectiveBucketMs = settings.bucketMs || pickBucketMs(samples, settings.targetCandles); data = bucketHistory(samples, effectiveBucketMs);
      }
    }
    dataRevision++; heikenCache = { revision: -1, data: null }; viewport.setOptions({ bucketMs: effectiveBucketMs }); if (resetViewport) viewport.reset();
  }

  function renderedData() {
    let output = data;
    if (settings.type === 'heiken-ashi') {
      if (heikenCache.revision !== dataRevision) {
        if (heikenCache.data?.length === data.length && data.length) {
          heikenCache.data[heikenCache.data.length - 1] = heikenAshiStep(heikenCache.data.length > 1 ? heikenCache.data.at(-2) : null, data.at(-1));
        } else if (heikenCache.data?.length + 1 === data.length) {
          heikenCache.data.push(heikenAshiStep(heikenCache.data.at(-1) || null, data.at(-1)));
        } else heikenCache.data = heikenAshi(data);
        heikenCache.revision = dataRevision;
      }
      output = heikenCache.data;
    }
    if (!animation || !output.length) return output;
    animation.display[animation.display.length - 1] = settings.type === 'heiken-ashi'
      ? heikenAshiStep(output.length > 1 ? output.at(-2) : null, animation.value)
      : animation.value;
    return animation.display;
  }

  function stopAnimation() { if (animationFrame != null) globalThis.cancelAnimationFrame?.(animationFrame); animationFrame = null; animation = null; }
  function animateCandle(previous, target) {
    previous = animation?.value?.t0 === target?.t0 ? animation.value : previous;
    stopAnimation(); const raf = globalThis.requestAnimationFrame;
    if (!settings.candleAnimation || settings.type === 'line' || typeof raf !== 'function' || !(settings.candleAnimationDuration > 0) || previous?.t0 !== target?.t0) return;
    const base = settings.type === 'heiken-ashi'
      ? (heikenCache.revision === dataRevision ? heikenCache.data : heikenAshi(data))
      : data;
    const start = globalThis.performance?.now?.() ?? Date.now(); animation = { value: previous, display: base.slice(), frame: 0 };
    const tick = now => { if (!animation || destroyed) return; const progress = Math.min(1, ((now ?? Date.now()) - start) / settings.candleAnimationDuration); const eased = 1 - Math.pow(1 - progress, 3); animation.value = Object.freeze({ ...target, o: previous.o + (target.o - previous.o) * eased, h: previous.h + (target.h - previous.h) * eased, l: previous.l + (target.l - previous.l) * eased, c: previous.c + (target.c - previous.c) * eased }); animation.frame++; render(); if (progress < 1) animationFrame = raf(tick); else stopAnimation(); };
    animationFrame = raf(tick);
  }

  function samsaraStudyFor(values, config, source, warm, end) {
    const cached = indicatorStudyCache;
    if (!animation && cached && cached.revision === dataRevision && cached.source === source && cached.warm === warm
      && cached.end === end && cached.config === config && cached.length === values.length) {
      return cached.study;
    }
    const study = buildSamsaraStudy(values, config);
    if (!animation) indicatorStudyCache = { revision: dataRevision, source, warm, end, config, length: values.length, study };
    return study;
  }

  // Mixes colorA toward colorB by (1 - weightA) — e.g. mixHex(upColor,
  // '#ffffff', 1) is plain upColor, mixHex(upColor, '#ffffff', 0) is plain
  // white. Blending toward white rather than directly toward downColor is
  // deliberate: red+green (or whichever pair a user picked) averaged
  // together lands on a muddy brown, not a meaningful "neutral" — fading
  // to white instead reads as "the signal is weak/mixed", which is the
  // actual thing consensus coloring is trying to show. Falls back to the
  // untouched color if either side isn't a plain 6-digit hex.
  function mixHex(colorA, colorB, weightA) {
    const a = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colorA);
    const b = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colorB);
    if (!a || !b) return colorA;
    const mix = (x, y) => Math.round(parseInt(x, 16) * weightA + parseInt(y, 16) * (1 - weightA));
    return `rgb(${mix(a[1], b[1])},${mix(a[2], b[2])},${mix(a[3], b[3])})`;
  }

  // Every enabled moving average "votes" up or down for each candle
  // (close vs. that MA's prior-bar value, same comparison the single-MA
  // basis already uses). A candle where all five agree gets the full
  // up/down color; one where they're split gets faded toward white in
  // proportion to how split it is — full white at an even split, same as
  // low-confidence readings elsewhere in this app (the allocation donut,
  // the session ticks) fade toward white rather than toward a hue.
  // colorCandles resolvers used to rebuild their whole colors Map (and, for
  // 'consensus', 5 full moving averages over every visible candle) on
  // *every* render() call -- including pure hover/crosshair redraws where
  // the visible candle set hasn't changed at all. `source` is the stable
  // renderedData() output (same reference across hover-only re-renders,
  // see samsaraStudyFor above for the same reasoning) and `warm`/`end`
  // bound the same slice each time nothing about the pan/zoom/data has
  // moved, so caching on those plus the colors -- same pattern as
  // samsaraStudyFor -- turns a repeat call back into a cache hit. Session
  // basis needs no caching at all since it derives purely from `candle.t0`
  // with no per-render computation, so it's hoisted to one stable resolver
  // reference (that stability also matters for the candle-markup cache
  // below, which is keyed in part on the colorOf resolver's identity).
  const SESSION_COLOR_RESOLVER = (candle, _index, _fallback) => mergedUtcSession(candle.t0).color;

  let consensusColorCache = null;
  function consensusColorResolver(candles, source, warm, end) {
    const cached = consensusColorCache;
    if (!animation && cached && cached.revision === dataRevision && cached.source === source && cached.warm === warm && cached.end === end
      && cached.upColor === settings.upColor && cached.downColor === settings.downColor && cached.length === candles.length) {
      return cached.resolver;
    }
    const closes = candles.map(candle => candle.c);
    const studies = SAMSARA_DEFAULTS.movingAverages.map(ma => movingAverage(closes, ma.type, ma.length));
    const colors = new Map();
    for (let index = 1; index < candles.length; index++) {
      let up = 0, down = 0;
      for (const values of studies) {
        const prior = values[index - 1];
        if (!Number.isFinite(prior)) continue;
        if (closes[index] > prior) up++; else if (closes[index] < prior) down++;
      }
      const total = up + down;
      if (!total) continue;
      const confidence = Math.abs(up - down) / total;
      colors.set(candles[index].t0, mixHex(up >= down ? settings.upColor : settings.downColor, '#ffffff', confidence));
    }
    const resolver = (candle, _index, fallback) => colors.get(candle.t0) || fallback;
    if (!animation) consensusColorCache = { revision: dataRevision, source, warm, end, upColor: settings.upColor, downColor: settings.downColor, length: candles.length, resolver };
    return resolver;
  }

  let maColorCache = null;
  function maColorResolver(candles, source, warm, end, maIndex) {
    const ma = SAMSARA_DEFAULTS.movingAverages[maIndex];
    if (!ma) return null;
    const cached = maColorCache;
    if (!animation && cached && cached.revision === dataRevision && cached.source === source && cached.warm === warm && cached.end === end
      && cached.maIndex === maIndex && cached.upColor === settings.upColor && cached.downColor === settings.downColor && cached.length === candles.length) {
      return cached.resolver;
    }
    const averages = movingAverage(candles.map(candle => candle.c), ma.type, ma.length), colors = new Map();
    for (let index = 1; index < candles.length; index++) if (Number.isFinite(averages[index - 1])) colors.set(candles[index].t0, candles[index].c > averages[index - 1] ? settings.upColor : settings.downColor);
    const resolver = (candle, _index, fallback) => colors.get(candle.t0) || fallback;
    if (!animation) maColorCache = { revision: dataRevision, source, warm, end, maIndex, upColor: settings.upColor, downColor: settings.downColor, length: candles.length, resolver };
    return resolver;
  }

  function candleColorResolver(candles, source, warm, end) {
    if (!settings.indicator?.colorCandles) return null;
    const basis = settings.indicator.candleColorBasis || 'session'; if (basis === 'session') return SESSION_COLOR_RESOLVER;
    if (basis === 'consensus') return consensusColorResolver(candles, source, warm, end);
    return maColorResolver(candles, source, warm, end, Number(basis.slice(2)) - 1);
  }

  function timeAxisMarkup(layout) {
    if (!settings.showTimeAxis || !layout.domain || !(layout.plotWidth > 0)) return '';
    // Sample the viewport mapping so compressed/gapless timelines stay aligned.
    const count = Math.max(1, Math.floor(layout.plotWidth / 110));
    const bottom = settings.height - settings.padding.bottom;
    const span = layout.domain.to - layout.domain.from;
    const seen = new Set();
    return Array.from({ length: count }, (_, index) => {
      const x = settings.padding.left + (index + .5) * layout.plotWidth / count;
      const time = layout.timeAtPixel(x);
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      const label = span >= 2 * 86400000
        ? date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(span >= 365 * 86400000 ? { year: '2-digit' } : {}) })
        : settings.formatTime(time);
      if (seen.has(label)) return '';
      seen.add(label);
      const grid = settings.gridColor === 'transparent' ? '' : `<line x1="${x.toFixed(1)}" y1="${settings.padding.top}" x2="${x.toFixed(1)}" y2="${bottom}" stroke="${escapeXml(settings.gridColor)}"/>`;
      return `<g class="atmos-chart__time-tick">${grid}<text x="${x.toFixed(1)}" y="${bottom + 14}" fill="${escapeXml(settings.textColor)}" text-anchor="middle" font-family="var(--app-font-family, system-ui, sans-serif)" font-size="9">${escapeXml(label)}</text></g>`;
    }).join('');
  }

  // Price tick labels end where the crosshair's price label ends: flush to
  // the same right edge (its CSS right offset) less the label's 6px padding,
  // so the whole number shows instead of running off the screen edge.
  function priceTickTextX() {
    if (settings.axisEdgeOffset != null) return settings.width + (Number(settings.axisEdgeOffset) || 0) - 10;
    const labelRight = settings.priceLabelRight ?? -measuredAxisEdgeOffset;
    return settings.width - labelRight - 6;
  }

  function axisMarkup(layout) {
    const timeAxis = timeAxisMarkup(layout);
    if (!settings.showPriceAxis || !layout.ticks.length) return timeAxis;
    return timeAxis + layout.ticks.map(tick => { const y = layout.yOfPrice(tick.value); const grid = settings.gridColor === 'transparent' ? '' : `<line x1="${settings.padding.left}" y1="${y.toFixed(1)}" x2="${settings.width - settings.padding.right}" y2="${y.toFixed(1)}" stroke="${escapeXml(settings.gridColor)}"/>`; return `${grid}<text x="${priceTickTextX().toFixed(1)}" y="${y.toFixed(1)}" fill="${escapeXml(settings.textColor)}" text-anchor="end" dominant-baseline="middle" font-family="var(--app-font-family, 'Segoe UI', Roboto, monospace)" font-size="9">${escapeXml(settings.formatValue(tick.value))}</text>`; }).join('');
  }

  let lineMarkupCache = null;
  let renderedStatus = null;
  let batchDepth = 0, renderPending = false;
  const paneMarkup = new Map();
  function batch(callback) {
    batchDepth++;
    try { callback(api); }
    finally { if (--batchDepth === 0 && renderPending) { renderPending = false; render(); } }
    return api;
  }
  function render() {
    if (batchDepth) { renderPending = true; return; }
    if (destroyed) return;
    if (renderedStatus !== settings.status) {
      stats.querySelectorAll?.('[data-chart-status]')?.forEach?.(element => element.remove());
      for (const item of settings.status) {
        const label = document.createElement('span'); label.dataset.chartStatus = item.key;
        label.textContent = item.value; label.title = item.title; label.style.color = item.color;
        stats.insertBefore?.(label, pointCount);
      }
      renderedStatus = settings.status;
    }
    const pixelRatio = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
    indicatorLayer.style.display = indicatorContext && settings.indicator && data.length ? '' : 'none';
    if (indicatorContext && settings.indicator) {
      const width = Math.max(1, Math.round(settings.width * pixelRatio));
      const height = Math.max(1, Math.round(settings.height * pixelRatio));
      const ink = globalThis.getComputedStyle?.(host).getPropertyValue('--ink-rgb').trim();
      const inkColor = ink ? 'rgb(' + ink + ')' : '#ffffff';
      if (indicatorInk !== inkColor || indicatorCanvas.width !== width || indicatorCanvas.height !== height) {
        indicatorCanvas.width = width; indicatorCanvas.height = height;
        indicatorInk = inkColor; indicatorMarkupCache = null;
      }
      indicatorLayer.setAttribute('width', settings.width); indicatorLayer.setAttribute('height', settings.height);
      indicatorContext.setTransform(width / settings.width, 0, 0, height / settings.height, 0, 0);
    }
    const useCanvas = !!candleContext && settings.type !== 'line';
    candleLayer.style.display = useCanvas && data.length ? '' : 'none';
    if (useCanvas) {
      const width = Math.max(1, Math.round(settings.width * pixelRatio));
      const height = Math.max(1, Math.round(settings.height * pixelRatio));
      if (candleCanvas.width !== width || candleCanvas.height !== height) {
        candleCanvas.width = width; candleCanvas.height = height;
        candleMarkupCache = null;
      }
      candleLayer.setAttribute('width', settings.width);
      candleLayer.setAttribute('height', settings.height);
      candleContext.setTransform(width / settings.width, 0, 0, height / settings.height, 0, 0);
    }
    const source = renderedData(), layout = viewport.calculate(source, dataRevision + (animation ? animation.frame / 1_000_000 : 0), true);
    for (const pane of paneSpecs) {
      const element = paneElements.get(pane.id);
      if (!element || paneVisibility.get(pane.id) === false) continue;
      let markup = '';
      try {
        markup = pane.render({
          data: paneData.get(pane.id) || [], xOfTime: layout.xOfTime,
          width: settings.width, height: paneHeights.get(pane.id) ?? pane.height, domain: layout.domain,
          textColor: settings.textColor, gridColor: settings.gridColor,
        }) || '';
      } catch (error) { console.warn(`[atmos-chart] pane "${pane.id}" render failed:`, error); }
      if (paneMarkup.get(pane.id) !== markup) {
        element.innerHTML = markup;
        paneMarkup.set(pane.id, markup);
      }
    }
    if (!layout.visible.length) { indicatorLayer.style.display = 'none'; candleLayer.style.display = 'none'; axisGroup.innerHTML = ''; lastAxisMarkup = null; const emptyMarkup = `<text x="50%" y="50%" fill="${escapeXml(settings.textColor)}" text-anchor="middle" font-family="var(--app-font-family, system-ui, sans-serif)" font-size="12">No chart data</text>`; if (lastContentMarkup !== emptyMarkup) { contentGroup.innerHTML = emptyMarkup; lastContentMarkup = emptyMarkup; } crosshairH.style.display = crosshairV.style.display = selectionRectEl.style.display = 'none'; measurementLabel.style.display = priceLabel.style.display = hoverValueLabel.style.display = hoverTimeLabel.style.display = 'none'; pointCount.textContent = ''; return; }
    let chartMarkup = '', indicatorMarkup = '';
    if (settings.type === 'line') {
      const visible = layout.visible;
      const cachedLine = lineMarkupCache;
      if (cachedLine && cachedLine.layout === layout && cachedLine.smoothing === settings.smoothing
        && cachedLine.color === settings.lineColor && cachedLine.opacity === settings.lineOpacity) {
        chartMarkup = cachedLine.markup;
      } else {
        const values = smoothValues(visible.map(point => point.value), settings.smoothing), points = visible.map((point, index) => `${layout.xOfTime(point.time).toFixed(1)},${layout.yOfPrice(values[index]).toFixed(1)}`);
        chartMarkup = `<path class="atmos-chart__line" d="M ${points.join(' L ')}" fill="none" stroke="${escapeXml(settings.lineColor)}" stroke-opacity="${settings.lineOpacity.toFixed(3)}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>`;
        lineMarkupCache = { layout, smoothing: settings.smoothing, color: settings.lineColor,
          opacity: settings.lineOpacity, markup: chartMarkup };
      }
      if (settings.indicator) {
        const first = Math.max(0, visible[0].index), warm = Math.max(0, first - 500), end = visible.at(-1).index, study = source.slice(warm, end + 1), x = new Map(visible.map(point => [point.time, layout.xOfTime(point.time)])), indicatorValues = study.map(point => point.value);
        // See the candle-mode branch's matching comment below -- same fix,
        // one point earlier so the overlay line/RSI-state/session strip has
        // a real pixel to start its first segment from instead of leaving a
        // bare gap between the pane's left edge and the first visible point.
        const edgeIndex = Math.max(warm, first - 1);
        const edgePoint = source[edgeIndex];
        if (edgePoint && !x.has(edgePoint.time)) x.set(edgePoint.time, layout.xOfTime(edgePoint.time));
        indicatorMarkup = cachedIndicatorOverlay({ values: indicatorValues, times: study.map(point => point.time), xs: study.map(point => x.get(point.time) ?? NaN), renderFrom: edgeIndex - warm, yOf: layout.yOfPrice, plotTop: settings.padding.top, plotHeight: layout.plotHeight, bullishColor: settings.upColor, bearishColor: settings.downColor, config: settings.indicator, clipId: `atmos-chart-indicator-${chartId}`, study: samsaraStudyFor(indicatorValues, settings.indicator, source, warm, end), intervalMs: effectiveBucketMs }, { source, warm, end, layout, indicator: settings.indicator, upColor: settings.upColor, downColor: settings.downColor, intervalMs: effectiveBucketMs });
      }
    } else {
      const candles = layout.visible.map(item => item.source), first = Math.max(0, layout.visible[0].index), warm = Math.max(0, first - 500), end = layout.visible.at(-1).index, study = source.slice(warm, end + 1), x = new Map(candles.map(candle => [candle.t0, layout.xOfTime(candle.t0)]));
      // One candle before the first visible one, mapped for x too -- a
      // line/RSI-state/session indicator has nothing to draw before its
      // first plotted point (unlike a candle body, which fills its own
      // slot), so starting exactly at `first` left a bare gap between the
      // pane's left edge and that point. `study`/`warm` already reach back
      // this far for VALUE accuracy (the MA/RSI math needs lookback); this
      // just lets the render loops (renderSamsaraOverlaySVG's renderFrom)
      // use one more of those already-computed points too.
      const edgeIndex = Math.max(warm, first - 1);
      const edgeCandle = source[edgeIndex];
      if (edgeCandle && !x.has(edgeCandle.t0)) x.set(edgeCandle.t0, layout.xOfTime(edgeCandle.t0));
      if (settings.indicator) { const indicatorValues = study.map(candle => candle.c); indicatorMarkup = cachedIndicatorOverlay({ values: indicatorValues, times: study.map(candle => candle.t0), xs: study.map(candle => x.get(candle.t0) ?? NaN), renderFrom: edgeIndex - warm, yOf: layout.yOfPrice, plotTop: settings.padding.top, plotHeight: layout.plotHeight, bullishColor: settings.upColor, bearishColor: settings.downColor, config: settings.indicator, clipId: `atmos-chart-indicator-${chartId}`, study: samsaraStudyFor(indicatorValues, settings.indicator, source, warm, end), intervalMs: effectiveBucketMs }, { source, warm, end, layout, indicator: settings.indicator, upColor: settings.upColor, downColor: settings.downColor, intervalMs: effectiveBucketMs }); }
      const colorOf = candleColorResolver(study, source, warm, end);
      const cachedMarkup = candleMarkupCache;
      if (cachedMarkup && cachedMarkup.layout === layout && cachedMarkup.colorOf === colorOf
        && cachedMarkup.upColor === settings.upColor && cachedMarkup.downColor === settings.downColor
        && cachedMarkup.bridge === settings.bridgeFromPreviousClose && cachedMarkup.pixelRatio === pixelRatio) {
        chartMarkup = cachedMarkup.markup;
      } else {
        const drawOptions = { candles, W: settings.width, H: settings.height, padLeft: settings.padding.left, padRight: settings.padding.right, padTop: settings.padding.top, padBottom: settings.padding.bottom, colorUp: settings.upColor, colorDown: settings.downColor, xOf: candle => layout.xOfTime(candle.t0), bodyWidth: layout.bodyWidth, yOf: layout.yOfPrice, bridgeFromPreviousClose: settings.bridgeFromPreviousClose, colorOf };
        if (useCanvas) renderCandlesCanvas(candleContext, drawOptions);
        else chartMarkup = renderCandlesSVG(drawOptions);
        candleMarkupCache = { layout, colorOf, upColor: settings.upColor, downColor: settings.downColor, bridge: settings.bridgeFromPreviousClose, pixelRatio, markup: chartMarkup };
      }
    }
    const last = layout.visible.at(-1), currentValue = settings.type === 'line' ? last?.value : last?.c, firstValue = settings.type === 'line' ? layout.visible[0]?.value : layout.visible[0]?.o, priceColor = currentValue >= firstValue ? settings.upColor : settings.downColor, currentY = Number.isFinite(currentValue) ? layout.yOfPrice(currentValue) : null;
    const priceLine = settings.showCurrentPriceLine && currentY != null ? `<line x1="${settings.padding.left}" y1="${currentY.toFixed(1)}" x2="${settings.width - settings.padding.right}" y2="${currentY.toFixed(1)}" stroke="${escapeXml(priceColor)}" stroke-width="0.6" stroke-dasharray="2,4" opacity="0.35"/>` : '';
    if (settings.showCurrentPriceLine && currentY != null) { priceLabel.textContent = settings.formatValue(currentValue); priceLabel.style.display = 'block'; priceLabel.style.top = `${currentY}px`; priceLabel.style.background = priceColor; } else priceLabel.style.display = 'none';
    pointCount.textContent = settings.showPointCount ? String(layout.visible.length) : '';
    const liveMarker = settings.type === 'line' && settings.showLiveMarker && settings.showCurrentPriceLine && currentY != null ? `<defs><style>@keyframes atmos-chart-pulse{0%{r:4;opacity:.7}100%{r:10;opacity:0}}.atmos-chart__live-ring{animation:atmos-chart-pulse 2s ease-out infinite}</style></defs><circle class="atmos-chart__live-ring" cx="${layout.xOfTime(last.time).toFixed(1)}" cy="${currentY.toFixed(1)}" r="4" fill="none" stroke="${escapeXml(priceColor)}"/><circle cx="${layout.xOfTime(last.time).toFixed(1)}" cy="${currentY.toFixed(1)}" r="2.5" fill="${escapeXml(priceColor)}"/>` : '';
    svg.setAttribute('viewBox', `0 0 ${settings.width} ${settings.height}`);
    axisSvg.setAttribute('viewBox', `0 0 ${settings.width} ${settings.height}`);
    // Preserve stacking: indicators and price line, candle bitmap, then axes.
    const contentMarkup = `${indicatorMarkup}${priceLine}${chartMarkup}${liveMarker}`;
    if (contentMarkup !== lastContentMarkup) { contentGroup.innerHTML = contentMarkup; lastContentMarkup = contentMarkup; }
    const axes = axisMarkup(layout);
    if (axes !== lastAxisMarkup) { axisGroup.innerHTML = axes; lastAxisMarkup = axes; }
    interactionSvg.setAttribute('viewBox', `0 0 ${settings.width} ${settings.height}`);
    renderInteraction(layout);
  }

  function renderInteraction(layout = viewport.getLayout()) {
    if (destroyed) return;
    measurementLabel.style.display = 'none';
    if (!layout.visible.length) {
      crosshairH.style.display = crosshairV.style.display = selectionRectEl.style.display = 'none';
      hoverValueLabel.style.display = hoverTimeLabel.style.display = 'none';
      return;
    }
    if (hover && settings.showHoverLabels) { hoverValueLabel.textContent = settings.formatValue(hover.value); hoverValueLabel.style.display = 'block'; hoverValueLabel.style.top = `${hover.y}px`; hoverTimeLabel.textContent = settings.formatTime(hover.time); hoverTimeLabel.style.display = settings.showTimeHoverLabel ? 'block' : 'none'; hoverTimeLabel.style.left = `${hover.x}px`; } else hoverValueLabel.style.display = hoverTimeLabel.style.display = 'none';
    // Crosshair and drag-selection change on every hover/drag pixel and
    // never share content with the cached markup above, so they're plain
    // attribute updates on persistent elements instead of being rebuilt as
    // part of that string.
    if (hover && settings.showCrosshair) {
      crosshairH.setAttribute('x1', settings.padding.left); crosshairH.setAttribute('y1', hover.y.toFixed(1));
      crosshairH.setAttribute('x2', settings.width - settings.padding.right); crosshairH.setAttribute('y2', hover.y.toFixed(1));
      crosshairH.style.display = '';
      crosshairV.setAttribute('x1', hover.x.toFixed(1)); crosshairV.setAttribute('y1', settings.padding.top);
      crosshairV.setAttribute('x2', hover.x.toFixed(1)); crosshairV.setAttribute('y2', settings.height - settings.padding.bottom);
      crosshairV.style.display = '';
    } else {
      crosshairH.style.display = crosshairV.style.display = 'none';
    }
    if (selection) {
      const measuring = selection.mode === 'measure';
      selectionRectEl.setAttribute('fill', measuring ? 'rgba(96,165,250,.14)' : 'rgba(248,113,113,.14)');
      selectionRectEl.setAttribute('stroke', measuring ? '#60a5fa' : '#f87171');
      selectionRectEl.setAttribute('x', Math.min(selection.startX, selection.x).toFixed(1));
      selectionRectEl.setAttribute('y', measuring ? Math.min(selection.startY, selection.y) : settings.padding.top);
      selectionRectEl.setAttribute('width', Math.abs(selection.x - selection.startX).toFixed(1));
      selectionRectEl.setAttribute('height', measuring ? Math.abs(selection.y - selection.startY) : layout.plotHeight);
      if (measuring) {
        const start = layout.priceAtPixel(selection.startY), delta = layout.priceAtPixel(selection.y) - start;
        const percent = start === 0 ? null : delta / Math.abs(start) * 100;
        let remaining = Math.round(Math.abs(layout.timeAtPixel(selection.x) - layout.timeAtPixel(selection.startX)) / 1000);
        const elapsed = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']].map(([unit, suffix]) => {
          const count = Math.floor(remaining / unit); remaining %= unit;
          return count ? `${count}${suffix}` : '';
        }).filter(Boolean).join(' ') || '0s';
        const sign = value => value > 0 ? '+' : value < 0 ? '−' : '';
        measurementLabel.textContent = `${elapsed}\n${percent == null ? 'N/A' : sign(percent) + Math.abs(percent).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%'}  ·  ${sign(delta)}$${Math.abs(delta).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
        measurementLabel.style.display = 'block';
        measurementLabel.style.maxWidth = `${layout.plotWidth}px`;
        measurementLabel.style.left = `${Math.max(settings.padding.left, Math.min(selection.x + 10, settings.width - settings.padding.right - (measurementLabel.offsetWidth || 180)))}px`;
        measurementLabel.style.top = `${Math.max(settings.padding.top, Math.min(selection.y + 10, settings.height - settings.padding.bottom - (measurementLabel.offsetHeight || 48)))}px`;
        tooltip.style.display = 'none';
      }
      selectionRectEl.style.display = '';
    } else {
      selectionRectEl.style.display = 'none';
    }
  }

  function setData(nextData = [], behavior = {}) {
    if (!Array.isArray(nextData)) throw new TypeError('chart data must be an array');
    stopAnimation();
    const hadData = sourceData.length > 0;
    const previousViewport = viewport.getState();
    sourceData = nextData.slice();
    const preserveUserViewport = behavior.preserveViewport !== false || userViewportPreference;
    rebuildData({ resetViewport: !preserveUserViewport && hadData });
    if (preserveUserViewport && previousViewport.domain && previousViewport.pan && !previousViewport.pan.live && data.length) {
      if (settings.type === 'line') {
        const anchor = data.findIndex(point => point.time >= previousViewport.domain.from);
        viewport.setOptions({ lineOffset: Math.max(0, anchor) });
      } else {
        viewport.setOptions({
          candleSpanMs: Math.max(1, previousViewport.domain.to - previousViewport.domain.from),
          candleOffsetMs: Math.max(0, previousViewport.domain.from - data[0].t0),
        });
      }
    }
    render(); emit('data', getState()); return api;
  }
  function appendSource(point, replaceLatest = false) { if (replaceLatest && sourceData.length) sourceData[sourceData.length - 1] = point; else sourceData.push(point); if (sourceData.length > settings.maxPoints) sourceData.splice(0, sourceData.length - settings.maxPoints); }
  function updateTail(point, replaceLatest = false) {
    // No separate "Live" toggle anymore — whether new data scrolls the
    // view is decided purely by viewport.pan.live (are we currently parked
    // at the newest edge, or did the user pan/zoom away from it?), same as
    // TradingView. pan.live already tracks that on its own (see viewport.js:
    // panPixels() snaps candleOffsetMs/lineOffset back to null once you drag
    // back to the live edge), so nothing here needs to force anything: if
    // pan.live is true the next render naturally shows the new tail; if
    // it's false the pinned offset is untouched and the view doesn't move.
    const previousCandle = settings.type === 'line' ? null : data.at(-1); appendSource(point, replaceLatest); if (hidden(pointTime(point))) { rebuildData(); return; }
    if (settings.type === 'line') { const normalized = normalizeLinePoint(point); if (!normalized) throw new TypeError('invalid chart point'); if (replaceLatest && data.length) data[data.length - 1] = normalized; else data.push(normalized); }
    else if (candleSamples) { const sample = normalizeLinePoint(point); if (!sample) throw new TypeError('invalid chart point'); if (replaceLatest && candleSamples.length) candleSamples[candleSamples.length - 1] = sample; else candleSamples.push(sample); const t0 = Math.floor(sample.time / effectiveBucketMs) * effectiveBucketMs, last = data.at(-1); if (last?.t0 === t0 && !replaceLatest) { data[data.length - 1] = appendCandleSample(last, { ...sample, v: sample.value }, effectiveBucketMs); } else if (last?.t0 === t0) { let start = candleSamples.length - 1; while (start > 0 && Math.floor(candleSamples[start - 1].time / effectiveBucketMs) * effectiveBucketMs === t0) start--; const samples = candleSamples.slice(start); data[data.length - 1] = bucketHistory(samples.map(item => ({ ...item, t: item.time, v: item.value })), effectiveBucketMs)[0]; } else data.push({ ...sample, t0, t1: t0 + effectiveBucketMs, o: sample.value, h: sample.value, l: sample.value, c: sample.value }); }
    else { const normalized = normalizeCandle(point); if (!normalized) throw new TypeError('invalid chart point'); if ((replaceLatest || data.at(-1)?.t0 === normalized.t0) && data.length) data[data.length - 1] = normalized; else data.push(normalized); }
    if (data.length > settings.maxPoints) { data.splice(0, data.length - settings.maxPoints); heikenCache.data = null; }
    dataRevision++; heikenCache.revision = -1;
    if (previousCandle && data.at(-1)?.t0 === previousCandle.t0) animateCandle(previousCandle, data.at(-1));
    else stopAnimation();
  }
  function append(point) { const time = pointTime(point), lastTime = pointTime(sourceData.at(-1)); if (time == null) throw new TypeError('invalid chart point'); if (lastTime != null && time < lastTime) { appendSource(point); rebuildData(); } else updateTail(point, false); render(); emit('data', getState()); return api; }
  function appendMany(points = []) { if (!Array.isArray(points)) throw new TypeError('chart points must be an array'); if (!points.length) return api; for (const point of points) { const time = pointTime(point), lastTime = pointTime(sourceData.at(-1)); if (time == null) throw new TypeError('invalid chart point'); if (lastTime != null && time < lastTime) { appendSource(point); rebuildData(); } else updateTail(point, false); } render(); emit('data', getState()); return api; }
  function updateLatest(point) { if (!sourceData.length) return append(point); updateTail(point, true); render(); emit('data', getState()); return api; }
  function setHiddenRanges(ranges = []) { settings = normalizeOptions(settings, { hiddenRanges: ranges }); rebuildData(); render(); syncToolbar(); emit('hiddenRanges', settings.hiddenRanges); return api; }

  function applyResolutionDensity() {
    viewport.reset();
    // Use the chart's freshly measured dimensions directly. During a
    // ResizeObserver callback viewport.getLayout() can still be the layout
    // cached for the previous grid-cell width until the next render.
    const plotWidth = Math.max(1, settings.width - settings.padding.left - settings.padding.right);
    responsivePlotWidth = Math.round(plotWidth);
    if (settings.type === 'line') {
      const points = Math.max(20, Math.round(plotWidth / SNAP_LINE_POINT_SPACING_PX));
      viewport.setOptions({ lineWindow: points, lineOffset: null });
    } else {
      const candles = Math.max(5, Math.round(plotWidth / SNAP_CANDLE_WIDTH_PX));
      viewport.setOptions({ candleSpanMs: (settings.bucketMs || effectiveBucketMs) * candles, candleOffsetMs: null });
    }
    settings.activeRangeKey = null;
  }
  function resize() { const bounds = priceHost.getBoundingClientRect(), containerBounds = container.getBoundingClientRect(), parentBounds = container.parentElement?.getBoundingClientRect?.(); measuredAxisEdgeOffset = parentBounds ? Math.max(0, parentBounds.right - containerBounds.right) : 0; priceLabel.style.right = hoverValueLabel.style.right = `${settings.priceLabelRight ?? -measuredAxisEdgeOffset}px`; const surfaceBounds = surface.getBoundingClientRect(); stats.style.top = `${settings.statsOffset?.top ?? 8 - (bounds.top - surfaceBounds.top)}px`; stats.style.left = `${settings.statsOffset?.left ?? 8 - (bounds.left - surfaceBounds.left)}px`; if (toolbar && !settings.toolbar?.element) { toolbar.style.left = `${8 - (bounds.left - surfaceBounds.left)}px`; toolbar.style.bottom = `${8 - Math.max(0, surfaceBounds.bottom - bounds.bottom)}px`; } settings.width = Math.max(1, Math.round(bounds.width)); settings.height = Math.max(1, Math.round(bounds.height)); viewport.resize(settings.width, settings.height); const nextPlotWidth = Math.round(Math.max(1, settings.width - settings.padding.left - settings.padding.right)); if (responsiveDefaultDensity && nextPlotWidth !== responsivePlotWidth) applyResolutionDensity(); for (const pane of paneSpecs) { const element = paneElements.get(pane.id); if (element) element.setAttribute('viewBox', `0 0 ${settings.width} ${Math.round(paneHeights.get(pane.id) ?? pane.height)}`); } render(); return api; }
  function fitContent() { responsiveDefaultDensity = false; userViewportPreference = true; viewport.reset(); viewport.setOptions({ activeRangeKey: 'all' }); settings.activeRangeKey = 'all'; persistInstanceState(); render(); emit('range', viewport.getState().domain); syncToolbar(); return api; }
  function snapDefaultView() {
    userViewportPreference = false;
    responsiveDefaultDensity = true;
    applyResolutionDensity();
    persistInstanceState(); render(); emit('range', viewport.getState().domain); syncToolbar();
    return api;
  }
  function setOptions(patch = {}) {
    const old = settings; if (patch.padding) axisPadding = { ...axisPadding, ...patch.padding };
    if ('indicator' in patch) { localIndicatorEnabled = patch.indicator !== null; const shared = getChartSettings(); patch = { ...patch, indicator: localIndicatorEnabled && shared.samsara.overlayEnabled ? { ...samsaraConfig(shared), ...(patch.indicator || {}) } : null }; }
    if ('showPriceAxis' in patch) explicitPriceAxis = true;
    const showPriceAxis = 'showPriceAxis' in patch ? !!patch.showPriceAxis : (!explicitPriceAxis && 'showCurrentPriceLine' in patch ? !!patch.showCurrentPriceLine : settings.showPriceAxis);
    settings = normalizeOptions(settings, { ...patch, showPriceAxis, padding: paddingForAxis(showPriceAxis) }); host.style.background = settings.background;
    if (('activeRangeKey' in patch && patch.activeRangeKey !== old.activeRangeKey)
      || ('bucketMs' in patch && patch.bucketMs !== old.bucketMs)
      || ('targetCandles' in patch && patch.targetCandles !== old.targetCandles)
      || ('type' in patch && patch.type !== old.type)) userViewportPreference = true;
    if ('activeRangeKey' in patch && patch.activeRangeKey) responsiveDefaultDensity = false;
    viewport.setOptions({ mode: settings.type, timelineMode: settings.timelineMode, bucketMs: settings.bucketMs || effectiveBucketMs, padding: settings.padding, candleDefaultCount: settings.targetCandles, priceScale: settings.priceScale, ...('activeRangeKey' in patch ? { activeRangeKey: patch.activeRangeKey } : {}) });
    if (patch.followLatest === true && !old.followLatest) viewport.setOptions({ lineOffset: null, candleOffsetMs: null });
    if (!settings.candleAnimation) stopAnimation();
    if (settings.type !== old.type || settings.bucketMs !== old.bucketMs || settings.targetCandles !== old.targetCandles || JSON.stringify(settings.hiddenRanges) !== JSON.stringify(old.hiddenRanges) || settings.maxPoints !== old.maxPoints) { stopAnimation(); rebuildData(); }
    persistInstanceState();
    if ('priceLabelRight' in patch || 'statsOffset' in patch) resize(); else render();
    syncToolbar(); emit('settings', getState()); return api;
  }
  function getState() { const state = viewport.getState(); return Object.freeze({ type: settings.type, timelineMode: settings.timelineMode, bucketMs: settings.bucketMs, priceScale: settings.priceScale, showTimeAxis: settings.showTimeAxis, showPriceAxis: settings.showPriceAxis, pointCount: data.length, range: state.domain, viewport: state, hiddenRanges: settings.hiddenRanges, status: settings.status, followLatest: settings.followLatest, bridgeFromPreviousClose: settings.bridgeFromPreviousClose, indicatorEnabled: !!settings.indicator, destroyed }); }

  function pointerCoordinates(event) { const bounds = priceHost.getBoundingClientRect(); return { x: Math.max(settings.padding.left, Math.min(settings.width - settings.padding.right, event.clientX - bounds.left)), y: Math.max(settings.padding.top, Math.min(settings.height - settings.padding.bottom, event.clientY - bounds.top)) }; }
  function processPointerMove(event) { const { x, y } = pointerCoordinates(event); if (selection) { selection.x = x; selection.y = y; } else if (drag) { responsiveDefaultDensity = false; userViewportPreference = true; const key = drag.unit === 'time' ? 'candleOffsetMs' : 'lineOffset'; viewport.setOptions({ [key]: drag.offset }); viewport.calculate(renderedData(), dataRevision); viewport.panPixels(event.clientX - drag.clientX); } const layout = viewport.calculate(renderedData(), dataRevision + (animation ? animation.frame / 1_000_000 : 0)), time = layout.nearestTimeAtPixel(x), value = layout.priceAtPixel(y); hover = { x, y, time, value }; const nearest = layout.visible.find(item => (item.time ?? item.t0) === time) || null; if (nearest) { const pointValue = settings.type === 'line' ? nearest.value : nearest.c; if (settings.showTooltip) { tooltip.textContent = `${settings.formatTime(time)}  ${settings.formatValue(pointValue)}`; tooltip.style.display = 'block'; tooltip.style.left = `${x}px`; tooltip.style.top = `${y}px`; } emit('hover', Object.freeze({ time, value: pointValue, pointerValue: value, point: nearest.source })); } if (drag) { render(); emit('range', viewport.getState().domain); } else renderInteraction(); }
  let pendingPointerEvent = null, pointerFrameHandle = null;
  function cancelPointerMoveFrame() {
    if (pointerFrameHandle == null) return;
    (globalThis.cancelAnimationFrame || globalThis.clearTimeout)(pointerFrameHandle);
    pointerFrameHandle = null;
  }
  // Applies whatever pointermove is still queued right now, synchronously
  // -- used right before a pointerup/pointercancel clears `drag`/`selection`
  // so the very last mouse position before release is never dropped just
  // because it hadn't reached its rAF turn yet.
  function flushPendingPointerMove() {
    cancelPointerMoveFrame();
    if (!pendingPointerEvent) return;
    const event = pendingPointerEvent;
    pendingPointerEvent = null;
    processPointerMove(event);
  }
  function onPointerMove(event) {
    pendingPointerEvent = event;
    if (pointerFrameHandle != null) return;
    const raf = globalThis.requestAnimationFrame;
    pointerFrameHandle = typeof raf === 'function' ? raf(flushPendingPointerMove) : globalThis.setTimeout(flushPendingPointerMove, 16);
  }
  function onWheel(event) { if (toolbar?.contains?.(event.target)) return; if (event.ctrlKey || event.metaKey) return; event.preventDefault(); responsiveDefaultDensity = false; userViewportPreference = true; viewport.zoom(event.deltaY); settings.activeRangeKey = null; persistInstanceState(); render(); syncToolbar(); emit('range', viewport.getState().domain); }

  let toolbar = null; const toolbarRefs = new Map();
  function createButton(label, title, action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'atmos-chart__tool'; button.textContent = label; button.title = title || label; button.style.cssText = "height:24px;padding:0 8px;border:1px solid transparent;border-radius:4px;color:rgba(var(--ink-rgb),.58);background:transparent;cursor:pointer;font:500 10px/1.35 var(--app-font-family, 'Segoe UI', Roboto, sans-serif)"; button.addEventListener('click', action, eventOptions); return button; }
  function createAxisControls() { const group = document.createElement('div'); group.className = 'atmos-chart__axes'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Chart axes'); group.style.cssText = 'display:flex;gap:2px'; const x = createButton('X', 'Toggle time axis', () => setOptions({ showTimeAxis: !settings.showTimeAxis })); const y = createButton('Y', 'Toggle price axis', () => setOptions({ showPriceAxis: !settings.showPriceAxis })); x.dataset.axisX = ''; y.dataset.axisY = ''; group.append(x, y); toolbarRefs.set('axisX', x); toolbarRefs.set('axisY', y); return group; }
  function buildToolbar() {
    const config = settings.toolbar === true ? {} : settings.toolbar; if (!config || toolbar) return;
    if (config.element) {
      toolbar = config.element;
      const bind = (key, selector, action) => { const element = toolbar.querySelector(selector); if (!element) return; toolbarRefs.set(key, element); element.addEventListener('click', action, eventOptions); };
      if (toolbar.querySelector('[data-axis-x]') || toolbar.querySelector('[data-axis-y]')) {
        bind('axisX', '[data-axis-x]', () => setOptions({ showTimeAxis: !settings.showTimeAxis }));
        bind('axisY', '[data-axis-y]', () => setOptions({ showPriceAxis: !settings.showPriceAxis }));
      } else toolbar.append(createAxisControls());
      bind('timeline', '[data-timeline]', () => setOptions({ timelineMode: settings.timelineMode === 'gapless' ? 'gaps' : 'gapless' }));
      bind('scale', '[data-scale]', () => setOptions({ priceScale: settings.priceScale === 'log' ? 'linear' : 'log' }));
      bind('bridge', '[data-bridge]', () => setOptions({ bridgeFromPreviousClose: !settings.bridgeFromPreviousClose }));
      bind('indicator', '[data-indicator]', () => setOptions({ indicator: settings.indicator ? null : {} }));
      bind('follow', '[data-follow]', () => setOptions({ followLatest: !settings.followLatest }));
      toolbarRefs.set('type', toolbar);
      toolbar.querySelectorAll('[data-chart-type]').forEach(button => button.addEventListener('click', () => setOptions({ type: button.dataset.chartType }), eventOptions));
      toolbarRefs.set('timeframe', toolbar.querySelector('.mq-timeframes'));
      toolbar.querySelectorAll('[data-interval]').forEach(button => {
        const interval = (config.intervals || DEFAULT_INTERVALS).find(item => item.value === button.dataset.interval);
        if (interval) button.dataset.bucketMs = interval.ms == null ? 'auto' : String(interval.ms);
        button.addEventListener('click', () => { if (interval) setOptions({ bucketMs: interval.ms }); }, eventOptions);
      });
      toolbarRefs.set('range', toolbar);
      toolbar.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => setOptions({ activeRangeKey: button.dataset.range }), eventOptions));
      syncToolbar();
      return;
    }
    toolbar = document.createElement('div'); toolbar.className = 'atmos-chart__toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', config.ariaLabel || 'Chart options');
    toolbar.style.cssText = "position:absolute;z-index:11;left:8px;bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:3px;max-width:calc(100% - 16px);padding:3px;border:1px solid rgba(var(--ink-rgb),.075);border-radius:7px;background:rgba(var(--surface-rgb),var(--shell-opacity, .88));box-shadow:0 3px 14px rgba(0,0,0,.22);backdrop-filter:blur(var(--shell-blur, 30px)) saturate(180%);-webkit-backdrop-filter:blur(var(--shell-blur, 30px)) saturate(180%);font:500 10px/1.35 var(--app-font-family, 'Segoe UI', Roboto, sans-serif)";
    const controls = new Set(config.controls || ['axes', 'timeline', 'scale', 'bridge', 'indicator', 'follow', 'type', 'timeframe', 'range', 'fit', 'hidden']), add = (key, element) => { toolbarRefs.set(key, element); toolbar.append(element); };
    for (const element of config.prepend || []) toolbar.append(element);
    if (controls.has('timeline')) add('timeline', createButton('Gapless', 'Toggle real-time gaps', () => setOptions({ timelineMode: settings.timelineMode === 'gapless' ? 'gaps' : 'gapless' })));
    if (controls.has('scale')) add('scale', createButton('Linear', 'Toggle log/linear price scale', () => setOptions({ priceScale: settings.priceScale === 'log' ? 'linear' : 'log' })));
    if (controls.has('bridge')) add('bridge', createButton('Bridge', 'Bridge close-to-open gaps', () => setOptions({ bridgeFromPreviousClose: !settings.bridgeFromPreviousClose })));
    if (controls.has('indicator')) add('indicator', createButton('SAR', 'Toggle indicator', () => setOptions({ indicator: settings.indicator ? null : {} })));
    if (controls.has('follow')) add('follow', createButton('Live', 'Follow newest data', () => setOptions({ followLatest: !settings.followLatest })));
    if (controls.has('type')) { const group = document.createElement('div'); group.style.cssText = 'display:flex;gap:2px'; for (const [type, label] of [['line', 'Line'], ['candlestick', 'Candle'], ['heiken-ashi', 'Heiken']]) { const button = createButton(label, label, () => setOptions({ type })); button.dataset.chartType = type; group.append(button); } add('type', group); }
    if (controls.has('timeframe')) { const group = document.createElement('div'); group.style.cssText = 'display:flex;gap:2px'; for (const interval of config.intervals || DEFAULT_INTERVALS) { const button = createButton(interval.label, interval.label, () => setOptions({ bucketMs: interval.ms })); button.dataset.bucketMs = interval.ms == null ? 'auto' : String(interval.ms); group.append(button); } add('timeframe', group); }
    if (controls.has('range')) { const group = document.createElement('div'); group.style.cssText = 'display:flex;gap:2px'; for (const range of config.ranges || DEFAULT_RANGES) { const button = createButton(range.label, `Show ${range.label}`, () => setOptions({ activeRangeKey: range.value })); button.dataset.range = range.value; group.append(button); } add('range', group); }
    if (controls.has('fit')) add('fit', createButton('Fit', 'Fit all data', fitContent));
    if (controls.has('hidden')) {
      const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:relative';
      const button = createButton('0 hidden', 'Manage hidden ranges', () => { menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; });
      const menu = document.createElement('div'); menu.style.cssText = "display:none;position:absolute;bottom:calc(100% + 6px);left:0;min-width:230px;max-height:220px;overflow:auto;padding:6px;border:1px solid rgba(var(--ink-rgb),.1);border-radius:6px;background:rgba(var(--surface-rgb),.97);box-shadow:0 8px 24px rgba(0,0,0,.35);font:10px/1.35 var(--app-font-family, 'Segoe UI', sans-serif)";
      wrapper.append(button, menu); toolbarRefs.set('hidden', button); toolbarRefs.set('hiddenMenu', menu); toolbar.append(wrapper);
    }
    for (const element of config.append || []) toolbar.append(element);
    if (controls.has('axes')) toolbar.append(createAxisControls());
    const style = document.createElement('style');
    style.textContent = '.atmos-chart__toolbar{opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .16s ease,transform .16s ease}.atmos-chart:hover .atmos-chart__toolbar,.atmos-chart:focus-within .atmos-chart__toolbar{opacity:1;transform:translateY(0);pointer-events:auto}.atmos-chart__tool:hover{color:rgba(var(--ink-rgb),.9)!important;background:rgba(120,140,180,.1)!important}@media(hover:none){.atmos-chart__toolbar{opacity:1;transform:none;pointer-events:auto}}';
    priceHost.append(style, toolbar); syncToolbar();
  }
  function syncToolbar() {
    if (!toolbar) return; const active = (element, on) => { if (!element) return; element.classList?.toggle('is-active', !!on); element.setAttribute?.('aria-pressed', String(!!on)); element.style.borderColor = on ? 'rgba(var(--ink-rgb),.22)' : 'transparent'; element.style.background = on ? 'rgba(var(--ink-rgb),.13)' : 'transparent'; element.style.color = on ? 'rgb(var(--ink-rgb))' : 'rgba(var(--ink-rgb),.58)'; };
    active(toolbarRefs.get('axisX'), settings.showTimeAxis); active(toolbarRefs.get('axisY'), settings.showPriceAxis);
    const timeline = toolbarRefs.get('timeline'); if (timeline) { timeline.textContent = settings.timelineMode === 'gapless' ? 'Gapless' : 'Gaps'; active(timeline, settings.timelineMode === 'gaps'); }
    const scaleToggle = toolbarRefs.get('scale'); if (scaleToggle) { scaleToggle.textContent = settings.priceScale === 'log' ? 'Log' : 'Linear'; active(scaleToggle, settings.priceScale === 'log'); }
    active(toolbarRefs.get('bridge'), settings.bridgeFromPreviousClose); active(toolbarRefs.get('indicator'), !!settings.indicator); active(toolbarRefs.get('follow'), settings.followLatest);
    toolbarRefs.get('type')?.querySelectorAll?.('[data-chart-type]')?.forEach(button => active(button, button.dataset.chartType === settings.type));
    const timeframe = toolbarRefs.get('timeframe');
    if (timeframe) timeframe.style.display = settings.type === 'line' ? 'none' : 'flex';
    // External toolbars may have no interval wrapper; never hide their root.
    (timeframe || toolbar).querySelectorAll?.('[data-bucket-ms]')?.forEach(button => {
      if (!timeframe) button.style.display = settings.type === 'line' ? 'none' : '';
      active(button, button.dataset.bucketMs === (settings.bucketMs == null ? 'auto' : String(settings.bucketMs)));
    });
    toolbarRefs.get('range')?.querySelectorAll?.('[data-range]')?.forEach(button => active(button, button.dataset.range === viewport.getState().activeRangeKey));
    const hiddenButton = toolbarRefs.get('hidden'), hiddenMenu = toolbarRefs.get('hiddenMenu');
    if (hiddenButton) { hiddenButton.textContent = `${settings.hiddenRanges.length} hidden`; hiddenButton.style.display = settings.hiddenRanges.length ? '' : 'none'; }
    if (hiddenMenu) {
      hiddenMenu.replaceChildren();
      settings.hiddenRanges.forEach((range, index) => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px';
        const label = document.createElement('span'); label.textContent = `${settings.formatTime(range.tStart)} – ${settings.formatTime(range.tEnd)}`; label.style.color = 'rgba(var(--ink-rgb),.62)';
        const restore = createButton('Restore', 'Restore hidden range', () => setHiddenRanges(settings.hiddenRanges.filter((_item, itemIndex) => itemIndex !== index)));
        row.append(label, restore); hiddenMenu.append(row);
      });
      if (settings.hiddenRanges.length > 1) hiddenMenu.append(createButton('Restore all', 'Restore all hidden ranges', () => setHiddenRanges([])));
      if (!settings.hiddenRanges.length) hiddenMenu.style.display = 'none';
    }
  }

  function destroy() { if (destroyed) return; persistInstanceState(); destroyed = true; stopAnimation(); cancelPointerMoveFrame(); pendingPointerEvent = null; observer.disconnect(); controller.abort(); options.signal?.removeEventListener('abort', destroy); listeners.clear(); stopSharedSettings?.(); surface.style.background = previousSurfaceBackground; container.style.cssText = previousContainerCssText; host.remove(); }
  const chartId = Math.random().toString(36).slice(2), controller = new AbortController(), eventOptions = { signal: controller.signal };
  priceHost.addEventListener('pointermove', onPointerMove, eventOptions);
  priceHost.addEventListener('pointerleave', () => { cancelPointerMoveFrame(); pendingPointerEvent = null; hover = null; tooltip.style.display = hoverValueLabel.style.display = hoverTimeLabel.style.display = 'none'; renderInteraction(); }, eventOptions);
  priceHost.addEventListener('pointerdown', event => { if (toolbar?.contains?.(event.target) || (event.button != null && event.button !== 0)) return; const { x, y } = pointerCoordinates(event), layout = viewport.getLayout(); if (!layout.visible.length) return; if (event.shiftKey) { event.preventDefault(); selection = { mode: 'measure', startX: x, x, startY: y, y }; renderInteraction(layout); } else if (event.ctrlKey || event.metaKey) { event.preventDefault(); selection = { startX: x, x, startTime: layout.nearestTimeAtPixel(x) }; } else { const pan = viewport.getState().pan; if (pan) drag = { clientX: event.clientX, unit: pan.unit, offset: pan.start }; } priceHost.setPointerCapture?.(event.pointerId); }, eventOptions);
  priceHost.addEventListener('pointerup', event => { flushPendingPointerMove(); if (selection) { const { x } = pointerCoordinates(event), end = viewport.getLayout().nearestTimeAtPixel(x); if (selection.mode !== 'measure' && end != null && selection.startTime != null && Math.abs(x - selection.startX) > 4) setHiddenRanges([...settings.hiddenRanges, { tStart: selection.startTime, tEnd: end }]); selection = null; render(); } if (drag) persistInstanceState(); drag = null; }, eventOptions);
  priceHost.addEventListener('pointercancel', () => { cancelPointerMoveFrame(); pendingPointerEvent = null; drag = selection = null; render(); }, eventOptions);
  priceHost.addEventListener('dblclick', event => { if (toolbar?.contains?.(event.target)) return; if ((event.ctrlKey || event.metaKey) && settings.hiddenRanges.length) setHiddenRanges([]); else snapDefaultView(); }, eventOptions);
  priceHost.addEventListener('wheel', onWheel, { signal: controller.signal, passive: false });

  // Pane data uses sorted {t} samples when hover is enabled. Consumers handle
  // the domain-specific response; the engine owns pointer scheduling/mapping.
  const paneHoverFrames = new Map();
  for (const pane of paneSpecs) {
    if (!pane.hover) continue;
    const element = paneElements.get(pane.id);
    if (!element) continue;
    const cancel = () => {
      const pending = paneHoverFrames.get(pane.id);
      if (pending) (globalThis.cancelAnimationFrame || globalThis.clearTimeout)(pending.handle);
      paneHoverFrames.delete(pane.id);
    };
    element.addEventListener('pointermove', event => {
      const existing = paneHoverFrames.get(pane.id);
      if (existing) { existing.clientX = event.clientX; return; }
      const pending = { clientX: event.clientX, handle: null };
      paneHoverFrames.set(pane.id, pending);
      const flush = () => {
        paneHoverFrames.delete(pane.id);
        if (destroyed || paneVisibility.get(pane.id) === false) return;
        const bounds = element.getBoundingClientRect();
        if (!bounds.width) return;
        const x = (pending.clientX - bounds.left) * settings.width / bounds.width;
        const series = paneData.get(pane.id) || [];
        const time = nearestSampleTime(series, viewport.getLayout().timeAtPixel(x));
        if (time != null) emit('paneHover', Object.freeze({ id: pane.id, time, x }));
      };
      pending.handle = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(flush) : globalThis.setTimeout(flush, 16);
    }, eventOptions);
    element.addEventListener('pointerleave', () => { cancel(); emit('paneLeave', Object.freeze({ id: pane.id })); }, eventOptions);
    controller.signal.addEventListener('abort', cancel, { once: true });
  }

  for (const pane of paneSpecs) {
    const handle = paneHandleElements.get(pane.id);
    if (!handle) continue;
    let dragStartY = null, dragStartHeight = null;
    handle.addEventListener('pointerdown', event => {
      dragStartY = event.clientY; dragStartHeight = paneHeights.get(pane.id) ?? pane.height;
      handle.setPointerCapture?.(event.pointerId); event.preventDefault?.();
    }, eventOptions);
    handle.addEventListener('pointermove', event => {
      if (dragStartY == null) return;
      // The handle sits above its pane, so dragging it up (smaller clientY)
      // grows the pane -- the same sense as dragging an RSI pane's own
      // top edge in a typical charting UI.
      setPaneHeight(pane.id, dragStartHeight + (dragStartY - event.clientY));
    }, eventOptions);
    const endPaneDrag = () => { dragStartY = dragStartHeight = null; };
    handle.addEventListener('pointerup', endPaneDrag, eventOptions);
    handle.addEventListener('pointercancel', endPaneDrag, eventOptions);
  }
  const observer = new ResizeObserver(resize);
  const stopSharedSettings = onChartSettingsChange(shared => { applyBackground(shared); if (!shared.candleAnimation) stopAnimation(); const showPriceAxis = explicitPriceAxis ? settings.showPriceAxis : shared.showCurrentPriceLine; settings = normalizeOptions(settings, { smoothing: shared.smoothing, lineOpacity: shared.lineOpacity, candleAnimation: shared.candleAnimation, showCurrentPriceLine: shared.showCurrentPriceLine, showPriceAxis, padding: paddingForAxis(showPriceAxis), indicator: localIndicatorEnabled && shared.samsara.overlayEnabled ? samsaraConfig(shared) : null }); viewport.setOptions({ padding: settings.padding }); render(); syncToolbar(); });
  function setPaneData(id, points = []) { paneData.set(id, Array.isArray(points) ? points : []); render(); return api; }
  function getPaneElement(id) { return paneElements.get(id) || null; }
  function setPaneHeight(id, height) {
    const pane = paneSpecs.find(item => item.id === id);
    if (!pane || !Number.isFinite(Number(height))) return api;
    const clamped = Math.max(pane.minHeight ?? PANE_MIN_HEIGHT, Math.min(pane.maxHeight ?? PANE_MAX_HEIGHT, Math.round(Number(height))));
    if (paneHeights.get(id) === clamped) return api;
    paneHeights.set(id, clamped);
    const element = paneElements.get(id);
    if (element) element.style.height = `${clamped}px`;
    resize();
    emit('paneResize', Object.freeze({ id, height: clamped }));
    return api;
  }
  function getPaneHeight(id) { return paneHeights.get(id) ?? null; }
  function setPaneVisible(id, visible) {
    if (!paneVisibility.has(id)) return api;
    const isVisible = visible !== false;
    if (paneVisibility.get(id) === isVisible) return api;
    paneVisibility.set(id, isVisible);
    // A pane's own svg AND its resize handle (when it has one) must hide
    // together -- a handle with no visible pane beneath it to resize is a
    // dangling control, not a smaller version of the indicator.
    const element = paneElements.get(id);
    if (element) element.style.display = isVisible ? '' : 'none';
    const handle = paneHandleElements.get(id);
    if (handle) handle.style.display = isVisible ? '' : 'none';
    resize();
    return api;
  }
  function getPaneVisible(id) { return paneVisibility.get(id) ?? null; }
  const api = Object.freeze({ batch, setData, append, appendMany, updateLatest, setHiddenRanges, setStatus(status) {
    const next = normalizeStatus(status);
    if (JSON.stringify(next) === JSON.stringify(settings.status)) return api;
    settings = { ...settings, status: next };
    render(); emit('settings', getState()); return api;
  }, setType(type) { return setOptions({ type }); }, setOptions, fitContent, snapDefaultView, resize, getState, setPaneData, getPaneElement, setPaneHeight, getPaneHeight, setPaneVisible, getPaneVisible, timeToCoordinate(time) { return viewport.getLayout().xOfTime(Number(time)); }, priceToCoordinate(value) { return viewport.getLayout().yOfPrice(Number(value)); }, coordinateToTime(x) { return viewport.getLayout().timeAtPixel(Number(x)); }, coordinateToPrice(y) { return viewport.getLayout().priceAtPixel(Number(y)); }, on(name, listener) { if (typeof listener !== 'function') throw new TypeError('listener must be a function'); if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); return () => listeners.get(name)?.delete(listener); }, destroy });
  buildToolbar(); observer.observe(host); options.signal?.addEventListener('abort', destroy, { once: true }); resize(); if (options.data) setData(options.data, { preserveViewport: true }); if (!hasRestoredViewport) snapDefaultView(); if (options.signal?.aborted) destroy(); return api;
}

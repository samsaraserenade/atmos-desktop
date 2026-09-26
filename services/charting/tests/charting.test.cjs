'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('service declares a renderer-only CoreV2 contract', () => {
  const extension = JSON.parse(read('extension.json'));
  const service = JSON.parse(read('service.json'));
  assert.equal(extension.apiVersion, 2);
  assert.equal(extension.requires['extensions.manifest'], 1);
  assert.equal(extension.requires['lifecycle.context'], 1);
  assert.equal(service.id, 'charting');
  assert.equal(service.apiVersion, 2);
  assert.equal(service.rendererApiVersion, 2);
  assert.equal(service.rendererApi, 'api.js');
  assert.equal(fs.existsSync(path.join(root, 'main.cjs')), false, 'renderer-only charting must not create a privileged main-process service');
});

test('all renderer modules parse and relative dependencies exist', () => {
  for (const file of ['api.js', 'chart-next.js', 'viewport.js', 'candlesticks.js', 'indicators.js', 'smoothing.js', 'preferences.js']) {
    const source = read(file);
    new vm.SourceTextModule(source, { identifier: path.join(root, file) });
    for (const match of source.matchAll(/from\s*(['"])(\.\.?\/[^'"]+)\1/g)) {
      assert.ok(fs.existsSync(path.resolve(root, match[2])), `${file} imports missing ${match[2]}`);
    }
  }
});

test('candle derivation and Heiken Ashi are stable and non-mutating', () => {
  const source = read('candlesticks.js').replace(/\bexport\s+/g, '');
  const module = vm.runInNewContext(`${source}\n({ bucketHistory, heikenAshi, renderCandlesSVG })`);
  const candles = module.bucketHistory([
    { t: 1_000, v: 100 },
    { t: 2_000, v: 105 },
    { t: 3_000, v: 98 },
    { t: 61_000, v: 102 },
  ], 60_000);
  assert.deepEqual(JSON.parse(JSON.stringify(candles)), [
    { t0: 0, t1: 60_000, o: 100, h: 105, l: 98, c: 98 },
    { t0: 60_000, t1: 120_000, o: 102, h: 102, l: 102, c: 102 },
  ]);
  const snapshot = JSON.stringify(candles);
  assert.equal(module.heikenAshi(candles).length, 2);
  assert.equal(JSON.stringify(candles), snapshot);
  assert.match(module.renderCandlesSVG({ candles, W: 100, H: 100, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, colorUp: '#0f0', colorDown: '#f00', bridgeFromPreviousClose: true }), /tc-candle-bridge/);
  assert.equal(JSON.stringify(candles), snapshot);
});

test('shared indicators preserve Portfolio Tracker calculations', () => {
  const source = read('indicators.js').replace(/\bexport\s+/g, '');
  const result = vm.runInNewContext(`${source}\n({
    sma: sma([1, 2, 3, 4, 5], 3),
    ema: ema([1, 2, 3, 4, 5], 3),
    wma: wma([1, 2, 3, 4, 5], 3),
    rsi: rsi(Array.from({ length: 20 }, (_, index) => index), 14),
    sessions: [0, 7, 13, 21].map(hour => mergedUtcSession(Date.UTC(2026, 0, 1, hour)).key),
  })`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sma)), [null, null, 2, 3, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.ema)), [null, null, 2, 3, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.wma)), [null, null, 14 / 6, 20 / 6, 26 / 6]);
  assert.equal(result.rsi[14], 100);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sessions)), ['tokyo', 'london', 'new-york', 'sydney']);
});

test('public chart API is plugin-agnostic and lifecycle managed', () => {
  const chart = read('chart-next.js');
  const api = read('api.js');
  assert.doesNotMatch(`${chart}\n${api}`, /portfolioState|portfolio-tracker|getTotal\(/i);
  assert.match(chart, /options\.signal\?\.addEventListener\('abort', destroy/);
  assert.match(chart, /observer\.disconnect\(\)/);
  for (const method of ['setData', 'append', 'appendMany', 'updateLatest', 'setHiddenRanges', 'setStatus', 'setType', 'setOptions', 'fitContent', 'resize', 'getState', 'destroy']) {
    assert.match(chart, new RegExp(`\\b${method}\\b`));
  }
  assert.match(api, /CHARTING_API_VERSION = 2/);
  assert.match(api, /getChartSettings/);
  assert.match(api, /setChartSettings/);
  assert.match(api, /onChartSettingsChange/);
  assert.match(chart, /bridgeFromPreviousClose: settings\.bridgeFromPreviousClose/);
  assert.match(chart, /followLatest/);
  assert.match(chart, /showTooltip/);
  assert.match(chart, /preserveViewport/);
  assert.match(chart, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(chart, /candleAnimationDuration/);
  assert.match(chart, /toolbar: false/);
  assert.doesNotMatch(chart, /function timeLabels/);
});

test('derived candles and Heiken Ashi preserve custom point metadata', () => {
  const source = read('candlesticks.js').replace(/\bexport\s+/g, '');
  const module = vm.runInNewContext(`${source}\n({ bucketHistory, heikenAshi })`);
  const candles = module.bucketHistory([
    { t: 1_000, v: 100, liveCount: 2, errorCount: 1 },
    { t: 2_000, v: 105, liveCount: 3, errorCount: 0 },
  ], 60_000);
  assert.equal(candles[0].liveCount, 3);
  assert.equal(candles[0].errorCount, 0);
  assert.equal(module.heikenAshi(candles)[0].liveCount, 3);
});

test('viewport normalization cache supports O(1) latest-point refreshes', () => {
  const viewport = read('viewport.js');
  assert.match(viewport, /normalizedCache\.data === data/);
  assert.match(viewport, /normalizedCache\.all\[normalizedCache\.all\.length - 1\]/);
  const chart = read('chart-next.js');
  assert.match(chart, /function updateLatest/);
  assert.match(chart, /data\[data\.length - 1\] = normalized/);
});

test('shared renderer carries the Portfolio chart presentation', () => {
  const chart = read('chart-next.js');
  assert.match(chart, /atmos-chart__price-label/);
  assert.match(chart, /atmos-chart__point-count/);
  assert.match(chart, /atmos-chart__hover-value/);
  assert.match(chart, /atmos-chart__hover-time/);
  assert.match(chart, /atmos-chart__live-ring/);
  assert.match(chart, /stroke-dasharray="2,4"/);
});

test('explicit Y-axis visibility remains independent of shared current-price line settings', () => {
  const chart = read('chart-next.js');
  assert.match(chart, /showPriceAxis: restoredOptions\.showPriceAxis \?\? sharedAtCreation\.showCurrentPriceLine/);
  assert.match(chart, /paddingForAxis\(showPriceAxis\)/);
  assert.match(chart, /const showPriceAxis = explicitPriceAxis \? settings\.showPriceAxis : shared\.showCurrentPriceLine/);
  assert.match(chart, /const labelRight = settings\.priceLabelRight \?\? -measuredAxisEdgeOffset;\s*return settings\.width - labelRight - 6;/, 'price ticks end where the crosshair price label ends');
});

test('shared indicators warm up from history before the visible window', () => {
  const chart = read('chart-next.js');
  assert.match(chart, /first - 500/);
  assert.match(chart, /xs: study\.map/);
  assert.match(chart, /candleColorResolver\(study, source, warm, end\)/);
});

test('shared indicators render starting one candle before the visible window, so the overlay line/RSI-state/session strip has no bare gap at the pane\'s left edge', () => {
  const chart = read('chart-next.js');
  assert.match(chart, /const edgeIndex = Math\.max\(warm, first - 1\);/);
  assert.match(chart, /renderFrom: edgeIndex - warm/);
  // Both the line-mode and candle-mode branches need their own x lookup
  // extended by that one edge point, or `xs` comes back NaN for it and
  // the render loops just skip it (see renderSamsaraOverlaySVG).
  const matches = chart.match(/if \(edge(?:Candle|Point) && !x\.has\(edge(?:Candle|Point)\.(?:t0|time)\)\) x\.set\(/g) || [];
  assert.equal(matches.length, 2, 'expected the edge-candle x lookup fix in both the line-mode and candle-mode branches');
});

test('generic chart accepts a live price stream in candle mode and disposes cleanly', async () => {
  class FakeElement {
    constructor() { this.style = {}; this.children = []; this.removed = false; this.handlers = new Map(); }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    dispatch(name, event = {}) { this.handlers.get(name)?.({ preventDefault() {}, ...event }); }
    getBoundingClientRect() { return { width: 640, height: 320, left: 0, top: 0, right: 640, bottom: 320 }; }
    remove() { this.removed = true; }
  }
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; }
    observe() { this.callback(); }
    disconnect() { this.disconnected = true; }
  }
  const frames = new Map();
  let frameId = 0;
  let clock = 0;
  const context = vm.createContext({
    console,
    AbortController,
    performance: { now: () => clock },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    Element: FakeElement,
    ResizeObserver: FakeResizeObserver,
    document: {
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
    },
  });
  const cache = new Map();
  const loadModule = async file => {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute);
    const module = new vm.SourceTextModule(fs.readFileSync(absolute, 'utf8'), { context, identifier: absolute });
    cache.set(absolute, module);
    await module.link(specifier => loadModule(path.resolve(path.dirname(absolute), specifier)));
    return module;
  };
  const module = await loadModule('chart-next.js');
  await module.evaluate();
  const container = new FakeElement();
  const chart = module.namespace.createTimeSeriesChart(container, {
    type: 'candlestick',
    candleAnimation: false,
    bucketMs: 60_000,
    data: [{ time: 1_000, value: 100 }, { time: 61_000, value: 102 }],
  });
  const svg = container.children[0].children[0].children[0].children[1];
  const initialMarkup = svg.innerHTML;
  const initialRangeEnd = chart.getState().range.to;
  assert.equal(chart.getState().pointCount, 2);
  chart.append({ time: 62_000, value: 105 });
  assert.equal(chart.getState().pointCount, 2, 'forming candle updates must stay in their existing bucket');
  assert.notEqual(svg.innerHTML, initialMarkup, 'forming candle price changes must repaint the SVG immediately');
  chart.appendMany([{ time: 63_000, value: 99 }, { time: 121_000, value: 103 }]);
  assert.equal(chart.getState().pointCount, 3, 'a live batch must update the forming candle and append the next bucket');
  assert.ok(chart.getState().range.to > initialRangeEnd, 'the live viewport must advance with the newest candle');
  chart.destroy();
  assert.equal(chart.getState().destroyed, true);
  assert.equal(container.children[0].removed, true);

  const sharedSettings = await loadModule('preferences.js');
  sharedSettings.namespace.setChartSettings({ lineOpacity: 0.25, showCurrentPriceLine: true, samsara: { overlayEnabled: false } });
  const sharedContainer = new FakeElement();
  const sharedChart = module.namespace.createTimeSeriesChart(sharedContainer, {
    type: 'line', data: [{ time: 1_000, value: 100 }, { time: 2_000, value: 102 }],
  });
  const sharedSvg = sharedContainer.children[0].children[0].children[0].children[1];
  assert.match(sharedSvg.innerHTML, /stroke-opacity="0\.250"/, 'new charts must inherit shared line opacity');
  assert.match(sharedSvg.innerHTML, /stroke-dasharray="2,4"/, 'new charts must inherit the shared price-tag setting');
  sharedSettings.namespace.setChartSettings({ lineOpacity: 0.6 });
  assert.match(sharedSvg.innerHTML, /stroke-opacity="0\.600"/, 'mounted charts must react to shared settings changes');
  const portfolioSurface = new FakeElement();
  portfolioSurface.style.background = 'original';
  const portfolioContainer = new FakeElement();
  const portfolioChart = module.namespace.createTimeSeriesChart(portfolioContainer, {
    surface: portfolioSurface, type: 'line',
    data: Array.from({ length: 1000 }, (_, index) => ({ time: index * 1000, value: index + 1 })),
  });
  for (const opacity of [0, 0.3, 1]) {
    sharedSettings.namespace.setChartSettings({ backgroundOpacity: opacity });
    assert.equal(sharedContainer.style.background, `rgba(var(--surface-rgb),${opacity})`);
    assert.equal(portfolioSurface.style.background, sharedContainer.style.background, 'both chart surfaces must track the same background setting');
  }
  const host = portfolioContainer.children[0].children[0];
  const beforeMeasure = portfolioChart.getState().range;
  const measurement = host.children.find(child => child.className === 'atmos-chart__measurement');
  host.dispatch('pointerdown', { shiftKey: true, clientX: 200, clientY: 180 });
  assert.equal(measurement.style.display, 'block');
  host.dispatch('pointermove', { shiftKey: true, clientX: 400, clientY: 100 });
  host.dispatch('pointerup', { clientX: 400, clientY: 100 });
  assert.match(measurement.textContent, /[dhms]\n\+[\d,.]+%  ·  \+\$/);
  assert.equal(measurement.style.display, 'none');
  assert.deepEqual(portfolioChart.getState().range, beforeMeasure, 'measurement must not pan');
  assert.equal(portfolioChart.getState().hiddenRanges.length, 0, 'measurement must not hide data');
  host.dispatch('pointerdown', { clientX: 200, clientY: 100 });
  host.dispatch('pointermove', { clientX: 400, clientY: 100 });
  host.dispatch('pointerup', { clientX: 400, clientY: 100 });
  const panned = portfolioChart.getState().range;
  assert.equal(portfolioChart.getState().viewport.pan.live, false);
  portfolioChart.append({ time: 1000000, value: 1001 });
  assert.deepEqual(portfolioChart.getState().range, panned, 'appending must not undo a manual pan');
  portfolioChart.setOptions({ followLatest: true });
  assert.deepEqual(portfolioChart.getState().range, panned, 'reapplying unchanged adapter options must not reset the viewport');
  portfolioChart.fitContent();
  assert.equal(portfolioChart.getState().viewport.activeRangeKey, 'all');
  portfolioChart.destroy();
  assert.equal(portfolioSurface.style.background, 'original', 'disposing restores the surface');
  const animatedContainer = new FakeElement();
  const animatedChart = module.namespace.createTimeSeriesChart(animatedContainer, {
    type: 'candlestick', bucketMs: 60000, candleAnimation: true,
    data: [{ time: 1000, value: 100 }, { time: 61000, value: 102 }],
  });
  animatedChart.append({ time: 62000, value: 110 });
  assert.equal(frames.size, 1, 'forming updates schedule animation');
  clock = 100;
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(clock));
  assert.equal(frames.size, 1, 'animation continues between frames');
  animatedChart.append({ time: 121000, value: 105 });
  assert.equal(frames.size, 0, 'a new bucket cancels the previous candle animation');
  animatedChart.append({ time: 122000, value: 106 });
  sharedSettings.namespace.setChartSettings({ candleAnimation: false });
  assert.equal(frames.size, 0, 'disabling animation cancels pending work');
  animatedChart.setHiddenRanges([{ from: 60000, to: 119999 }]);
  assert.equal(animatedChart.getState().pointCount, 2);
  animatedChart.setHiddenRanges([]);
  assert.equal(animatedChart.getState().pointCount, 3);
  animatedChart.destroy();
  sharedChart.destroy();
});


test('incremental candle samples match full rebuilds including metadata', () => {
  const source = read('candlesticks.js').replace(/\bexport\s+/g, '');
  const { bucketHistory, appendCandleSample } = vm.runInNewContext(source + '\n({ bucketHistory, appendCandleSample })');
  const points = [];
  let candle;
  for (let index = 0; index < 300; index++) {
    const point = { t: index, v: (index * 71) % 397, tag: index % 3 ? undefined : 'updated',
      ...(index % 7 ? {} : { extra: index }) };
    points.push(point);
    const previous = candle && JSON.stringify(candle);
    const next = candle ? appendCandleSample(candle, point, 60000) : bucketHistory([point], 60000)[0];
    if (candle) assert.equal(JSON.stringify(candle), previous, 'previous candle remains unchanged');
    candle = next;
    assert.deepEqual(candle, bucketHistory(points, 60000)[0]);
  }
});

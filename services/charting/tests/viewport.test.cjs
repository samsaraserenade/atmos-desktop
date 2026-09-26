'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadViewport() {
  const module = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'viewport.js'), 'utf8'), {
    identifier: path.join(root, 'viewport.js'),
  });
  await module.link(() => { throw new Error('viewport must remain dependency-free'); });
  await module.evaluate();
  return module.namespace;
}

const candles = Array.from({ length: 100 }, (_, index) => ({
  t0: index * 60_000, t1: (index + 1) * 60_000,
  o: 100 + index, h: 103 + index, l: 98 + index, c: 101 + index,
}));

test('candle viewport restores Portfolio Tracker initial range and density', async () => {
  const { createChartViewport } = await loadViewport();
  const viewport = createChartViewport({ mode: 'candlestick', timelineMode: 'gapless', bucketMs: 60_000, width: 660, height: 320, padding: { left: 4, right: 56, top: 8, bottom: 24 } });
  const layout = viewport.calculate(candles);
  assert.equal(layout.count, 60);
  assert.deepEqual({ ...layout.domain }, { from: 40 * 60_000, to: 100 * 60_000 });
  assert.equal(layout.pan.live, true);
  assert.equal(layout.bodyWidth, 6);
});

test('wheel zoom uses the original 1.15 time-span model and five-candle floor', async () => {
  const { createChartViewport } = await loadViewport();
  const viewport = createChartViewport({ mode: 'candlestick', bucketMs: 60_000, width: 660, height: 320, padding: { left: 4, right: 56, top: 8, bottom: 24 } });
  viewport.calculate(candles);
  viewport.zoom(-1);
  viewport.calculate(candles);
  assert.equal(viewport.getState().candleSpanMs, Math.round(60 * 60_000 / 1.15));
  for (let index = 0; index < 100; index++) { viewport.zoom(-1); viewport.calculate(candles); }
  assert.equal(viewport.getState().candleSpanMs, 5 * 60_000);
  assert.equal(viewport.getState().pan.live, true);
});

test('resize preserves candle density and panning clamps to both data edges', async () => {
  const { createChartViewport } = await loadViewport();
  const viewport = createChartViewport({ mode: 'candlestick', timelineMode: 'gaps', bucketMs: 60_000, width: 660, height: 320, padding: { left: 4, right: 56, top: 8, bottom: 24 } });
  const before = viewport.calculate(candles);
  viewport.resize(960, 320);
  const after = viewport.calculate(candles);
  assert.ok(Math.abs(after.slotWidth - before.slotWidth) < 0.01);
  viewport.panPixels(1_000_000);
  assert.equal(viewport.calculate(candles).pan.start, 0);
  viewport.panPixels(-1_000_000);
  const latest = viewport.calculate(candles).pan;
  assert.equal(latest.start, latest.maxOffset);
  assert.equal(latest.live, true);
});

test('price scale and adaptive ticks match the original visible-domain formula', async () => {
  const { createChartViewport, computeAxisTicks } = await loadViewport();
  const viewport = createChartViewport({ mode: 'line', width: 520, height: 110, padding: { left: 0, right: 0, top: 8, bottom: 24 } });
  const layout = viewport.calculate([{ t: 0, v: 100 }, { t: 1, v: 101 }]);
  assert.equal(layout.priceDomain.minimum, 99.92);
  assert.ok(Math.abs(layout.priceDomain.range - 1.16) < 1e-12);
  assert.deepEqual(computeAxisTicks(0, 100, 200).map(tick => tick.value), [0, 20, 40, 60, 80, 100]);
  assert.equal(layout.priceAtPixel(layout.yOfPrice(100.5)), 100.5);
  assert.equal(layout.timeAtPixel(layout.xOfTime(1)), 1);
});


test('ordered appends reuse normalization and preserve a replaced tail; unordered appends fall back', async () => {
  const { createChartViewport } = await loadViewport();
  const data = Array.from({ length: 50 }, (_, i) => ({ time: i * 1000, value: i }));
  const viewport = createChartViewport({ mode: 'line', width: 640, height: 320 });
  viewport.calculate(data, 0);
  data[49] = { time: 49000, value: 999 };
  data.push({ time: 50000, value: 50 });
  const actual = viewport.calculate(data, 1, true);
  const fresh = createChartViewport({ mode: 'line', width: 640, height: 320 }).calculate(data, 1);
  assert.equal(JSON.stringify(actual.visible), JSON.stringify(fresh.visible));
  data.push({ time: 25000, value: -10 });
  const fallback = viewport.calculate(data, 2, true);
  const expected = createChartViewport({ mode: 'line', width: 640, height: 320 }).calculate(data, 2);
  assert.equal(JSON.stringify(fallback.visible), JSON.stringify(expected.visible));
});

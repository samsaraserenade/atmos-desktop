'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/total-chart.js'), 'utf8');

assert.match(source, /createTimeSeriesChart/);
assert.match(source, /chart\.setData\(history, \{ preserveViewport: true \}\)/);
assert.match(source, /chart\.updateLatest\(last\)/);
assert.match(source, /chart\.setStatus\(chartStatus\(\)\)/);
assert.doesNotMatch(source, /snapDefaultView/, 'only the shared renderer double-click handler may restore optimal view');
assert.match(source, /chart\.on\('hiddenRanges'/);
assert.match(source, /saveChartHidden\(hiddenRanges\)/);
assert.match(source, /toolbar: true/);
assert.doesNotMatch(source, /renderCandlesSVG|heikenAshi|computePriceScale|renderSamsaraOverlaySVG|createChartViewport/);
for (const obsolete of ['candlesticks.js', 'smoothing.js', 'samsara-indicator.js']) {
  assert.equal(fs.existsSync(path.join(root, 'src', obsolete)), false, `${obsolete} must be removed`);
}

const sampleSource = source.slice(source.indexOf('function sample()'), source.indexOf('export function getChartDiagnostics'));
let now = 0;
let total = { value: 100, gbp: 100, liveCount: 1, errorCount: 0 };
let remoteMode = false;
const totalHistory = [{ t: -15_000, v: 90 }];
const calls = [];
let optimalResets = 0;
const context = vm.createContext({
  currentSplit: () => ({ spot: total.value, perp: 0 }), section: 'total', refreshExtraPortfolioViews() {},
  isRemotePortfolioMode: () => remoteMode,
  Date: { now: () => now }, getTotal: () => total, totalHistory, collectAfter: 120_000,
  MAX_HISTORY_POINTS: 10_000, recordPortfolioHistoryFrame() {}, updateBalanceDisplay() {},
  chart: { batch(callback) { callback(); }, setStatus() {}, updateLatest: point => calls.push(['update', point.v]), append: point => calls.push(['append', point.v]), snapDefaultView() { optimalResets++; } },
  chartStatus: () => [], Object,
});
vm.runInContext(sampleSource, context);
const tick = (time, value) => { now = time; total.value = value; vm.runInContext('sample()', context); };
tick(119_999, 20);
assert.equal(totalHistory.length, 1);
tick(120_000, 100);
tick(120_500, 100.2);
assert.equal(totalHistory.length, 2, 'rapid updates coalesce');
assert.deepEqual(calls.map(call => call[0]), ['append', 'update']);
assert.deepEqual(calls, [['append', 100], ['update', 100.2]], 'the renderer must receive the new point, not the previous sample');
tick(122_000, 100.4);
assert.equal(totalHistory.length, 3, 'later samples append');
assert.deepEqual(calls.at(-1), ['append', 100.4]);
assert.equal(optimalResets, 0, 'live data must not restore optimal view');
tick(137_000, 100.4);
assert.equal(totalHistory.length, 4, 'flat polling advances time');
tick(152_000, NaN);
assert.equal(totalHistory.length, 4, 'invalid totals are rejected');
total.value = 101;
remoteMode = true;
tick(167_000, 101);
assert.equal(totalHistory.length, 4, 'VPS mode must not append a competing local history point');
assert.equal(calls.length, 4, 'VPS mode waits for authoritative reconstructed history');

console.log('Passed: Portfolio is a data adapter using the shared chart renderer');

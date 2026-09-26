const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const state = {};
const scope = vm.createContext({ portfolioState: state });
vm.runInContext(read('src/chart-axes.js').replace(/^import.*\n/, '').replace('export function', 'function'), scope);
for (const x of [true, false]) for (const y of [true, false]) {
  state.timeAxisVisible = x; state.priceAxisVisible = y;
  const options = scope.chartAxisOptions();
  assert.equal(options.showTimeAxis, x);
  assert.equal(options.showPriceAxis, y);
  assert.equal(options.showCrosshair, true);
  assert.equal(options.showHoverLabels, true);
  assert.equal(options.showTimeHoverLabel, true);
}

const renderer = fs.readFileSync(path.resolve(root, '../../services/charting/chart-next.js'), 'utf8').replace(/\r\n/g, '\n');
const start = renderer.indexOf('  function timeAxisMarkup(');
const end = renderer.indexOf('  let lineMarkupCache', start);
const settings = { showTimeAxis: true, showPriceAxis: true, width: 600, height: 300,
  padding: { left: 4, right: 56, top: 8, bottom: 22 }, gridColor: '#333', textColor: '#aaa',
  formatTime: t => String(t), formatValue: v => String(v) };
const axes = vm.createContext({ settings, measuredAxisEdgeOffset: 0, escapeXml: String });
vm.runInContext(renderer.slice(start, end), axes);
const layout = { domain: { from: 0, to: 10000 }, plotWidth: 440,
  timeAtPixel: x => x * 10, ticks: [{ value: 25 }, { value: 50 }], yOfPrice: v => v * 2 };
for (const x of [true, false]) for (const y of [true, false]) {
  settings.showTimeAxis = x; settings.showPriceAxis = y;
  const markup = axes.axisMarkup(layout);
  assert.equal((markup.match(/<line /g) || []).length, (x ? 4 : 0) + (y ? 2 : 0));
  assert.equal((markup.match(/<text /g) || []).length, (x ? 4 : 0) + (y ? 2 : 0));
}
settings.showTimeAxis = true;
assert.equal(axes.timeAxisMarkup({ ...layout, domain: null }), '');
assert.equal(axes.timeAxisMarkup({ ...layout, plotWidth: 0 }), '');

// Axis controls now live in the chart toolbar and Finance mirrors their
// renderer-owned aria state into its shared persisted axis preferences.
const panel = read('panel.js');
const sidebar = read('src/sidebar-settings.js');
assert.match(renderer, /dataset\.axisX/);
assert.match(renderer, /dataset\.axisY/);
assert.match(panel, /closest\('\[data-axis-x\], \[data-axis-y\]'\)/);
assert.match(panel, /setTimeAxisVisible\(visible\)/);
assert.match(panel, /setPriceAxisVisible\(visible\)/);
assert.doesNotMatch(sidebar, /vis-time-axis|vis-price-axis|mountChartOptions/);
console.log('Passed: independent axes render correctly and persist from right-side toolbar controls');

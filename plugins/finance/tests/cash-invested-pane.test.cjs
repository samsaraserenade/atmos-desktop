'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

// ── cash-invested-pane.js + its ratio-history-chart.js dependency: both
// pure, no DOM -- same execute-in-sandbox pattern as
// ratio-history-timeline.test.cjs. The dependency's `import`/`export`
// lines are stripped and the two sources concatenated into one sandbox,
// same as the finance plugin's other pure-module tests. ────────────────────
const seriesSource = readFileSync(`${__dirname}/../../../services/charting/series.js`, 'utf8').replace(/\bexport\s+/g, '');
const ratioSource = seriesSource + '\n' + readFileSync(`${__dirname}/../src/ratio-history-chart.js`, 'utf8')
  .replace(/^(?:import|export \{).*$/gm, '')
  .replace(/\bexport\s+/g, '');
const paneSource = readFileSync(`${__dirname}/../src/indicators/cash-invested-pane.js`, 'utf8')
  .replace(/^import\s+.*$/gm, '')
  .replace(/\bexport\s+/g, '');
const combined = `${ratioSource}\n${paneSource}`;

const points = [
  { t: 1_000, investedRatio: 0.75, cashRatio: 0.25 },
  { t: 61_000, investedRatio: 0.5, cashRatio: 0.5 },
  { t: 121_000, investedRatio: 0.25, cashRatio: 0.75 },
  { t: 181_000, investedRatio: 0.6, cashRatio: 0.4 },
];

/** Runs renderCashInvestedPane in a fresh sandbox and reports which raw
 * timestamps xOfTime was actually called with, so domain-clipping/
 * downsampling behavior can be verified without reaching into internals. */
function renderWithSpy({ data, domain, width = 640, height = 56 }) {
  const calls = [];
  const sandbox = vm.createContext({
    data, domain, width, height,
    xot: t => { calls.push(t); return (t / 500_000) * 640; },
  });
  const markup = vm.runInContext(`${combined}
    renderCashInvestedPane({ data, xOfTime: xot, width, height, domain })`, sandbox);
  return { markup, calls };
}

const full = renderWithSpy({ data: points, domain: { from: 0, to: 500_000 } });
assert.match(full.markup, /<path d="M [\d.]+,56\.0/, 'the invested area path must be a closed shape starting at the pane baseline');
assert.equal((full.markup.match(/<path/g) || []).length, 2, 'a rendered pane must draw exactly two stacked areas (invested + cash)');
assert.deepEqual(full.calls, points.map(p => p.t), 'a domain covering all samples must pass every point through to xOfTime');
console.log('Passed: renderCashInvestedPane draws a stacked area from the real xOfTime mapping it is handed');

const empty = renderWithSpy({ data: [points[0]], domain: { from: 0, to: 500_000 } });
assert.match(empty.markup, /Not enough history yet/, 'fewer than 2 valid points must show the empty-state text, not draw an area');
assert.equal(empty.calls.length, 0, 'the empty-state path must not call xOfTime at all');
console.log('Passed: renderCashInvestedPane falls back to an empty-state message below 2 points');

const narrow = renderWithSpy({ data: points, domain: { from: 55_000, to: 65_000 } });
assert.deepEqual(narrow.calls, [1_000, 61_000, 121_000],
  'a narrow domain must clip to the visible window plus one padding sample on each side, not draw the whole history');
console.log('Passed: renderCashInvestedPane clips to the pane\'s visible domain (plus one edge sample) instead of the full series');

const other = vm.runInContext(`${combined}
  ({
    paneId: CASH_INVESTED_PANE_ID,
    paneHeight: CASH_INVESTED_PANE_HEIGHT,
    paneMinHeight: CASH_INVESTED_PANE_MIN_HEIGHT,
    paneMaxHeight: CASH_INVESTED_PANE_MAX_HEIGHT,
    spec: createCashInvestedPane(),
    specWithSavedHeight: createCashInvestedPane(undefined, 88),
    specWithInvalidHeight: createCashInvestedPane(undefined, -5),
    nearest: nearestCashInvestedSampleTime(points, 65000),
    nearestEmpty: nearestCashInvestedSampleTime([], 100),
  })`, vm.createContext({ points }));

assert.equal(other.paneId, 'cash-invested');
assert.equal(other.paneHeight, 56);
assert.equal(other.paneMinHeight, 30);
assert.equal(other.paneMaxHeight, 200);
assert.deepEqual(Object.keys(other.spec).sort(), ['height', 'hover', 'id', 'maxHeight', 'minHeight', 'render', 'resizable']);
assert.equal(other.spec.id, 'cash-invested');
assert.equal(other.spec.height, 56, 'without a saved height, the pane must start at the default height');
assert.equal(other.spec.minHeight, 30);
assert.equal(other.spec.maxHeight, 200);
assert.equal(other.spec.resizable, true, 'the pane must opt into the engine\'s drag-to-resize handle');
assert.equal(typeof other.spec.render, 'function');
assert.equal(other.specWithSavedHeight.height, 88, 'a previously-persisted height must seed the pane instead of the default');
assert.equal(other.specWithInvalidHeight.height, 56, 'an invalid saved height (<=0) must fall back to the default, not produce a broken pane');
console.log('Passed: createCashInvestedPane returns a spec matching the shared engine\'s options.panes[] contract, resizable and seeded from a saved height');

assert.equal(other.nearest, 61_000, 'nearestCashInvestedSampleTime must resolve a raw chart timestamp to the closest actual ratio sample');
assert.equal(other.nearestEmpty, null, 'nearestCashInvestedSampleTime must return null when there is no ratio history yet');
console.log('Passed: nearestCashInvestedSampleTime resolves chart.coordinateToTime() output to the nearest real sample');

const colorTest = vm.runInContext(`${combined}
  (() => {
    let callCount = 0;
    const withColors = createCashInvestedPane(() => { callCount++; return { up: '#111111', down: '#222222' }; });
    const ctx = { data: points, xOfTime: t => t / 1000, width: 640, height: 56, domain: { from: 0, to: 500000 } };
    const markupWithColors = withColors.render(ctx);
    const markupWithColorsAgain = withColors.render(ctx);
    const markupDefault = createCashInvestedPane().render(ctx);
    const markupFalsy = createCashInvestedPane(() => null).render(ctx);
    return { callCount, markupWithColors, markupWithColorsAgain, markupDefault, markupFalsy };
  })()`, vm.createContext({ points }));

assert.ok(colorTest.markupWithColors.includes('#111111'), 'a getColors callback\'s "up" color must flow into the invested area\'s fill/stroke');
assert.ok(colorTest.markupWithColors.includes('#222222'), 'a getColors callback\'s "down" color must flow into the cash area\'s fill/stroke');
assert.equal(colorTest.callCount, 2, 'getColors must be re-read on every render() call, not just once at pane creation, so price-color changes take effect live');
assert.ok(colorTest.markupDefault.includes('#34d399'), 'omitting getColors must fall back to the pane\'s own default invested color');
assert.ok(colorTest.markupFalsy.includes('#34d399'), 'a getColors callback returning nothing must fall back to the default color, not crash');
console.log('Passed: createCashInvestedPane re-reads colors from getColors on every render, so it tracks price-color.js live');


const preparedContext = vm.createContext({ points });
vm.runInContext(combined, preparedContext);
vm.runInContext(`
  const prepared = prepareCashInvestedData(points);
  const rawMarkup = renderCashInvestedPane({ data: points, xOfTime: t => t / 1000, width: 640, domain: { from: 60000, to: 130000 } });
  const preparedMarkup = renderCashInvestedPane({ data: prepared, xOfTime: t => t / 1000, width: 640, domain: { from: 60000, to: 130000 } });
  if (rawMarkup !== preparedMarkup) throw new Error('prepared rendering differs');
  buildRatioSeries = () => { throw new Error('unexpected history rebuild'); };
  renderCashInvestedPane({ data: prepared, xOfTime: t => t / 1000, width: 640 });
  if (nearestCashInvestedSampleTime(prepared, 61001) !== 61000) throw new Error('incorrect cached lookup');
`, preparedContext);
console.log('Passed: prepared ratio snapshots render and hit-test without rebuilding history');

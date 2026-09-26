'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

// ── ratio-history-chart.js: pure, no imports — same execute-in-sandbox
// pattern as allocation-chart.test.cjs. ──────────────────────────────────────
const seriesSource = readFileSync(`${__dirname}/../../../services/charting/series.js`, 'utf8').replace(/\r\n/g, '\n').replace(/\bexport\s+/g, '');
const ratioSource = seriesSource + '\n' + readFileSync(`${__dirname}/../src/ratio-history-chart.js`, 'utf8').replace(/\r\n/g, '\n')
  .replace(/^(?:import|export \{).*$/gm, '')
  .replace(/\bexport\s+/g, '');

const ratioResult = vm.runInNewContext(`${ratioSource}
({
  empty: renderRatioHistorySVG({ points: [{ t: 1, investedRatio: 0.5, cashRatio: 0.5 }], W: 300, H: 34 }),
  filtered: buildRatioSeries([
    { t: 3000, investedRatio: 0.6, cashRatio: 0.4 },
    { t: 1000, investedRatio: 0.75, cashRatio: 0.25 },
    { t: 2000, investedRatio: NaN, cashRatio: 0.5 },
    { t: 2500 },
    { t: 4000, investedRatio: 1.4, cashRatio: -0.2 },
  ]),
  rendered: renderRatioHistorySVG({
    points: [
      { t: 1000, investedRatio: 0.75, cashRatio: 0.25 },
      { t: 2000, investedRatio: 0.5, cashRatio: 0.5 },
      { t: 3000, investedRatio: 0.25, cashRatio: 0.75 },
    ],
    W: 300, H: 40, investedColor: '#34d399', cashColor: '#f87171',
  }),
  xAtStart: timestampForX({
    series: [{ t: 1000 }, { t: 2000 }, { t: 3000 }], W: 300, x: 0,
  }),
  xAtEnd: timestampForX({
    series: [{ t: 1000 }, { t: 2000 }, { t: 3000 }], W: 300, x: 300,
  }),
  xNearestMidLow: timestampForX({
    series: [{ t: 1000 }, { t: 2000 }, { t: 3000 }], W: 300, x: 50,
  }),
  xTooShort: timestampForX({ series: [{ t: 1000 }], W: 300, x: 10 }),
})`);

assert.match(ratioResult.empty.markup, /Not enough history yet/, 'a single point must fall back to the empty state, not draw a zero-width area');
assert.equal(ratioResult.filtered.length, 3, 'NaN ratios and missing ratios must be dropped; out-of-range-but-finite ratios must still be kept (and clamped)');
assert.equal(ratioResult.filtered.map(p => p.t).join(','), '1000,3000,4000', 'series must come back sorted by time');
assert.equal(ratioResult.filtered[0].investedRatio, 0.75);
assert.equal(ratioResult.filtered[2].investedRatio, 1, 'an out-of-range ratio must be clamped to [0,1], not passed through raw');
assert.equal(ratioResult.filtered[2].cashRatio, 0, 'an out-of-range ratio must be clamped to [0,1], not passed through raw');
assert.equal(ratioResult.rendered.series.length, 3);
assert.match(ratioResult.rendered.markup, /pt-ratio-history-chart/);
assert.equal((ratioResult.rendered.markup.match(/<path /g) || []).length, 2, 'must draw exactly an invested area and a cash area');
assert.match(ratioResult.rendered.markup, /fill="#34d399"/);
assert.match(ratioResult.rendered.markup, /fill="#f87171"/);
assert.equal(ratioResult.xAtStart, 1000, 'the left edge must map to the first sample');
assert.equal(ratioResult.xAtEnd, 3000, 'the right edge must map to the last sample');
assert.equal(ratioResult.xNearestMidLow, 1000, 'a pointer position closer to the earlier sample must snap to it, not the next one');
assert.equal(ratioResult.xTooShort, null, 'a single-sample series has nothing to map a pointer position onto');
console.log('Passed: cash/invested ratio history renders a stacked area and hit-tests back to the right sample');

// ── holdings-timeline.js: strip the registry.js import (fetchHoldingsHistory
// is only referenced inside loadHoldingsTimeline(), which nothing here
// calls) so the pure bucketing/lookup helpers can run the same
// sandboxed way, without pulling in registry.js's own app-runtime
// dependencies. ───────────────────────────────────────────────────────────
const timelineSource = readFileSync(`${__dirname}/../src/holdings-timeline.js`, 'utf8').replace(/\r\n/g, '\n')
  .replace(/^import .*from '\.\/registry\.js';\n/m, '')
  .replace(/\bexport\s+/g, '');

const timelineResult = vm.runInNewContext(`${timelineSource}
const rows = [
  { ts_ms: 1000, source_id: 'a', symbol: 'SOL', kind: 'invested', quantity: 2, price: 50, value: 100, currency: 'USD' },
  { ts_ms: 1000, source_id: 'b', symbol: 'USDC', kind: 'cash', quantity: 20, price: 1, value: 20, currency: 'USD' },
  { ts_ms: 2000, source_id: 'a', symbol: 'SOL', kind: 'invested', quantity: 2, price: 55, value: 110, currency: 'USD' },
  { ts_ms: 'not-a-number', source_id: 'x', symbol: 'BAD', kind: 'cash', quantity: 1, price: 1, value: 1, currency: 'USD' },
];
const bucketed = bucketByTimestamp(rows);
({
  sortedTs: bucketed.sortedTs,
  bucketSizes: bucketed.sortedTs.map(ts => bucketed.byTs.get(ts).length),
  exact: nearestSnapshot(bucketed, 2000),
  between: nearestSnapshot(bucketed, 1500),
  before: nearestSnapshot(bucketed, 0),
  after: nearestSnapshot(bucketed, 9000),
  empty: nearestSnapshot({ sortedTs: [], byTs: new Map() }, 1000),
  nullCache: nearestSnapshot(null, 1000),
})`);

assert.equal(timelineResult.sortedTs.join(','), '1000,2000', 'a row with an unparseable timestamp must be dropped, not crash the bucketer');
assert.equal(timelineResult.bucketSizes.join(','), '2,1', 'two sources polled at the same ts_ms must land in the same bucket');
assert.equal(timelineResult.exact.ts, 2000, 'an exact timestamp match must be used directly');
assert.equal(timelineResult.between.ts, 1000, 'a timestamp between two polls must resolve to the one at-or-before it, not the next one');
assert.equal(timelineResult.before.ts, 1000, 'a timestamp before every cached poll must fall back to the earliest one, not return nothing');
assert.equal(timelineResult.after.ts, 2000, 'a timestamp after every cached poll must resolve to the latest one');
assert.equal(timelineResult.empty, null, 'an empty cache must report "nothing to show", not throw');
assert.equal(timelineResult.nullCache, null, 'a missing cache (e.g. before the first fetch resolves) must report "nothing to show", not throw');
console.log('Passed: holdings-history rows bucket by poll and resolve to the nearest snapshot at or before a hovered time');

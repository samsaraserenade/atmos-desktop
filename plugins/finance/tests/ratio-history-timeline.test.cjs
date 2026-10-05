'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

// ── ratio-history-chart.js: pure, no imports — executed in a sandbox. ────────
const seriesSource = readFileSync(`${__dirname}/../../../services/charting/series.js`, 'utf8').replace(/\r\n/g, '\n').replace(/\bexport\s+/g, '');
const ratioSource = seriesSource + '\n' + readFileSync(`${__dirname}/../src/ratio-history-chart.js`, 'utf8').replace(/\r\n/g, '\n')
  .replace(/^(?:import|export \{).*$/gm, '')
  .replace(/\bexport\s+/g, '');

const ratioResult = vm.runInNewContext(`${ratioSource}
({
  filtered: buildRatioSeries([
    { t: 3000, investedRatio: 0.6, cashRatio: 0.4 },
    { t: 1000, investedRatio: 0.75, cashRatio: 0.25 },
    { t: 2000, investedRatio: NaN, cashRatio: 0.5 },
    { t: 2500 },
    { t: 4000, investedRatio: 1.4, cashRatio: -0.2 },
  ]),
})`);

assert.equal(ratioResult.filtered.length, 3, 'NaN ratios and missing ratios must be dropped; out-of-range-but-finite ratios must still be kept (and clamped)');
assert.equal(ratioResult.filtered.map(p => p.t).join(','), '1000,3000,4000', 'series must come back sorted by time');
assert.equal(ratioResult.filtered[0].investedRatio, 0.75);
assert.equal(ratioResult.filtered[2].investedRatio, 1, 'an out-of-range ratio must be clamped to [0,1], not passed through raw');
assert.equal(ratioResult.filtered[2].cashRatio, 0, 'an out-of-range ratio must be clamped to [0,1], not passed through raw');
console.log('Passed: cash/invested ratio series is filtered, sorted and clamped');

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

// ── loadSnapshotNear: one poll, read from a few minutes of polls ──────────
// (the Movers' "a day ago" read every poll of 30 hours, up to 50,000 rows,
// and the server ran out of memory).
(async () => {
  const MIN = 60_000;
  const context = vm.createContext({ Map, Set, Promise, Number, Math, Array });
  vm.runInContext(timelineSource, context);
  const polls = [10 * MIN, 11 * MIN, 12 * MIN, 200 * MIN];
  const asked = [];
  const fetch = async ({ from, to }) => {
    asked.push([from / MIN, to / MIN]);
    return polls.filter(ts => ts >= from && ts <= to).flatMap(ts => [
      { ts_ms: ts, source_id: 'a', symbol: 'SOL', value: 1 }, { ts_ms: ts, source_id: 'b', symbol: 'ETH', value: 2 },
    ]);
  };
  const near = (at, options) => context.loadSnapshotNear(at, { ...options, fetch });

  const at13 = await near(13 * MIN, { before: 6 * 60 * MIN });
  assert.equal(at13.ts, 12 * MIN, 'the last poll at or before');
  assert.equal(at13.holdings.length, 2);
  assert.deepEqual(asked, [[8, 13]], 'five minutes of polls, one read');

  asked.length = 0;
  const at100 = await near(100 * MIN, { before: 6 * 60 * MIN });
  assert.equal(at100.ts, 12 * MIN, 'a gap: wider windows, narrowest first');
  assert.deepEqual(asked, [[95, 100], [40, 100], [-260, 100]]);

  asked.length = 0;
  assert.equal(await near(100 * MIN, { before: 6 * 60 * MIN }), at100, 'asked again: kept');
  assert.deepEqual(asked, []);

  assert.equal(await near(5 * MIN, { before: 3 * MIN }), null, 'none that close: nothing');
  asked.length = 0;
  const ahead = await near(150 * MIN, { before: 30 * MIN, after: 6 * 60 * MIN });
  assert.equal(ahead.ts, 200 * MIN, 'none before: the first one after, within `after`');
  assert.deepEqual(asked, [[145, 150], [120, 150], [150, 155], [150, 210]]);

  assert.deepEqual(Array.from(context.snapshotWindows(48 * 60 * MIN)).map(ms => ms / MIN), [5, 60, 360, 2880]);
  assert.deepEqual(Array.from(context.snapshotWindows(12 * 60 * MIN)).map(ms => ms / MIN), [5, 60, 360, 720]);
  assert.deepEqual(Array.from(context.snapshotWindows(0)), []);

  let failing = true;
  const flaky = async range => { if (failing) throw new Error('down'); return fetch(range); };
  await assert.rejects(context.loadSnapshotNear(11 * MIN, { fetch: flaky }), /down/);
  failing = false;
  assert.equal((await context.loadSnapshotNear(11 * MIN, { fetch: flaky })).ts, 11 * MIN, 'a failed read is asked again');

  const balance = readFileSync(`${__dirname}/../src/balance.js`, 'utf8');
  assert.doesNotMatch(balance, /loadHoldingsTimeline\(/, 'no range of every poll is read for one snapshot');
  assert.match(balance, /if \(!_compositionEl\) \{\r?\n\s+if \(minute !== _relayedMinute\)/, 'a frame without the composition bar reads nothing, it tells the frame that has it');
  console.log('Passed: a snapshot is read from a few minutes of polls, wider only when there\'s none, and kept');
})().catch(error => { console.error(error); process.exitCode = 1; });

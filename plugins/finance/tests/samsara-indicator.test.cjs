'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

const source = readFileSync(`${__dirname}/../../../services/charting/indicators.js`, 'utf8')
  .replace(/\bexport\s+/g, '');
const result = vm.runInNewContext(`${source}
({
  sma: sma([1, 2, 3, 4, 5], 3),
  ema: ema([1, 2, 3, 4, 5], 3),
  wma: wma([1, 2, 3, 4, 5], 3),
  risingRsi: rsi(Array.from({ length: 20 }, (_, i) => i), 14),
  sessions: [0, 7, 13, 21].map(hour => mergedUtcSession(Date.UTC(2026, 0, 1, hour)).key),
  filteredMaCount: buildSamsaraStudy(
    Array.from({ length: 20 }, (_, i) => i),
    { movingAverages: [
      { type: 'EMA', length: 5, enabled: false },
      { type: 'SMA', length: 5, enabled: true },
    ] },
  ).movingAverages.length,
  svg: renderSamsaraOverlaySVG({
    values: Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 8) * 5),
    times: Array.from({ length: 250 }, (_, i) => Date.UTC(2026, 0, 1) + i * 60000),
    xs: Array.from({ length: 250 }, (_, i) => i),
    yOf: value => 200 - value,
    plotTop: 0,
    plotHeight: 120,
    bullishColor: '#00ff00',
    bearishColor: '#ff0000',
  }),
  hiddenSvg: renderSamsaraOverlaySVG({
    values: Array.from({ length: 30 }, (_, i) => 100 + i),
    times: Array.from({ length: 30 }, (_, i) => Date.UTC(2026, 0, 1) + i * 60000),
    xs: Array.from({ length: 30 }, (_, i) => i),
    yOf: value => 200 - value,
    plotTop: 0,
    plotHeight: 120,
    bullishColor: '#00ff00',
    bearishColor: '#ff0000',
    config: { showMovingAverages: false, showRsi: false, showSessions: false },
  }),
})`);

assert.deepEqual(JSON.parse(JSON.stringify(result.sma)), [null, null, 2, 3, 4]);
assert.deepEqual(JSON.parse(JSON.stringify(result.ema)), [null, null, 2, 3, 4]);
assert.deepEqual(JSON.parse(JSON.stringify(result.wma)), [null, null, 14 / 6, 20 / 6, 26 / 6]);
assert.equal(result.risingRsi[14], 100, 'Wilder RSI must reach 100 for an uninterrupted rise');
assert.deepEqual(JSON.parse(JSON.stringify(result.sessions)), ['tokyo', 'london', 'new-york', 'sydney']);
assert.equal(result.filteredMaCount, 1, 'disabled moving averages must be omitted independently');
assert.match(result.svg, /tc-samsara-overlay/);
assert.match(result.svg, /<path/);
assert.match(result.svg, /<rect/);
assert.doesNotMatch(result.hiddenSvg, /<path|<polygon|opacity="0\.13"|height="3"/,
  'each Samsara visual layer must be independently hideable');
console.log('Passed: Samsara moving averages, RSI, sessions, and SVG overlay');

'use strict';

// The Markets chart saves its timeframe through an allow-list
// (markets/persist.js). Every timeframe Charting offers must be on it, or it
// is saved as 5m and the chart comes back on the wrong one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '..', '..', '..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');

test('every Charting timeframe is one the Markets chart can save', async () => {
  const toolbar = read('services/charting/toolbar.js');
  const { CHART_INTERVALS } = await import('data:text/javascript;base64,' + Buffer.from(toolbar).toString('base64'));
  const persist = read('plugins/finance/markets/persist.js');
  const list = /const INTERVALS = new Set\(\[([\s\S]*?)\]\)/.exec(persist);
  assert.ok(list, 'persist.js has its INTERVALS allow-list');
  const saved = new Set([...list[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
  for (const interval of CHART_INTERVALS) assert.ok(saved.has(interval.value), `${interval.value} (${interval.label}) is saved as itself`);
  assert.ok(saved.has('custom'));
});

test('a chart that restores another timeframe than the one fetched fetches that one', () => {
  const panel = read('plugins/finance/markets/panel.js');
  assert.match(panel, /syncFromChart\(chart\.getState\(\), true\)/);
});

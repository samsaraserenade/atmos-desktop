'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(pluginRoot, relative), 'utf8');

test('registry owns timestamped per-connector source history', () => {
  const registry = read('src/registry.js');
  const storage = read('src/storage.js');
  const chart = read('src/total-chart.js');

  assert.match(storage, /portfolio-tracker:connection-history-v1/);
  assert.match(storage, /portfolio-tracker:connection-history-v2/);
  assert.match(registry, /HISTORY_CHUNK_SIZE = 1024/);
  assert.match(registry, /saveConnectionHistoryChunk/);
  assert.doesNotMatch(registry, /_serializePortfolioHistories/);
  assert.match(registry, /export function recordPortfolioHistoryFrame/);
  assert.match(registry, /snapshot: _clonePortfolioSnapshot\(data\)/);
  assert.match(registry, /observedValue/);
  assert.match(registry, /status === 'error' \|\| status === 'partial'/);
  assert.match(chart, /buildCombinedHistoryFromConnectors/);
  assert.match(chart, /recordPortfolioHistoryFrame\(now, \{ settled \}\)/);
  assert.doesNotMatch(registry, /export function getPortfolioCandles/);
  assert.doesNotMatch(chart, /_scheduleHistorySave/);
});

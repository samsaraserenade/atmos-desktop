'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Markets keeps its module entry points inside Finance', () => {
  // Markets is part of Finance; only Finance has a manifest.
  assert.equal(fs.existsSync(path.join(root, 'extension.json')), false);
  for (const file of ['panel.js', 'sidebar.js', 'persist.js', 'watchlist.js', 'src/watchlist-data.js', 'styles.css']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
});

test('Markets reuses the Portfolio chart panel', () => {
  assert.doesNotMatch(read('panel.js'), /registerPanelPlugin\(/);
  assert.match(read('panel.js'), /export function mountMarketsPanel/);
  assert.match(read('sidebar.js'), /registerSection\('markets'/);
  // A watchlist symbol opens in the Finance panel, another frame (frame-panel.js).
  assert.match(read('sidebar.js'), /requestPanelAction\(\{ type: 'open-market'/);
  assert.match(read('../frame-panel.js'), /atmos:chart-mode/);
  assert.match(read('../src/host/mirror.js'), /watchlist\.startPolling\(context\)/);
  assert.match(read('persist.js'), /registerStateNamespace\('markets'/);
  assert.match(read('persist.js'), /version: 2/);
  assert.match(read('persist.js'), /migrate\(data, fromVersion\)/);
  assert.match(read('persist.js'), /persistChartSettings/);
  assert.match(read('persist.js'), /extensionState\['market-query'\]/);
});

test('plugin consumes services through the loader and owns lifecycle cleanup', () => {
  const panel = read('panel.js');
  assert.match(panel, /getServiceFileUrl\('market-data', 'api\.js'\)/);
  assert.match(panel, /getServiceFileUrl\('charting', 'api\.js'\)/);
  assert.match(panel, /context\.onCleanup\(\(\) => subscription\?\.unsubscribe\(\)\)/);
  assert.doesNotMatch(panel, /exchanges\/(binance|bybit|kraken)/);
  assert.doesNotMatch(panel, /\.mjs['"]/);
  assert.match(panel, /\.\/src\/query-engine\.js/);
});

test('all Markets renderer modules parse and relative imports resolve', () => {
  for (const file of ['panel.js', 'sidebar.js', 'persist.js', 'watchlist.js', 'src/query-engine.js', 'src/session.js', 'src/watchlist-data.js']) {
    const source = read(file);
    assert.doesNotThrow(() => new vm.SourceTextModule(source, { identifier: file }), file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
      const resolved = path.resolve(root, path.dirname(file), match[2]);
      assert.equal(fs.existsSync(resolved), true, `${file}: missing ${match[2]}`);
    }
  }
});

test('sidebar icon uses the standard Atmos accordion dimensions', () => {
  const sidebar = read('sidebar.js');
  assert.match(sidebar, /<svg width="11" height="11" viewBox="0 0 24 24"/);
});

test('query parser recognizes symbols, intents, exchanges, and intervals', async () => {
  const source = read('src/query-engine.js').replace(/^export \{ parseIntervalMs[^\n]+/m, fs.readFileSync(path.resolve(root, '../../../services/charting/intervals.js'), 'utf8'));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { parseMarketQuery } = await import(moduleUrl);
  assert.deepEqual(parseMarketQuery('BTC order book on Kraken'), {
    raw: 'BTC order book on Kraken', intent: 'orderbook', symbol: 'BTCUSDT', interval: '1m', exchanges: ['kraken'],
  });
  assert.equal(parseMarketQuery('ETHUSDT liquidations').intent, 'liquidations');
  assert.equal(parseMarketQuery('SOL 5m candles').interval, '5m');
  assert.equal(parseMarketQuery('provider health', 'DOGEUSDT').symbol, 'DOGEUSDT');
});

test('chart labels show the coin and any named exchange, not the remembered query text', async () => {
  const source = read('src/query-engine.js').replace(/^export \{ parseIntervalMs[^\n]+/m, fs.readFileSync(path.resolve(root, '../../../services/charting/intervals.js'), 'utf8'));
  const { chartLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(chartLabel('BTCUSDT 1m candles'), 'BTC');
  assert.equal(chartLabel('BTCUSDT coinbase 1m candles'), 'BTC · Coinbase');
  assert.equal(chartLabel('ETHBTC'), 'ETHBTC');
});

test('custom chart intervals accept seconds through days and reject unsafe values', async () => {
  const source = read('src/query-engine.js').replace(/^export \{ parseIntervalMs[^\n]+/m, fs.readFileSync(path.resolve(root, '../../../services/charting/intervals.js'), 'utf8'));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { parseIntervalMs, formatIntervalMs } = await import(moduleUrl);
  assert.equal(parseIntervalMs('1s'), 1_000);
  assert.equal(parseIntervalMs('30s'), 30_000);
  assert.equal(parseIntervalMs('2m'), 120_000);
  assert.equal(parseIntervalMs('3h'), 10_800_000);
  assert.equal(parseIntervalMs('1'), 1_000);
  assert.equal(parseIntervalMs('500ms'), null);
  assert.equal(parseIntervalMs('31d'), null);
  assert.equal(formatIntervalMs(1_000), '1s');
});

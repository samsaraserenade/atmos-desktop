'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Finance loads both features locally and routes IPC to its installed identity', () => {
  for (const entry of ['sidebar.js', 'persist.js']) {
    assert.ok(read(entry).includes(`import './markets/${entry}'`));
  }
  assert.ok(read('panel.js').includes("import('./markets/panel.js')"));
  assert.ok(read('src/registry.js').includes("import('../markets/watchlist.js')"));
  assert.match(read('src/host/frame.js'), /export const SELF = 'plugin:finance'/);
  for (const file of ['src/remote.js', 'src/network.js']) {
    assert.match(read(file), /invokeFinance as invoke/);
    assert.doesNotMatch(read(file), /getPluginFileUrl\(|atmos-plugin:\/\/(markets|portfolio-tracker|market-query)/);
  }
});

test('Finance registers and hydrates the existing saved state namespaces together', async () => {
  const registered = new Map();
  const context = vm.createContext({
    structuredClone, console,
    localStorage: { getItem: () => null },
  });
  const persist = new vm.SyntheticModule(['registerStateNamespace', 'onStateLoaded', 'save'], function () {
    this.setExport('registerStateNamespace', (id, spec) => {
      assert.equal(registered.has(id), false, `duplicate namespace ${id}`);
      registered.set(id, spec);
      return structuredClone(spec.defaults);
    });
    this.setExport('onStateLoaded', () => {});
    this.setExport('save', () => {});
  }, { context });
  const markets = new vm.SourceTextModule(read('markets/persist.js'), { context });
  const finance = new vm.SourceTextModule(read('persist.js'), { context });
  await markets.link(() => persist);
  await finance.link(specifier => specifier === './markets/persist.js' ? markets : persist);
  await finance.evaluate();
  assert.deepEqual([...registered.keys()].sort(), ['markets', 'portfolio-tracker', 'watchlist']);
  const portfolio = {};
  registered.get('portfolio-tracker').hydrate(portfolio, { chartVisible: true, chartSmoothing: 7, tickerEnabled: { wallet: true } });
  assert.equal(portfolio.chartVisible, true);
  assert.equal(portfolio.chartSmoothing, 7);
  assert.equal(portfolio.tickerEnabled.wallet, true);
  const watchlist = {};
  registered.get('watchlist').hydrate(watchlist, { tickers: ['SOL'], activeT: 'SOL' });
  assert.equal(watchlist.activeT, 'SOL');
  const market = {};
  registered.get('markets').hydrate(market, { lastQuery: 'SOLUSDT', chart: { interval: '1h' } });
  assert.equal(market.lastQuery, 'SOLUSDT');
  assert.equal(market.chart.interval, '1h');
});
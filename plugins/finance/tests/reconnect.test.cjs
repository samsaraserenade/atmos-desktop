'use strict';
// registry.js's engine pairing another server (R13): a reconnect while the
// first server is still starting leaves only the new one running, and what
// the old one sends meanwhile isn't taken for the new one's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../src');

test('a reconnect while the first server is still starting keeps only the new one', async () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), window: {} });
  const readers = [];
  let paired = 'A';
  const synthetic = (names, values) => new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); }, { context });
  const stubs = {
    './totals.js': synthetic(['initCurrencyService', 'startRatesPolling'], { initCurrencyService: async () => {}, startRatesPolling: () => {} }),
    './storage.js': synthetic(['loadConnectionHistory', 'loadConnectionHistoryChunk', 'loadConnectionHistoryManifest', 'saveConnectionHistoryChunk', 'saveConnectionHistoryManifest'],
      { loadConnectionHistory: async () => ({ version: 1, connections: {} }), loadConnectionHistoryChunk: async () => [], loadConnectionHistoryManifest: async () => null, saveConnectionHistoryChunk: async () => {}, saveConnectionHistoryManifest: async () => {} }),
    './history-constants.js': synthetic(['MAX_HISTORY_POINTS'], { MAX_HISTORY_POINTS: 10_000 }),
    './remote.js': synthetic(['getConnection', 'startVpsPortfolio', 'fetchHoldingsHistory', 'fetchHoldingsPage'], {
      getConnection: async () => ({ configured: true, address: `https://${paired}`, id: paired }),
      // As remote.js: the first read publishes, then it resolves. A is slow.
      startVpsPortfolio: (_context, callbacks) => {
        const reader = { server: paired, stopped: false };
        reader.stop = () => { reader.stopped = true; };
        readers.push(reader);
        return new Promise(resolve => setTimeout(() => {
          callbacks.publish(`${reader.server}-wallet`, { label: `${reader.server}'s wallet`, value: 100, currency: 'USD', holdings: [], lastUpdate: 1 });
          resolve({ ids: new Set(), refresh: () => {}, refreshHistory: async () => {}, stop: reader.stop });
        }, reader.server === 'A' ? 50 : 5));
      },
      fetchHoldingsHistory: async () => [], fetchHoldingsPage: async () => ({}),
    }),
    './connections-list.js': synthetic(['renderConnections'], { renderConnections: () => {} }),
    './host/frame.js': synthetic(['isEngine'], { isEngine: () => true }),
  };
  const change = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'history-change.js'), 'utf8'), { context, identifier: 'history-change.js' });
  await change.link(() => { throw new Error('unexpected import'); });
  const registryModule = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'registry.js'), 'utf8'), { context, identifier: 'registry.js' });
  await registryModule.link(specifier => specifier === './history-change.js' ? change : stubs[specifier]);
  await registryModule.evaluate();
  const registry = registryModule.namespace;

  const starting = registry.initExchanges(null);
  await new Promise(resolve => setTimeout(resolve, 10));
  paired = 'B'; // paired meanwhile: main.cjs switched, the engine is told to reconnect
  await registry.reconnectPortfolio();
  await starting;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(registry.getServerConnection().id, 'B');
  assert.deepEqual([...registry.getAllPortfolios().keys()], ['B-wallet'], "A's wallet isn't taken for B's");
  assert.deepEqual(readers.map(reader => `${reader.server}:${reader.stopped ? 'stopped' : 'running'}`), ['A:stopped', 'B:running']);
});

test("Movers and the change split aren't the server paired before's, nor in the currency shown before", () => {
  const balance = fs.readFileSync(path.join(root, 'balance.js'), 'utf8');
  const fn = name => {
    const start = balance.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `balance.js has ${name}()`);
    let depth = 0, i = balance.indexOf('{', balance.indexOf(')', start));
    for (; i < balance.length; i++) { if (balance[i] === '{') depth++; else if (balance[i] === '}') { depth--; if (!depth) break; } }
    return balance.slice(balance.lastIndexOf('\n', start) + 1, i + 1);
  };
  let pairing = 'A', currency = 'USD';
  const refreshed = [];
  const context = vm.createContext({
    getServerConnection: () => ({ configured: true, id: pairing }), getOutputCurrency: () => currency,
    _refreshAttribution: period => { refreshed.push(period); },
  });
  vm.runInContext(`const _attribution = { '1d': null, '1w': null };
${balance.match(/const _attributionKey = [^\n]+/)[0]}
${fn('_currentAttribution')}`, context);
  vm.runInContext("_attribution['1d'] = { movers: [1], key: _attributionKey() }", context);
  assert.equal(vm.runInContext("JSON.stringify(_currentAttribution('1d').movers)", context), '[1]');
  pairing = 'B';
  assert.equal(vm.runInContext("_currentAttribution('1d')", context), null, "A's movers aren't shown for B");
  assert.deepEqual(refreshed, ['1d'], 'read again');
  vm.runInContext("_attribution['1w'] = { movers: [2], key: _attributionKey() }", context);
  currency = 'GBP';
  assert.equal(vm.runInContext("_currentAttribution('1w')", context), null, 'dollar amounts not written as pounds');
  assert.match(fn('_renderMovers'), /_currentAttribution\(period\)/);
  assert.match(fn('_renderFlow'), /_currentAttribution\(period\)/);
});

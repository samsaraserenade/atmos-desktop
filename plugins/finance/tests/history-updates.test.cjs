'use strict';
// The VPS history reaches views as changes, not whole: remote.js reads only
// the newest samples after the first load (the whole history again only
// when what the portfolio includes changes), history-change.js describes
// and combines changes, and the engine (src/host/mirror.js) reloads for
// scope changes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function synthetic(context, exports) {
  const names = Object.keys(exports);
  const module = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, exports[name]);
  }, { context });
  return module;
}

async function load(file, context, imports = {}) {
  const module = new vm.SourceTextModule(read(file), {
    context, identifier: file,
    importModuleDynamically: async specifier => {
      const target = imports[specifier];
      if (!target) throw new Error(`${file}: unexpected import('${specifier}')`);
      if (target.status === 'unlinked') await target.link(() => {});
      if (target.status === 'linked') await target.evaluate();
      return target;
    },
  });
  await module.link(specifier => {
    const target = imports[specifier];
    if (!target) throw new Error(`${file}: unexpected import '${specifier}'`);
    return target;
  });
  await module.evaluate();
  return module.namespace;
}

async function historyChange() {
  return load('src/history-change.js', vm.createContext({}));
}

const point = (t, value = t) => ({ t, value, spot: null, perp: null, currency: 'USD', errorCount: 0, invested: null, cash: null, investedRatio: null, cashRatio: null });

test('a change is where two histories first differ', async () => {
  const { diffHistoryTail, applyHistoryChange } = await historyChange();
  const before = [point(1), point(2), point(3)];
  assert.equal(diffHistoryTail(before, 2, [point(2), point(3)]), null, 'same samples again: nothing to send');
  const appended = diffHistoryTail(before, 2, [point(2), point(3), point(4)]);
  assert.deepEqual(plain(appended), plain({ from: 4, points: [point(4)] }), 'a new sample: just that');
  const revised = diffHistoryTail(before, 2, [point(2), point(3, 30), point(4)]);
  assert.deepEqual(plain(revised), plain({ from: 3, points: [point(3, 30), point(4)] }));
  const removed = diffHistoryTail(before, 2, [point(2)]);
  assert.deepEqual(plain(removed), plain({ from: 3, points: [] }));
  const late = diffHistoryTail(before, 2, [point(2), point(2.5), point(3)]);
  assert.deepEqual(plain(applyHistoryChange(before, late)), plain([point(1), point(2), point(2.5), point(3)]));
  assert.deepEqual(plain(before), plain([point(1), point(2), point(3)]), 'the original is left alone');
});

test('a view applying the published changes ends up with the engine\'s history', async () => {
  const { diffHistoryTail, applyHistoryChange, composeHistoryChanges } = await historyChange();
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  let engine = Array.from({ length: 50 }, (_, index) => point(index * 10));
  let view = engine.slice();
  for (let round = 0; round < 200; round++) {
    // Several refreshes can land before one publish; their changes combine.
    let unpublished = null;
    for (let refresh = 0, count = 1 + Math.floor(random() * 3); refresh < count; refresh++) {
      const last = engine.at(-1).t;
      const from = last - Math.floor(random() * 40);
      const fresh = engine.filter(p => p.t >= from).map(p => (random() < 0.1 ? point(p.t, p.value + 1) : p)).filter(() => random() > 0.05);
      for (let t = last + 10, n = Math.floor(random() * 3); n > 0; n--, t += 10) fresh.push(point(t));
      const change = diffHistoryTail(engine, from, fresh);
      if (!change) continue;
      engine = applyHistoryChange(engine, change);
      unpublished = unpublished ? composeHistoryChanges(unpublished, change) : change;
    }
    if (unpublished) view = applyHistoryChange(view, structuredClone(unpublished));
    assert.deepEqual(plain(view), plain(engine), `round ${round}`);
  }
});

async function startRemote({ history, portfolio = { sources: [], holdings: [] }, clock = { offset: 0 } }) {
  const requests = [];
  const scope = { holdings: [] };
  class ClockDate extends Date { static now() { return Date.now() + clock.offset; } }
  const context = vm.createContext({ URLSearchParams, Date: ClockDate, console, JSON, setInterval: () => 0, clearInterval: () => {} });
  const remote = await load('src/remote.js', context, {
    './host/frame.js': synthetic(context, {
      atmos: {}, SELF: 'plugin:finance',
      invokeFinance: async (channel, route) => {
        const url = new URL(route, 'http://vps');
        if (url.pathname === '/v1/portfolio') return { ok: true, body: JSON.stringify(portfolio) };
        const request = Object.fromEntries(['from', 'to', 'resolution'].map(key => [key, url.searchParams.get(key)]));
        request.exclude = url.searchParams.getAll('exclude');
        requests.push(request);
        return { ok: true, body: JSON.stringify(history(request)) };
      },
    }),
    './portfolio-scope.js': synthetic(context, {
      excludedHoldingKeys: () => [...scope.holdings],
      excludedSourceIds: () => [],
      excludedGroupKeys: () => [],
      historyScopeKey: () => scope.holdings.map(key => `h:${key}`).sort().join('\n'),
    }),
  });
  const calls = [];
  const vps = await remote.startVpsPortfolio(null, {
    publish() {}, remove() {}, setStatus() {},
    setHistory: points => calls.push({ full: plain(points) }),
    mergeHistory: (from, points) => calls.push({ from, points: plain(points) }),
  });
  return { vps, requests, calls, scope };
}

test('after the first load, a refresh reads only the newest samples', async () => {
  const now = Date.now();
  const samples = [now - 90 * 60_000, now - 30 * 60_000, now - 60_000];
  const { vps, requests, calls } = await startRemote({
    history: ({ from, to }) => ({ points: samples.filter(t => t >= Number(from) && t <= (to === null ? Infinity : Number(to))).map(t => ({ t, v: 1 })) }),
  });
  assert.deepEqual(requests.map(r => r.resolution), ['1d', '1h', '5m', 'raw'], 'the first load is the whole history');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].full.map(p => p.t), samples);

  requests.length = 0;
  samples.push(now);
  await vps.refreshHistory();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].resolution, 'raw');
  assert.equal(Number(requests[0].from), now - 60_000 - 10 * 60_000, 'from ten minutes before the newest point');
  assert.equal(requests[0].to, null, 'to the server\'s newest sample, not this computer\'s clock');
  assert.deepEqual(calls[1], { from: now - 11 * 60_000, points: calls[1].points });
  assert.deepEqual(calls[1].points.map(p => p.t), [now - 60_000, now]);

  requests.length = 0;
  await vps.refreshHistory();
  assert.equal(Number(requests[0].from), now - 10 * 60_000, 'and on from the newest point it has now');
  vps.stop();
});

test('what the portfolio includes changing reloads the whole history for it', async () => {
  const now = Date.now();
  const { vps, requests, calls, scope } = await startRemote({ history: () => ({ points: [{ t: now, v: 1 }] }) });
  requests.length = 0;
  scope.holdings = ['wallet|usdc'];
  await vps.refreshHistory();
  assert.deepEqual(requests.map(r => r.resolution), ['1d', '1h', '5m', 'raw']);
  assert.ok(requests.every(r => r.exclude.includes('wallet|usdc')));
  assert.ok(calls.at(-1).full);
  vps.stop();
});

test('every six hours the whole history is read again', async () => {
  const now = Date.now();
  const clock = { offset: 0 };
  const { vps, requests } = await startRemote({ clock, history: () => ({ points: [{ t: now, v: 1 }] }) });
  requests.length = 0;
  clock.offset = 5 * 60 * 60_000;
  await vps.refreshHistory();
  assert.deepEqual(requests.map(r => r.resolution), ['raw']);
  requests.length = 0;
  clock.offset = 6 * 60 * 60_000 + 1;
  await vps.refreshHistory();
  assert.deepEqual(requests.map(r => r.resolution), ['1d', '1h', '5m', 'raw']);
  vps.stop();
});

test('if the server held samples back, the whole history is reloaded', async () => {
  const now = Date.now();
  let truncate = false;
  const { vps, requests } = await startRemote({
    history: ({ resolution }) => ({ points: [{ t: now, v: 1 }], truncated: truncate && resolution === 'raw' && requests.length === 1 }),
  });
  requests.length = 0;
  truncate = true;
  await vps.refreshHistory();
  assert.deepEqual(requests.map(r => r.resolution), ['raw', '1d', '1h', '5m', 'raw']);
  vps.stop();
});

test('the engine reloads the history for a change of scope, not for any setting', async () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  let scope = '';
  let settingsListener = null;
  const refreshes = [];
  const published = [];
  const emitted = [];
  let revision = 1;
  let engineChanged = null;
  const registry = synthetic(context, {
    initExchanges: async () => {},
    onEngineChange: fn => { engineChanged = fn; return () => {}; },
    exportEngineState: since => ({ historyRevision: revision, since }),
    markHistoryPublished: value => published.push(value),
    refreshRemoteHistory: async () => { refreshes.push(scope); },
    reconnectPortfolio: async () => true,
  });
  const mirror = await load('src/host/mirror.js', context, {
    './frame.js': synthetic(context, { atmos: { events: { emit: async (name, payload) => emitted.push(plain(payload)) } }, SELF: 'plugin:finance' }),
    './persist.js': synthetic(context, { onExternalStateChange: fn => { settingsListener = fn; return () => {}; } }),
    '../portfolio-scope.js': synthetic(context, { historyScopeKey: () => scope }),
    '../registry.js': registry,
    '../totals.js': synthetic(context, { exportRates: () => ({}) }),
    '../../markets/src/watchlist-data.js': synthetic(context, { startPolling() {}, onUpdate: () => () => {}, tickerData: {}, fetchTickers: async () => {} }),
  });
  const cleanups = [];
  await mirror.startEngine({ onCleanup: fn => cleanups.push(fn) });

  settingsListener(); // a font, a colour, a sort order...
  await settle();
  assert.deepEqual(refreshes, []);
  scope = 'h:wallet|usdc'; // a holding hidden
  settingsListener();
  settingsListener();
  await settle();
  assert.deepEqual(refreshes, ['h:wallet|usdc']);

  // Publishing: the first event carries everything; after it, changes since.
  engineChanged();
  await new Promise(resolve => setTimeout(resolve, 300));
  revision = 2;
  engineChanged();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(emitted.map(payload => payload.portfolio.since), [-1, 1]);
  assert.deepEqual(published, [1, 2]);
});

test('views draw new samples by appending them, and reconvert all of it for new rates', () => {
  const chart = read('src/total-chart.js');
  assert.match(chart, /onRemoteTotalHistoryUpdate\(replaceHistoryFromVps\)/);
  assert.match(chart, /onRatesChange\(\(\) => replaceHistoryFromVps\(\)\)/);
  assert.match(chart, /chart\.appendMany\(appended\)/);
  assert.match(chart, /view\.appendMany\(appended\)/);
  const registry = read('src/registry.js');
  assert.match(registry, /mergeHistory: _mergeRemoteTotalHistory/);
  assert.match(registry, /setHistory: points => _mergeRemoteTotalHistory\(-Infinity, points\)/, 'a full reload sends only what differs too');
  assert.match(registry, /historyChange: \{ base: sinceRevision/);
});

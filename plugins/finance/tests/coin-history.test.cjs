'use strict';
// A coin's chart (src/coin-history.js): what your holdings of it have been
// worth, read as the total less the total without them (remote.js
// loadHoldingsValueHistory), in the portfolio's scope, and kept up while a
// chart shows it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
// Samples an hour apart, in the last few hours (the raw tier).
const H = 60 * 60_000;
const NOW = Date.now();
const [T1, T2, T3] = [NOW - 3 * H, NOW - 2 * H, NOW - H];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function synthetic(context, exports) {
  const names = Object.keys(exports);
  return new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, exports[name]);
  }, { context });
}

async function load(file, context, imports = {}) {
  const module = new vm.SourceTextModule(read(file), { context, identifier: file });
  await module.link(specifier => {
    const target = imports[specifier];
    if (!target) throw new Error(`${file}: unexpected import '${specifier}'`);
    return target;
  });
  await module.evaluate();
  return module.namespace;
}

/** remote.js against a stand-in server: SOL on two sources, worth 10, 20, 30 (5, 10, 15 each). */
async function remoteWith({ late = false, truncated = false } = {}) {
  const requests = [];
  const context = vm.createContext({ URLSearchParams, Date, console, JSON, setInterval: () => 0, clearInterval: () => {} });
  const sol = { [T1]: 5, [T2]: 10, [T3]: 15 };
  const remote = await load('src/remote.js', context, {
    './host/frame.js': synthetic(context, {
      atmos: {}, SELF: 'plugin:finance',
      invokeFinance: async (channel, route) => {
        const url = new URL(route, 'http://vps');
        const exclude = url.searchParams.getAll('exclude');
        const request = { resolution: url.searchParams.get('resolution'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), exclude };
        requests.push(request);
        // Every sample in the raw tier, for simplicity; the server leaves
        // out what's excluded, as hiding does.
        const without = exclude.includes('a|sol');
        const times = request.resolution === 'raw' ? Object.keys(sol).map(Number).filter(t => t >= Number(request.from)) : [];
        const points = times
          .filter(t => !(late && without && t === T3)) // a sample that landed between the two reads
          .map(t => ({ t, v: 100 + (t - T1) / H - (exclude.includes('a|sol') ? sol[t] : 0) - (exclude.includes('b|sol') ? sol[t] : 0), currency: 'USD' }));
        return { ok: true, body: JSON.stringify({ points, truncated: truncated && request.resolution === 'raw' && without }) };
      },
    }),
    './portfolio-scope.js': synthetic(context, {
      excludedHoldingKeys: () => ['wallet|usdc'], excludedSourceIds: () => [], excludedGroupKeys: () => [], historyScopeKey: () => 'h:wallet|usdc',
    }),
  });
  return { remote, requests };
}

test('a coin\'s history is the total less the total without its holdings, point for point', async () => {
  const { remote, requests } = await remoteWith();
  const { points, truncated } = await remote.loadHoldingsValueHistory(['a|sol', 'b|sol']);
  assert.deepEqual(plain(points), [
    { t: T1, value: 10, currency: 'USD' }, { t: T2, value: 20, currency: 'USD' }, { t: T3, value: 30, currency: 'USD' },
  ]);
  assert.equal(truncated, false);
  const full = requests.filter(request => !request.exclude.includes('a|sol'));
  const less = requests.filter(request => request.exclude.includes('a|sol'));
  assert.deepEqual(full.map(request => request.resolution), ['1d', '1h', '5m', 'raw'], 'the whole history, in the tiers the total is read in');
  assert.ok(full.every(request => request.exclude.join() === 'wallet|usdc'), 'in the portfolio\'s scope: what\'s hidden stays out');
  assert.ok(less.every(request => request.exclude.join() === 'wallet|usdc,a|sol,b|sol'));
  assert.deepEqual(less.map(request => [request.from, request.to]), full.map(request => [request.from, request.to]), 'both read for the same times');
});

test('only the times both reads have, and only the newest samples when asked', async () => {
  const late = await remoteWith({ late: true });
  assert.deepEqual(plain((await late.remote.loadHoldingsValueHistory(['a|sol', 'b|sol'])).points.map(point => point.t)), [T1, T2], 'a sample one read missed is left out');
  const recent = await remoteWith({ truncated: true });
  const answer = await recent.remote.loadHoldingsValueHistory(['a|sol', 'b|sol'], { from: T2 });
  assert.deepEqual(plain(answer.points.map(point => point.value)), [20, 30]);
  assert.equal(answer.truncated, true, 'the server held some back');
  assert.deepEqual(recent.requests.map(request => [request.resolution, request.from, request.to]), [['raw', String(T2), null], ['raw', String(T2), null]]);
});

/** coin-history.js with stand-ins: what it counts, and what each read returns. */
async function store() {
  const reads = [];
  const answers = [];
  const listeners = [];
  const scope = { key: '' };
  const positions = [
    { symbol: 'SOL', holdings: [
      { connectionId: 'a', holding: { id: 'sol', value: 30, currency: 'USD' }, included: true },
      { connectionId: 'b', holding: { id: 'sol', value: 20, currency: 'USD' }, included: true },
      { connectionId: 'c', holding: { id: 'sol', value: 7, currency: 'USD' }, included: false },
      { connectionId: 'hl', holding: { id: 'sol-earn', value: 9, currency: 'USD', meta: { group: 'earn' } }, included: true },
    ] },
    { symbol: 'HIDDEN', holdings: [{ connectionId: 'a', holding: { id: 'x', value: 5, currency: 'USD' }, included: false }] },
  ];
  const context = vm.createContext({ console, setTimeout: fn => { fn(); return 0; }, clearTimeout() {} });
  const coins = await load('src/coin-history.js', context, {
    './totals.js': synthetic(context, { getSpotScopePositions: () => positions, convertToGbp: value => value, convertFromGbp: value => value * 2 }),
    './portfolio-scope.js': synthetic(context, {
      holdingScopeGroup: (source, holding) => holding?.meta?.group || null,
      holdingScopeKey: (source, holding) => `${source}|${holding.id}`,
      historyScopeKey: () => scope.key,
    }),
    './registry.js': synthetic(context, { isRemotePortfolioMode: () => true, onRemoteTotalHistoryUpdate: fn => { listeners.push(fn); return () => {}; } }),
    './remote.js': synthetic(context, {
      loadHoldingsValueHistory: async (keys, options) => { reads.push({ keys: [...keys], from: options.from }); return (await answers.shift()) || { points: [], truncated: false }; },
    }),
  });
  return { coins, reads, answers, listeners, positions, scope };
}

test('a coin counts its included holdings, not hidden or grouped ones, and is listed by what they\'re worth', async () => {
  const { coins } = await store();
  assert.deepEqual(plain(coins.coinHoldingKeys('SOL')), ['a|sol', 'b|sol']);
  assert.equal(coins.coinValue('SOL'), 100, 'the counted holdings, in the display currency');
  assert.deepEqual(plain(coins.portfolioCoins()), [{ symbol: 'SOL', value: 100 }], 'a coin with nothing counted has no chart');
});

test('shown, a coin is read once in full, then follows the portfolio\'s history with its newest samples', async () => {
  const { coins, reads, answers, listeners, scope } = await store();
  const heard = [];
  answers.push({ points: [{ t: T1, value: 10, currency: 'USD' }, { t: T2, value: 20, currency: 'USD' }], truncated: false });
  const stop = coins.useCoinHistory('SOL', () => heard.push(coins.coinHistory('SOL').status));
  const second = coins.useCoinHistory('SOL', () => {});
  await settle();
  assert.deepEqual(plain(reads), [{ keys: ['a|sol', 'b|sol'], from: null }], 'two charts showing it: one read');
  assert.deepEqual(heard, ['loading', 'ready']);
  assert.deepEqual(plain(coins.coinHistory('SOL').points).map(point => point.t), [T1, T2]);

  answers.push({ points: [{ t: T2, value: 21, currency: 'USD' }, { t: T3, value: 30, currency: 'USD' }], truncated: false });
  listeners[0]({ from: T3, points: [] }); // a new sample
  await settle();
  assert.equal(reads[1].from, T2 - 10 * 60_000, 'the newest samples, from a little before the last one');
  assert.deepEqual(plain(coins.coinHistory('SOL').points).map(point => [point.t, point.value]), [[T1, 10], [T2, 21], [T3, 30]]);

  scope.key = 'h:b|sol'; // what the portfolio includes changed
  answers.push({ points: [{ t: T3, value: 15, currency: 'USD' }], truncated: false });
  listeners[0]({ from: T3, points: [] });
  await settle();
  assert.equal(reads[2].from, null, 'read again in full');
  assert.deepEqual(plain(coins.coinHistory('SOL').points), [{ t: T3, value: 15, currency: 'USD' }]);
  assert.deepEqual(heard, ['loading', 'ready', 'ready', 'ready'], 'what was drawn stayed until the new history came');

  // The portfolio's history replaced whole (another server paired): this one too.
  answers.push({ points: [{ t: T3, value: 99, currency: 'USD' }], truncated: false });
  listeners[0](undefined);
  await settle();
  assert.equal(reads[3].from, null);
  assert.deepEqual(plain(coins.coinHistory('SOL').points), [{ t: T3, value: 99, currency: 'USD' }], 'nothing of the old server\'s kept');

  stop(); second();
  listeners[0]({ from: T3, points: [] });
  await settle();
  assert.equal(reads.length, 4, 'shown nowhere: not kept up');
  assert.equal(coins.coinHistory('HIDDEN').status, 'idle');
  coins.useCoinHistory('HIDDEN', () => {});
  assert.equal(coins.coinHistory('HIDDEN').status, 'none', 'nothing counted: nothing read');
  assert.equal(reads.length, 4);
});

test('a failed read keeps what was drawn; one cut short is read whole next', async () => {
  const { coins, reads, answers, listeners } = await store();
  answers.push({ points: [{ t: T1, value: 10, currency: 'USD' }], truncated: false });
  coins.useCoinHistory('SOL', () => {});
  await settle();
  answers.push({ points: [{ t: T2, value: 20, currency: 'USD' }], truncated: true });
  answers.push({ points: [{ t: T1, value: 11, currency: 'USD' }, { t: T2, value: 21, currency: 'USD' }], truncated: false });
  listeners[0]({ from: T2, points: [] });
  await settle();
  assert.deepEqual(plain(reads.map(read => read.from === null)), [true, false, true], 'the server held some back: then all of it');
  assert.deepEqual(plain(coins.coinHistory('SOL').points.map(point => point.value)), [11, 21]);
  answers.push({ then: (resolve, reject) => reject(new Error('down')) }); // the server didn't answer
  listeners[0]({ from: T2, points: [] });
  await settle();
  assert.equal(coins.coinHistory('SOL').status, 'ready', 'still drawn');
  assert.deepEqual(plain(coins.coinHistory('SOL').points.map(point => point.value)), [11, 21]);
});

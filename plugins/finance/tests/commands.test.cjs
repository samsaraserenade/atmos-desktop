'use strict';

// Finance's rev/ commands (src/commands.js) as Atmos's bar uses them,
// against the SDK's fake Atmos and stand-ins for the engine's state and the
// panel request; and the panel's side (frame-panel.js, markets/panel.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '..', '..', '..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const fakeSdk = pathToFileURL(path.join(repo, 'core/js/sdk/testing/sdk.mjs')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeSdk, shortCircuit: true };
  return nextResolve(specifier, context);
} });

const manifest = JSON.parse(read('plugins/finance/extension.json'));

async function start({ marketData = true, charts = 1, mode = 'markets', interval = '5m', hidden = false } = {}) {
  const { installFakeAtmos } = await import(pathToFileURL(path.join(repo, 'core/js/sdk/testing/fake-atmos.mjs')).href);
  const atmos = installFakeAtmos({ extension: { id: 'finance', tier: 'first-party' }, commands: manifest.contributes.commands });
  const commands = await import(pathToFileURL(path.join(repo, 'plugins/finance/src/commands.js')).href);
  const asked = [];
  const shows = [];
  commands.handleCommands({
    requestPanelAction: async (action, options) => { asked.push(action); shows.push(options?.show); },
    watchlist: () => ['BTC', 'ETH', 'SOL', '1INCH', 'FARTCOIN'],
    // As frame-engine.js gives them: nothing you hold while balances are hidden.
    held: async () => (hidden ? [] : ['ETH', 'BNB', 'USDT', 'USDC']),
    coins: async () => (hidden ? [] : ['ETH', 'BNB', 'USDT', 'SPX']),
    privateMode: async () => hidden,
    recent: () => ['DOGEUSDT coinbase 1m candles', 'BTCUSDT 5m candles', '1000PEPEUSDT 1h candles'],
    chartCount: () => charts,
    currentTimeframe: () => (mode === 'markets' ? interval : null),
    hasMarketData: async () => marketData,
  });
  return {
    commands, asked, shows, atmos,
    run: (name, input = {}) => atmos.fake.runCommand(name, input),
    suggest: (name, input = {}) => atmos.fake.suggestCommand(name, input),
  };
}

test('the commands are declared for Atmos\'s bar, with the Atmos that has it, and both handled', async () => {
  assert.equal(manifest.apiVersion, 4);
  assert.equal(manifest.engines.atmos, '>=0.20.0', 'atmos.commands is SDK 1.3 (Atmos 0.20.0)');
  assert.deepEqual(manifest.contributes.commands.map(command => command.name), ['chart', 'timeframe', 'portfolio']);
  for (const command of manifest.contributes.commands) {
    assert.match(command.name, /^[a-z][a-z0-9-]{0,29}$/);
    assert.ok(command.about.length <= 120);
    assert.equal(command.suggests, true);
  }
  const { atmos } = await start();
  assert.deepEqual(atmos.fake.commandsHandled.sort(), ['chart', 'portfolio', 'timeframe']);
  assert.match(read('plugins/finance/frame-engine.js'), /import\('\.\/src\/commands\.js'\)/, 'answered in the engine frame, from any panel');
});

test('the timeframes are Charting\'s, typed as its toolbar shows them or spelled out', async () => {
  const { commands } = await start();
  const toolbar = read('services/charting/toolbar.js');
  const { CHART_INTERVALS } = await import('data:text/javascript;base64,' + Buffer.from(toolbar).toString('base64'));
  assert.deepEqual(commands.TIMEFRAMES.map(item => [item.value, item.label]), CHART_INTERVALS.map(item => [item.value, item.label]));
  const parse = commands.parseTimeframe;
  assert.equal(parse('4H'), '4h');
  assert.equal(parse('4h'), '4h');
  assert.equal(parse('1m'), '1m', 'm is minutes');
  assert.equal(parse('1M'), '1mo', 'M is a month, as the toolbar shows it');
  assert.equal(parse('3M'), '3mo');
  assert.equal(parse('30M'), '30m', 'a capital M that is no month: minutes');
  assert.equal(parse('1mo'), '1mo');
  assert.equal(parse('1W'), '1w');
  assert.equal(parse('2weeks'), '2w');
  assert.equal(parse('1Y'), '1y');
  assert.equal(parse('auto'), 'auto');
  assert.equal(parse('7m'), null, 'not one the charts have');
  assert.equal(parse('4x'), null);
  assert.deepEqual(commands.matchTimeframes('1').map(item => item.label), ['1m', '10m', '15m', '1H', '12H', '1D', '1W', '1M', '1Y']);
  assert.deepEqual(commands.matchTimeframes('4h').map(item => item.label), ['4H']);
});

test('rev/chart: a symbol, exchanges and a timeframe in any order, asked of the panel', async () => {
  const { commands, asked, run } = await start();
  assert.deepEqual(commands.parseChartArgs('btc 4h'), { symbol: 'BTCUSDT', base: 'BTC', typed: 'btc', exchanges: [], interval: '4h', unknown: [] });
  assert.deepEqual(commands.parseChartArgs('1D Coinbase eth/usdt'), { symbol: 'ETHUSDT', base: 'ETH', typed: 'eth/usdt', exchanges: ['coinbase'], interval: '1d', unknown: [] });
  assert.deepEqual(await run('chart', { args: 'BTC 4h' }), { done: 'Showing BTC on 4H.' });
  assert.deepEqual(await run('chart', { args: 'eth coinbase' }), { done: 'Showing ETH · Coinbase.' });
  assert.deepEqual(await run('chart', { args: 'b 1W', value: 'BNBUSDT' }), { done: 'Showing BNB on 1W.' }, 'a row\'s pair, with the timeframe typed');
  assert.deepEqual(asked, [
    { type: 'open-market', query: 'BTCUSDT', interval: '4h' },
    { type: 'open-market', query: 'ETHUSDT coinbase', interval: null },
    { type: 'open-market', query: 'BNBUSDT', interval: '1w' },
  ]);
  await assert.rejects(run('chart', { args: '4h' }), /Type a symbol: rev\/chart BTC 4h/);
  await assert.rejects(run('chart', { args: 'w' }), /Type a symbol/, 'one letter is no symbol');
  await assert.rejects(run('chart', { args: 'abcdefghijklmnop' }), /Type a symbol/, 'longer than the charts read');
  assert.deepEqual(await run('chart', { args: 'fartcoin' }), { done: 'Showing FARTCOIN.' });
  assert.equal(asked.at(-1).query, 'FARTCOINUSDT', 'typed in full: the pair you have, as the watchlist opens it');
  await run('chart', { args: '1000pepeusdt' });
  assert.equal(asked.at(-1).query, '1000PEPEUSDT');
  await assert.rejects(run('chart', { args: 'btc eth' }), /“eth” isn’t one/);
  await run('chart', { args: 'btc', value: '<b>x</b>' });
  assert.equal(asked.at(-1).query, 'BTCUSDT', 'a value that isn\'t a plain symbol is ignored: what\'s typed decides');
  // Alt+Enter in the bar: done in Finance without opening it.
  const here = await start();
  assert.deepEqual(await here.run('chart', { args: 'eth 1d', go: false }), { done: 'ETH on 1D in Finance.' });
  assert.deepEqual(await here.run('timeframe', { args: '4h', go: false }), { done: 'Finance’s chart on 4H.' });
  await here.run('chart', { args: 'btc', go: true });
  assert.deepEqual(here.shows, [false, false, true], 'the panel opens unless asked to stay');
  const without = await start({ marketData: false });
  await assert.rejects(without.run('chart', { args: 'BTC' }), /Market charts need Market Data/);
  assert.deepEqual(without.asked, []);
});

test('rev/chart lists the watchlist, your holdings and recent charts, once each, and any symbol typed in full', async () => {
  const { suggest } = await start();
  assert.deepEqual((await suggest('chart')).map(row => [row.title, row.sub, row.value]), [
    ['BTC', 'Watchlist', 'BTCUSDT'], ['ETH', 'Watchlist', 'ETHUSDT'], ['SOL', 'Watchlist', 'SOLUSDT'],
    ['1INCH', 'Watchlist', '1INCHUSDT'], ['FARTCOIN', 'Watchlist', 'FARTCOINUSDT'], ['BNB', 'In your portfolio', 'BNBUSDT'],
    ['DOGE', 'Recent', 'DOGEUSDT'], ['1000PEPE', 'Recent', '1000PEPEUSDT'],
  ], 'each the pair it opens (as the watchlist widget opens it, or as charted); no stablecoins');
  assert.deepEqual(await suggest('chart', { args: 'e 4h' }), [{ title: 'ETH on 4H', sub: 'Watchlist', action: 'Show', value: 'ETHUSDT', complete: 'ETH 4H' }], 'one letter is no symbol of its own');
  assert.deepEqual((await suggest('chart', { args: 'bt' })).map(row => [row.title, row.sub]), [['BTC', 'Watchlist'], ['BT', 'Any symbol the exchanges trade']], 'what you have first');
  assert.deepEqual((await suggest('chart', { args: 'eth' }))[0].title, 'ETH', 'the one typed in full first');
  assert.deepEqual((await suggest('chart', { args: 'avax coinbase' }))[0], {
    title: 'AVAX · Coinbase', sub: 'Any symbol the exchanges trade', action: 'Show', value: 'AVAXUSDT', complete: 'AVAX coinbase',
  });
  assert.deepEqual(await suggest('chart', { args: 'btc eth' }), [{ note: 'rev/chart takes a symbol, an exchange and a timeframe; “eth” isn’t one.' }]);
  const without = await start({ marketData: false });
  assert.deepEqual(await without.suggest('chart', { args: 'b' }), [{ note: 'Market charts need Market Data. Install it in Settings → Extensions.' }]);
});

test('rev/timeframe: the main chart, or every chart with its option when there are several', async () => {
  const one = await start({ interval: '4h' });
  const listed = await one.suggest('timeframe', { args: '4' });
  assert.deepEqual(listed.rows[0], { title: '4H', sub: '4 hours · now', action: 'Set', value: '4h', complete: '4H' });
  assert.equal(listed.options, undefined, 'one chart: no "every chart"');
  assert.deepEqual(await one.run('timeframe', { args: '1D' }), { done: 'Finance’s chart on 1D.' });
  assert.deepEqual(await one.run('timeframe', { args: '1', value: '1w' }), { done: 'Finance’s chart on 1W.' });
  assert.deepEqual(await one.run('timeframe', { args: '1d', options: { every: true } }), { done: 'Finance’s chart on 1D.' }, 'one chart: "every" means it');
  await assert.rejects(one.run('timeframe', { args: '7x' }), /There’s no “7x” timeframe/);
  await assert.rejects(one.run('timeframe'), /Type a timeframe/);
  assert.deepEqual(one.asked, [
    { type: 'chart-timeframe', interval: '1d', every: false },
    { type: 'chart-timeframe', interval: '1w', every: false },
    { type: 'chart-timeframe', interval: '1d', every: false },
  ]);
  const four = await start({ charts: 4, mode: 'portfolio' });
  const options = await four.suggest('timeframe', { args: '1h', options: { every: true } });
  assert.deepEqual(options.options, [{ id: 'every', type: 'toggle', label: 'every chart', value: true }]);
  assert.equal(options.rows[0].sub, '1 hour', 'the portfolio chart\'s timeframe isn\'t known here: none marked');
  assert.deepEqual(await four.run('timeframe', { args: '1h', options: { every: true } }), { done: 'Every Finance chart on 1H.' });
  assert.deepEqual(four.asked.at(-1), { type: 'chart-timeframe', interval: '1h', every: true });
});

test('rev/portfolio: the total, Spot, Perp or a coin you hold, asked of the panel', async () => {
  const { asked, shows, run, suggest } = await start();
  assert.deepEqual((await suggest('portfolio')).map(row => [row.title, row.value]), [
    ['Total', 'total'], ['Spot', 'spot'], ['Perp', 'perp'],
    ['ETH', 'coin:ETH'], ['BNB', 'coin:BNB'], ['USDT', 'coin:USDT'], ['SPX', 'coin:SPX'],
  ]);
  assert.deepEqual((await suggest('portfolio', { args: 'sp' })).map(row => row.value), ['spot', 'coin:SPX'], 'by name, Total, Spot and Perp before coins');
  assert.deepEqual((await suggest('portfolio', { args: 'spx' })).map(row => row.value), ['coin:SPX']);
  assert.deepEqual((await suggest('portfolio', { args: 'futures' }))[0], { title: 'Perp', sub: 'Your perp accounts', action: 'Show', value: 'perp', complete: 'Perp' });
  assert.deepEqual(await suggest('portfolio', { args: 'doge' }), [{ note: 'You don’t hold “doge”. Try total, spot, perp or a coin you hold.' }]);

  assert.deepEqual(await run('portfolio'), { done: 'Showing your portfolio.' });
  assert.deepEqual(await run('portfolio', { args: 'spot' }), { done: 'Showing your Spot balance.' });
  assert.deepEqual(await run('portfolio', { args: 'e', value: 'coin:ETH' }), { done: 'Showing your ETH holdings.' }, 'a row\'s chart');
  assert.deepEqual(await run('portfolio', { args: 'bnb' }), { done: 'Showing your BNB holdings.' }, 'Enter before the list caught up: what\'s typed');
  assert.deepEqual(await run('portfolio', { args: 'perps', go: false }), { done: 'Your Perp balance in Finance.' }, 'Alt+Enter: done without opening Finance');
  await assert.rejects(run('portfolio', { args: 'doge' }), /You don’t hold “doge”/);
  await run('portfolio', { args: 'spot', value: 'coin:\nX' });
  assert.deepEqual(asked.map(action => action.section), ['total', 'spot', 'coin:ETH', 'coin:BNB', 'perp', 'spot'], 'a value that is no chart is ignored: what\'s typed decides');
  assert.ok(asked.every(action => action.type === 'portfolio-section'));
  assert.deepEqual(shows, [true, true, true, true, false, true]);
  const panel = read('plugins/finance/frame-panel.js');
  assert.match(panel, /action\.type === 'portfolio-section' && isPortfolioSection\(action\.section\)/, 'the panel checks what it is asked to show');
});

test('private mode: what you hold isn\'t listed in the bar, and not said either way', async () => {
  const { suggest, run } = await start({ hidden: true });
  assert.deepEqual((await suggest('portfolio')).map(row => row.value), ['total', 'spot', 'perp']);
  assert.deepEqual(await suggest('portfolio', { args: 'eth' }), [{ note: 'Coins aren’t listed while balances are hidden. Try total, spot or perp.' }]);
  await assert.rejects(run('portfolio', { args: 'eth' }), /Coins aren’t listed while balances are hidden/);
  await assert.rejects(run('portfolio', { args: 'e', value: 'coin:ETH' }), /Coins aren’t listed/, 'a row listed before balances were hidden');
  assert.deepEqual(await run('portfolio', { value: 'spot' }), { done: 'Showing your Spot balance.' });
  assert.ok(!(await suggest('chart')).some(row => row.sub === 'In your portfolio'), 'rev/chart lists the watchlist and recent charts only');
  const engine = read('plugins/finance/frame-engine.js');
  assert.match(engine, /held: async \(\) => \(\(await import\('\.\/src\/privacy\.js'\)\)\.isPrivate\(\) \? \[\]/);
  assert.match(engine, /coins: async \(\) => \(\(await import\('\.\/src\/privacy\.js'\)\)\.isPrivate\(\) \? \[\]/);
});

test('a timeframe queued with a query reaches the chart that opens, once', async () => {
  const session = await import(pathToFileURL(path.join(repo, 'plugins/finance/markets/src/session.js')).href);
  const heard = [];
  const stop = session.onMarketQuery((query, interval) => heard.push([query, interval]));
  const second = [];
  const stopSecond = session.onMarketQuery((query, interval) => second.push([query, interval]));
  session.queueMarketQuery('BTCUSDT', { interval: '4h' });
  assert.deepEqual(heard, [['BTCUSDT', '4h']], 'a chart showing hears both');
  assert.deepEqual(second, [['BTCUSDT', '4h']], 'every listener hears the same');
  assert.equal(session.consumePendingQuery('fallback'), 'fallback', 'taken by the chart showing: not run again when one next mounts');
  assert.equal(session.consumePendingInterval(), null);
  stop();
  stopSecond();
  session.queueMarketQuery('ETHUSDT', { interval: '1d' });
  assert.equal(session.consumePendingInterval(), '1d', 'no chart showing: kept for the one that mounts');
  assert.equal(session.consumePendingInterval(), null, 'once');
  assert.equal(session.consumePendingQuery('fallback'), 'ETHUSDT');
  session.queueMarketQuery('SOLUSDT');
  assert.equal(session.consumePendingInterval(), null, 'a query without one (the watchlist widget) clears it');
  const markets = read('plugins/finance/markets/panel.js');
  assert.match(markets, /const queuedInterval = isolated \? null : consumePendingInterval\(\);/, 'the main chart, mounting, takes it');
  assert.match(markets, /if \(requestedInterval && requestedInterval === activeInterval\) \{\r?\n\s+chart\.setOptions\(\{ bucketMs:/, 'and keeps it over the one Charting restores');
  const panel = read('plugins/finance/panel.js');
  assert.match(panel, /nextMode === activeMode \|\| context\.signal\?\.aborted/, 'a second switch to the mode already shown mounts nothing');
  assert.doesNotMatch(panel, /previousDispose/, 'the chart showing at the swap is the one disposed');
});

test('panel requests are a queue: each done once, in order, one after another', async () => {
  const { installFakeAtmos } = await import(pathToFileURL(path.join(repo, 'core/js/sdk/testing/fake-atmos.mjs')).href);
  const atmos = installFakeAtmos({ extension: { id: 'finance', tier: 'first-party' } });
  const frame = await import(pathToFileURL(path.join(repo, 'plugins/finance/src/host/frame.js')).href);
  await frame.requestPanelAction({ type: 'open-market', query: 'BTCUSDT', interval: '4h' });
  await frame.requestPanelAction({ type: 'chart-timeframe', interval: '1d', every: false });
  const done = [];
  let running = 0;
  const stop = frame.handlePanelActions(async action => {
    running += 1;
    assert.equal(running, 1, 'one at a time');
    await new Promise(resolve => setTimeout(resolve, 20));
    done.push(action.type);
    running -= 1;
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(done, ['open-market', 'chart-timeframe'], 'both, in the order asked (the second didn\'t replace the first)');
  // Asked from the engine frame, heard here as another frame's change.
  await frame.requestPanelAction({ type: 'chart-timeframe', interval: '1w', every: false });
  atmos.fake.setState(await atmos.state.get());
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(done, ['open-market', 'chart-timeframe', 'chart-timeframe']);
  // One stamped earlier in another frame, arriving after those: still run.
  atmos.fake.setState({ pendingActions: [{ type: 'late', at: Date.now() - 5_000 }] });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(done.at(-1), 'late');
  stop?.();
  // For when the panel next shows (Alt+Enter): it isn't opened; they're
  // kept in order, for a day (not a minute).
  const shownBefore = atmos.fake.panelShown;
  await frame.requestPanelAction({ type: 'open-market', query: 'BTCUSDT', interval: null }, { show: false });
  await frame.requestPanelAction({ type: 'chart-timeframe', interval: '4h', every: false }, { show: false });
  await frame.requestPanelAction({ type: 'open-market', query: 'ETHUSDT', interval: null }, { show: false });
  assert.equal(atmos.fake.panelShown, shownBefore, 'not opened');
  const later = (await atmos.state.get()).pendingActions.filter(item => item.later);
  assert.deepEqual(later.map(item => item.query || item.interval), ['BTCUSDT', '4h', 'ETHUSDT'], 'in the order asked: ETH ends on 4H, as run at once');
  const tenMinutesAgo = Date.now() - 10 * 60_000;
  atmos.fake.setState({ pendingActions: [
    ...later.map((item, index) => ({ ...item, at: tenMinutesAgo + index })),
    { type: 'open-market', query: 'OLDUSDT', later: true, at: Date.now() - 25 * 60 * 60_000 },
  ] });
  const whenShown = [];
  const stopLater = frame.handlePanelActions(action => { whenShown.push(action.query || action.interval); });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(whenShown, ['BTCUSDT', '4h', 'ETHUSDT'], 'done when the panel next shows, ten minutes on; not one from yesterday');
  stopLater?.();
  // A panel that starts again doesn't do them again: they were taken off.
  const again = [];
  const stopAgain = frame.handlePanelActions(action => { again.push(action.type); });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(again, []);
  stopAgain?.();
});

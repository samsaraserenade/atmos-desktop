// Atmos Browser's rev/ commands (src/commands.js) as Atmos's bar uses them,
// against the SDK's fake Atmos and the real engine (src/engine.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const fakeSdk = new URL('../../../core/js/sdk/testing/sdk.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeSdk, shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { installFakeAtmos } = await import('../../../core/js/sdk/testing/fake-atmos.mjs');
const { createEngine } = await import('../src/engine.js');
const { memoryStore } = await import('../src/store.js');
const { handleCommands, findTabs, tabName } = await import('../src/commands.js');

const manifest = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8'));
const engines = JSON.parse(readFileSync(new URL('../src/search-engines.json', import.meta.url), 'utf8'));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0 };

async function start(state = {}) {
  const atmos = installFakeAtmos({
    extension: { id: 'browser', tier: 'first-party' }, permissions: { web: true },
    commands: manifest.contributes.commands, state,
  });
  const engine = createEngine({ atmos, store: memoryStore(), engines, now: () => 1_000_000, timers });
  await engine.ready;
  handleCommands(engine);
  return {
    atmos, engine,
    run: (name, input = {}) => atmos.fake.runCommand(name, input),
    suggest: (name, input = {}) => atmos.fake.suggestCommand(name, input),
  };
}

const TABS = { session: { tabs: [
  { id: 'a1', url: 'https://www.tradingview.com/chart/', title: 'TradingView' },
  { id: 'b1', url: 'https://news.example/today', title: 'Morning news' },
  { id: 'c1', url: 'https://docs.example/trading', title: 'Docs' },
], selected: 'b1' } };

test('the commands are declared for Atmos\'s bar, with the Atmos that has it, and all handled', async () => {
  assert.equal(manifest.engines.atmos, '>=0.21.0', 'atmos.commands is SDK 1.3 (Atmos 0.20.0); atmos.nowPlaying and web.media 1.4 (0.21.0)');
  assert.deepEqual(manifest.contributes.commands.map(command => command.name), ['new-tab', 'tab', 'close-tab']);
  for (const command of manifest.contributes.commands) {
    assert.match(command.name, /^[a-z][a-z0-9-]{0,29}$/);
    assert.ok(command.about.length <= 120);
    assert.equal(command.suggests, true, `rev/${command.name} lists what it would do`);
  }
  const { atmos } = await start();
  assert.deepEqual(atmos.fake.commandsHandled.sort(), ['close-tab', 'new-tab', 'tab']);
});

test('rev/new-tab: an empty tab, an address, a search, or a row\'s address; private with its option; the panel shows', async () => {
  const { engine, atmos, run, suggest } = await start();
  const before = engine.tabs().length;
  assert.deepEqual(await run('new-tab'), { done: 'Opened a new tab.' });
  assert.equal(engine.tabs().length, before + 1);
  assert.equal(engine.selected().kind, 'new');

  // The address typed is the first row, and goes as the address bar sends it.
  const typedRows = await suggest('new-tab', { args: 'tradingview.com' });
  assert.equal(typedRows.rows[0].value, 'typed');
  assert.deepEqual(await run('new-tab', { args: 'tradingview.com', value: typedRows.rows[0].value }), { done: 'Opened tradingview.com.' });
  assert.equal(engine.selected().url, 'http://tradingview.com/', 'as the address bar reads it (https is tried first by Atmos)');
  assert.deepEqual(engine.selected().typed, { text: 'tradingview.com', query: 'tradingview.com' }, 'remembered as typed: its error page can offer a search');

  const searchRow = (await suggest('new-tab', { args: 'btc price' })).rows.find(row => row.sub === 'Search DuckDuckGo');
  await run('new-tab', { args: 'btc price', value: searchRow.value });
  assert.match(engine.selected().url, /^https:\/\/duckduckgo\.com\/\?q=btc(\+|%20)price/);
  await run('new-tab', { args: 'eth price' });
  assert.match(engine.selected().url, /q=eth(\+|%20)price/, 'Enter before the list caught up: what\'s typed');

  // A bookmark or a page from history by key, however long its address
  // (Atmos hands a row's value back cut to 500 characters).
  const long = `https://www.tradingview.com/chart/?symbol=${'X'.repeat(700)}`;
  await engine.bookmarks.add({ url: long, title: 'Long chart' });
  const markRow = (await suggest('new-tab', { args: 'long chart' })).rows.find(row => row.title === 'Long chart');
  assert.ok(markRow.value.length < 20, 'a key, not the address');
  assert.deepEqual(await run('new-tab', { args: 'long chart', value: markRow.value }), { done: 'Opened tradingview.com.' });
  assert.equal(engine.selected().url, long);

  assert.deepEqual(await run('new-tab', { args: 'example.org', options: { private: true } }), { done: 'Opened example.org in a private tab.' });
  assert.equal(engine.selected().private, true);
  assert.ok(atmos.fake.panelShown >= 5, 'each one shows the browser');

  // What the address bar refuses opens nothing, and the current tab stays.
  const count = engine.tabs().length;
  const current = engine.selectedId();
  await assert.rejects(run('new-tab', { args: 'javascript:alert(1)' }), error => !/Opened/.test(error.message));
  await assert.rejects(run('new-tab', { args: 'file:///C:/secret.txt' }));
  assert.equal(engine.tabs().length, count, 'no tab opened');
  assert.equal(engine.selectedId(), current, 'the current tab is still current');
  // A value that isn't a key it gave (an address, a stale key) is ignored: what's typed decides.
  await run('new-tab', { args: 'example.net', value: 'javascript:alert(1)' });
  assert.equal(engine.selected().url, 'http://example.net/');
  await run('new-tab', { args: 'example.org', value: 'u999999' });
  assert.equal(engine.selected().url, 'http://example.org/');

  const empty = await suggest('new-tab');
  assert.deepEqual(empty.rows, [{ title: 'New tab', sub: 'An empty tab', action: 'Open' }]);
  assert.deepEqual(empty.options, [{ id: 'private', type: 'toggle', label: 'private', value: false }]);
  const typed = await suggest('new-tab', { args: 'example.com', options: { private: true } });
  assert.deepEqual(typed.rows[0], { title: 'http://example.com/', sub: 'Go to this address', action: 'Open', value: 'typed' });
  assert.equal(typed.rows[1].sub, 'Search DuckDuckGo');
  assert.equal(typed.options[0].value, true);
});

test('rev/tab goes to a tab by name, titles that start so first; rev/close-tab closes the one showing or one by name', async () => {
  const { engine, run, suggest } = await start(TABS);
  assert.deepEqual(findTabs(engine.tabs(), 'trad').map(tabName), ['TradingView', 'Docs'], 'Docs by its address');
  assert.deepEqual(findTabs(engine.tabs(), '').map(tabName), ['Morning news', 'TradingView', 'Docs'], 'nothing typed: the one showing first');

  assert.deepEqual(await suggest('tab', { args: 'trad' }), [
    { title: 'TradingView', sub: 'tradingview.com', action: 'Go', value: 'a1', complete: 'TradingView' },
    { title: 'Docs', sub: 'docs.example', action: 'Go', value: 'c1', complete: 'Docs' },
  ]);
  assert.deepEqual(await run('tab', { args: 'trad', value: 'c1' }), { done: 'Showing Docs.' });
  assert.equal(engine.selectedId(), 'c1');
  assert.deepEqual(await run('tab', { args: 'trading' }), { done: 'Showing TradingView.' }, 'Enter before the list caught up: the first match');
  await assert.rejects(run('tab', { args: 'nope' }), /No tab matches “nope”/);
  await assert.rejects(run('tab'), /Type part of a tab’s name/);
  assert.deepEqual(await suggest('tab', { args: 'nope' }), [{ note: 'No tab matches “nope”.' }]);

  const closing = await suggest('close-tab');
  assert.deepEqual(closing[0], { title: 'TradingView', sub: 'tradingview.com · Current tab', action: 'Close', value: 'a1', complete: 'TradingView' });
  assert.deepEqual(await run('close-tab'), { done: 'Closed TradingView. Ctrl+Shift+T in the browser brings it back.' });
  assert.equal(engine.tabs().some(tab => tab.id === 'a1'), false);
  await run('close-tab', { value: 'c1' });
  assert.deepEqual(engine.tabs().map(tab => tab.id), ['b1']);
  await assert.rejects(run('close-tab', { value: 'c1' }), /That tab is closed now/);
  assert.ok(engine.reopenClosed(), 'closed tabs can come back');
  await settle();
});

test('a private tab\'s row is marked; closing the last one promises nothing back, an empty tab neither', async () => {
  const { engine, run, suggest } = await start(TABS);
  const secret = engine.newTab({ url: 'https://private.example/', private: true });
  const row = (await suggest('close-tab', { args: 'private' }))[0];
  assert.equal(row.value, String(secret.id));
  assert.equal(row.danger, true);
  assert.equal(row.sub, 'Private · private.example · Current tab');
  assert.deepEqual(await run('close-tab', { value: String(secret.id) }), { done: `Closed ${row.title}.` }, 'the last private tab');
  assert.equal((await suggest('close-tab', { args: 'docs' }))[0].danger, undefined, 'an ordinary tab\'s isn\'t');
  const one = engine.newTab({ url: 'https://one.example/', private: true });
  engine.newTab({ url: 'https://two.example/', private: true });
  assert.match((await run('close-tab', { value: String(one.id) })).done, /Ctrl\+Shift\+T in the browser brings it back/, 'another private tab is open: it can come back');
  const empty = engine.newTab({});
  assert.deepEqual(await run('close-tab', { value: String(empty.id) }), { done: 'Closed New tab.' }, 'an empty tab isn\'t kept');
});

// The browser's engine against a fake Atmos (src/engine.js): tabs restored
// and loaded lazily, pages put away, private tabs, what pages ask, links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeAtmos } from '../../../core/js/sdk/testing/fake-atmos.mjs';
import { createEngine, cleanSettings, isAddress } from '../src/engine.js';
import { memoryStore } from '../src/store.js';

const engines = JSON.parse(readFileSync(new URL('../src/search-engines.json', import.meta.url), 'utf8'));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: id => pending.delete(id),
    setInterval: () => next++,
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
  };
}

async function start({ state = {}, now = () => 1_000_000 } = {}) {
  const atmos = createFakeAtmos({ extension: { id: 'browser', tier: 'first-party' }, permissions: { web: true }, state });
  const timers = fakeTimers();
  const store = memoryStore();
  const engine = createEngine({ atmos, store, engines, now, timers });
  await engine.ready;
  return { atmos, engine, timers, store, calls: name => atmos.fake.web.calls.filter(call => call.name === name) };
}

test('saved tabs come back without loading; the selected one loads when the panel is there', async () => {
  const { engine, atmos, calls } = await start({
    state: { session: { tabs: [{ id: 'a1', url: 'https://a.example/', title: 'A' }, { id: 'b1', url: 'https://b.example/', title: 'B' }], selected: 'b1' } },
  });
  assert.deepEqual(engine.tabs().map(tab => [tab.id, tab.title, tab.live]), [['a1', 'A', false], ['b1', 'B', false]]);
  assert.equal(calls('open').length, 0, 'nothing loads at start');
  const detach = engine.attachPanel();
  await settle();
  assert.deepEqual(calls('open').map(call => call.args), [['b1', { url: 'https://b.example/', private: false }]]);
  assert.equal(atmos.fake.web.shown, 'b1');
  assert.equal(engine.tab('b1').live, true);
  assert.equal(engine.tab('a1').live, false, 'the other tab waits until you go to it');
  engine.selectTab('a1');
  await settle();
  assert.equal(atmos.fake.web.shown, 'a1');
  detach();
});

test('the address bar navigates or searches; a new tab page shows nothing of Core’s', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const [first] = engine.tabs();
  assert.equal(first.kind, 'new');
  await settle();
  assert.equal(calls('open').length, 0, 'a new-tab page has no page');
  assert.equal(atmos.fake.web.shown, null);
  assert.deepEqual(await engine.navigate(first.id, 'example.com'), { ok: true });
  await settle();
  assert.equal(engine.tab(first.id).url, 'https://example.com/');
  assert.equal(engine.tab(first.id).kind, 'page');
  assert.equal(atmos.fake.web.shown, first.id);
  await engine.navigate(first.id, 'atmos browser');
  await settle();
  assert.equal(engine.tab(first.id).url, 'https://duckduckgo.com/?q=atmos%20browser');
  await engine.setSettings({ searchEngine: 'google' });
  await engine.navigate(first.id, 'more words');
  await settle();
  assert.equal(engine.tab(first.id).url, 'https://www.google.com/search?q=more%20words');
  const visited = await engine.history.search('');
  assert.deepEqual(visited.map(entry => entry.url).sort(), ['https://duckduckgo.com/?q=atmos%20browser', 'https://example.com/', 'https://www.google.com/search?q=more%20words']);
});

test('script and files typed into the address bar never reach Core', async () => {
  const { engine, calls } = await start();
  engine.attachPanel();
  const id = engine.selectedId();
  for (const text of ['javascript:alert(document.cookie)', 'file:///C:/Windows/win.ini', 'C:\\Windows']) {
    const result = await engine.navigate(id, text);
    assert.equal(result.ok, false, text);
    assert.ok(engine.tab(id).notice?.text, text);
  }
  assert.equal(calls('open').length + calls('navigate').length, 0);
});

test('private tabs: their own session, no history, not kept, links from them stay private', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const tab = engine.newTab({ private: true });
  await engine.navigate(tab.id, 'https://secret.example/');
  await settle();
  assert.deepEqual(calls('open').at(-1).args, [tab.id, { url: 'https://secret.example/', private: true }]);
  assert.equal((await engine.history.search('')).length, 0, 'no history');
  await engine._save();
  assert.ok(!JSON.stringify(atmos.fake.state.session).includes('secret'), 'not kept across starts');
  // A link from it that opens a tab (target=_blank, window.open).
  atmos.fake.webEvent({ type: 'open-tab', tabId: tab.id, url: 'https://secret.example/next', background: false, private: true });
  await settle();
  const opened = engine.selected();
  assert.equal(opened.private, true);
  assert.equal(opened.index, engine.tab(tab.id).index + 1, 'right after the tab it came from');
  // Even if Core's flag were missing, a private opener makes it private.
  atmos.fake.webEvent({ type: 'open-tab', tabId: tab.id, url: 'https://secret.example/other', background: true });
  await settle();
  assert.equal(engine.tabs().filter(item => item.private).length, 3);
  for (const item of engine.tabs().filter(other => other.private)) engine.closeTab(item.id);
  assert.equal(engine.closedCount(), 0, 'closed private tabs can’t be reopened once none is left');
});

test('pages are put away past the limit and when left alone; the tab keeps its address', async () => {
  let clock = 1_000_000;
  const { engine, calls } = await start({ now: () => clock });
  await engine.setSettings({ maxLoadedTabs: 5, putAwayAfterMinutes: 30 });
  engine.attachPanel();
  const ids = [];
  for (let i = 0; i < 7; i++) {
    clock += 1000;
    const tab = engine.newTab({ url: `https://site${i}.example/` });
    ids.push(tab.id);
    await settle();
  }
  const live = () => engine.tabs().filter(tab => tab.live).map(tab => tab.id);
  assert.equal(live().length, 5, 'at most five pages loaded');
  assert.ok(live().includes(ids[6]), 'the selected tab is kept');
  const putAway = engine.tab(ids[0]);
  assert.equal(putAway.live, false);
  assert.equal(putAway.url, 'https://site0.example/', 'its address stays');
  assert.ok(calls('close').some(call => call.args[0] === ids[0]));
  engine.selectTab(ids[0]);
  await settle();
  assert.equal(engine.tab(ids[0]).live, true, 'going back to it loads it again');
  clock += 31 * 60 * 1000;
  engine._checkPutAway();
  assert.deepEqual(live(), [ids[0]], 'everything but the selected tab was left alone too long');
  assert.deepEqual(cleanSettings({ maxLoadedTabs: 3, putAwayAfterMinutes: -1, searchEngine: 'nope' }, engines),
    { searchEngine: '', putAwayAfterMinutes: 30, maxLoadedTabs: 10 }, 'only the offered choices');
});

test('closing, reopening and cycling tabs; shortcuts from a page arrive as commands', async () => {
  const { engine, atmos } = await start();
  engine.attachPanel();
  const heard = [];
  engine.subscribe(change => { if (change.type === 'command') heard.push(change.command); });
  const a = engine.newTab({ url: 'https://a.example/' });
  const b = engine.newTab({ url: 'https://b.example/' });
  await settle();
  atmos.fake.webEvent({ type: 'command', tabId: b.id, command: 'previous-tab' });
  assert.equal(engine.selectedId(), a.id);
  atmos.fake.webEvent({ type: 'command', tabId: a.id, command: 'close-tab' });
  assert.ok(!engine.tab(a.id));
  atmos.fake.webEvent({ type: 'command', tabId: b.id, command: 'reopen-tab' });
  assert.equal(engine.selected().url, 'https://a.example/');
  atmos.fake.webEvent({ type: 'command', tabId: b.id, command: 'new-tab' });
  assert.equal(engine.selected().kind, 'new');
  atmos.fake.webEvent({ type: 'command', tabId: b.id, command: 'find' });
  atmos.fake.webEvent({ type: 'command', tabId: b.id, command: 'tab-1' });
  assert.equal(engine.selectedId(), engine.tabs()[0].id);
  assert.deepEqual(heard, ['focus-address', 'find']);
});

test('what a page asks: a permission prompt, another program, a refusal, a failed certificate', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const tab = engine.newTab({ url: 'https://meet.example/' });
  await settle();
  atmos.fake.webEvent({ type: 'permission-request', tabId: tab.id, requestId: 'p1', origin: 'https://meet.example', permissions: ['camera', 'microphone'] });
  assert.deepEqual(engine.tab(tab.id).permission, { requestId: 'p1', origin: 'https://meet.example', permissions: ['camera', 'microphone'] });
  await engine.answerPermission(tab.id, 'p1', true);
  assert.deepEqual(calls('permissions.respond').at(-1).args, ['p1', { allow: true, remember: true }]);
  assert.equal(engine.tab(tab.id).permission, null);
  atmos.fake.webEvent({ type: 'permission-request', tabId: tab.id, requestId: 'p2', origin: 'https://meet.example', permissions: ['geolocation'] });
  await engine.dismissPermission(tab.id, 'p2');
  assert.deepEqual(calls('permissions.respond').at(-1).args, ['p2', { allow: false, remember: false }], 'dismissing isn’t remembered');

  atmos.fake.webEvent({ type: 'external-request', tabId: tab.id, requestId: 'x1', url: 'mailto:a@b.c', scheme: 'mailto' });
  assert.equal(engine.tab(tab.id).external.scheme, 'mailto');
  await engine.answerExternal(tab.id, false);
  assert.deepEqual(calls('external.respond').at(-1).args, ['x1', false]);

  atmos.fake.webEvent({ type: 'refused', tabId: tab.id, url: 'file:///etc/passwd', reason: 'file: addresses aren’t opened in Atmos Browser' });
  assert.match(engine.tab(tab.id).notice.text, /file:/);

  atmos.fake.webEvent({ type: 'load-failed', tabId: tab.id, url: 'https://expired.example/', code: -201, description: 'ERR_CERT_DATE_INVALID', certificate: true });
  assert.equal(engine.tab(tab.id).kind, 'error');
  assert.equal(engine.tab(tab.id).error.kind, 'certificate');
  await settle();
  assert.equal(atmos.fake.web.shown, null, 'the panel shows the warning, not the page');
  atmos.fake.webEvent({ type: 'progress', tabId: tab.id, value: 0.15 });
  await settle();
  assert.equal(engine.tab(tab.id).kind, 'page', 'a new page starts: the warning goes');
  assert.equal(engine.tab(tab.id).notice, null);
  assert.equal(atmos.fake.web.shown, tab.id);
});

test('links from the rest of Atmos open in a new tab and bring the panel up', async () => {
  const { engine, atmos } = await start();
  atmos.fake.webEvent({ type: 'open-link', url: 'https://docs.example/' });
  await settle();
  assert.equal(engine.selected().url, 'https://docs.example/');
  assert.equal(atmos.fake.panelShown, 1);
});

test('titles, icons, history and bookmarks follow the page', async () => {
  const { engine, atmos, store } = await start();
  engine.attachPanel();
  const tab = engine.newTab({ url: 'https://news.example/' });
  await settle();
  atmos.fake.webEvent({ type: 'state', tabId: tab.id, url: 'https://news.example/', title: 'The News', loading: false, canGoBack: true, canGoForward: false, audible: true, muted: false, zoom: 1.25, secure: true });
  const now = engine.tab(tab.id);
  assert.equal(now.title, 'The News');
  assert.equal(now.audible, true);
  assert.equal(now.zoom, 1.25);
  assert.equal((await engine.history.search('news'))[0].title, 'The News');
  atmos.fake.webEvent({ type: 'favicon', tabId: tab.id, dataUrl: 'data:image/png;base64,AAAA', pageUrl: 'https://news.example/' });
  assert.equal(engine.tab(tab.id).favicon, 'data:image/png;base64,AAAA');
  assert.equal((await store.icons.getAll())[0].host, 'news.example');
  atmos.fake.webEvent({ type: 'favicon', tabId: tab.id, dataUrl: 'data:image/png;base64,BBBB', pageUrl: 'https://elsewhere.example/' });
  assert.equal(engine.tab(tab.id).favicon, 'data:image/png;base64,AAAA', 'an icon for another page is ignored');
  assert.equal(await engine.toggleBookmark(tab.id), true);
  assert.equal(engine.tab(tab.id).bookmarked, true);
  const suggestions = await engine.suggest('news');
  assert.equal(suggestions[0].kind, 'search', 'one word: searching first');
  assert.ok(suggestions.some(item => item.kind === 'bookmark' && item.url === 'https://news.example/'));
  assert.ok(!suggestions.some(item => item.kind === 'history' && item.url === 'https://news.example/'), 'each address once');
  assert.equal((await engine.suggest('news.example'))[0].kind, 'url');
  await engine.clearData({ history: true });
  assert.equal((await engine.history.search('')).length, 0);
  assert.equal((await store.icons.getAll()).length, 0);
});

test('downloads and the session are followed', async () => {
  const { engine, atmos, timers } = await start();
  engine.attachPanel();
  const heard = [];
  engine.subscribe(change => { if (change.type === 'downloads') heard.push(change.started); });
  atmos.fake.webEvent({ type: 'download', tabId: null, id: 'd1', name: 'report.pdf', state: 'progressing', received: 10, total: 100, started: 5 });
  atmos.fake.webEvent({ type: 'download', tabId: null, id: 'd1', name: 'report.pdf', state: 'completed', received: 100, total: 100, started: 5 });
  assert.deepEqual(heard, ['d1', null], 'started once');
  assert.equal(engine.downloads()[0].state, 'completed');
  atmos.fake.webEvent({ type: 'download-removed', id: 'd1' });
  assert.equal(engine.downloads().length, 0);
  await assert.rejects(engine.downloadAction('d1', 'constructor'), /unknown action/);

  engine.newTab({ url: 'https://kept.example/' });
  timers.flush();
  await settle();
  assert.ok(atmos.fake.state.session.tabs.some(tab => tab.url === 'https://kept.example/'));
});

test('a title that is only the address (a page without one yet, a failed page) isn’t taken as the title', () => {
  assert.ok(isAddress('example.com/path?x=1', 'https://example.com/path?x=1'));
  assert.ok(isAddress('https://example.com/', 'https://example.com/'));
  assert.ok(isAddress('example.com', 'https://example.com/'));
  assert.ok(isAddress('about:blank', 'about:blank'));
  assert.ok(!isAddress('Example Domain', 'https://example.com/'));
  assert.ok(!isAddress('example', 'https://example.com/'));
});

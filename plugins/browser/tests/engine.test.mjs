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
  assert.equal(engine.tab(first.id).url, 'http://example.com/', 'Core tries it over https first');
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
  assert.deepEqual(visited.map(entry => entry.url).sort(), ['http://example.com/', 'https://duckduckgo.com/?q=atmos%20browser', 'https://www.google.com/search?q=more%20words']);
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

  atmos.fake.webEvent({ type: 'external-request', tabId: tab.id, requestId: 'x1', url: 'mailto:a@b.c', scheme: 'mailto', site: 'https://meet.example' });
  assert.equal(engine.tab(tab.id).external.scheme, 'mailto');
  assert.equal(engine.tab(tab.id).external.site, 'https://meet.example', 'the asking page, for the prompt to name');
  // An answer for a request that's no longer the one shown does nothing.
  assert.equal(await engine.answerExternal(tab.id, true, 'x0'), false);
  assert.equal(engine.tab(tab.id).external.requestId, 'x1');
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

test('links from the rest of Atmos open in a new tab and bring the panel up, or wait behind without a click', async () => {
  const { engine, atmos } = await start();
  atmos.fake.webEvent({ type: 'open-link', url: 'https://docs.example/' });
  await settle();
  assert.equal(engine.selected().url, 'https://docs.example/');
  assert.equal(atmos.fake.panelShown, 1);
  // No click in Atmos just before (Core says): a tab behind, the panel left as it is.
  atmos.fake.webEvent({ type: 'open-link', url: 'https://later.example/', background: true });
  await settle();
  assert.ok(engine.tabs().some(tab => tab.url === 'https://later.example/' && !tab.selected));
  assert.equal(engine.selected().url, 'https://docs.example/');
  assert.equal(atmos.fake.panelShown, 1);
});

test('a pop-up or a download a page tried without a click: a notice in the tab, with a way to go ahead', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const tab = engine.newTab({ url: 'https://site.example/' });
  await settle();
  const before = engine.tabs().length;
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: tab.id, url: 'https://ads.example/pop', site: 'https://site.example', private: false });
  let notice = engine.tab(tab.id).notice;
  assert.match(notice.text, /^Pop-up blocked: site\.example tried to open one without a click/);
  assert.deepEqual(notice.actions.map(action => action.label), ['Open', 'Always allow']);
  assert.equal(engine.tabs().length, before, 'nothing opened');
  await engine.noticeAction(tab.id);
  assert.equal(engine.tabs().length, before + 1);
  assert.equal(engine.selected().url, 'https://ads.example/pop');
  assert.equal(engine.tab(tab.id).notice, null);
  // Nothing to open (about:blank, an address too long to pass on): told, and the site's pop-ups can be allowed.
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: tab.id, url: null, site: 'https://site.example' });
  assert.deepEqual(engine.tab(tab.id).notice.actions.map(action => action.label), ['Always allow']);
  await engine.noticeAction(tab.id, 0);
  assert.deepEqual(calls('permissions.set').at(-1).args, ['https://site.example', 'popups', 'allow']);
  // A private tab keeps nothing: no Always allow there.
  const secret = engine.newTab({ url: 'https://secret.example/', private: true });
  await settle();
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: secret.id, url: 'https://secret.example/pop', site: 'https://secret.example', private: true });
  assert.deepEqual(engine.tab(secret.id).notice.actions.map(action => [action.label, action.private]), [['Open', true]]);
  engine.closeTab(secret.id);
  // A second download without a click; Download asks Core for it (which then lets it through).
  atmos.fake.webEvent({ type: 'download-blocked', tabId: tab.id, url: 'https://site.example/second.zip', name: 'second.zip', site: 'https://site.example' });
  notice = engine.tab(tab.id).notice;
  assert.match(notice.text, /^Download blocked: site\.example tried to save “second\.zip” without a click/);
  await engine.noticeAction(tab.id);
  assert.deepEqual(calls('download').at(-1).args, [tab.id, 'https://site.example/second.zip']);
  // From a pop-up window (no tab of its own): told in the tab you're on.
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: null, url: 'https://x.example/', site: 'https://login.example' });
  assert.match(engine.selected().notice.text, /login\.example/);
  // A click meant for one notice never acts on the one that replaced it.
  const shownId = engine.selected().notice.id;
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: null, url: 'https://y.example/', site: 'https://other.example' });
  const setsBefore = calls('permissions.set').length;
  assert.equal(await engine.noticeAction(engine.selectedId(), 1, shownId), null);
  assert.equal(calls('permissions.set').length, setsBefore, 'other.example not allowed by a click on login.example\'s notice');
  assert.match(engine.selected().notice.text, /other\.example/, 'and its notice stays');
  // The same words again are a new notice (the panel waits again before taking its button).
  const first = engine.selected().notice.id;
  atmos.fake.webEvent({ type: 'popup-blocked', tabId: null, url: 'https://x.example/', site: 'https://login.example' });
  assert.notEqual(engine.selected().notice.id, first);
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

test('ads and trackers: the count and the shield follow the page; the shield is per site and reloads it', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const [first] = engine.tabs();
  await engine.navigate(first.id, 'https://news.example/story');
  await settle();
  assert.equal(engine.tab(first.id).shield, 'on');
  assert.equal(engine.tab(first.id).blocked, 0);
  atmos.fake.webBlocked(first.id, 12);
  await settle();
  assert.equal(engine.tab(first.id).blocked, 12);
  // Down for the site: Core keeps it, the page reloads.
  const reloads = calls('reload').length;
  assert.equal(await engine.setShield(first.id, false), 'off');
  assert.equal(engine.tab(first.id).shield, 'off');
  assert.deepEqual(atmos.fake.web.adsAllowed, ['https://news.example']);
  await settle();
  assert.equal(calls('reload').length, reloads + 1);
  // Another page on the site: still down; elsewhere: up.
  await engine.navigate(first.id, 'https://news.example/other');
  await settle();
  assert.equal(engine.tab(first.id).shield, 'off');
  await engine.navigate(first.id, 'https://elsewhere.example/');
  await settle();
  assert.equal(engine.tab(first.id).shield, 'on');
  assert.equal(engine.tab(first.id).blocked, 0, 'a new page starts at nothing blocked');
  // Blocking off for all.
  await engine.setOptions({ blockAds: false });
  await engine.navigate(first.id, 'https://third.example/');
  await settle();
  assert.equal(engine.tab(first.id).shield, 'disabled');
  assert.equal((await engine.adblockStatus()).enabled, false);
});

test('the blocker\'s status arrives with Core\'s events', async () => {
  const { engine, atmos } = await start();
  const heard = [];
  engine.subscribe(change => { if (change.type === 'adblock') heard.push(change); });
  atmos.fake.webEvent({ type: 'adblock', tabId: null, state: 'ready', rules: 1234, total: 5 });
  await settle();
  assert.equal(engine.adblock().rules, 1234);
  assert.equal(engine.adblock().total, 5);
  assert.ok(heard.length >= 1);
});

test('a page using too much memory: asleep in the background, with why; a notice with Reload where you are', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const heavy = engine.newTab({ url: 'https://x.example/' });
  await settle();
  const here = engine.newTab({ url: 'https://docs.example/' });
  await settle();
  assert.equal(engine.tab(heavy.id).live, true);
  // In the background: put to sleep, and it says why.
  atmos.fake.webEvent({ type: 'memory', tabId: heavy.id, bytes: 14341 * 1024 ** 2 });
  assert.equal(engine.tab(heavy.id).live, false, 'put to sleep');
  assert.ok(calls('close').some(call => call.args[0] === heavy.id));
  assert.match(engine.tab(heavy.id).notice.text, /^Put to sleep in the background: it was using 14 GB of memory/);
  // Coming back loads it again, and the notice stays through that load.
  engine.selectTab(heavy.id);
  await settle();
  assert.equal(engine.tab(heavy.id).live, true);
  atmos.fake.webEvent({ type: 'progress', tabId: heavy.id, value: 0.1 });
  assert.match(engine.tab(heavy.id).notice?.text || '', /Put to sleep/, 'still there once it has loaded');
  atmos.fake.webEvent({ type: 'progress', tabId: heavy.id, value: 0.1 });
  assert.equal(engine.tab(heavy.id).notice, null, 'gone at the next page');
  // The tab you're on isn't put away: told, with Reload.
  atmos.fake.webEvent({ type: 'memory', tabId: heavy.id, bytes: 4.2 * 1024 ** 3 });
  assert.equal(engine.tab(heavy.id).live, true);
  const notice = engine.tab(heavy.id).notice;
  assert.match(notice.text, /^This page is using 4\.2 GB of memory/);
  assert.deepEqual(notice.actions.map(action => action.label), ['Reload']);
  await engine.noticeAction(heavy.id, 0, notice.id);
  await settle();
  assert.ok(calls('reload').some(call => call.args[0] === heavy.id), 'Reload reloads it');
  // A background tab playing sound keeps going (told instead).
  engine.selectTab(here.id);
  await settle();
  atmos.fake.webEvent({ type: 'state', tabId: heavy.id, audible: true });
  atmos.fake.webEvent({ type: 'memory', tabId: heavy.id, bytes: 6.5 * 1024 ** 3 });
  assert.equal(engine.tab(heavy.id).live, true, 'sound playing: not put away');
});

test('automatic https fell back to http: the tab says so through the load; an insecure download, with Download anyway', async () => {
  const { engine, atmos, calls } = await start();
  engine.attachPanel();
  const tab = engine.newTab({ url: 'http://old.example/' });
  await settle();
  atmos.fake.webEvent({ type: 'https-fallback', tabId: tab.id, url: 'http://old.example/', site: 'old.example' });
  atmos.fake.webEvent({ type: 'progress', tabId: tab.id, value: 0.1 });
  assert.match(engine.tab(tab.id).notice?.text || '', /^old\.example has no working secure connection, so it opened without one/);
  atmos.fake.webEvent({ type: 'download-blocked', tabId: tab.id, url: 'http://files.example/a.zip', name: 'a.zip', site: 'https://site.example', insecure: true });
  const notice = engine.tab(tab.id).notice;
  assert.match(notice.text, /^Insecure download blocked: “a\.zip” comes over a connection that isn’t secure/);
  assert.deepEqual(notice.actions.map(action => action.label), ['Download anyway']);
  await engine.noticeAction(tab.id, 0, notice.id);
  await settle();
  assert.deepEqual(calls('download').at(-1).args, [tab.id, 'http://files.example/a.zip']);
});

test('a tab that plays is in Now Playing: what the page says, else its title; its controls go back to the page', async () => {
  const atmos = createFakeAtmos({ extension: { id: 'browser', tier: 'first-party' }, permissions: { web: true, invokes: ['service:now-playing'] } });
  const timers = fakeTimers();
  const engine = createEngine({ atmos, store: memoryStore(), engines, now: () => 1_000_000, timers });
  await engine.ready;
  engine.attachPanel();
  const tab = engine.newTab({ url: 'https://www.youtube.com/watch?v=x' });
  await settle();
  const web = event => atmos.fake.webEvent({ tabId: tab.id, ...event });
  const sync = async () => { timers.flush(); await settle(); };
  web({ type: 'state', url: 'https://www.youtube.com/watch?v=x', title: 'Lofi - YouTube', audible: false });
  await sync();
  assert.deepEqual(atmos.fake.nowPlaying, {}, 'nothing plays');

  // A muted video playing by itself never sounded: its report alone isn't enough.
  web({ type: 'media', media: { title: 'Lofi', artist: 'Girl', album: null, artwork: null, playing: true, position: 3, duration: null, actions: ['toggle'] } });
  await sync();
  assert.deepEqual(atmos.fake.nowPlaying, {});

  web({ type: 'state', url: 'https://www.youtube.com/watch?v=x', title: 'Lofi - YouTube', audible: true });
  await sync();
  const session = atmos.fake.nowPlaying[tab.id];
  assert.deepEqual({ ...session, artwork: !!session.artwork },
    { title: 'Lofi', artist: 'Girl', album: null, from: 'youtube.com', artwork: false, duration: null, position: 3, playing: true, actions: ['toggle'], volume: null });

  // The widget's play/pause reaches the page.
  atmos.fake.controlNowPlaying(tab.id, 'toggle');
  await settle();
  assert.deepEqual(atmos.fake.web.calls.filter(call => call.name === 'media').map(call => call.args), [[tab.id, 'toggle', null]]);

  // Paused: still there, to resume; a new page: gone.
  web({ type: 'state', url: 'https://www.youtube.com/watch?v=x', title: 'Lofi - YouTube', audible: false });
  web({ type: 'media', media: { title: 'Lofi', artist: 'Girl', playing: false, position: 9, actions: ['toggle', 'seek'] } });
  await sync();
  assert.equal(atmos.fake.nowPlaying[tab.id].playing, false);
  web({ type: 'navigated', url: 'https://example.com/', title: 'Example', inPage: false });
  await sync();
  assert.deepEqual(atmos.fake.nowPlaying, {}, 'what the last page played is over');

  // A page that sounds without saying what (an embedded video): the tab's title and the site's icon, no controls.
  web({ type: 'favicon', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', pageUrl: 'https://example.com/' });
  web({ type: 'state', url: 'https://example.com/', title: 'Example', audible: true });
  await sync();
  const plain = atmos.fake.nowPlaying[tab.id];
  assert.deepEqual([plain.title, plain.from, plain.playing, plain.actions, plain.artwork?.type], ['Example', 'example.com', true, [], 'image/png']);
  engine.closeTab(tab.id);
  await sync();
  assert.deepEqual(atmos.fake.nowPlaying, {}, 'closed: gone');
});

test('what a tab shows in Now Playing: never a crashed page; a page that began by itself is marked so', async () => {
  const { nowPlayingSession } = await import('../src/now-playing.js');
  const tab = { id: 't1', url: 'https://www.youtube.com/watch?v=x', title: 'Lofi - YouTube' };
  const media = { title: 'Lofi', artist: 'Girl', playing: true, actions: ['toggle', 'delete'] };
  const live = { live: true, audible: true, heard: true, media, error: null };
  const session = nowPlayingSession(tab, live, { startedByUser: false });
  assert.deepEqual([session.title, session.from, session.actions, session.startedByUser], ['Lofi', 'youtube.com', ['toggle'], false]);
  assert.equal(nowPlayingSession(tab, live).startedByUser, true);
  assert.equal(nowPlayingSession(tab, { ...live, error: { kind: 'crashed' } }), null);
  assert.equal(nowPlayingSession(tab, { ...live, live: false }), null, 'put away');
  assert.equal(nowPlayingSession(tab, { ...live, audible: false, heard: false }), null, 'never sounded');
  assert.equal(nowPlayingSession({ ...tab, url: 'about:blank' }, live), null);
  assert.equal(nowPlayingSession({ ...tab, title: 'https://www.youtube.com/watch?v=x' }, { ...live, media: null }).title, 'youtube.com', 'no title of its own: the site');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createAdblock, LISTS, MIRRORS, expiresMs, looksLikeList, cleanTokens, cleanMeta } = require('./web-adblock.cjs');
const { buildEngine } = require('./web-adblock-parser.cjs');
const { FiltersEngine } = require('@ghostery/adblocker');

const DAY = 24 * 60 * 60 * 1000;
const RESOURCES = fs.readFileSync(path.join(__dirname, 'web-adblock-resources.json'), 'utf8');

const folder = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-adblock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Small lists standing in for uBlock Origin's and EasyList's.
const LIST_TEXT = {
  'ublock-filters': `! Title: uBlock filters\n! Expires: 5 days\n||ads.test^$third-party\nalpha.test##+js(set-constant, adblockTest, true)\nalpha.test##+js(trusted-set-cookie, trustedcookie, 1)\n`,
  'ublock-badware': `! Title: badware\n! Expires: 5 days\n||scam.test^$script\n`,
  'ublock-privacy': `! Title: privacy\n! Expires: 5 days\n*$removeparam=utm_source\n`,
  'ublock-unbreak': `! Title: unbreak\n! Expires: 5 days\n@@||fine.test^\n`,
  'ublock-quick-fixes': `! Title: quick fixes\n! Expires: 5 days\n||quick.test^\n`,
  easylist: `[Adblock Plus 2.0]\n! Title: EasyList\n! Expires: 4 days (update frequency)\n##.ad-slot\n###banner\nalpha.test##.sponsored\n||tracker.test^$script,redirect=noop.js\nbeta.test##+js(trusted-set-cookie, fromeasylist, 1)\nbeta.test##+js(rpnt, p, x, y)\nbeta.test##+js(set-constant, fromEasylist, true)\n`,
  easyprivacy: `! Title: EasyPrivacy\n||pixel.test^\n`,
};
const listFor = url => LISTS.find(list => url.endsWith(list.path));

/** A CDN serving LIST_TEXT (or `texts`) with ETags; `down` mirrors fail. */
function cdn({ texts = LIST_TEXT, down = [] } = {}) {
  const calls = [];
  const fetchText = async (url, { etag } = {}) => {
    calls.push({ url, etag });
    if (down.some(prefix => url.startsWith(prefix))) throw new Error('unreachable');
    const list = listFor(url);
    const text = list ? texts[list.id] : undefined;
    if (text === undefined) return { status: 404, text: 'not found' };
    const tag = `"${require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 16)}"`;
    if (etag && etag === tag) return { status: 304 };
    return { status: 200, text, etag: tag, lastModified: 'Wed, 30 Sep 2026 12:00:00 GMT' };
  };
  return { fetchText, calls };
}

function blocker(t, { dir = folder(t), fetchText = cdn().fetchText, now = () => 1_000_000, build = buildEngine, ...rest } = {}) {
  const builds = [];
  const adblock = createAdblock({
    dir, fetchText, now, log: { warn() {} }, timers: { setInterval: () => null, clearInterval() {}, setTimeout: () => null },
    buildEngine: async payload => { builds.push(payload.lists.map(list => list.id)); return build(payload); },
    ...rest,
  });
  t.after(() => adblock.stop());
  return { adblock, builds, dir };
}

test('helpers: a list\'s expiry, what a list looks like, the DOM tokens a page may send', () => {
  assert.equal(expiresMs('! Title: x\n! Expires: 4 days (update frequency)\n'), 4 * DAY);
  assert.equal(expiresMs('! Expires: 12 hours\n'), DAY, 'at least a day');
  assert.equal(expiresMs('! Expires: 30 days\n'), 7 * DAY, 'at most a week');
  assert.equal(expiresMs('no header'), 4 * DAY);
  assert.ok(looksLikeList('[Adblock Plus 2.0]\n! Title: EasyList\n||a^'));
  assert.ok(looksLikeList('! Title: uBlock\n||a^\n'));
  assert.ok(!looksLikeList('<!doctype html><title>404</title>'));
  assert.ok(!looksLikeList(''));
  const clean = cleanTokens({
    classes: ['ad', 'ad', 42, '', 'x'.repeat(300), ...Array.from({ length: 1500 }, (_, i) => `c${i}`)],
    ids: 'nope', hrefs: ['https://a.test/x', 'javascript:alert(1)', 'data:text/html,x'],
  });
  assert.equal(clean.classes[0], 'ad');
  assert.equal(clean.classes.length, 1000, 'bounded');
  assert.ok(!clean.classes.includes(''), 'no empty names');
  assert.deepEqual(clean.ids, []);
  assert.deepEqual(clean.hrefs, ['https://a.test/x']);
  assert.deepEqual(cleanMeta({ lists: { easylist: { etag: 1, fetchedAt: 'x' }, other: {} }, total: -5 }).lists, {
    easylist: { etag: null, lastModified: null, fetchedAt: 0, changedAt: 0, expires: 4 * DAY, bytes: 0 },
  });
});

test('the lists are uBlock Origin\'s, EasyList and EasyPrivacy, from uBlock Origin\'s CDN over https', () => {
  assert.deepEqual(LISTS.map(list => list.id), ['ublock-filters', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes', 'easylist', 'easyprivacy']);
  assert.deepEqual(LISTS.filter(list => list.trusted).map(list => list.id), ['ublock-filters', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes']);
  assert.ok(MIRRORS.length >= 2 && MIRRORS.every(url => url.startsWith('https://') && url.endsWith('/')));
});

test('a list that isn\'t uBlock Origin\'s own can\'t reach a scriptlet that needs trust, however it\'s written', () => {
  const trustedBody = /trusted-replace-fetch-response|setCookieFn|replaceNodeText/;
  const scriptsFor = (text, trusted, host = 'b.test') => {
    const { buffer } = buildEngine({ lists: [{ id: 'x', trusted, text }], resources: RESOURCES });
    return FiltersEngine.deserialize(buffer).getCosmeticsFilters({
      url: `https://${host}/`, hostname: host, domain: host,
      getBaseRules: true, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false,
    }).scripts;
  };
  const sneaky = [
    'b.test##+js(trusted-replace-fetch-response, a, b)',
    'b.test##+js(trusted-replace-fetch-response.js, a, b)',
    'b.test##+js(rpnt, p, a, b)',                                 // an alias of trusted-replace-node-text
    'b.test##+js(prevent-clipboard-write)',                       // needs trust, though not called trusted-
    'b.test##+js(t \\\n    rusted-replace-fetch-response, a, b)',   // a continued line (the engine joins it)
    'b.test##+js(trusted-se \\\n    t-cookie, name, 1)',
    '   b.test##+js(trusted-set-cookie, name, 1)',
  ];
  for (const filter of sneaky) {
    assert.deepEqual(scriptsFor(`! Title: x\n${filter}\n`, false), [], filter);
  }
  // In uBlock Origin's own list, they run.
  assert.equal(scriptsFor('! Title: x\nb.test##+js(t \\\n    rusted-replace-fetch-response, a, b)\n', true).length, 1);
  assert.equal(scriptsFor('! Title: x\nb.test##+js(rpnt, p, a, b)\n', true).length, 1);
  // Ordinary scriptlets stay in any list; so do exceptions.
  assert.equal(scriptsFor('! Title: x\nb.test##+js(set-constant, x, true)\n', false).length, 1);
  assert.equal(scriptsFor('! Title: x\nb.test##+js(set-constant, x, true)\nb.test#@#+js(set-constant, x, true)\n', false).length, 0);
  assert.ok(!scriptsFor(`! Title: x\n${sneaky.join('\n')}\n`, false).some(script => trustedBody.test(script)));
});

test('each list is parsed on its own: an unclosed "!#if" in one doesn\'t reach the next', () => {
  const { buffer } = buildEngine({
    resources: RESOURCES,
    lists: [
      { id: 'a', trusted: true, text: '! Title: a\n!#if false\n||never.test^\n' },
      { id: 'b', trusted: false, text: '! Title: b\n||always.test^\n' },
    ],
  });
  const engine = FiltersEngine.deserialize(buffer);
  engine.updateEnv(new Map([['env_chromium', true]]));
  const { Request } = require('@ghostery/adblocker');
  const blocked = url => engine.match(Request.fromRawDetails({ url, type: 'script', sourceUrl: 'https://page.test/' })).match;
  assert.equal(blocked('https://always.test/x.js'), true);
  assert.equal(blocked('https://never.test/x.js'), false);
});

test('a $redirect to a resource Atmos doesn\'t have still blocks (and never a page)', async t => {
  const { adblock } = blocker(t, { fetchText: cdn({ texts: { ...LIST_TEXT, easyprivacy: '! Title: EasyPrivacy\n||oddity.test^$redirect=no-such.xyz\n' } }).fetchText });
  await adblock.start();
  const verdict = adblock.match({ url: 'https://oddity.test/x.js', type: 'script', sourceUrl: 'https://alpha.test/' });
  assert.ok(verdict.blocked && (verdict.cancel === true || /^data:[^,]*,$/.test(verdict.redirectURL)), verdict);
  assert.equal(adblock.match({ url: 'https://oddity.test/', type: 'mainFrame' }), null);
});

test('first start: the lists are downloaded, built into an engine, kept', async t => {
  const { fetchText, calls } = cdn();
  const { adblock, builds, dir } = blocker(t, { fetchText });
  assert.equal(adblock.status().state, 'off');
  await adblock.start();
  assert.ok(adblock.ready());
  const status = adblock.status();
  assert.equal(status.state, 'ready');
  assert.ok(status.rules > 5, status.rules);
  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0], LISTS.map(list => list.id));
  assert.equal(calls.length, LISTS.length);
  assert.ok(calls.every(call => call.url.startsWith(MIRRORS[0])), 'the first mirror answered');
  for (const file of ['state.json', 'engine.bin', 'lists/easylist.txt']) assert.ok(fs.existsSync(path.join(dir, file)), file);
  assert.ok(status.lists.every(list => list.changedAt && list.checkedAt));
  assert.equal(status.error, null);
});

test('a list nobody serves is left out, and tried again later', async t => {
  const { fetchText, calls } = cdn({ texts: { ...LIST_TEXT, 'ublock-badware': undefined } });
  const { adblock, builds } = blocker(t, { fetchText });
  await adblock.start();
  assert.ok(adblock.ready());
  assert.ok(!builds[0].includes('ublock-badware'));
  assert.match(adblock.status().error, /Badware risks: HTTP 404/);
  assert.equal(calls.filter(call => call.url.endsWith('badware.min.txt')).length, MIRRORS.length, 'every mirror');
  calls.length = 0;
  await adblock.update();
  assert.deepEqual(calls.map(call => listFor(call.url).id), Array(MIRRORS.length).fill('ublock-badware'), 'only the missing one');
});

test('requests: third-party ad servers blocked, stand-ins for trackers, pages never blocked but cleaned', async t => {
  const { adblock } = blocker(t);
  await adblock.start();
  const page = 'https://alpha.test/article';
  assert.deepEqual(adblock.match({ url: 'https://ads.test/show.js', type: 'script', sourceUrl: page }), { cancel: true, blocked: true });
  assert.equal(adblock.match({ url: 'https://ads.test/show.js', type: 'script', sourceUrl: 'https://ads.test/' }), null, 'first-party: not $third-party');
  const standIn = adblock.match({ url: 'https://tracker.test/t.js', type: 'script', sourceUrl: page });
  assert.ok(standIn.blocked && /^data:application\/javascript/.test(standIn.redirectURL), standIn);
  assert.deepEqual(adblock.match({ url: 'https://pixel.test/p.gif', type: 'image', sourceUrl: page }), { cancel: true, blocked: true });
  assert.equal(adblock.match({ url: 'https://alpha.test/app.js', type: 'script', sourceUrl: page }), null);
  // A page itself: never blocked, even on a blocked server; its tracking parameters go.
  assert.equal(adblock.match({ url: 'https://ads.test/', type: 'mainFrame', sourceUrl: '' }), null);
  assert.deepEqual(adblock.match({ url: 'https://alpha.test/?utm_source=x&id=2', type: 'mainFrame' }), { redirectURL: 'https://alpha.test/?id=2', blocked: false });
  assert.equal(adblock.match({ url: 'data:text/plain,x', type: 'other' }), null);
  assert.equal(adblock.match({ url: 'file:///C:/x', type: 'other' }), null);
});

test('pages: the styles and scriptlets for a page\'s own address, then the styles its DOM calls for', async t => {
  const { adblock } = blocker(t);
  await adblock.start();
  const alpha = adblock.pageStart('https://alpha.test/article');
  assert.match(alpha.styles, /\.sponsored/);
  // uBlock Origin's own list may use a trusted scriptlet. A page's
  // scriptlets come as one script for the page's world and one for their
  // own (uBlock Origin's "isolated" ones: setting a cookie, here).
  assert.equal(alpha.scripts.length, 1);
  assert.match(alpha.scripts[0], /adblockTest/);
  assert.doesNotMatch(alpha.scripts[0], /trustedcookie/);
  assert.equal(alpha.isolated.length, 1);
  assert.match(alpha.isolated[0], /trustedcookie/);
  // EasyList's trusted scriptlets went; its ordinary one stays.
  const beta = adblock.pageStart('https://beta.test/');
  assert.equal(beta.scripts.length, 1);
  assert.match(beta.scripts[0], /fromEasylist/);
  assert.deepEqual(beta.isolated, []);
  assert.doesNotMatch(beta.scripts.join(''), /fromeasylist|"p"/);
  assert.equal(adblock.pageStart('about:blank'), null);
  assert.equal(adblock.pageStart('atmos-app://local/index.html'), null);
  // Generic hiding by what the page holds.
  const dom = adblock.pageTokens('https://gamma.test/', { classes: ['ad-slot', 'content'], ids: ['banner'], hrefs: [] });
  assert.match(dom.styles, /\.ad-slot/);
  assert.match(dom.styles, /#banner/);
  assert.equal(adblock.pageTokens('https://gamma.test/', { classes: ['content'] }), null, 'nothing to hide');
  assert.equal(adblock.pageTokens('https://gamma.test/', 'junk'), null);
});

/**
 * A window-like context for running a page's scriptlets outside a browser
 * (what they touch made in its own realm, as a page's are): { run, added,
 * toStringReplaced, openReplaced }.
 */
function pageContext() {
  const context = vm.createContext({});
  vm.runInContext(`
    var self = globalThis, window = globalThis;
    globalThis.console = { log() {}, info() {}, warn() {}, error() {} };
    globalThis.location = { href: 'https://x.test/i/flow/login', origin: 'https://x.test', hostname: 'x.test', protocol: 'https:' };
    globalThis.document = { readyState: 'loading', addEventListener() {}, removeEventListener() {} };
    globalThis.navigator = {};
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.Request = class Request {};
    globalThis.EventTarget = class EventTarget { addEventListener() {} removeEventListener() {} };
    globalThis.fetch = async () => ({});
    globalThis.XMLHttpRequest = class XMLHttpRequest { open() {} send() {} };
  `, context);
  const names = () => Array.from(vm.runInContext('Object.getOwnPropertyNames(globalThis)', context));
  const before = { names: names(), toString: vm.runInContext('Function.prototype.toString', context), open: vm.runInContext('XMLHttpRequest.prototype.open', context) };
  return {
    run: code => vm.runInContext(code, context),
    added: () => names().filter(name => !before.names.includes(name)),
    toStringReplaced: () => vm.runInContext('Function.prototype.toString', context) !== before.toString,
    openReplaced: () => vm.runInContext('XMLHttpRequest.prototype.open', context) !== before.open,
  };
}

test('a page\'s scriptlets run as uBlock Origin runs them: one scope, helpers shared, the configuring ones first', async t => {
  // X's own lines in uBlock Origin's privacy list, in its order: the one that
  // stops the others replacing Function.prototype.toString (which X checks
  // for) comes after the first of them. y.test has one without it.
  const texts = { ...LIST_TEXT, 'ublock-privacy': `${LIST_TEXT['ublock-privacy']}${[
    'x.test##+js(prevent-xhr, /i/api/1.1/flow/viewer.json)',
    'x.test##+js(prevent-xhr, /i/api/1.1/flow/timeline.json)',
    'x.test##+js(proxy-apply-config, {"skipToString":true})',
    'x.test##+js(prevent-xhr, /i/api/1.1/graphql/viewer_context.json)',
    'y.test##+js(prevent-xhr, /tracking)',
    'z.test##+js(set-constant, zed, 1)', 'z.test##+js(noop.js)',
  ].join('\n')}\n`,
  // EasyPrivacy repeats one of them under another name (as it does for X): it runs once.
  easyprivacy: `${LIST_TEXT.easyprivacy}x.test##+js(no-xhr-if, /i/api/1.1/flow/viewer.json)\n` };
  const { adblock } = blocker(t, { fetchText: cdn({ texts }).fetchText });
  await adblock.start();

  const x = adblock.pageStart('https://x.test/i/flow/login').scripts;
  assert.equal(x.length, 1, 'one script');
  assert.equal((x[0].match(/function proxyApplyFn\(/g) || []).length, 1, 'each helper once');
  const calls = [...x[0].matchAll(/^try \{ ([A-Za-z]+)\(/gm)].map(found => found[1]);
  assert.deepEqual(calls, ['proxyApplyConfig', 'preventXhr', 'preventXhr', 'preventXhr'], 'the configuring one first, each call once');
  const page = pageContext();
  page.run(x[0]);
  assert.equal(page.openReplaced(), true, 'the scriptlets ran');
  assert.equal(page.toStringReplaced(), false, 'the configuration reached them');
  assert.deepEqual(page.added(), [], 'nothing left on the window');

  // Without the configuration the same scriptlet replaces toString (so the
  // check above means something), still leaving nothing on the window.
  const y = pageContext();
  y.run(adblock.pageStart('https://y.test/').scripts[0]);
  assert.equal(y.toStringReplaced(), true);
  assert.deepEqual(y.added(), []);

  // A resource the engine gives as it is (not a scriptlet) runs on its own, after.
  const z = adblock.pageStart('https://z.test/').scripts;
  assert.equal(z.length, 2);
  assert.match(z[0], /^\(function \(\) \{\nvar scriptletGlobals = \{\};/);
  assert.match(z[0], /zed/);
  assert.doesNotMatch(z[1], /scriptletGlobals/);
});

test('scriptlet arguments arrive as the list wrote them, as JSON: no "%" decoding, no way out of an argument', async t => {
  // The engine's own scripts put arguments in template literals and decoded
  // them as if URI-encoded: "50%" threw, "a%20b" became "a b", a backtick
  // broke the script, and a list could end an argument and run its own code.
  const texts = {
    ...LIST_TEXT,
    'ublock-filters': `${LIST_TEXT['ublock-filters']}${[
      'w.test##+js(trusted-set-constant, pctA, json:"50%")',
      'w.test##+js(trusted-set-constant, pctB, json:"a%20b")',
      'w.test##+js(trusted-set-constant, tick, json:"a`b")',
      'w.test##+js(broken)',
    ].join('\n')}\n`,
    // EasyList, which may not run trusted scriptlets: an argument written to
    // get out (with the engine's own scripts this ran `injected=1` in the page).
    easylist: `${LIST_TEXT.easylist}w.test##+js(set-constant, escaped, x\`\\,injected=1\\,\`)\n`,
  };
  // A scriptlet whose code doesn't parse (none of uBlock Origin's), so a call is left out.
  const resources = JSON.parse(RESOURCES);
  resources.scriptlets.push({ name: 'broken.js', aliases: [], body: 'function broken(){ return ( }', dependencies: [] });
  const warnings = [];
  const { adblock } = blocker(t, { fetchText: cdn({ texts }).fetchText, readResources: () => JSON.stringify(resources), log: { warn: (...args) => warnings.push(args.join(' ')) } });
  await adblock.start();
  const [script] = adblock.pageStart('https://w.test/').scripts;
  assert.doesNotMatch(script, /decodeURIComponent/);
  assert.doesNotMatch(script, /function broken/, 'the call that doesn\'t parse is left out');
  assert.ok(warnings.some(line => /1 scriptlet\(s\) left out/.test(line)), warnings.join('\n'));
  const page = pageContext();
  page.run(script);
  assert.deepEqual([page.run('globalThis.pctA'), page.run('globalThis.pctB'), page.run('globalThis.tick')], ['50%', 'a%20b', 'a`b']);
  assert.equal(page.run('typeof injected'), 'undefined', 'an argument is only ever a string');
});

test('a restart loads the kept engine: no download, no parse', async t => {
  const dir = folder(t);
  const first = blocker(t, { dir });
  await first.adblock.start();
  const { fetchText, calls } = cdn();
  const second = blocker(t, { dir, fetchText });
  await second.adblock.start();
  assert.ok(second.adblock.ready());
  assert.equal(calls.length, 0, 'nothing due yet');
  assert.equal(second.builds.length, 0, 'the engine was kept');
  assert.deepEqual(second.adblock.match({ url: 'https://ads.test/x.js', type: 'script', sourceUrl: 'https://alpha.test/' }), { cancel: true, blocked: true });
});

test('updates: only lists past their expiry, conditionally; built again only when one changed', async t => {
  const dir = folder(t);
  let clock = 1_000_000;
  const texts = { ...LIST_TEXT };
  const server = cdn({ texts });
  const { adblock, builds } = blocker(t, { dir, fetchText: server.fetchText, now: () => clock });
  await adblock.start();
  assert.equal(builds.length, 1);
  server.calls.length = 0;
  await adblock.update();
  assert.equal(server.calls.length, 0, 'nothing expired');
  // Four days on: EasyList (4 days) and the ones that don't say are due; uBlock filters (5 days) isn't.
  clock += 4 * DAY + 1;
  await adblock.update();
  const asked = server.calls.map(call => listFor(call.url).id);
  assert.ok(asked.includes('easylist') && !asked.includes('ublock-filters'), asked);
  assert.ok(server.calls.filter(call => listFor(call.url).id === 'easylist').every(call => call.etag), 'with its ETag');
  assert.equal(builds.length, 1, 'unchanged (304): no new engine');
  // EasyList changes: a new engine.
  texts.easylist = `${LIST_TEXT.easylist}||newads.test^\n`;
  await adblock.update({ force: true });
  assert.equal(builds.length, 2);
  assert.deepEqual(adblock.match({ url: 'https://newads.test/a.js', type: 'script', sourceUrl: 'https://alpha.test/' }), { cancel: true, blocked: true });
});

test('mirrors: the next one when one is down; nothing reachable leaves an error, then it recovers', async t => {
  const down = cdn({ down: [MIRRORS[0]] });
  const one = blocker(t, { fetchText: down.fetchText });
  await one.adblock.start();
  assert.ok(one.adblock.ready());
  assert.ok(down.calls.some(call => call.url.startsWith(MIRRORS[1])));

  let offline = true;
  const server = cdn();
  const fetchText = async (url, options) => { if (offline) throw new Error('offline'); return server.fetchText(url, options); };
  const two = blocker(t, { fetchText });
  await two.adblock.start();
  assert.equal(two.adblock.status().state, 'error');
  assert.match(two.adblock.status().error, /offline/);
  assert.equal(two.adblock.match({ url: 'https://ads.test/x.js', type: 'script', sourceUrl: 'https://alpha.test/' }), null, 'no engine: nothing blocked');
  offline = false;
  await two.adblock.update();
  assert.equal(two.adblock.status().state, 'ready');
  assert.equal(two.adblock.status().error, null);
});

test('an error page or an oversized answer isn\'t taken for a list', async t => {
  const fetchText = async url => (listFor(url)?.id === 'easylist'
    ? { status: 200, text: '<!doctype html><h1>Rate limited</h1>' }
    : cdn().fetchText(url));
  const { adblock, builds } = blocker(t, { fetchText });
  await adblock.start();
  assert.ok(adblock.ready());
  assert.ok(!builds[0].includes('easylist'));
  assert.match(adblock.status().error, /EasyList: not a filter list/);
});

test('a new library, resources or parser: the engine is built again from the kept lists, offline', async t => {
  const dir = folder(t);
  await blocker(t, { dir }).adblock.start();
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  state.engine.library = '0.0.1';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const fetchText = async () => { throw new Error('offline'); };
  const { adblock, builds } = blocker(t, { dir, fetchText });
  await adblock.start();
  assert.equal(builds.length, 1);
  assert.ok(adblock.ready());
  assert.equal(adblock.status().state, 'ready');
  // A parser that leaves out other filters than the one that built it.
  const again = blocker(t, { dir, fetchText, readParser: () => '// another parser' });
  await again.adblock.start();
  assert.equal(again.builds.length, 1, 'built again for a new parser');
  const same = blocker(t, { dir, fetchText, readParser: () => '// another parser' });
  await same.adblock.start();
  assert.equal(same.builds.length, 0, 'and kept after that');
});

test('what a list can\'t put in a page: styles that leave their rule or load an address, $csp reports, text too long', async t => {
  const long = 'a'.repeat(70 * 1024);
  const texts = {
    ...LIST_TEXT,
    easylist: `${LIST_TEXT.easylist}${[
      'v.test##.fine-ad',
      'v.test##body:style(color:red } input[value$="x"] { background:url(https://evil.test/x) } z {color:red)',
      'v.test##a{background:url(https://evil.test/s)}b',
      '##html:style(background:u\\72l(https://evil.test/e))',
      'v.test##x; @import url(https://evil.test/i.css)',
      'v.test##.ok-style:style(height: 0 !important; margin: 0 !important)',
      `v.test##div[data-x="${long}"]`,
    ].join('\n')}\n`,
    easyprivacy: `${LIST_TEXT.easyprivacy}${['*$csp=report-uri https://evil.test/r', '||v.test^$csp=img-src \'none\'', '||v.test^$csp=script-src \'none\'; report-to evil'].join('\n')}\n`,
  };
  const { adblock } = blocker(t, { fetchText: cdn({ texts }).fetchText });
  await adblock.start();
  const page = adblock.pageStart('https://v.test/');
  assert.match(page.styles, /\.fine-ad/);
  assert.match(page.styles, /\.ok-style/);
  assert.doesNotMatch(page.styles, /evil\.test|@import|url\(|u\\72l|data-x/);
  const policy = adblock.csp({ url: 'https://v.test/', type: 'mainFrame', sourceUrl: 'https://v.test/' });
  assert.equal(policy, "img-src 'none'");
  assert.equal(adblock.csp({ url: 'https://w.test/', type: 'mainFrame', sourceUrl: 'https://w.test/' }), undefined);
});

test('test lists from a folder (the end-to-end check): nothing downloaded or kept', async t => {
  const lists = folder(t);
  fs.writeFileSync(path.join(lists, 'easylist.txt'), LIST_TEXT.easylist);
  const fetchText = async () => { throw new Error('should not download'); };
  const { adblock, dir } = blocker(t, { fetchText, localLists: lists });
  await adblock.start();
  assert.ok(adblock.ready());
  assert.ok(!fs.existsSync(path.join(dir, 'engine.bin')));
  assert.ok(adblock.pageStart('https://alpha.test/').styles.includes('.sponsored'));
});

test('the total blocked is counted and kept', async t => {
  const dir = folder(t);
  const { adblock } = blocker(t, { dir });
  await adblock.start();
  adblock.counted();
  adblock.counted(4);
  assert.equal(adblock.status().total, 5);
  adblock.flush();
  assert.equal(blocker(t, { dir }).adblock.status().total, 5);
});

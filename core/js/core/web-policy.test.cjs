'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./web-policy.cjs');

const { navigationPolicy, isLoadable } = policy;
const action = (url, frame = 'top') => navigationPolicy(url, { frame }).action;

test('the browser\'s sessions are its own partitions: one on disk, one in memory', () => {
  assert.equal(policy.PARTITION, 'persist:atmos-browser');
  assert.ok(!policy.PRIVATE_PARTITION.startsWith('persist:'), 'private tabs keep nothing on disk');
  assert.notEqual(policy.PARTITION, '');
  assert.deepEqual([...policy.PARTITIONS], [policy.PARTITION, policy.PRIVATE_PARTITION]);
});

test('every page runs sandboxed, isolated, with web security, no Node, no preload of its own and no FedCM', () => {
  const prefs = policy.WEB_PREFERENCES;
  assert.ok(Object.isFrozen(prefs));
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.webviewTag, false);
  // The host adds Core's own (web-page-preload.cjs); a page never chooses one.
  assert.equal(prefs.preload, undefined);
  // A page with no background of its own isn't see-through to Atmos.
  assert.equal(prefs.transparent, false);
  // FedCM has no dialog in Electron: off, so sites use a sign-in pop-up.
  assert.equal(prefs.disableBlinkFeatures, 'FedCm');
});

test('a Chrome user agent, with no Electron or Atmos in it', () => {
  const windows = policy.chromeUserAgent('win32', '152.0.7890.12');
  assert.equal(windows, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
  assert.match(policy.chromeUserAgent('darwin', '152.1'), /\(Macintosh; Intel Mac OS X 10_15_7\).*Chrome\/152\.0\.0\.0/);
  assert.match(policy.chromeUserAgent('linux', '152.1'), /\(X11; Linux x86_64\)/);
  for (const ua of [windows, policy.chromeUserAgent()]) assert.doesNotMatch(ua, /electron|atmos/i);
});

test('the user agent client hints are Chromium\'s, for its major version', () => {
  // As Chromium 141 and Electron 44 (Chromium 152) report them.
  assert.deepEqual(policy.uaBrands('141.0.7390.37'), [{ brand: 'Chromium', version: '141' }, { brand: 'Not?A_Brand', version: '8' }]);
  assert.deepEqual(policy.uaBrands('152.0.7977.130'), [{ brand: 'Not?A_Brand', version: '24' }, { brand: 'Chromium', version: '152' }]);
  const headers = policy.withClientHints({ 'User-Agent': 'x', Accept: '*/*' }, 'win32', '141.0.7390.37');
  assert.equal(headers['sec-ch-ua'], '"Chromium";v="141", "Not?A_Brand";v="8"');
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  assert.equal(headers['sec-ch-ua-platform'], '"Windows"');
  assert.equal(headers['User-Agent'], 'x');
  assert.equal(policy.withClientHints({}, 'darwin', '152')['sec-ch-ua-platform'], '"macOS"');
  // Hints already there are left alone.
  const sent = { 'Sec-CH-UA': '"Chromium";v="152"' };
  assert.equal(policy.withClientHints(sent, 'win32', '152'), sent);
  // Navigations to secure origins: a page's own requests have them already.
  assert.deepEqual([...policy.CLIENT_HINTS_FILTER.types], ['mainFrame', 'subFrame']);
  assert.ok(policy.CLIENT_HINTS_FILTER.urls.every(url => /^(https:\/\/\*|http:\/\/(localhost|127\.0\.0\.1))\//.test(url)));
});

test('pages: http, https and about:blank only', () => {
  assert.equal(action('https://example.com/a?b#c'), 'allow');
  assert.equal(action('http://localhost:3000/'), 'allow');
  assert.equal(action('HTTP://EXAMPLE.COM/'), 'allow');
  assert.equal(action('http://[::1]:8080/'), 'allow');
  assert.equal(action('about:blank'), 'allow');
  assert.equal(action('about:srcdoc'), 'refuse');
  assert.equal(action('about:config'), 'refuse');
  for (const url of [
    'atmos-app://local/index.html', 'atmos-ext://first-party-plugin-browser/__atmos/frame.html', 'atmos-resource://audio-player-media/x',
    'file:///etc/passwd', 'file://C:/Windows/win.ini', 'chrome://settings', 'chrome-extension://abc/x.html', 'devtools://devtools/bundled/inspector.html',
    'javascript:alert(1)', 'JavaScript:alert(1)', 'view-source:https://example.com', 'data:text/html,<p>x', 'blob:https://example.com/uuid',
    'filesystem:https://example.com/temporary/x', 'ws://example.com/', 'ftp://example.com/',
  ]) {
    assert.equal(action(url), 'refuse', url);
  }
  assert.equal(action('not a url'), 'refuse');
  assert.equal(action(''), 'refuse');
  assert.equal(action(`https://example.com/${'a'.repeat(9000)}`), 'refuse', 'absurdly long addresses');
  assert.equal(action('http://'), 'refuse');
});

test('frames inside a page may also be about:srcdoc, data: and blob:, never Atmos\'s schemes or files', () => {
  for (const url of ['https://example.com/', 'about:blank', 'about:srcdoc', 'data:text/html,x', 'blob:https://example.com/1']) {
    assert.equal(action(url, 'sub'), 'allow', url);
  }
  for (const url of ['atmos-app://local/', 'atmos-ext://first-party/x', 'atmos-resource://x/y', 'file:///C:/', 'chrome://gpu', 'javascript:1', 'mailto:a@b.c']) {
    assert.equal(action(url, 'sub'), 'refuse', url);
  }
});

test('other schemes ask before another program opens them, except ones that run programs', () => {
  assert.deepEqual(navigationPolicy('mailto:someone@example.com'), { action: 'external', scheme: 'mailto' });
  assert.deepEqual(navigationPolicy('magnet:?xt=urn:btih:abc'), { action: 'external', scheme: 'magnet' });
  assert.equal(action('tel:+441234'), 'external');
  assert.equal(action('steam://run/1'), 'external');
  for (const url of ['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'ms-officecmd:x', 'ms-settings:privacy', 'shell:startup', 'vbscript:x']) {
    assert.equal(action(url), 'refuse', url);
  }
  // A drive letter parses as a one-letter scheme; handed to the system it
  // would open (or run) the file.
  for (const url of ['C:\\Windows\\System32\\calc.exe', 'c:/Users/x/file.txt', 'D:relative']) {
    assert.equal(action(url), 'refuse', url);
  }
  assert.ok(!isLoadable('mailto:a@b.c'), 'an external link is never loaded as a page');
  assert.ok(isLoadable('https://example.com/'));
});

test('a site setting is kept per http(s) origin', () => {
  assert.equal(policy.siteOf('https://Example.com:443/path?q'), 'https://example.com');
  assert.equal(policy.siteOf('http://example.com:8080/'), 'http://example.com:8080');
  assert.equal(policy.siteOf('file:///x'), null);
  assert.equal(policy.siteOf('about:blank'), null);
  assert.equal(policy.siteOf('nonsense'), null);
});

test('a request\'s page and document: its initiator when the browser hasn\'t caught up with a navigation', () => {
  const context = policy.requestContext;
  const A = 'https://alpha.example', B = 'https://beta.example', G = 'https://gamma.example';
  const top = url => ({ url, topUrl: url, parentUrl: '', isTop: true });
  const inFrame = (url, topUrl) => ({ url, topUrl, parentUrl: topUrl, isTop: false });
  const ad = 'https://ads.example/ad.js';
  // A page's document: page and source are the page.
  assert.deepEqual(context({ type: 'mainFrame', url: `${A}/news` }), { pageUrl: `${A}/news`, sourceUrl: `${A}/news` });
  assert.deepEqual(context({ type: 'script', url: ad, frame: top(`${A}/news`), contentsUrl: `${A}/news`, initiator: A }),
    { pageUrl: `${A}/news`, sourceUrl: `${A}/news` });
  // The page's first requests, with its frame still at the page before
  // (another site, its shield and context) or at nothing yet (a new tab).
  assert.deepEqual(context({ type: 'script', url: ad, frame: top(`${B}/solid`), contentsUrl: `${B}/solid`, referrer: `${A}/`, initiator: A }),
    { pageUrl: `${A}/`, sourceUrl: `${A}/` });
  for (const blank of ['', 'about:blank']) {
    assert.deepEqual(context({ type: 'image', url: ad, frame: top(blank), contentsUrl: blank, initiator: A }), { pageUrl: `${A}/`, sourceUrl: `${A}/` });
  }
  // A document a page opened and wrote (about:blank, blob:) is the opener's.
  assert.equal(context({ type: 'script', url: ad, frame: top('about:blank'), initiator: A }).pageUrl, `${A}/`);
  assert.equal(context({ type: 'script', url: ad, frame: top(`blob:${A}/0b5e`), initiator: A }).pageUrl, `${A}/`);
  // Without an initiator (or an opaque one), what the browser knows.
  assert.deepEqual(context({ type: 'script', url: ad, frame: top(`${A}/news`), initiator: 'null' }), { pageUrl: `${A}/news`, sourceUrl: `${A}/news` });
  assert.deepEqual(context({ type: 'script', url: ad, frame: top('about:blank'), contentsUrl: 'about:blank' }), { pageUrl: '', sourceUrl: '' });
  assert.equal(context({ type: 'script', url: ad, frame: top(''), referrer: `${A}/news` }).pageUrl, `${A}/news`);
  // A frame's document: the page is the top frame's, the frame asks (even
  // before the browser knows the frame's address).
  assert.deepEqual(context({ type: 'script', url: ad, frame: inFrame(`${G}/widget`, `${A}/news`), contentsUrl: `${A}/news`, initiator: G }),
    { pageUrl: `${A}/news`, sourceUrl: `${G}/` });
  assert.deepEqual(context({ type: 'script', url: ad, frame: inFrame('', `${A}/news`), contentsUrl: `${A}/news`, initiator: G }),
    { pageUrl: `${A}/news`, sourceUrl: `${G}/` });
  assert.deepEqual(context({ type: 'script', url: ad, frame: inFrame('about:srcdoc', `${A}/news`), initiator: 'null' }),
    { pageUrl: `${A}/news`, sourceUrl: `${A}/news` });
  // A frame loading: in the context of the document around it.
  assert.deepEqual(context({ type: 'subFrame', url: `${G}/widget`, frame: { url: '', topUrl: `${A}/news`, parentUrl: `${B}/inner`, isTop: false }, initiator: B }),
    { pageUrl: `${A}/news`, sourceUrl: `${B}/inner` });
  // A service worker's requests (no frame, no tab): its site.
  assert.deepEqual(context({ type: 'xhr', url: ad, initiator: A, referrer: '' }), { pageUrl: `${A}/`, sourceUrl: `${A}/` });
  assert.deepEqual(context({ type: 'xhr', url: ad, referrer: `${A}/sw.js` }), { pageUrl: `${A}/sw.js`, sourceUrl: `${A}/sw.js` });
  assert.deepEqual(context({ type: 'other', url: ad }), { pageUrl: '', sourceUrl: '' });
});

test('permissions: denied unless the user allowed the site; fullscreen and clipboard writes need no prompt', () => {
  const none = () => undefined;
  const allowAll = () => 'allow';
  const origin = 'https://example.com';
  const decide = (permission, details, setting, o = origin) => policy.permissionDecision(permission, details, setting, { origin: o });
  assert.equal(decide('fullscreen', {}, none), 'allow');
  assert.equal(decide('clipboard-sanitized-write', {}, none), 'allow');
  for (const name of ['geolocation', 'notifications', 'clipboard-read']) {
    assert.equal(decide(name, {}, none), 'ask', name);
    assert.equal(decide(name, {}, allowAll), 'allow', name);
    assert.equal(decide(name, {}, () => 'block'), 'deny', name);
  }
  // The mouse's back and forward buttons: on release, never other buttons or moves.
  assert.equal(policy.mouseCommand({ type: 'mouseUp', button: 'back' }), 'back');
  assert.equal(policy.mouseCommand({ type: 'mouseUp', button: 'forward' }), 'forward');
  for (const mouse of [{ type: 'mouseDown', button: 'back' }, { type: 'mouseUp', button: 'left' }, { type: 'mouseUp', button: 'middle' },
    { type: 'mouseMove', button: 'none' }, { type: 'mouseUp' }, null, undefined]) {
    assert.equal(policy.mouseCommand(mouse), null, JSON.stringify(mouse));
  }
  // Pointer lock: a tab's, just after a click or key in it, with no prompt; never a pop-up's.
  assert.equal(policy.permissionDecision('pointerLock', {}, none, { origin, tab: true, activated: true }), 'allow');
  assert.equal(policy.permissionDecision('pointerLock', {}, allowAll, { origin, tab: true, activated: false }), 'deny');
  assert.equal(policy.permissionDecision('pointerLock', {}, none, { origin, tab: true }), 'deny');
  assert.equal(policy.permissionDecision('pointerLock', {}, allowAll, { origin, tab: false, activated: true }), 'deny');
  assert.equal(policy.permissionCheck('pointerLock', {}, none, { origin, tab: true }), true);
  assert.equal(policy.permissionCheck('pointerLock', {}, none, { origin, tab: false }), false);
  assert.deepEqual(policy.permissionNames('pointerLock'), []);
  for (const name of ['midi', 'midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'idle-detection', 'openExternal', 'keyboardLock', 'storage-access', 'window-management', 'unknown']) {
    assert.equal(decide(name, {}, allowAll), 'deny', name);
    assert.equal(policy.permissionCheck(name, {}, allowAll, { origin }), false, name);
  }
  // Camera and microphone are asked for separately; both must be allowed.
  assert.deepEqual(policy.permissionNames('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(policy.permissionNames('media', { mediaTypes: ['audio'] }), ['microphone']);
  assert.deepEqual(policy.permissionNames('media', { mediaType: 'video' }), ['camera']);
  assert.deepEqual(policy.permissionNames('media', {}), ['camera', 'microphone']);
  const cameraOnly = name => (name === 'camera' ? 'allow' : undefined);
  assert.equal(decide('media', { mediaTypes: ['video'] }, cameraOnly), 'allow');
  assert.equal(decide('media', { mediaTypes: ['video', 'audio'] }, cameraOnly), 'ask');
  assert.equal(decide('media', { mediaTypes: ['video', 'audio'] }, name => (name === 'camera' ? 'allow' : 'block')), 'deny');
  // No site (about:blank, a data: frame): nothing to ask about.
  assert.equal(decide('geolocation', {}, allowAll, null), 'deny');
  // A check is only ever what the user allowed.
  assert.equal(policy.permissionCheck('notifications', {}, none, { origin }), false);
  assert.equal(policy.permissionCheck('notifications', {}, allowAll, { origin }), true);
  assert.equal(policy.permissionCheck('fullscreen', {}, none, { origin }), true);
});

test('fullscreen is a tab\'s only: a pop-up window, with no notice naming its site, never goes fullscreen', () => {
  const none = () => undefined;
  const origin = 'https://example.com';
  assert.equal(policy.permissionDecision('fullscreen', {}, none, { origin, tab: true }), 'allow');
  assert.equal(policy.permissionDecision('fullscreen', {}, none, { origin, tab: false }), 'deny');
  assert.equal(policy.permissionCheck('fullscreen', {}, none, { origin, tab: false }), false);
  // Nothing else changes for a pop-up (it's never asked about, having no browser around it).
  assert.equal(policy.permissionDecision('clipboard-sanitized-write', {}, none, { origin, tab: false }), 'allow');
  assert.equal(policy.permissionDecision('geolocation', {}, () => 'allow', { origin, tab: false }), 'allow');
});

test('a permission is the page\'s: a frame\'s request names and is kept for the site you\'re on', () => {
  const page = 'https://news.example/article';
  const site = (permission, requestingUrl, topUrl = page) => policy.permissionSite(permission, { requestingUrl, topUrl });
  assert.equal(site('geolocation', page), 'https://news.example');
  // A frame from another site (which the page let ask: Chromium checks its allow=): the page's site.
  assert.equal(site('geolocation', 'https://maps.example/embed'), 'https://news.example');
  assert.equal(site('media', 'https://call.example/room'), 'https://news.example');
  // Notifications from a frame of another origin: refused, as Chrome does (same-site too).
  assert.equal(site('notifications', 'https://ads.example/frame'), null);
  assert.equal(site('notifications', 'https://cdn.news.example/frame'), null);
  assert.equal(site('notifications', `${page}#frame`), 'https://news.example');
  // A frame without a site of its own (about:blank, srcdoc) is the page's.
  assert.equal(site('notifications', 'about:blank'), 'https://news.example');
  // No page site (a pop-up still blank, a data: page): nothing to keep it under.
  assert.equal(site('geolocation', 'https://maps.example/', 'about:blank'), null);
  assert.equal(site('geolocation', '', ''), null);
});

test('user activation: a click, a tap or a key the page gets; not a repeat, Escape, a modifier or a browser shortcut', () => {
  const yes = [
    { type: 'mouseDown', button: 'left' }, { type: 'mouseDown', button: 'middle' }, { type: 'touchEnd' }, { type: 'gestureTap' },
    { type: 'keyDown', key: 'a' }, { type: 'keyDown', key: 'Enter' }, { type: 'rawKeyDown', key: ' ' }, { type: 'keyDown', key: 'A', shift: true },
    { type: 'keyDown', key: 'c', control: true },
  ];
  for (const input of yes) assert.equal(policy.activatesUser(input), true, JSON.stringify(input));
  const no = [
    null, {}, { type: 'mouseUp' }, { type: 'mouseMove' }, { type: 'mouseWheel' }, { type: 'touchStart' }, { type: 'keyUp', key: 'a' }, { type: 'char', key: 'a' },
    { type: 'keyDown', key: 'a', isAutoRepeat: true }, { type: 'keyDown', key: 'Escape' }, { type: 'keyDown', key: 'Shift', shift: true },
    { type: 'keyDown', key: 'Control', control: true }, { type: 'keyDown', key: 'Alt', alt: true }, { type: 'keyDown', key: 'Meta', meta: true },
    { type: 'keyDown', key: 't', control: true }, { type: 'keyDown', key: 'F5' }, { type: 'keyDown', key: '' },
  ];
  for (const input of no) assert.equal(policy.activatesUser(input), false, JSON.stringify(input));
});

test('activations: within 5 s of a click, and one pop-up per click', () => {
  let clock = 1000;
  const activations = policy.createActivations({ now: () => clock });
  assert.equal(activations.take(1, 'popup'), false, 'never used');
  activations.activate(1);
  assert.equal(activations.lastAt(1), 1000);
  assert.equal(activations.take(2, 'popup'), false, 'another page\'s click is its own');
  clock += 4999;
  assert.equal(activations.take(1, 'popup'), true);
  assert.equal(activations.take(1, 'popup'), false, 'that click paid for one');
  assert.equal(activations.take(1, 'link'), true, 'each kind once');
  activations.activate(1);
  clock += policy.USER_ACTIVATION_MS;
  assert.equal(activations.take(1, 'popup'), false, 'too long ago');
  activations.activate(1);
  activations.forget(1);
  assert.equal(activations.take(1, 'popup'), false);
  assert.equal(activations.lastAt(1), 0);
});

test('"Leave site?": not again for half a minute after a Cancel, unless you just did something yourself', () => {
  const now = 100_000;
  assert.equal(policy.askBeforeLeaving({ now }), true, 'first time');
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - 1000, now }), false, 'the page asking again right away');
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - policy.LEAVE_QUIET_MS + 1, now }), false);
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - policy.LEAVE_QUIET_MS, now }), true, 'half a minute on');
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - 5000, actedAt: now - 500, now }), true, 'you clicked Back, or a link');
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - 5000, actedAt: now - policy.LEAVE_ACTED_MS, now }), false, 'not that recently');
  assert.equal(policy.askBeforeLeaving({ refusedAt: now - 5000, actedAt: now - 6000, now }), false, 'before the Cancel');
});

test('a site\'s icon is fetched only from a public address, unless the page is on that host', () => {
  const page = 'https://example.com/';
  for (const icon of ['https://example.com/favicon.ico', 'https://cdn.example.net/i.png', 'http://8.8.8.8/x.png', 'https://[2606:4700::1111]/i.png', 'https://172.32.0.1/i.png']) {
    assert.equal(policy.iconFetchAllowed(icon, page), true, icon);
  }
  for (const icon of [
    'http://localhost/x.png', 'http://app.localhost/x.png', 'http://127.0.0.1/x.png', 'http://127.1/x.png', 'http://2130706433/x.png',
    'http://0x7f000001/x.png', 'http://10.0.0.1/x.png', 'http://192.168.1.1/admin.png', 'http://172.16.5.4/x.png', 'http://169.254.169.254/latest',
    'http://100.64.0.1/x.png', 'http://0.0.0.0/x.png', 'http://[::1]/x.png', 'http://[fd00::1]/x.png', 'http://[fe80::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png', 'http://[::ffff:c0a8:101]/x.png', 'http://router/x.png', 'http://printer.local/x.png', 'http://nas.lan/x.png',
    'http://box.internal/x.png', 'http://me@example.com/x.png', 'ftp://example.com/x.png', 'file:///C:/x.png', 'data:image/png;base64,AA==', 'not a url',
  ]) {
    assert.equal(policy.iconFetchAllowed(icon, page), false, icon);
  }
  // A page on a local server gets its own icon (another port of that host too).
  assert.equal(policy.iconFetchAllowed('http://localhost:3000/favicon.ico', 'http://localhost:3000/app'), true);
  assert.equal(policy.iconFetchAllowed('http://localhost:8080/favicon.ico', 'http://localhost:3000/app'), true);
  assert.equal(policy.iconFetchAllowed('http://192.168.1.1/favicon.ico', 'http://192.168.1.1/'), true);
  assert.equal(policy.iconFetchAllowed('http://192.168.1.2/favicon.ico', 'http://192.168.1.1/'), false);
  // Every way of writing a local IPv4 address in IPv6, and the other local IPv6 ranges.
  for (const icon of ['http://[::127.0.0.1]/x.png', 'http://[::ffff:0:127.0.0.1]/x.png', 'http://[64:ff9b::10.0.0.1]/x.png', 'http://[fec0::1]/x.png',
    'http://[2002:c0a8:101::1]/x.png', 'http://[ff02::1]/x.png', 'http://[::]/x.png']) {
    assert.equal(policy.iconFetchAllowed(icon, page), false, icon);
  }
  assert.equal(policy.iconFetchAllowed('http://[64:ff9b::8.8.8.8]/x.png', page), true);
});

test('a name an icon is fetched from is resolved first, and every address it has must be public', () => {
  const page = 'https://example.com/';
  // A name that isn't the page's own host is looked up (fritz.box and the like pass the name check).
  assert.equal(policy.iconLookup('http://fritz.box/x.png', page), 'fritz.box');
  assert.equal(policy.iconLookup('https://CDN.example.net./i.png', page), 'cdn.example.net');
  assert.equal(policy.iconLookup('https://example.com/favicon.ico', page), null, 'the page\'s own host');
  assert.equal(policy.iconLookup('http://8.8.8.8/x.png', page), null, 'an address, already judged');
  assert.equal(policy.iconLookup('http://[2606:4700::1111]/x.png', page), null);
  // What a resolver says: local or not.
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '169.254.169.254', '::1', '::', 'fe80::1%eth0', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'garbage']) {
    assert.equal(policy.isLocalAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8']) {
    assert.equal(policy.isLocalAddress(address), false, address);
  }
});

test('download names: no folders, no forbidden characters or device names, bounded, with a fallback', () => {
  assert.equal(policy.downloadName('report.pdf'), 'report.pdf');
  assert.equal(policy.downloadName('../../../Windows/System32/evil.exe'), 'evil.exe');
  assert.equal(policy.downloadName('..\\..\\evil.dll'), 'evil.dll');
  assert.equal(policy.downloadName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(policy.downloadName('CON.txt'), '_CON.txt');
  assert.equal(policy.downloadName('lpt1'), '_lpt1');
  assert.equal(policy.downloadName('con.tar.gz'), '_con.tar.gz');
  assert.equal(policy.downloadName('  .hidden. '), 'hidden');
  assert.equal(policy.downloadName('bad\u0000name\u202e.txt'), 'badname.txt');
  assert.equal(policy.downloadName('', 'https://example.com/files/My%20Doc.pdf?x=1'), 'My Doc.pdf');
  assert.equal(policy.downloadName('', 'https://example.com/'), 'download');
  assert.equal(policy.downloadName(null, 'not a url'), 'download');
  const long = policy.downloadName(`${'x'.repeat(400)}.jpeg`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.jpeg'));
});

test('download names are made unique in their folder', () => {
  const taken = new Set(['a.txt', 'a (1).txt', 'b']);
  assert.equal(policy.uniqueName('a.txt', name => taken.has(name)), 'a (2).txt');
  assert.equal(policy.uniqueName('b', name => taken.has(name)), 'b (1)');
  assert.equal(policy.uniqueName('c.txt', name => taken.has(name)), 'c.txt');
});

test('only documents, media and archives are opened from the downloads list', () => {
  for (const name of ['setup.exe', 'SETUP.EXE', 'x.msi', 'run.bat', 'a.ps1', 'b.vbs', 'c.js', 'd.lnk', 'e.hta', 'f.jar', 'g.reg', 'h.scr', 'disk.iso', 'noextension',
    // Windows types that run or fetch something, which a list of programs missed.
    'remote.rdp', 'notes.one', 'notes.onepkg', 'update.msu', 'kit.ppkg', 'box.wsb', 'look.theme', 'look.themepack', 'app.jnlp', 'app.xbap', 'sheet.slk', 'query.iqy',
    // Pages and pictures with script, macro-enabled Office files, an extension too long to be one.
    'page.html', 'page.htm', 'page.xhtml', 'image.svg', 'data.xml', 'letter.docm', 'book.xlsm', 'deck.pptm', 'addin.xlam', `x.${'a'.repeat(20)}`]) {
    assert.equal(policy.openableDownload(name), false, name);
  }
  for (const name of ['report.pdf', 'photo.JPG', 'song.mp3', 'notes.txt', 'data.csv', 'archive.zip', 'letter.docx', 'sheet.xlsx', 'film.mkv', 'backup.tar.gz', 'book.epub']) {
    assert.equal(policy.openableDownload(name), true, name);
  }
});

test('the browser\'s shortcuts are taken before the page; single keys never are', () => {
  const key = (k, mods = {}) => policy.shortcutFor({ type: 'keyDown', key: k, ...mods });
  assert.equal(key('l', { control: true }), 'focus-address');
  assert.equal(key('L', { control: true }), 'focus-address');
  assert.equal(key('t', { control: true }), 'new-tab');
  assert.equal(key('T', { control: true, shift: true }), 'reopen-tab');
  assert.equal(key('w', { control: true }), 'close-tab');
  assert.equal(key('Tab', { control: true }), 'next-tab');
  assert.equal(key('Tab', { control: true, shift: true }), 'previous-tab');
  assert.equal(key('r', { control: true }), 'reload');
  assert.equal(key('F5'), 'reload');
  assert.equal(key('F5', { shift: true }), 'hard-reload');
  assert.equal(key('ArrowLeft', { alt: true }), 'back');
  assert.equal(key('ArrowRight', { alt: true }), 'forward');
  assert.equal(key('f', { control: true }), 'find');
  assert.equal(key('=', { control: true }), 'zoom-in');
  assert.equal(key('+', { control: true, shift: true }), 'zoom-in');
  assert.equal(key('-', { control: true }), 'zoom-out');
  assert.equal(key('0', { control: true }), 'zoom-reset');
  assert.equal(key('l', { meta: true }), 'focus-address', 'Cmd on a Mac');
  assert.equal(key('F6'), 'focus-address');
  assert.equal(key('N', { control: true, shift: true }), 'new-private-tab');
  assert.equal(key('1', { control: true }), 'tab-1');
  assert.equal(key('8', { control: true }), 'tab-8');
  assert.equal(key('9', { control: true }), 'last-tab');
  assert.equal(key('d', { control: true }), 'bookmark');
  assert.equal(key('h', { control: true }), 'history');
  assert.equal(key('j', { control: true }), 'downloads');
  assert.equal(key('p', { control: true }), 'print');
  assert.equal(key('n', { control: true }), null, 'no new windows');
  // Atmos's command bar: the \ | key (US \, UK's left of Z), with Shift too, Cmd on a Mac.
  assert.equal(key('\\', { control: true, code: 'Backslash' }), 'command-bar');
  assert.equal(key('\\', { control: true, code: 'IntlBackslash' }), 'command-bar');
  assert.equal(key('|', { control: true, shift: true, code: 'IntlBackslash' }), 'command-bar');
  assert.equal(key('Unidentified', { control: true, code: 'IntlBackslash' }), 'command-bar');
  assert.equal(key('\\', { meta: true }), 'command-bar');
  assert.equal(key('\\', { control: true, alt: true }), null, 'AltGr+\\ types a character');
  for (const single of [']', '[', '\\', 'Tab', ' ', 'Escape', 'a', 'ArrowLeft']) assert.equal(key(single), null, single);
  assert.equal(policy.shortcutFor({ type: 'keyUp', key: 't', control: true }), null);
  assert.equal(key('ArrowLeft', { alt: true, control: true }), null);
});

test('zoom steps like Chrome\'s', () => {
  assert.equal(policy.nextZoom(1, 'in'), 1.1);
  assert.equal(policy.nextZoom(1, 'out'), 0.9);
  assert.equal(policy.nextZoom(1.1, 'in'), 1.25);
  assert.equal(policy.nextZoom(5, 'in'), 5);
  assert.equal(policy.nextZoom(0.25, 'out'), 0.25);
  assert.equal(policy.nextZoom(1.7, 'reset'), 1);
  assert.equal(policy.nextZoom(1.12, 'out'), 1.1, 'from between two steps');
  assert.equal(policy.nextZoom(NaN, 'in'), 1.1);
});

test('a <webview> attaches only from the Atmos page, in a browser partition, blank, with fixed preferences', () => {
  const attach = (params, fromAtmosPage = true) => policy.webviewAttachment({ fromAtmosPage, params });
  const ok = attach({ partition: 'persist:atmos-browser', src: 'about:blank' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.webPreferences, { ...policy.WEB_PREFERENCES, partition: 'persist:atmos-browser' });
  assert.equal(attach({ partition: 'atmos-browser-private' }).ok, true);
  assert.equal(attach({ partition: 'persist:atmos-browser' }, false).ok, false);
  assert.equal(attach({ src: 'about:blank' }).ok, false, 'the default session is Atmos\'s own');
  assert.equal(attach({ partition: 'persist:elsewhere', src: 'about:blank' }).ok, false);
  assert.equal(attach({ partition: 'persist:atmos-browser', src: 'https://example.com/' }).ok, false, 'Core navigates it afterwards');
  assert.equal(attach({ partition: 'persist:atmos-browser', src: 'file:///etc/passwd' }).ok, false);
  const sneaky = attach({
    partition: 'persist:atmos-browser', src: 'about:blank', preload: 'file:///evil.js', nodeintegration: '', webpreferences: 'sandbox=no',
    disablewebsecurity: '', allowpopups: '', useragent: 'Electron', plugins: '', enableblinkfeatures: 'X',
  });
  assert.equal(sneaky.ok, true);
  assert.deepEqual(Object.keys(sneaky.params).sort(), ['partition', 'src']);
  assert.equal(sneaky.webPreferences.sandbox, true);
  assert.equal(sneaky.webPreferences.nodeIntegration, false);
  assert.equal(sneaky.webPreferences.preload, undefined);
});

test('a site icon in a data: address: its bytes, image types only, bounded', () => {
  const png = policy.imageDataUrlBytes('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(png.type, 'image/png');
  assert.deepEqual([...png.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const svg = policy.imageDataUrlBytes('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E');
  assert.equal(svg.type, 'image/svg+xml');
  assert.equal(svg.bytes.toString(), '<svg></svg>');
  assert.equal(policy.imageDataUrlBytes('data:text/html;base64,PGgxPg=='), null);
  assert.equal(policy.imageDataUrlBytes('https://example.com/favicon.ico'), null);
  assert.equal(policy.imageDataUrlBytes('data:image/png;base64,'), null, 'empty');
  assert.equal(policy.imageDataUrlBytes(`data:image/png;base64,${Buffer.alloc(300 * 1024).toString('base64')}`), null, 'too large');
  assert.equal(policy.imageDataUrlBytes('data:image/png,%E0%A4%A'), null, 'bad percent-encoding');
});

test('what the icon decoder returns is only ever 32×32 pixels, premultiplied BGRA for Core', () => {
  assert.equal(policy.ICON_SIZE, 32);
  assert.ok(!policy.PARTITIONS.includes(policy.ICON_PARTITION), 'no page attaches in the decoder\'s session');
  assert.equal(policy.iconBitmap(Buffer.alloc(31 * 32 * 4)), null);
  assert.equal(policy.iconBitmap('not a buffer'), null);
  const rgba = Buffer.alloc(32 * 32 * 4);
  rgba.set([200, 100, 50, 255], 0);   // opaque orange
  rgba.set([200, 100, 50, 128], 4);   // half see-through
  const bgra = policy.iconBitmap(rgba);
  assert.deepEqual([...bgra.subarray(0, 4)], [50, 100, 200, 255]);
  assert.deepEqual([...bgra.subarray(4, 8)], [25, 50, 100, 128]);
  assert.deepEqual([...bgra.subarray(8, 12)], [0, 0, 0, 0]);
});

test('automatic https: plain http to a public name on its usual port, unless found to have none', () => {
  assert.equal(policy.httpsUpgrade('http://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(policy.httpsUpgrade('http://Example.COM./'), 'https://example.com./');
  for (const url of ['https://example.com/', 'http://example.com:8080/', 'http://user:pw@example.com/', 'http://localhost/', 'http://printer.local/',
    'http://router/', 'http://192.168.1.1/', 'http://[::1]/', 'http://alpha.test/', 'ftp://example.com/', 'not a url']) {
    assert.equal(policy.httpsUpgrade(url), null, url);
  }
  assert.equal(policy.httpsUpgrade('http://old.example/', new Set(['old.example'])), null, 'a site without https stays http');
});

test('insecure downloads: a secure page\'s download over plain http, redirects included', () => {
  assert.equal(policy.insecureDownload(['http://files.example/a.zip'], 'https://site.example/'), true);
  assert.equal(policy.insecureDownload(['https://cdn.example/a', 'http://files.example/a.zip'], 'https://site.example/'), true, 'a hop over http');
  assert.equal(policy.insecureDownload(['https://files.example/a.zip'], 'https://site.example/'), false);
  assert.equal(policy.insecureDownload(['http://files.example/a.zip'], 'http://site.example/'), false, 'an http page: Chrome only warns there');
  assert.equal(policy.insecureDownload(['http://localhost:3000/a.zip'], 'https://site.example/'), false, 'your own machine');
  assert.equal(policy.insecureDownload(['blob:https://site.example/1', 'data:text/plain,hi'], 'https://site.example/'), false);
});

test('automatic https falls back on connection and certificate errors, not when the network is out', () => {
  for (const code of [-100, -101, -102, -107, -113, -118, -200, -201, -202]) assert.equal(policy.httpsFallbackError(code), true, String(code));
  for (const code of [-3, -20, -21, -105, -106, -109, -137, -300, -310]) assert.equal(policy.httpsFallbackError(code), false, String(code));
});

test('insecure downloads: an address Atmos upgraded to https wasn\'t fetched over http', () => {
  assert.equal(policy.insecureDownload(['http://cdn.example/f.zip', 'https://cdn.example/f.zip'], 'https://site.example/'), false);
  assert.equal(policy.insecureDownload(['http://cdn.example/f.zip', 'https://cdn.example/f.zip', 'http://other.example/f.zip'], 'https://site.example/'), true);
});

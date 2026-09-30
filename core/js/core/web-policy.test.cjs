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

test('every page runs sandboxed, isolated, with web security and no Node or preload', () => {
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
  assert.equal(prefs.preload, undefined);
  // A page with no background of its own isn't see-through to Atmos.
  assert.equal(prefs.transparent, false);
});

test('a Chrome user agent, with no Electron or Atmos in it', () => {
  const windows = policy.chromeUserAgent('win32', '152.0.7890.12');
  assert.equal(windows, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
  assert.match(policy.chromeUserAgent('darwin', '152.1'), /\(Macintosh; Intel Mac OS X 10_15_7\).*Chrome\/152\.0\.0\.0/);
  assert.match(policy.chromeUserAgent('linux', '152.1'), /\(X11; Linux x86_64\)/);
  for (const ua of [windows, policy.chromeUserAgent()]) assert.doesNotMatch(ua, /electron|atmos/i);
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
  for (const name of ['midi', 'midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'idle-detection', 'openExternal', 'pointerLock', 'keyboardLock', 'storage-access', 'window-management', 'unknown']) {
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

test('programs and scripts are never opened from the downloads list', () => {
  for (const name of ['setup.exe', 'SETUP.EXE', 'x.msi', 'run.bat', 'a.ps1', 'b.vbs', 'c.js', 'd.lnk', 'e.hta', 'f.jar', 'g.reg', 'h.scr', 'disk.iso', 'noextension']) {
    assert.equal(policy.openableDownload(name), false, name);
  }
  for (const name of ['report.pdf', 'photo.JPG', 'song.mp3', 'notes.txt', 'data.csv', 'archive.zip']) {
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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installChromeMembers, applyFilters, SCRIPTLET_WORLD, SCRIPTLET_WORLD_CSP } = require('./web-page-preload.cjs');

// The page's location, which loadTimes() reads (Node has none).
globalThis.location = { protocol: 'https:' };

/** Run the preload's page-world function against a window like Electron's (an empty, redefinable window.chrome). */
function page({ chrome = {} } = {}) {
  const win = {};
  Object.defineProperty(win, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: true });
  const saved = globalThis.window;
  globalThis.window = win;
  try { installChromeMembers(); } finally { globalThis.window = saved; }
  return win;
}

test('window.chrome gets Chrome\'s members, in Chrome\'s order, with its attributes', () => {
  const win = page();
  const chrome = win.chrome;
  assert.deepEqual(Object.keys(chrome), ['loadTimes', 'csi', 'app']);
  for (const key of Object.keys(chrome)) {
    const own = Object.getOwnPropertyDescriptor(chrome, key);
    assert.deepEqual([own.writable, own.enumerable, own.configurable], [true, true, true], key);
  }
  // Like Chrome's: window.chrome itself can't be redefined.
  const own = Object.getOwnPropertyDescriptor(win, 'chrome');
  assert.deepEqual([own.writable, own.enumerable, own.configurable], [true, true, false]);
  // loadTimes and csi: anonymous functions with a prototype, as Chrome's.
  for (const fn of [chrome.loadTimes, chrome.csi]) {
    assert.equal(fn.name, '');
    assert.equal(fn.length, 0);
    assert.ok('prototype' in fn);
  }
});

test('chrome.app: a page that isn\'t an installed app', () => {
  const { app } = page().chrome;
  assert.deepEqual(Object.keys(app), ['isInstalled', 'getDetails', 'getIsInstalled', 'installState', 'runningState', 'InstallState', 'RunningState']);
  assert.equal(app.isInstalled, false);
  assert.equal(app.getDetails(), null);
  assert.equal(app.getIsInstalled(), false);
  assert.equal(app.runningState(), 'cannot_run');
  assert.deepEqual(app.InstallState, { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' });
  assert.deepEqual(app.RunningState, { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' });
  assert.throws(() => app.getDetails(1), { name: 'TypeError', message: 'Error in invocation of app.getDetails(): ' });
  // Methods: named, no declared parameters, no prototype.
  for (const name of ['getDetails', 'getIsInstalled', 'installState', 'runningState']) {
    assert.equal(app[name].name, name);
    assert.equal(app[name].length, 0);
    assert.ok(!('prototype' in app[name]), name);
  }
});

test('chrome.app.installState answers its callback', async () => {
  const { app } = page().chrome;
  assert.equal(await new Promise(resolve => app.installState(resolve)), 'not_installed');
  assert.doesNotThrow(() => app.installState());
});

test('chrome.loadTimes() and chrome.csi() report on the page, in Chrome\'s shape', () => {
  const { loadTimes, csi } = page().chrome;
  const times = loadTimes();
  assert.deepEqual(Object.keys(times), ['requestTime', 'startLoadTime', 'commitLoadTime', 'finishDocumentLoadTime', 'finishLoadTime',
    'firstPaintTime', 'firstPaintAfterLoadTime', 'navigationType', 'wasFetchedViaSpdy', 'wasNpnNegotiated', 'npnNegotiatedProtocol',
    'wasAlternateProtocolAvailable', 'connectionInfo']);
  assert.equal(times.requestTime, Math.floor(performance.timeOrigin) / 1000);
  assert.equal(times.navigationType, 'Other');
  const report = csi();
  assert.deepEqual(Object.keys(report), ['startE', 'onloadT', 'pageT', 'tran']);
  assert.equal(report.startE, Math.floor(performance.timeOrigin));
  assert.equal(report.tran, 15);
  assert.ok(report.pageT >= 0);
});

test('members a page already has are left as they are', () => {
  const own = { app: 'mine' };
  const chrome = page({ chrome: own }).chrome;
  assert.equal(chrome, own);
  assert.deepEqual(Object.keys(chrome), ['app']);
});

test('the blocker\'s scriptlets: the page\'s world, then a world of their own with a policy of its own', () => {
  const calls = [];
  const webFrame = {
    insertCSS: (css, options) => calls.push(['css', css, options.cssOrigin]),
    executeJavaScript: code => { calls.push(['main', code]); return Promise.resolve(); },
    setIsolatedWorldInfo: (id, info) => calls.push(['world', id, info]),
    executeJavaScriptInIsolatedWorld: (id, sources) => { calls.push(['isolated', id, sources]); return Promise.resolve(); },
  };
  const ipcRenderer = { sendSync: () => ({ styles: '.ad{display:none}', scripts: ['main();'], isolated: ['isolated();', 7, ''], watch: false }) };
  applyFilters({ ipcRenderer, webFrame }, { origin: 'https://www.youtube.com' });
  assert.deepEqual(calls, [
    ['css', '.ad{display:none}', 'user'],
    ['main', 'main();'],
    ['world', SCRIPTLET_WORLD, { securityOrigin: 'https://www.youtube.com', csp: SCRIPTLET_WORLD_CSP, name: 'Atmos Browser: ad blocker' }],
    ['isolated', SCRIPTLET_WORLD, [{ code: 'isolated();' }]],
  ]);
  assert.notEqual(SCRIPTLET_WORLD, 999, 'not Electron\'s own world, where the preload runs');
  assert.doesNotMatch(SCRIPTLET_WORLD_CSP, /trusted-types/, 'the page\'s Trusted Types rules don\'t follow it there');
  // Nothing for the world when a page has no isolated scriptlets.
  calls.length = 0;
  applyFilters({ ipcRenderer: { sendSync: () => ({ styles: '', scripts: [], isolated: [] }) }, webFrame }, { origin: 'https://a.test' });
  assert.deepEqual(calls, []);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installChromeMembers } = require('./web-page-preload.cjs');

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

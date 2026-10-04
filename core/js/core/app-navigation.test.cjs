'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const nav = require('./app-navigation.cjs');

test('isAppUrl: the Atmos page and nothing that only starts like it', () => {
  for (const url of ['atmos-app://local', 'atmos-app://local/', 'atmos-app://local/index.html', 'atmos-app://local/__atmos/storage.html']) {
    assert.equal(nav.isAppUrl(url), true, url);
  }
  for (const url of ['atmos-app://localhost/', 'atmos-app://local.evil/', 'atmos-app://locals', 'atmos-app://other/', 'atmos-ext://local/',
    'https://local/', 'ATMOS-APP://LOCAL/', ' atmos-app://local/', '', null, undefined, 42, {}]) {
    assert.equal(nav.isAppUrl(url), false, String(url));
  }
});

test('originOf: scheme and host (with port), or null', () => {
  assert.equal(nav.originOf('atmos-ext://plugin-finance/plugins/finance/panel.js'), 'atmos-ext://plugin-finance');
  assert.equal(nav.originOf('https://example.com:8443/a?b#c'), 'https://example.com:8443');
  assert.equal(nav.originOf('https://user:pw@example.com/'), 'https://example.com');
  assert.equal(nav.originOf('not a url'), null);
  assert.equal(nav.originOf(''), null);
});

test('mayOpenExternally: http, https and mailto only', () => {
  for (const url of ['https://example.com/', 'http://example.com/', 'mailto:a@example.com', 'HTTPS://EXAMPLE.COM/']) {
    assert.equal(nav.mayOpenExternally(url), true, url);
  }
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'search-ms:query=x', 'smb://host/share',
    'atmos-app://local/', 'atmos-ext://plugin-x/', 'data:text/html,x', 'vbscript:x', 'not a url', '', null, undefined]) {
    assert.equal(nav.mayOpenExternally(url), false, String(url));
  }
});

test('frameNavigationAllowed: Core moves frames anywhere in atmos-ext; a frame only within its own origin', () => {
  const main = { origin: 'atmos-app://local' };
  const frame = { origin: 'atmos-ext://plugin-finance' };
  const target = 'atmos-ext://plugin-finance/plugins/finance/panel.html';
  // Core: no initiator, or the page's main frame.
  assert.equal(nav.frameNavigationAllowed(target, null, main), true);
  assert.equal(nav.frameNavigationAllowed(target, undefined, main), true);
  assert.equal(nav.frameNavigationAllowed('atmos-ext://service-x/a', main, main), true);
  // The frame itself, within its origin.
  assert.equal(nav.frameNavigationAllowed(target, frame, main), true);
  // …but not to another extension's origin, the web or Atmos itself.
  assert.equal(nav.frameNavigationAllowed('atmos-ext://plugin-weather/plugins/weather/panel.html', frame, main), false);
  assert.equal(nav.frameNavigationAllowed('atmos-ext://plugin-finance.evil/x', frame, main), false);
  assert.equal(nav.frameNavigationAllowed('https://example.com/', frame, main), false);
  assert.equal(nav.frameNavigationAllowed('atmos-app://local/', frame, main), false);
  // Even Core never sends a frame outside atmos-ext.
  assert.equal(nav.frameNavigationAllowed('https://example.com/', null, main), false);
  assert.equal(nav.frameNavigationAllowed('atmos-app://local/', main, main), false);
  assert.equal(nav.frameNavigationAllowed('javascript:alert(1)', null, main), false);
  // An initiator that is a different object from the main frame is a frame, whatever its origin says.
  assert.equal(nav.frameNavigationAllowed('atmos-ext://service-x/a', { origin: 'atmos-app://local' }, main), false);
  // A frame with no origin (opaque, sandboxed) can't navigate anywhere.
  assert.equal(nav.frameNavigationAllowed(target, { origin: '' }, main), false);
  assert.equal(nav.frameNavigationAllowed(target, { origin: null }, main), false);
  assert.equal(nav.frameNavigationAllowed(null, null, main), false);
});

function fakeContents() {
  const contents = new EventEmitter();
  contents.mainFrame = { origin: 'atmos-app://local' };
  contents.setWindowOpenHandler = fn => { contents.openHandler = fn; };
  return contents;
}

function guarded() {
  const contents = fakeContents();
  const opened = [];
  const warned = [];
  const attached = [];
  nav.guardContents(contents, {
    openExternally: url => opened.push(url),
    attachWebview: (...args) => attached.push(args),
    warn: (...args) => warned.push(args.join(' ')),
  });
  return { contents, opened, warned, attached };
}

test('guardContents: window.open is always refused, and handed on to open outside', () => {
  const { contents, opened } = guarded();
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'atmos-app://local/' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/', 'atmos-app://local/']);
});

test('guardContents: the page stays on atmos-app; a link elsewhere is handed on, not followed', () => {
  const { contents, opened } = guarded();
  const navigate = url => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit('will-navigate', event, url);
    return event.prevented;
  };
  assert.equal(navigate('atmos-app://local/index.html'), false);
  assert.equal(navigate('https://example.com/'), true);
  assert.equal(navigate('atmos-ext://plugin-finance/x'), true);
  assert.equal(navigate('file:///etc/passwd'), true);
  assert.deepEqual(opened, ['https://example.com/', 'atmos-ext://plugin-finance/x', 'file:///etc/passwd']);
});

test('guardContents: frame navigations are checked; the main frame\u2019s are left to will-navigate', () => {
  const { contents, warned } = guarded();
  const frameNavigate = (url, initiator, isMainFrame = false) => {
    const details = { url, initiator, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit('will-frame-navigate', details);
    return details.prevented;
  };
  assert.equal(frameNavigate('atmos-ext://plugin-finance/a', contents.mainFrame), false);
  assert.equal(frameNavigate('atmos-ext://plugin-finance/b', { origin: 'atmos-ext://plugin-finance' }), false);
  assert.equal(frameNavigate('atmos-ext://plugin-weather/a', { origin: 'atmos-ext://plugin-finance' }), true);
  assert.equal(frameNavigate('https://example.com/', undefined), true);
  assert.equal(frameNavigate('https://example.com/', undefined, true), false);
  assert.equal(warned.length, 2);
  assert.match(warned[0], /blocked frame navigation to atmos-ext:\/\/plugin-weather/);
});

test('guardContents: <webview>s are left to the web host\u2019s decision', () => {
  const { contents, attached } = guarded();
  const event = {};
  contents.emit('will-attach-webview', event, { nodeIntegration: true }, { src: 'https://example.com/' });
  assert.equal(attached.length, 1);
  assert.equal(attached[0][0], contents);
  assert.equal(attached[0][1], event);
});

test('guardContents: the page\u2019s main frame is the one at the time of the navigation', () => {
  const { contents } = guarded();
  const before = contents.mainFrame;
  contents.mainFrame = { origin: 'atmos-app://local' }; // a reload gives the page a new main frame
  const details = { url: 'atmos-ext://service-x/a', initiator: before, isMainFrame: false, prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-frame-navigate', details);
  assert.equal(details.prevented, true);
  const fromNow = { ...details, initiator: contents.mainFrame, prevented: false };
  contents.emit('will-frame-navigate', fromNow);
  assert.equal(fromNow.prevented, false);
});

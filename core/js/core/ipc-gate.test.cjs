'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fromAtmosPage, pageOnly, APP_PREFIX } = require('./ipc-gate.cjs');

const ATMOS = `${APP_PREFIX}index.html`;
const atmosSession = { name: 'default' };
const webSession = { name: 'persist:atmos-browser' };
const isWebSession = session => session === webSession;

/** An IPC event as Electron gives one: the sender's contents and frame. */
function event({ url = ATMOS, frameUrl = url, session = atmosSession, noFrame = false } = {}) {
  return { sender: { session, getURL: () => url }, senderFrame: noFrame ? null : { url: frameUrl } };
}

test('only the Atmos page itself: not an extension\'s frame, not a web page, whatever it claims', () => {
  const allowed = e => fromAtmosPage(e, { isWebSession });
  assert.equal(allowed(event()), true);
  // Its last messages as it unloads, its frame already gone: its contents' address.
  assert.equal(allowed(event({ noFrame: true })), true);
  assert.equal(allowed(event({ frameUrl: 'atmos-ext://first-party-plugin-browser/__atmos/frame.html' })), false, 'an extension\'s frame');
  assert.equal(allowed(event({ frameUrl: 'about:blank' })), false, 'a blank frame of the page');
  assert.equal(allowed(event({ url: 'https://example.com/', session: webSession })), false, 'a tab');
  // A page whose renderer was taken over can claim any frame address; its session it can't.
  assert.equal(allowed(event({ url: 'https://example.com/', frameUrl: ATMOS, session: webSession })), false);
  assert.equal(allowed(event({ url: ATMOS, session: webSession })), false);
  assert.equal(allowed(event({ url: 'https://example.com/' })), false);
  assert.equal(allowed(event({ url: 'atmos-app://local.evil/', noFrame: true })), false);
  assert.equal(allowed({}), false);
  assert.equal(allowed({ sender: { getURL() { throw new Error('destroyed'); } } }), false);
});

test('handle() rejects and on() drops a refused sender; a refused sendSync still gets an answer', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(`handle ${channel}`, fn),
    on: (channel, fn) => handlers.set(`on ${channel}`, fn),
  };
  const page = pageOnly(ipcMain, e => fromAtmosPage(e, { isWebSession }));
  const ran = [];
  page.handle('capture', (e, rect) => { ran.push(['capture', rect]); return 'image'; });
  page.on('close', () => ran.push(['close']));
  page.on('save-sync', e => { e.returnValue = true; }, { refused: false });
  const tab = () => event({ url: 'https://example.com/', session: webSession });

  assert.equal(await handlers.get('handle capture')(event(), { x: 1 }), 'image');
  assert.throws(() => handlers.get('handle capture')(tab(), { x: 1 }), /Not allowed/);
  handlers.get('on close')(tab());
  handlers.get('on close')(event());
  const refused = tab();
  handlers.get('on save-sync')(refused);
  assert.equal(refused.returnValue, false);
  const accepted = event();
  handlers.get('on save-sync')(accepted);
  assert.equal(accepted.returnValue, true);
  const dropped = tab();
  handlers.get('on close')(dropped);
  assert.equal('returnValue' in dropped, false, 'an ordinary message gets nothing back');
  assert.deepEqual(ran, [['capture', { x: 1 }], ['close']]);
});

test('main.js registers every channel through the gate, and the window controls among them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  const direct = [...source.matchAll(/ipcMain\s*\.\s*(handle|handleOnce|on|once|addListener|prependListener)\s*\(/g)];
  assert.deepEqual(direct.map(match => match[0]), [], 'no ipcMain registration outside ipc-gate.cjs');
  assert.match(source, /const _page = pageOnly\(ipcMain, event => _fromAtmosPage\(event\)\);/);
  const channels = new Set([...source.matchAll(/_page\.(?:handle|on)\('([^']+)'/g)].map(match => match[1]));
  for (const name of [...source.matchAll(/_managerHandler\('([^']+)'/g)].map(match => match[1])) channels.add(`extensions:${name}`);
  for (const channel of [
    'toggle-fullscreen', 'app:version', 'is-fullscreen', 'is-maximized', 'task-view:capture-preview', 'window-effects:get', 'window-effects:set-transparent',
    'win-minimize', 'win-maximize', 'win-close', 'set-window-click-through', 'window-resize:start', 'window-resize:update', 'window-resize:end',
    'plugins:list', 'services:list', 'extension-state:load-all', 'extension-state:save', 'extension-state:save-sync', 'extensions:set-enabled',
    'extensions:approve', 'extensions:revoke', 'extensions:restart', 'extensions:notify', 'extensions:open-link', 'extensions:fetch', 'extensions:fetch-abort',
    'extensions:open-root', 'extensions:manager-status', 'extensions:install', 'location:allow-detect',
  ]) {
    assert.ok(channels.has(channel), `${channel} goes through the gate`);
  }
  // Every channel the Atmos page's preload uses is one of them, or Core's
  // web host's (its own gate), or an extension's (extension-host.cjs).
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\('([^']+)'/g)].map(match => match[1]);
  const web = fs.readFileSync(path.join(__dirname, 'web-host.cjs'), 'utf8');
  const webChannels = new Set([...web.matchAll(/handle\('(web:[^']+)'/g)].map(match => match[1]));
  for (const channel of used) assert.ok(channels.has(channel) || webChannels.has(channel), `${channel} (used by the page) is gated`);
});

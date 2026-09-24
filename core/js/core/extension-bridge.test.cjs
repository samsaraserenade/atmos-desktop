'use strict';
// The Core side of the Atmos SDK, driven directly with fake Core services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadBridge(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, 'extension-bridge.js'), path.join(dir, 'extension-bridge.js'));
  return import(pathToFileURL(path.join(dir, 'extension-bridge.js')).href);
}

function harness(createExtensionBridge, { extension = {}, surface = { type: 'panel' }, deps = {} } = {}) {
  const posted = [];
  const bridge = createExtensionBridge({
    extension: { id: 'probe', kind: 'plugin', tier: 'first-party', permissions: {}, ...extension },
    surface,
    post: message => posted.push(message),
    deps: { services: new Map(), ...deps },
  });
  let id = 0;
  const request = async (method, ...args) => {
    const reply = ++id;
    await bridge.receive({ id: reply, method, args });
    return posted.find(message => message.reply === reply);
  };
  return { bridge, posted, request };
}

test('main-process events: own and declared extensions only, forwarded and cleaned up', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const listeners = new Map();
  const onMain = (kind, id, channel, fn) => {
    const key = `${kind}:${id} ${channel}`;
    listeners.set(key, fn);
    return () => listeners.delete(key);
  };
  const { bridge, posted, request } = harness(createExtensionBridge, {
    extension: { permissions: { invokes: ['service:other'] } },
    deps: { onMain },
  });

  assert.equal((await request('main.subscribe', 'plugin:probe', 'progress')).error, undefined);
  assert.equal((await request('main.subscribe', 'service:other', 'ready')).error, undefined);
  const denied = await request('main.subscribe', 'plugin:notes', 'anything');
  assert.equal(denied.error.name, 'AtmosPermissionError');
  const badChannel = await request('main.subscribe', 'plugin:probe', '../x');
  assert.equal(badChannel.error.name, 'TypeError');
  assert.deepEqual([...listeners.keys()].sort(), ['plugin:probe progress', 'service:other ready']);

  listeners.get('plugin:probe progress')(1, { done: false });
  assert.deepEqual(posted.at(-1), { topic: 'main:plugin:probe progress', payload: [1, { done: false }] });

  await bridge.receive({ method: 'main.unsubscribe', args: ['service:other', 'ready'] });
  assert.deepEqual([...listeners.keys()], ['plugin:probe progress']);
  bridge.dispose();
  assert.equal(listeners.size, 0, 'a closed frame stops listening');
});

test('legacy localStorage: declared keys only, first-party only', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const readLegacyLocalStorage = keys => Object.fromEntries(keys.map(key => [key, key === 'a' ? '1' : null]));
  const manifest = { legacyStorage: { localStorage: ['a', 'b'] } };
  const { request } = harness(createExtensionBridge, { extension: { manifest }, deps: { readLegacyLocalStorage } });
  assert.deepEqual((await request('legacy.readLocalStorage', ['a', 'b'])).result, { a: '1', b: null });
  assert.equal((await request('legacy.readLocalStorage', ['a', 'secret'])).error.name, 'AtmosPermissionError');
  const prefixed = harness(createExtensionBridge, {
    extension: { manifest: { legacyStorage: { localStorage: ['app_recovery_*', 'x*y*', '*'] } } },
    deps: { readLegacyLocalStorage: keys => ({ asked: keys }) },
  });
  assert.deepEqual((await prefixed.request('legacy.readLocalStorage', ['app_recovery_*'])).result, { asked: ['app_recovery_*'] });
  assert.equal((await prefixed.request('legacy.readLocalStorage', ['x*y*'])).error.name, 'AtmosPermissionError', 'only a trailing *');
  assert.equal((await prefixed.request('legacy.readLocalStorage', ['*'])).error.name, 'AtmosPermissionError', 'no match-everything prefix');
  const thirdParty = harness(createExtensionBridge, { extension: { manifest, tier: 'third-party' }, deps: { readLegacyLocalStorage } });
  assert.equal((await thirdParty.request('legacy.readLocalStorage', ['a'])).error.name, 'AtmosPermissionError');
});

test('wallpaper: needs the Wallpaper service declared, and an image to set', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const set = [];
  const listeners = [];
  const deps = { wallpaper: {
    set: file => { set.push(file.type); },
    get: async () => ({ mode: 'wallpaper', opacity: 100, thumbnail: 'data:image/jpeg;base64,x' }),
    subscribe: fn => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
  } };
  const allowed = harness(createExtensionBridge, { extension: { permissions: { invokes: ['service:wallpaper'] } }, deps });
  assert.equal((await allowed.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error, undefined);
  assert.equal((await allowed.request('wallpaper.set', new Blob(['x'], { type: 'text/html' }))).error.name, 'TypeError');
  assert.equal((await allowed.request('wallpaper.get')).result.mode, 'wallpaper');
  await allowed.request('wallpaper.subscribe');
  await allowed.request('wallpaper.subscribe');
  assert.equal(listeners.length, 1);
  listeners[0]({ mode: 'transparent' });
  assert.deepEqual(allowed.posted.at(-1), { topic: 'wallpaper', payload: { mode: 'transparent' } });
  allowed.bridge.dispose();
  assert.equal(listeners.length, 0);

  const denied = harness(createExtensionBridge, { deps });
  assert.equal((await denied.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error.name, 'AtmosPermissionError');
  assert.equal((await denied.request('wallpaper.get')).error.name, 'AtmosPermissionError');
  // The old Background id no longer grants anything.
  const old = harness(createExtensionBridge, { extension: { permissions: { invokes: ['plugin:background'] } }, deps });
  assert.equal((await old.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error.name, 'AtmosPermissionError');
  assert.deepEqual(set, ['image/png']);
});

test('audio: own channel only, declared service, sources limited to Blobs and declared providers', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  let watched = 0;
  const channel = {
    load: (source, options) => { calls.push(['load', source instanceof Blob ? 'blob' : source, options]); return { source: options.id }; },
    play: async () => { calls.push(['play']); return true; },
    pause: () => calls.push(['pause']),
    seek: value => calls.push(['seek', value]),
    setVolume: value => calls.push(['volume', value]),
    stop: () => calls.push(['stop']),
    state: () => ({ playing: false }),
  };
  const deps = { audio: { channel: () => channel, watch: () => { watched++; } } };
  const { request } = harness(createExtensionBridge, {
    extension: { permissions: { invokes: ['service:audio'] }, frame: { resourceProviders: ['audio-player-media'] } },
    deps,
  });
  assert.equal((await request('audio.load', 'atmos-resource://audio-player-media/C:/Music/a.mp3', { id: 'k1', position: 12, play: true, extra: 1 })).result.source, 'k1');
  assert.equal((await request('audio.load', new Blob(['x'], { type: 'audio/mpeg' }))).error, undefined);
  assert.equal((await request('audio.load', 'atmos-resource://media-library/secret')).error.name, 'TypeError');
  assert.equal((await request('audio.load', 'https://example.com/a.mp3')).error.name, 'TypeError');
  assert.equal((await request('audio.load', 'file:///etc/passwd')).error.name, 'TypeError');
  assert.equal((await request('audio.play')).result, true);
  await request('audio.pause');
  await request('audio.seek', 30);
  assert.equal((await request('audio.seek', 'x')).error.name, 'TypeError');
  await request('audio.volume', 0.5);
  await request('audio.stop');
  await request('audio.subscribe');
  assert.equal(watched, 1);
  assert.deepEqual(calls, [
    ['load', 'atmos-resource://audio-player-media/C:/Music/a.mp3', { id: 'k1', position: 12, play: true }],
    ['load', 'blob', { id: null, position: 0, play: false }],
    ['play'], ['pause'], ['seek', 30], ['volume', 0.5], ['stop'],
  ]);

  const undeclared = harness(createExtensionBridge, { deps });
  assert.equal((await undeclared.request('audio.play')).error.name, 'AtmosPermissionError');
  assert.equal((await undeclared.request('audio.subscribe')).error.name, 'AtmosPermissionError');
});

test('menus: controls report every change, plain rows once; only known fields cross', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let opened = null;
  const deps = {
    openMenu: (x, y, items, onChange) => {
      opened = items;
      onChange({ id: 'size', value: 120 });
      onChange({ id: 'size', value: 124 });
      return Promise.resolve('play');
    },
  };
  const { request, posted } = harness(createExtensionBridge, { deps });
  const reply = await request('contextMenu.open', 10, 20, [
    { id: 'play', label: 'Play', icon: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', onclick: 'x' },
    { id: 'labels', label: 'Labels', type: 'toggle', checked: true },
    { id: 'size', label: 'Size', type: 'range', min: 60, max: 180, step: 4, value: 160, suffix: 'px', zeroLabel: 'Off', format: 'x' },
    { id: 'fps', label: 'Rate', type: 'number', min: 1, max: 1000, value: 'nope' },
    { id: 'grad', label: 'Gradient', type: 'colors', values: ['#ff0000', 'javascript:alert(1)'] },
    { id: 'evil', label: 'Evil', type: 'html' },
  ]);
  assert.equal(reply.result, 'play');
  assert.deepEqual(opened.map(item => item.id), ['play', 'labels', 'size', 'fps', 'grad']);
  assert.equal(opened[0].onclick, undefined);
  assert.equal(opened[0].icon.startsWith('<svg'), true);
  assert.equal(opened[1].checked, true);
  assert.deepEqual([opened[2].min, opened[2].max, opened[2].step, opened[2].value, opened[2].suffix, opened[2].zeroLabel, opened[2].format], [60, 180, 4, 160, 'px', 'Off', undefined]);
  assert.equal(opened[3].value, 1);
  assert.deepEqual(opened[4].values, ['#ff0000', '#ffffff']);
  assert.deepEqual(posted.filter(message => message.topic === 'menu').map(message => message.payload), [
    { id: 'size', value: 120 }, { id: 'size', value: 124 }, 'play',
  ]);
});
test('menus: a button row carries plain buttons, and the chosen button\'s id comes back', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let opened = null;
  const { request, posted } = harness(createExtensionBridge, {
    deps: { openMenu: (x, y, items) => { opened = items; return Promise.resolve('react-2'); } },
  });
  const reply = await request('contextMenu.open', 0, 0, [{
    id: 'react', type: 'buttons', onclick: 'x',
    buttons: [{ id: 'react-1', label: '👍', onclick: 'x' }, { id: 'react-2', label: '❤️', title: 'Love', icon: '<svg/>' }],
  }]);
  assert.equal(reply.result, 'react-2');
  assert.equal(opened[0].onclick, undefined);
  assert.deepEqual(opened[0].buttons, [{ id: 'react-1', label: '👍' }, { id: 'react-2', label: '❤️', title: 'Love', icon: '<svg/>' }]);
  assert.equal(posted.filter(message => message.topic === 'menu').at(-1).payload, 'react-2');
});

test('clipboard: text or a PNG, written by the page', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const written = [];
  const { request } = harness(createExtensionBridge, { deps: { clipboardWrite: data => { written.push(data); } } });
  assert.equal((await request('clipboard.write', { text: 'C:/Music/a.flac' })).error, undefined);
  const png = new Blob([new Uint8Array([137, 80])], { type: 'image/png' });
  assert.equal((await request('clipboard.write', { image: png })).error, undefined);
  assert.equal((await request('clipboard.write', { image: new Blob(['x'], { type: 'image/gif' }) })).error.name, 'TypeError');
  assert.equal((await request('clipboard.write', {})).error.name, 'TypeError');
  assert.equal((await request('clipboard.write', { text: 42 })).error.name, 'TypeError');
  assert.deepEqual(written.map(entry => [entry.text, entry.image?.type ?? null]), [['C:/Music/a.flac', null], [null, 'image/png']]);
});

test('sidebar header menus: sidebar widgets only, cleaned', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let set = null;
  const sidebar = harness(createExtensionBridge, { surface: { type: 'sidebar' }, deps: { setSurfaceMenu: items => { set = items; } } });
  await sidebar.request('surface.setMenu', [{ id: 'a', label: '✓ Show', extra: 1 }, { type: 'separator' }, { type: 'bogus', label: 'x' }]);
  assert.deepEqual(set, [{ id: 'a', label: '✓ Show', type: undefined }, { id: '', label: '', type: 'separator' }]);
  const panel = harness(createExtensionBridge, { deps: { setSurfaceMenu: () => {} } });
  assert.equal((await panel.request('surface.setMenu', [])).error.name, 'Error');
});

test('legacy IndexedDB by key and legacy state namespaces: declared only', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  const deps = {
    readLegacyIndexedDB: (name, keys) => { calls.push([name, keys]); return { stores: {} }; },
    readLegacyState: namespace => ({ from: namespace }),
  };
  const manifest = { legacyStorage: {
    indexedDB: ['whole-db', { name: 'shared_db', keys: ['mine:*', 'old-key', '*'] }],
    state: ['old-namespace'],
  } };
  const { request } = harness(createExtensionBridge, { extension: { manifest }, deps });
  await request('legacy.readIndexedDB', 'whole-db');
  await request('legacy.readIndexedDB', 'shared_db');
  assert.deepEqual(calls, [['whole-db', null], ['shared_db', ['mine:*', 'old-key']]], 'a bare "*" never reads everything');
  assert.equal((await request('legacy.readIndexedDB', 'other_db')).error.name, 'AtmosPermissionError');
  assert.deepEqual((await request('legacy.readState', 'old-namespace')).result, { from: 'old-namespace' });
  assert.equal((await request('legacy.readState', 'someone-else')).error.name, 'AtmosPermissionError');
  const thirdParty = harness(createExtensionBridge, { extension: { manifest, tier: 'third-party' }, deps });
  assert.equal((await thirdParty.request('legacy.readState', 'old-namespace')).error.name, 'AtmosPermissionError');
});

test('legacy database deletion: declared names and long-enough prefixes only, first-party only', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const asked = [];
  const deps = { deleteLegacyIndexedDB: patterns => { asked.push(patterns); return ['old-cache::crypto']; } };
  const manifest = { legacyStorage: { deleteIndexedDB: ['old-cache::*', '*', 'ab*', 'a*b', 'exact-db'] } };
  const { request } = harness(createExtensionBridge, { extension: { manifest }, deps });
  assert.deepEqual((await request('legacy.deleteIndexedDB')).result, ['old-cache::crypto']);
  assert.deepEqual(asked, [['old-cache::*', 'exact-db']]);
  const undeclared = harness(createExtensionBridge, { deps });
  assert.equal((await undeclared.request('legacy.deleteIndexedDB')).error.name, 'AtmosPermissionError');
  const thirdParty = harness(createExtensionBridge, { extension: { manifest, tier: 'third-party' }, deps });
  assert.equal((await thirdParty.request('legacy.deleteIndexedDB')).error.name, 'AtmosPermissionError');
});

test('notifications: need the declared permission and a title; options are trimmed to plain values', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const shown = [];
  const notify = async options => { shown.push(options); return true; };

  const undeclared = harness(createExtensionBridge, { deps: { notify } });
  const denied = await undeclared.request('notifications.show', { title: 'Hi' });
  assert.equal(denied.error.name, 'AtmosPermissionError');

  const { request } = harness(createExtensionBridge, {
    extension: { permissions: { browser: ['notifications'] } },
    surface: { type: 'boot' },
    deps: { notify },
  });
  assert.equal((await request('notifications.show', { body: 'no title' })).error.name, 'TypeError');
  assert.equal((await request('notifications.show', 'Hi')).error.name, 'TypeError');
  const ok = await request('notifications.show', { title: 'x'.repeat(300), body: 'Hello', tag: 'room-1', silent: true, icon: 'file:///etc/passwd' });
  assert.equal(ok.result, true);
  assert.deepEqual(shown, [{ title: 'x'.repeat(120), body: 'Hello', tag: 'room-1', silent: true }]);
});

test('glass: panels declaring it only; regions cleaned and bounded', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let painted = null;
  const deps = { setGlass: regions => { painted = regions; } };
  const plain = harness(createExtensionBridge, { surface: { type: 'panel' }, deps });
  assert.match((await plain.request('surface.setGlass', [])).error.message, /declaring "glass"/);
  const widget = harness(createExtensionBridge, { surface: { type: 'sidebar', glass: true }, deps });
  assert.ok((await widget.request('surface.setGlass', [])).error);

  const { request } = harness(createExtensionBridge, { surface: { type: 'panel', glass: true }, deps });
  assert.equal((await request('surface.setGlass', 'nope')).error.name, 'TypeError');
  const regions = [
    { x: 0.4, y: 10, width: 300.6, height: 200, material: 'panel', radius: 99, extra: '<b>' },
    { x: 0, y: 210, width: 300, height: 54, material: 'shell' },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 'a', y: null, width: 20, height: 20, material: 'lava' },
    ...Array.from({ length: 30 }, () => ({ x: 1, y: 1, width: 1, height: 1 })),
  ];
  assert.equal((await request('surface.setGlass', regions)).error, undefined);
  assert.deepEqual(painted.slice(0, 3), [
    { x: 0, y: 10, width: 301, height: 200, material: 'panel', radius: 40 },
    { x: 0, y: 210, width: 300, height: 54, material: 'shell', radius: 0 },
    { x: 0, y: 0, width: 20, height: 20, material: 'panel', radius: 0 },
  ]);
  assert.ok(painted.length <= 24);
});

test('menus: a frame closes only its own open menu', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let closed = 0;
  const { request } = harness(createExtensionBridge, { deps: { closeOwnMenu: () => { closed++; } } });
  assert.equal((await request('contextMenu.close')).error, undefined);
  assert.equal(closed, 1);
});

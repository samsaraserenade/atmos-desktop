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
  fs.copyFileSync(path.join(__dirname, 'command-list.js'), path.join(dir, 'command-list.js'));
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
    extension: { permissions: { invokes: ['service:other'] }, frame: { reach: { 'service:other': { ipc: [], events: ['ready'], methods: [], resources: [] } } } },
    deps: { onMain },
  });

  assert.equal((await request('main.subscribe', 'plugin:probe', 'progress')).error, undefined);
  assert.equal((await request('main.subscribe', 'service:other', 'ready')).error, undefined);
  assert.match((await request('main.subscribe', 'service:other', 'private')).error.message, /doesn't share its 'private' events with other extensions/);
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
  const owners = [];
  const deps = { wallpaper: {
    // Each call names the extension making it: its image is its own, and only it can restore.
    set: (file, owner) => { set.push(file.type); owners.push(['set', owner]); },
    restore: async owner => { owners.push(['restore', owner]); return owner === 'plugin:probe'; },
    get: async owner => ({ mode: 'wallpaper', opacity: 100, thumbnail: 'data:image/jpeg;base64,x', canRestore: owner === 'plugin:probe' }),
    subscribe: (fn, owner) => { owners.push(['subscribe', owner]); listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
  } };
  const allowed = harness(createExtensionBridge, { extension: { permissions: { invokes: ['service:wallpaper'] } }, deps });
  assert.equal((await allowed.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error, undefined);
  assert.equal((await allowed.request('wallpaper.set', new Blob(['x'], { type: 'text/html' }))).error.name, 'TypeError');
  assert.equal((await allowed.request('wallpaper.get')).result.mode, 'wallpaper');
  assert.equal((await allowed.request('wallpaper.restore')).result, true);
  await allowed.request('wallpaper.subscribe');
  await allowed.request('wallpaper.subscribe');
  assert.equal(listeners.length, 1);
  // A change as Atmos reports it (no see-through window since SDK 1.7: the wallpaper removed, say).
  listeners[0]({ mode: 'wallpaper', opacity: 100, thumbnail: null, canRestore: false });
  assert.deepEqual(allowed.posted.at(-1), { topic: 'wallpaper', payload: { mode: 'wallpaper', opacity: 100, thumbnail: null, canRestore: false } });
  allowed.bridge.dispose();
  assert.equal(listeners.length, 0);

  const denied = harness(createExtensionBridge, { deps });
  assert.equal((await denied.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error.name, 'AtmosPermissionError');
  assert.equal((await denied.request('wallpaper.get')).error.name, 'AtmosPermissionError');
  assert.equal((await denied.request('wallpaper.restore')).error.name, 'AtmosPermissionError');
  // The old Background id no longer grants anything.
  const old = harness(createExtensionBridge, { extension: { permissions: { invokes: ['plugin:background'] } }, deps });
  assert.equal((await old.request('wallpaper.set', new Blob(['x'], { type: 'image/png' }))).error.name, 'AtmosPermissionError');
  assert.deepEqual(set, ['image/png']);
  assert.deepEqual([...new Set(owners.map(([, owner]) => owner))], ['plugin:probe']);
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
  assert.equal((await request('audio.load', new Blob(['x'], { type: 'audio/wav' }), { id: 'rain', loop: true })).error, undefined);
  assert.equal((await request('audio.load', new Blob(['x'], { type: 'audio/wav' }), { loop: 'yes' })).error, undefined);
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
    ['load', 'atmos-resource://audio-player-media/C:/Music/a.mp3', { id: 'k1', position: 12, play: true, loop: false }],
    ['load', 'blob', { id: null, position: 0, play: false, loop: false }],
    ['load', 'blob', { id: 'rain', position: 0, play: false, loop: true }],
    ['load', 'blob', { id: null, position: 0, play: false, loop: false }],
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
    { id: 'play', label: 'Play', icon: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', onclick: 'x', hold: true, tone: 'danger' },
    { id: 'labels', label: 'Labels', type: 'toggle', checked: true },
    { id: 'size', label: 'Size', type: 'range', min: 60, max: 180, step: 4, value: 160, suffix: 'px', zeroLabel: 'Off', format: 'x' },
    { id: 'fps', label: 'Rate', type: 'number', min: 1, max: 1000, value: 'nope' },
    { id: 'name', label: 'Name', type: 'text', value: 42, placeholder: 'Room name', maxLength: 9999, pattern: 'x' },
    { id: 'grad', label: 'Gradient', type: 'colors', values: ['#ff0000', 'javascript:alert(1)'] },
    { id: 'evil', label: 'Evil', type: 'html' },
  ]);
  assert.equal(reply.result, 'play');
  assert.deepEqual(opened.map(item => item.id), ['play', 'labels', 'size', 'fps', 'name', 'grad']);
  assert.equal(opened[0].onclick, undefined);
  assert.equal(opened[0].icon.startsWith('<svg'), true);
  assert.deepEqual([opened[0].hold, opened[0].tone], [true, 'danger'], 'a row can ask for a hold and be drawn as destructive');
  assert.equal(opened[1].hold, undefined, 'only plain rows can ask for a hold');
  assert.equal(opened[1].checked, true);
  assert.deepEqual([opened[2].min, opened[2].max, opened[2].step, opened[2].value, opened[2].suffix, opened[2].zeroLabel, opened[2].format], [60, 180, 4, 160, 'px', 'Off', undefined]);
  assert.equal(opened[3].value, 1);
  assert.deepEqual([opened[4].value, opened[4].placeholder, opened[4].maxLength, opened[4].pattern], ['42', 'Room name', 500, undefined]);
  assert.deepEqual(opened[5].values, ['#ff0000', '#ffffff']);
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

test('audio: a call made before the Audio service has started waits for it', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  // Core creates frames before its boot hooks start Audio: channel() then
  // resolves a moment later (extension-frame-host.js _whenCapability).
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const calls = [];
  const channel = { play: () => { calls.push('play'); return true; }, state: () => ({ playing: true }) };
  const { request } = harness(createExtensionBridge, {
    extension: { permissions: { invokes: ['service:audio'] } },
    deps: { audio: { channel: () => started.then(() => channel), watch: async () => { await started; calls.push('watch'); } } },
  });
  const play = request('audio.play');
  const subscribe = request('audio.subscribe');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, [], 'nothing reaches the channel before Audio starts');
  start();
  assert.equal((await play).result, true);
  assert.equal((await subscribe).error, undefined);
  assert.deepEqual(calls.sort(), ['play', 'watch']);
});

test('an audio call waiting for Audio to start is dropped if the frame goes meanwhile (R38)', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const calls = [];
  const channel = { load: (...args) => { calls.push('load'); return args; }, play: () => calls.push('play') };
  const { bridge, request } = harness(createExtensionBridge, {
    extension: { permissions: { invokes: ['service:audio'] } },
    deps: { audio: { channel: () => started.then(() => channel), watch: async () => {} } },
  });
  const load = request('audio.load', new Blob(['x'], { type: 'audio/wav' }), { play: true, loop: true });
  const play = request('audio.play');
  await new Promise(resolve => setImmediate(resolve));
  bridge.dispose(); // its frame goes (say, its approval removed) before Audio starts
  start();
  await Promise.all([load, play]);
  assert.deepEqual(calls, [], 'nothing reaches the channel');
});

test('a service call waiting for its service to start is dropped if the frame goes meanwhile (R38)', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let started;
  const calls = [];
  const service = { methods: ['save'], call: (method, args) => { calls.push([method, ...args]); return 'saved'; } };
  const { bridge, request } = harness(createExtensionBridge, {
    extension: { permissions: { invokes: ['service:store'] }, frame: { reach: { 'service:store': { ipc: [], events: [], methods: ['save'], resources: [] } } } },
    deps: { awaitService: () => new Promise(resolve => { started = () => resolve(service); }) },
  });
  const pending = request('call', 'service:store', 'save', { draft: 1 });
  await new Promise(resolve => setImmediate(resolve));
  bridge.dispose(); // its frame closes while the service is still starting
  started();
  const reply = await pending;
  assert.deepEqual(calls, [], 'the call never reaches the service');
  assert.match(reply?.error?.message || '', /went away/);
});

test('fetch: declared https hosts only, stamped with the caller, abortable, cleaned up with the frame', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  const aborted = [];
  let answer = { result: { url: 'https://api.test.example/x', status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: new Uint8Array([104, 105]), redirected: false } };
  const deps = {
    fetch: async (caller, requestId, request) => { calls.push({ caller, requestId, request }); return typeof answer === 'function' ? answer() : answer; },
    fetchAbort: (caller, requestId) => aborted.push([caller, requestId]),
  };
  const { bridge, request } = harness(createExtensionBridge, {
    extension: { tier: 'third-party', permissions: { network: ['api.test.example', '*.cdn.test.example'] } },
    deps,
  });
  const ask = (url, extra = {}) => request('fetch', { id: 7, url, method: 'GET', headers: [['accept', 'text/plain']], body: null, redirect: 'follow', ...extra });

  const ok = await ask('https://api.test.example/x');
  assert.equal(ok.error, undefined);
  assert.equal(ok.result.status, 200);
  assert.ok(ok.result.body instanceof ArrayBuffer);
  assert.equal(Buffer.from(ok.result.body).toString(), 'hi');
  assert.equal(calls[0].caller, 'plugin:probe');
  assert.match(calls[0].requestId, /^\d+:7$/);
  assert.equal((await ask('https://img.cdn.test.example/a.png')).error, undefined, '"*." covers subdomains');

  assert.equal((await ask('https://elsewhere.example/')).error.name, 'AtmosPermissionError');
  assert.equal((await ask('https://cdn.test.example/')).error.name, 'AtmosPermissionError', '"*.x" is not x itself');
  assert.equal((await ask('http://api.test.example/')).error.name, 'TypeError');
  assert.equal((await ask('atmos-app://local/')).error.name, 'TypeError');
  assert.equal((await ask('not a url')).error.name, 'TypeError');
  assert.equal((await ask('https://api.test.example/', { method: 'TRACE' })).error.name, 'TypeError');
  assert.equal((await ask('https://api.test.example/', { headers: [['a']] })).error.name, 'TypeError');
  assert.equal((await ask('https://api.test.example/', { body: 'text' })).error.name, 'TypeError');
  assert.equal(calls.length, 2, 'refused requests never reach the main process');

  answer = { error: { name: 'TypeError', message: 'api.test.example is on a private or local network' } };
  const refused = await ask('https://api.test.example/');
  assert.deepEqual(refused.error, { name: 'TypeError', message: 'api.test.example is on a private or local network' });

  // In flight: an abort goes through; a closed frame aborts what it left.
  const releases = [];
  answer = () => new Promise(resolve => { releases.push(resolve); });
  const slow = request('fetch', { id: 8, url: 'https://api.test.example/slow', method: 'GET', headers: [], body: null });
  await new Promise(resolve => setImmediate(resolve));
  await bridge.receive({ method: 'fetch.abort', args: [8] });
  await bridge.receive({ method: 'fetch.abort', args: [99] });
  assert.equal(aborted.length, 1);
  assert.match(aborted[0][1], /:8$/);
  const leftOver = request('fetch', { id: 9, url: 'https://api.test.example/slow', method: 'GET', headers: [], body: null });
  await new Promise(resolve => setImmediate(resolve));
  bridge.dispose();
  assert.equal(aborted.length, 3, 'both requests still in flight are aborted when the frame goes');
  for (const release of releases) release({ error: { name: 'AbortError', message: 'aborted' } });
  await Promise.allSettled([slow, leftOver]);
});

test('fetch: one frame has at most 32 requests in flight', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const releases = [];
  const deps = {
    fetch: () => new Promise(resolve => releases.push(resolve)),
    fetchAbort: () => {},
  };
  const { request } = harness(createExtensionBridge, { extension: { tier: 'third-party', permissions: { network: ['api.test.example'] } }, deps });
  const send = id => request('fetch', { id, url: 'https://api.test.example/', method: 'GET', headers: [], body: null });
  const first = Array.from({ length: 32 }, (_, index) => send(index + 1));
  while (releases.length < 32) await new Promise(resolve => setImmediate(resolve));
  const refused = await send(33);
  assert.equal(refused.error.name, 'TypeError');
  assert.match(refused.error.message, /too many atmos\.fetch\(\) requests/);
  for (const release of releases.splice(0)) release({ result: { url: 'https://api.test.example/', status: 204, statusText: '', headers: [], body: null, redirected: false } });
  await Promise.all(first);
  const again = send(34);
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  releases[0]({ result: { url: 'https://api.test.example/', status: 204, statusText: '', headers: [], body: null, redirected: false } });
  assert.equal((await again).error, undefined, 'room again once they finish');
});

test('location: read-only, only with "invokes": ["service:location"]', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  let listener = null;
  const location = {
    get: async () => ({ lat: 51.5, lon: -0.12, label: 'London', mode: 'manual' }),
    subscribe: fn => { listener = fn; return () => { listener = null; }; },
  };
  const allowed = harness(createExtensionBridge, { extension: { tier: 'third-party', permissions: { invokes: ['service:location'] } }, deps: { location } });
  assert.deepEqual((await allowed.request('location.get')).result, { lat: 51.5, lon: -0.12, label: 'London', mode: 'manual' });
  await allowed.request('location.subscribe');
  listener({ lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' });
  assert.deepEqual(allowed.posted.at(-1), { topic: 'location', payload: { lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' } });
  allowed.bridge.dispose();
  assert.equal(listener, null, 'a closed frame stops following it');

  const denied = harness(createExtensionBridge, { extension: { tier: 'third-party', permissions: {} }, deps: { location } });
  const refusal = (await denied.request('location.get')).error;
  assert.equal(refusal.name, 'AtmosPermissionError');
  assert.match(refusal.message, /service:location/);
  assert.equal((await denied.request('location.subscribe')).error.name, 'AtmosPermissionError');
});

test('web pages: official extensions declaring "web" only; tab ids, commands and the surface checked', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  const web = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return name === 'subscribe' ? () => calls.push(['unsubscribe']) : true; } });
  const official = harness(createExtensionBridge, { extension: { permissions: { web: true } }, deps: { web } });
  assert.equal((await official.request('web.open', 'tab-1', { url: 'https://example.com/', private: true })).result, true);
  assert.deepEqual(calls.at(-1), ['open', 'tab-1', { url: 'https://example.com/', private: true }]);
  assert.equal((await official.request('web.open', 'bad id!', {})).error.name, 'TypeError', 'a tab id is letters, digits, - and _');
  await official.request('web.close', 'tab-1', { sleep: 'yes', evil: true });
  assert.deepEqual(calls.at(-1), ['close', 'tab-1', { sleep: false }], 'closing, or putting to sleep only when asked for exactly');
  await official.request('web.close', 'tab-1', { sleep: true });
  assert.deepEqual(calls.at(-1), ['close', 'tab-1', { sleep: true }]);
  assert.equal((await official.request('web.do', 'tab-1', 'executeJavaScript', 'alert(1)')).error.name, 'TypeError', 'only the listed commands');
  assert.equal((await official.request('web.do', 'tab-1', 'navigate', 42)).error.name, 'TypeError');
  assert.equal((await official.request('web.do', 'tab-1', 'copyImage', 'x', 1)).error.name, 'TypeError');
  await official.request('web.do', 'tab-1', 'find', 'text', { forward: true }, 'extra');
  assert.deepEqual(calls.at(-1), ['do', 'tab-1', 'find', 'text', { forward: true }], 'at most two arguments cross');
  await official.request('web.setSurface', { x: 1.4, y: 2, width: -5, height: 10, over: [{ x: 0, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 9 }, ...Array(10).fill({ x: 1, y: 1, width: 1, height: 1 })], evil: true });
  assert.deepEqual(calls.at(-1), ['setSurface', { x: 1, y: 2, width: 0, height: 10, over: [{ x: 0, y: 0, width: 5, height: 5 }, ...Array(6).fill({ x: 1, y: 1, width: 1, height: 1 })] }]);
  assert.equal((await official.request('web.siteSetting', 'https://a.example', 'camera', 'maybe')).error.name, 'TypeError');
  await official.request('web.subscribe');
  official.bridge.dispose();
  assert.deepEqual(calls.slice(-2), [['unsubscribe'], ['clearSurface']], 'a closed panel stops listening and shows no page');

  const widget = harness(createExtensionBridge, { extension: { permissions: { web: true } }, surface: { type: 'sidebar' }, deps: { web } });
  assert.match((await widget.request('web.setSurface', { x: 0, y: 0, width: 1, height: 1 })).error.message, /only a panel/);

  for (const extension of [{ permissions: {} }, { tier: 'third-party', permissions: { web: true } }]) {
    const refused = harness(createExtensionBridge, { extension, deps: { web } });
    const reply = await refused.request('web.open', 'tab-1', {});
    assert.equal(reply.error.name, 'AtmosPermissionError', JSON.stringify(extension));
    assert.match(reply.error.message, /may not show web pages/);
  }
});

test('links.open: http(s) and mailto only, handed to Core (which decides whether to ask)', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const opened = [];
  const { request } = harness(createExtensionBridge, {
    extension: { tier: 'third-party' },
    deps: { openLink: async url => { opened.push(url); return true; } },
  });
  assert.equal((await request('links.open', 'https://example.com/a')).result, true);
  assert.equal((await request('links.open', 'mailto:me@example.com')).result, true);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'atmos-ext://plugin-x/', '', 42]) {
    assert.equal((await request('links.open', bad)).error.name, 'TypeError', String(bad));
  }
  assert.deepEqual(opened, ['https://example.com/a', 'mailto:me@example.com']);
  const noCore = harness(createExtensionBridge, {});
  assert.equal((await noCore.request('links.open', 'https://example.com/')).result, false);
});

test('commands: only declared ones are handled, a panel says where its bar is, and the bar opens with clean text', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  const commands = {
    handle: (name, meta) => calls.push(['handle', name, meta]),
    unhandle: name => calls.push(['unhandle', name]),
    setBar: rect => calls.push(['bar', rect]),
    open: (text, options, follow) => { calls.push(['open', text, options, follow]); return true; },
    refresh: () => calls.push(['refresh']),
  };
  const extension = { frame: { commands: [{ name: 'roll', args: '', about: 'Roll a die', takesArgs: false, suggests: true }] } };
  const { bridge, request } = harness(createExtensionBridge, { extension, deps: { commands } });
  assert.equal((await request('commands.handle', 'roll', { suggests: true })).error, undefined);
  const undeclared = await request('commands.handle', 'flip', {});
  assert.equal(undeclared.error.name, 'TypeError');
  assert.match(undeclared.error.message, /rev\/flip isn't a command plugin:probe declares \("contributes\.commands"/);
  await bridge.receive({ method: 'commands.unhandle', args: ['roll'] });
  assert.equal((await request('commands.bar', { x: 0.4, y: 746.6, width: 990, height: 54, extra: 'x' })).error, undefined);
  assert.equal((await request('commands.bar', { x: 0, y: 0, width: 0, height: 54 })).error, undefined, 'an empty box is no bar');
  assert.equal((await request('commands.bar', 'nope')).error.name, 'TypeError');
  assert.equal((await request('commands.open', `rev/roll ${'x'.repeat(300)}`, { parent: '!space:example', encrypted: false, 'bad id!': 1, nested: { a: 1 } })).result, true);
  assert.equal((await request('commands.open', 42)).error.name, 'TypeError');
  assert.equal((await request('commands.open', 'rev/', 'not an object')).error.name, 'TypeError');
  assert.equal((await request('commands.open', 'rev/ro', null, true)).result, true, 'keys that followed (atmos.commands.field)');
  assert.equal((await request('commands.open', 'rev/ro', null, 'yes')).result, true, '…only when it says so exactly');
  await bridge.receive({ method: 'commands.refresh', args: [] });
  assert.deepEqual(calls, [
    ['handle', 'roll', { suggests: true }],
    ['unhandle', 'roll'],
    ['bar', { x: 0, y: 747, width: 990, height: 54 }],
    ['bar', null],
    ['open', `rev/roll ${'x'.repeat(191)}`, { parent: '!space:example', encrypted: false }, false],
    ['open', 'rev/ro', {}, true],
    ['open', 'rev/ro', {}, false],
    ['refresh'],
  ]);
  // Only a panel has a bar.
  const widget = harness(createExtensionBridge, { extension, surface: { type: 'sidebar' }, deps: { commands } });
  assert.match((await widget.request('commands.bar', { x: 0, y: 0, width: 10, height: 10 })).error.message, /only a panel/);
});

test('commands: Core asks the frame to run or suggest, and hears back once; a frame that goes rejects what was asked', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const { bridge, posted } = harness(createExtensionBridge, { extension: { frame: { commands: [{ name: 'roll' }] } } });
  const asked = bridge.requestCommand('run', 'roll', { args: '2d6', value: null, options: {} });
  const message = posted.at(-1);
  assert.deepEqual({ ...message, command: typeof message.command }, { command: 'number', action: 'run', name: 'roll', input: { args: '2d6', value: null, options: {} } });
  await bridge.receive({ commandReply: message.command, result: { done: 'Rolled 7' } });
  assert.deepEqual(await asked, { done: 'Rolled 7' });
  await bridge.receive({ commandReply: message.command, result: 'again' }); // a second answer is ignored

  const failing = bridge.requestCommand('suggest', 'roll', { args: '' });
  await bridge.receive({ commandReply: posted.at(-1).command, error: { name: 'Error', message: 'No dice here' } });
  await assert.rejects(failing, /No dice here/);

  const slow = bridge.requestCommand('suggest', 'roll', { args: '' }, 20);
  await assert.rejects(slow, error => error.name === 'TimeoutError' && /didn't answer/.test(error.message));

  const pending = bridge.requestCommand('run', 'roll', {});
  bridge.dispose();
  await assert.rejects(pending, /frame went away/);
  await assert.rejects(bridge.requestCommand('run', 'roll', {}), /frame went away/);
});

test('location (SDK 1.4): only the official Location service publishes, takes and clears what Atmos kept, or opens Detect', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  const location = {
    get: async () => null, subscribe: () => () => {},
    publish: value => calls.push(['publish', value]),
    takeEarlier: () => ({ lat: 1, lon: 2, label: 'Earlier', mode: 'manual' }),
    forgetEarlier: () => calls.push(['forgetEarlier']),
    allowDetect: async () => { calls.push(['allowDetect']); return true; },
  };
  for (const extension of [
    { tier: 'third-party', permissions: { invokes: ['service:location'] } },
    { id: 'location', kind: 'service', tier: 'third-party' },
    { id: 'weather', kind: 'plugin', tier: 'first-party', permissions: { invokes: ['service:location'] } },
  ]) {
    const other = harness(createExtensionBridge, { extension, deps: { location } });
    for (const method of ['location.publish', 'location.takeEarlier', 'location.forgetEarlier', 'location.allowDetect']) {
      assert.match((await other.request(method, { lat: 0, lon: 0 })).error.message, /only Atmos's Location service/, `${extension.id ?? 'a community plugin'}: ${method}`);
    }
  }
  assert.deepEqual(calls, []);
  const service = harness(createExtensionBridge, { extension: { id: 'location', kind: 'service', tier: 'first-party' }, deps: { location } });
  assert.equal((await service.request('location.publish', { lat: 51.5, lon: -0.12 })).error, undefined);
  assert.deepEqual((await service.request('location.takeEarlier')).result, { lat: 1, lon: 2, label: 'Earlier', mode: 'manual' });
  assert.equal((await service.request('location.forgetEarlier')).error, undefined);
  assert.equal((await service.request('location.allowDetect')).result, true);
  assert.deepEqual(calls, [['publish', { lat: 51.5, lon: -0.12 }], ['forgetEarlier'], ['allowDetect']]);
  location.allowDetect = async () => { throw new Error('Detect works from a click on its button'); };
  assert.match((await service.request('location.allowDetect')).error.message, /click/);
});

test('nowPlaying (SDK 1.4): set and clear with "invokes": ["service:now-playing"]; every session and the controls for the official service only', async t => {
  const { createExtensionBridge } = await loadBridge(t);
  const calls = [];
  let watcher = null;
  const nowPlaying = {
    set: (key, session) => {
      if (!session?.title) throw new TypeError('a Now Playing session has a title');
      // The artwork is read later: what's wrong with it, or a limit, rejects.
      if (session.title === 'later') return Promise.reject(new RangeError('an extension updates Now Playing 20 times a second at most'));
      calls.push(['set', key, session.title]);
      return Promise.resolve();
    },
    clear: key => calls.push(['clear', key]),
    watch: fn => { watcher = fn; return () => { watcher = null; }; },
    control: (id, action, value) => {
      if (action === 'next') throw new TypeError('X doesn’t take “next” from Now Playing');
      calls.push(['control', id, action, value]);
    },
  };

  const refused = harness(createExtensionBridge, { deps: { nowPlaying } });
  const denied = await refused.request('nowPlaying.set', { title: 'x', playing: true });
  assert.equal(denied.error.name, 'AtmosPermissionError');
  assert.match(denied.error.message, /declare it in extension\.json "permissions\.invokes"/);

  const { request } = harness(createExtensionBridge, { extension: { tier: 'third-party', permissions: { invokes: ['service:now-playing'] } }, deps: { nowPlaying } });
  assert.equal((await request('nowPlaying.set', { title: 'One', playing: true })).error, undefined);
  assert.equal((await request('nowPlaying.set', { title: 'Tab', playing: true }, 'tab-1')).error, undefined);
  const bad = await request('nowPlaying.set', { playing: true });
  assert.equal(bad.error.name, 'TypeError', 'what Core finds wrong comes back as a TypeError');
  const late = await request('nowPlaying.set', { title: 'later' });
  assert.deepEqual([late.error.name, late.error.message], ['RangeError', 'an extension updates Now Playing 20 times a second at most'], 'found after reading the artwork: still its error');
  assert.equal((await request('nowPlaying.clear', 'tab-1')).error, undefined);
  assert.equal((await request('nowPlaying.clear', null)).error, undefined);
  assert.equal((await request('nowPlaying.clear', 3)).error.name, 'TypeError');
  assert.deepEqual(calls, [['set', 'main', 'One'], ['set', 'tab-1', 'Tab'], ['clear', 'tab-1'], ['clear', null]]);

  // A community extension, even one calling itself service:now-playing, sees nothing.
  for (const extension of [{ tier: 'third-party', permissions: { invokes: ['service:now-playing'] } }, { id: 'now-playing', kind: 'service', tier: 'third-party' }]) {
    const other = harness(createExtensionBridge, { extension, deps: { nowPlaying } });
    assert.match((await other.request('nowPlaying.sessions')).error.message, /only Atmos's Now Playing service/);
    assert.match((await other.request('nowPlaying.control', 'plugin:x|main', 'toggle')).error.message, /only Atmos's Now Playing service/);
  }
  assert.equal(watcher, null);

  const service = harness(createExtensionBridge, { extension: { id: 'now-playing', kind: 'service', tier: 'first-party' }, surface: { type: 'sidebar' }, deps: { nowPlaying } });
  assert.equal((await service.request('nowPlaying.sessions')).error, undefined);
  watcher([{ id: 'plugin:x|main', title: 'One' }]);
  assert.deepEqual(service.posted.at(-1), { topic: 'nowPlaying.sessions', payload: [{ id: 'plugin:x|main', title: 'One' }] });
  const first = watcher;
  assert.equal((await service.request('nowPlaying.sessions')).error, undefined);
  assert.notEqual(watcher, first, 'asked again: watched afresh, so the list comes again');
  assert.equal((await service.request('nowPlaying.control', 'plugin:x|main', 'seek', 12)).error, undefined);
  assert.equal((await service.request('nowPlaying.control', 'plugin:x|main', 'next')).error.name, 'TypeError');
  assert.deepEqual(calls.at(-1), ['control', 'plugin:x|main', 'seek', 12]);
  service.bridge.dispose();
  assert.equal(watcher, null, 'the service frame went: it stops hearing');
});

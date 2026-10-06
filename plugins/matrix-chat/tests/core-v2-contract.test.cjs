const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('runs in frames: engine in the boot frame, Chat panel, Matrix Chat and Matrix Account widgets', () => {
  const manifest = JSON.parse(read('extension.json'));
  assert.equal(manifest.runtime, 'frame');
  assert.equal(manifest.contributes.panel.label, 'Chat');
  assert.equal(manifest.contributes.panel.glass, true);
  const [chat, account] = manifest.contributes.sidebar;
  assert.equal(chat.legacyId, 'matrix-chat-rooms');
  assert.equal(chat.label, 'Matrix Chat');
  assert.deepEqual(chat.showIn, ['matrix-chat']);
  assert.equal(account.label, 'Matrix Account');
  assert.equal(account.entry, 'sidebar-account.js');
  assert.deepEqual(account.showIn, ['matrix-chat']);
  assert.equal(manifest.contributes.boot.entry, 'boot.js');
  for (const target of ['service:audio', 'service:wallpaper', 'service:fullscreen-viewer']) {
    assert.ok(manifest.permissions.invokes.includes(target), target);
  }
  assert.ok(manifest.permissions.browser.includes('wasm'), 'the crypto WASM needs compiling');
  assert.deepEqual(manifest.legacyStorage.deleteIndexedDB, ['matrix-js-sdk*']);
});

test('nothing imports the Atmos page any more', () => {
  const files = ['boot.js', 'panel.js', 'sidebar.js', 'sidebar-account.js',
    ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`),
    ...fs.readdirSync(path.join(root, 'src/ui')).map(name => `src/ui/${name}`)];
  for (const file of files) {
    assert.doesNotMatch(read(file), /from 'atmos-core\/|window\.atmos\.|window\.(confirm|alert)\(/, file);
  }
});

test('views reach the engine only through src/ui/engine.js', () => {
  for (const name of fs.readdirSync(path.join(root, 'src/ui'))) {
    assert.doesNotMatch(read(`src/ui/${name}`), /from '\.\.\/(client|preferences|relation-index|state)\.js'/, name);
  }
  const engine = read('src/ui/engine.js');
  assert.match(engine, /atmos\.background\(\)/);
  assert.match(engine, /addEventListener\('pagehide'/);
  assert.match(read('boot.js'), /defineProperty\(window, '__matrixEngine'/);
});

test('engine listeners are isolated from each other', () => {
  assert.match(read('src/client.js'), /try \{ fn\(\.\.\.args\); \} catch/);
});

test('secure start signs old devices out once and keeps display preferences', () => {
  const boot = read('boot.js');
  assert.match(boot, /if \(matrixState\.storageVersion >= STORAGE_VERSION\) return;/);
  // The vault opens before saved state is read.
  assert.ok(boot.indexOf('await openVault()') < boot.indexOf('await loadState()'));
  assert.match(boot, /_matrix\/client\/v3\/logout/);
  assert.match(boot, /atmos\.legacy\.deleteIndexedDB\(\)/);
  assert.doesNotMatch(boot, /showUsernames|chatScale|railOrder/);
});

test('Core draws the panel and composer glass', () => {
  assert.match(read('src/ui/room-view.js'), /class="mx-room-view" data-atmos-glass="panel" data-atmos-glass-inset="0 0 54 0"/);
  assert.match(read('src/ui/room-view.js'), /class="mx-composer" data-atmos-glass="shell"/);
  assert.match(read('panel.js'), /atmos\.surface\.trackGlass\(\)/);
});

test('Matrix Chat widget is one list of groups; Matrix Account holds settings', () => {
  const widget = read('sidebar.js');
  assert.doesNotMatch(widget, /data-matrix-room-mode|mx-rooms-add/);
  assert.match(read('sidebar-account.js'), /renderSettingsDashboard\(root/);
  const list = read('src/ui/room-list.js');
  assert.match(list, /function spacesPaneHtml\(entries, activeRoomId\)/);
  assert.match(list, /\.\.\.\(direct \? \[direct\] : \[\]\)/);
});

test('network goes through scoped IPC; services load as libraries', () => {
  assert.doesNotMatch(read('main.cjs'), /ipcMain\.(?:on|handle)/);
  assert.match(read('src/matrix-fetch.js'), /atmos\.invoke\('plugin:matrix-chat', name/);
  assert.match(read('src/ui/fullscreen-media.js'), /atmos\.library\('service:fullscreen-viewer', 'index\.js'\)/);
});

test('main process registers only scoped handlers', () => {
  const handlers = new Map();
  const sandbox = {
    module: { exports: {} }, exports: {}, URL, AbortController, Uint8Array, setTimeout, clearTimeout,
    require(name) {
      if (name === 'fs' || name === 'path' || name === 'http' || name === 'crypto') return require(name);
      if (name === './oauth-callback.cjs') return require('../oauth-callback.cjs');
      if (name === './vault.cjs') return require('../vault.cjs');
      assert.equal(name, 'electron');
      return { net: { fetch: async () => { throw new Error('unused'); } }, dialog: {}, app: { on() {}, getPath: () => require('os').tmpdir() }, BrowserWindow: {}, shell: {}, safeStorage: {} };
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read('main.cjs'), sandbox, { filename: 'main.cjs' });
  sandbox.module.exports.activate({ handle: (name, handler) => handlers.set(name, handler) });
  assert.deepEqual([...handlers.keys()].sort(), ['fetch', 'fetch-abort', 'oauth-cancel', 'oauth-listen', 'oauth-open', 'oauth-wait', 'open-link', 'pick-image', 'save-file', 'vault-key']);
});

test('the fetch relay sends no cookies and drops headers that could spoof a request', async () => {
  const handlers = new Map();
  let sent = null;
  const sandbox = {
    module: { exports: {} }, exports: {}, URL, AbortController, Uint8Array, setTimeout, clearTimeout,
    require(name) {
      if (['fs', 'path', 'http', 'crypto'].includes(name)) return require(name);
      if (name === './oauth-callback.cjs') return require('../oauth-callback.cjs');
      if (name === './vault.cjs') return require('../vault.cjs');
      return {
        net: { fetch: async (url, options) => { sent = { url, options }; return new Response('{}', { status: 200 }); } },
        dialog: {}, app: { on() {}, getPath: () => require('os').tmpdir() }, BrowserWindow: {}, shell: {}, safeStorage: {},
      };
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read('main.cjs'), sandbox, { filename: 'main.cjs' });
  sandbox.module.exports.activate({ handle: (name, handler) => handlers.set(name, handler) });
  const event = { sender: { id: 1 } };
  const result = await handlers.get('fetch')(event, {
    requestId: 'r1', url: 'https://matrix.example/_matrix/client/versions', method: 'GET',
    headers: [['Authorization', 'Bearer t'], ['Accept', 'application/json'], ['Cookie', 'a=b'], ['Origin', 'https://evil'], ['Sec-Fetch-Site', 'none'], ['Host', 'other']],
  });
  assert.equal(result.ok, true);
  assert.equal(sent.options.credentials, 'omit');
  assert.deepEqual(sent.options.headers.map(([name]) => name), ['Authorization', 'Accept']);
  const refused = await handlers.get('fetch')(event, { requestId: 'r2', url: 'file:///etc/passwd', method: 'GET' });
  assert.equal(refused.ok, false);
});

/** main.cjs in a sandbox, its net.fetch the given one; returns its handlers. */
function loadMain(netFetch, timers = { setTimeout, clearTimeout }) {
  const handlers = new Map();
  const sandbox = {
    module: { exports: {} }, exports: {}, URL, AbortController, Uint8Array, ...timers,
    require(name) {
      if (['fs', 'path', 'http', 'crypto'].includes(name)) return require(name);
      if (name === './oauth-callback.cjs') return require('../oauth-callback.cjs');
      if (name === './vault.cjs') return require('../vault.cjs');
      return { net: { fetch: netFetch }, dialog: {}, app: { on() {}, getPath: () => require('os').tmpdir() }, BrowserWindow: {}, shell: {}, safeStorage: {} };
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read('main.cjs'), sandbox, { filename: 'main.cjs' });
  sandbox.module.exports.activate({ handle: (name, handler) => handlers.set(name, handler) });
  return handlers;
}
const MB = 1024 * 1024;
const relayed = (handlers, requestId, more = {}) => handlers.get('fetch')({ sender: { id: 1 } }, { requestId, url: 'https://matrix.example/_matrix/media/v3/download/x', method: 'GET', ...more });

test('the relay refuses an answer too big to hold, before reading it and while reading it (R19)', async () => {
  // Declared too big: refused without reading a byte, and the answer let go.
  let pulled = 0;
  let declaredCancelled = false;
  const declared = loadMain(async () => new Response(new ReadableStream({
    pull(c) { pulled += 1; c.enqueue(new Uint8Array(16)); }, cancel() { declaredCancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(4096 * MB) } }));
  const refused = await relayed(declared, 'big-declared');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /too large/);
  assert.equal(pulled, 0, 'not a byte read');
  assert.equal(declaredCancelled, true, 'the answer is cancelled, not left open');
  // Not declared (chunked): read up to the limit, then the rest is never asked for.
  const chunk = new Uint8Array(4 * MB);
  let sent = 0;
  let cancelled = false;
  const streamed = loadMain(async () => new Response(new ReadableStream({
    pull(c) { if (sent >= 160 * MB) { c.close(); return; } sent += chunk.length; c.enqueue(chunk); },
    cancel() { cancelled = true; },
  })));
  const cut = await relayed(streamed, 'big-streamed');
  assert.equal(cut.ok, false);
  assert.match(cut.message, /too large/);
  assert.ok(sent <= 112 * MB, `read ${sent / MB} MB`); // the limit, and the stream's read-ahead
  assert.equal(cancelled, true);
  // An upload too big is refused before it is sent.
  let fetched = false;
  const upload = loadMain(async () => { fetched = true; return new Response('{}'); });
  const tooBig = await relayed(upload, 'big-upload', { method: 'POST', body: new ArrayBuffer(101 * MB) });
  assert.equal(tooBig.ok, false);
  assert.equal(fetched, false);
  // A normal answer still comes through whole.
  const fine = await relayed(loadMain(async () => new Response(new Uint8Array(3 * MB))), 'fine');
  assert.equal(fine.ok, true);
  assert.equal(fine.body.length, 3 * MB);
});

test('the relay runs a bounded number of requests at once; the rest wait their turn (R19)', async () => {
  let started = 0;
  const release = [];
  const handlers = loadMain(() => { started += 1; return new Promise(resolve => release.push(() => resolve(new Response('{}')))); });
  const all = Array.from({ length: 40 }, (_, i) => relayed(handlers, `r${i}`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 16);
  // One waiting is aborted: it never starts.
  await handlers.get('fetch-abort')({ sender: { id: 1 } }, 'r39');
  while (release.length) { release.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  const results = await Promise.all(all);
  assert.equal(started, 39);
  assert.equal(results.filter(result => result.ok).length, 39);
  assert.equal(results[39].name, 'AbortError');
});

test('the relay gives up on a homeserver that stops sending (R19)', async () => {
  const timers = [];
  const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } };
  let cancelled = false;
  const handlers = loadMain(async (url, { signal }) => {
    signal.addEventListener('abort', () => { cancelled = true; });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } }));
  }, fake);
  const pending = relayed(handlers, 'stalled');
  await new Promise(resolve => setImmediate(resolve));
  const armed = timers.filter(timer => timer.fn);
  assert.ok(armed.length >= 1);
  assert.ok(armed.every(timer => timer.ms >= 60_000), 'a long poll (30 s) must not count as stalled');
  armed.at(-1).fn();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.notEqual(result.name, 'AbortError'); // a network failure the client retries, not a cancel
  assert.match(result.message, /stopped answering/);
  assert.equal(cancelled, true);
});

test('an upload has time to be sent before the homeserver is expected to answer (R19)', async () => {
  const timers = [];
  const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } };
  const handlers = loadMain(() => new Promise(() => {}), fake);
  void relayed(handlers, 'upload', { method: 'POST', body: new ArrayBuffer(50 * MB) });
  await new Promise(resolve => setImmediate(resolve));
  const armed = timers.filter(timer => timer.fn);
  assert.equal(armed.length, 1);
  // 50 MB at a slow uplink (64 KB/s) takes about 13 minutes: more than the 5 a silent answer gets.
  assert.ok(armed[0].ms >= 5 * 60_000 + (50 * MB) / 65.536, `${Math.round(armed[0].ms / 60_000)} min`);
});

test("a frame's relayed requests are its own, and end when it goes (R17's frame, not the page)", { timeout: 5_000 }, async () => {
  const { EventEmitter } = require('node:events');
  const waiting = [];
  const handlers = loadMain((_url, options) => new Promise((resolve, reject) => {
    waiting.push(resolve);
    const aborted = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (options.signal.aborted) aborted();
    options.signal.addEventListener('abort', aborted);
  }));
  const frame = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
  const one = frame('f1');
  const two = frame('f2');
  const call = (callerFrame, requestId) => handlers.get('fetch')({ sender: { id: 1 }, callerFrame }, { requestId, url: 'https://matrix.example/_matrix/client/v3/sync', method: 'GET' });
  const first = call(one, 'same-id');
  const second = call(two, 'same-id');
  await new Promise(resolve => setImmediate(resolve));
  await handlers.get('fetch-abort')({ sender: { id: 1 }, callerFrame: one }, 'same-id');
  assert.equal((await first).ok, false, "the first frame's own, aborted");
  one.emit('destroyed');
  const third = call(two, 'other');
  two.emit('destroyed');
  assert.equal((await third).ok, false, 'a frame that goes takes its requests with it');
  assert.equal((await second).ok, false);
  assert.equal(two.listenerCount('destroyed'), 0, 'and lets go of the frame');
});

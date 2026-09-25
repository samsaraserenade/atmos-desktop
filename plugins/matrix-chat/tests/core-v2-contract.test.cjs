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
    module: { exports: {} }, exports: {}, URL, AbortController, Uint8Array,
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
    module: { exports: {} }, exports: {}, URL, AbortController, Uint8Array,
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

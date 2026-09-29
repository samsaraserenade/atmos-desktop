'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionHost } = require('./extension-host.cjs');

test('renderer and main-process capability registries stay aligned', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, 'capabilities.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, 'extension-host.cjs'), 'utf8');
  const names = source => [...source.matchAll(/'([a-z][a-z0-9.-]+)'\s*:\s*1/g)].map(match => match[1]).sort();
  assert.deepEqual(names(mainSource), names(rendererSource));
});

test('capabilities Core still has do not prevent main-process activation', async () => {
  const handlers = new Map();
  const host = createExtensionHost({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-sidebar-capability-'));
  try {
    const plugin = path.join(root, 'resizable-plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({
      apiVersion: 2,
      requires: { 'extensions.manifest': 1, 'lifecycle.context': 1 },
      permissions: { ipc: true },
    }));
    fs.writeFileSync(path.join(plugin, 'main.cjs'), `module.exports = context => context.handle('list-files', () => ['ok']);`);
    await host.activateRoot('plugin', root);
    const handler = handlers.get('atmos-extension:plugin:resizable-plugin:list-files');
    assert.equal(typeof handler, 'function');
    assert.deepEqual(handler(), ['ok']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extensions receive isolated IPC channels', async () => {
  const handlers = new Map();
  const sent = [];
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const host = createExtensionHost({ ipcMain });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-host-'));
  try {
    const plugin = path.join(root, 'example-plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({ permissions: { ipc: true } }));
    fs.writeFileSync(path.join(plugin, 'main.cjs'), `module.exports = context => { context.handle('read:value', () => 42); context.send({ send: (...args) => global.sent.push(args) }, 'changed', { ok: true }); };`);
    global.sent = sent;
    await host.activateRoot('plugin', root);
    assert.equal(await handlers.get('atmos-extension:plugin:example-plugin:read:value')(), 42);
    assert.deepEqual(sent, [['atmos-extension:plugin:example-plugin:changed', { ok: true }]]);
  } finally {
    delete global.sent;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugin metadata suppresses only valid legacy service ids', () => {
  const host = createExtensionHost({ ipcMain: { handle() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-meta-'));
  try {
    const plugin = path.join(root, 'gallery');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({ supersedesServices: ['gallery-import', '../escape', 'Bad Name'] }));
    assert.deepEqual([...host.supersededServices(root)], ['gallery-import']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled plugins do not suppress services', () => {
  const host = createExtensionHost({ ipcMain: { handle() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-meta-'));
  try {
    const plugin = path.join(root, 'replacement');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({ supersedesServices: ['legacy-service'] }));
    assert.deepEqual([...host.supersededServices(root, { exclude: new Set(['replacement']) })], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incompatible plugins cannot suppress legacy services', () => {
  const host = createExtensionHost({ ipcMain: { handle() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-meta-'));
  try {
    const plugin = path.join(root, 'future-plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({
      apiVersion: 999,
      supersedesServices: ['media-metadata'],
    }));
    assert.deepEqual([...host.supersededServices(root)], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incompatible main-process extensions are rejected before require executes them', async () => {
  const host = createExtensionHost({ ipcMain: { handle() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-compat-'));
  const marker = `__atmos_incompatible_${Date.now()}`;
  try {
    const plugin = path.join(root, 'future-plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({ apiVersion: 999 }));
    fs.writeFileSync(
      path.join(plugin, 'main.cjs'),
      `globalThis.${marker} = true; module.exports = () => {};`,
    );

    await host.activateRoot('plugin', root);
    assert.equal(globalThis[marker], undefined);
  } finally {
    delete globalThis[marker];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('"after" orders activation and ignores missing dependencies', async () => {
  const { orderExtensions } = require('./extension-host.cjs');
  const ids = list => list.map(entry => entry.id);
  assert.deepEqual(ids(orderExtensions([
    { id: 'tagging', manifest: { after: ['media-library'] } },
    { id: 'media-library', manifest: {} },
    { id: 'converter', manifest: null },
  ])), ['converter', 'media-library', 'tagging']);
  assert.deepEqual(ids(orderExtensions([
    { id: 'b', manifest: { after: ['not-installed', 'BAD ID'] } },
    { id: 'a' },
  ])), ['a', 'b']);
  const warnings = [];
  assert.deepEqual(ids(orderExtensions([
    { id: 'x', manifest: { after: ['y'] } },
    { id: 'y', manifest: { after: ['x'] } },
    { id: 'z', manifest: { after: ['x'] } },
  ], message => warnings.push(message))), ['x', 'y', 'z']);
  assert.equal(warnings.length, 1);

  const order = [];
  global.activationOrder = order;
  const host = createExtensionHost({ ipcMain: { handle() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-order-'));
  try {
    for (const [id, manifest] of [['tagging', { after: ['media-library'] }], ['media-library', {}]]) {
      fs.mkdirSync(path.join(root, id));
      fs.writeFileSync(path.join(root, id, 'extension.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(root, id, 'main.cjs'), `module.exports = () => global.activationOrder.push('${id}');`);
    }
    await host.activateRoot('service', root);
    assert.deepEqual(order, ['media-library', 'tagging']);
  } finally {
    delete global.activationOrder;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main.cjs only receives what its permissions declare', async () => {
  const handlers = new Map();
  const seen = {};
  global.permissionProbe = seen;
  const host = createExtensionHost({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openPath() {} }, dialog: { showOpenDialog() {} }, app: {}, protocol: {},
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-permissions-'));
  const originalError = console.error;
  console.error = () => {};
  try {
    const write = (id, permissions, body) => {
      fs.mkdirSync(path.join(root, id));
      fs.writeFileSync(path.join(root, id, 'extension.json'), JSON.stringify({ permissions }));
      fs.writeFileSync(path.join(root, id, 'main.cjs'), `module.exports = context => { ${body} };`);
    };
    write('declared', { ipc: true, electron: ['shell'], provides: ['thing'] },
      "global.permissionProbe.declared = { shell: !!context.shell, dialog: !!context.dialog, ipcMain: !!context.ipcMain, protocol: !!context.protocol }; context.handle('ok', () => 1); context.provide('thing', 1);");
    write('undeclared', {}, "context.handle('sneaky', () => 1);");
    write('capability', {}, "global.permissionProbe.capability = typeof context.use;");
    await host.activateRoot('plugin', root);
    assert.deepEqual(seen.declared, { shell: true, dialog: false, ipcMain: false, protocol: false });
    assert.equal(handlers.has('atmos-extension:plugin:declared:ok'), true);
    assert.equal(handlers.has('atmos-extension:plugin:undeclared:sneaky'), false);
    assert.equal(seen.capability, 'undefined', 'main-process capabilities went with SDK 1.0');
  } finally {
    console.error = originalError;
    delete global.permissionProbe;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a main.cjs that stalls or throws is failed, withdrawn, and startup carries on', async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => { removed.push(channel); handlers.delete(channel); },
  };
  const host = createExtensionHost({ ipcMain });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-timeout-'));
  const write = (id, manifest, source) => {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'extension.json'), JSON.stringify({ permissions: { ipc: true }, ...manifest }));
    fs.writeFileSync(path.join(root, id, 'main.cjs'), source);
  };
  try {
    // Registers a handler, then never finishes; a late registration is refused.
    write('stalls', {}, `module.exports = context => { context.handle('early', () => 1); global.lateRegister = () => context.handle('late', () => 2); return new Promise(() => {}); };`);
    write('throws', {}, `module.exports = () => { throw new Error('boom'); };`);
    write('needs-stalls', { dependencies: { 'plugin:stalls': '*' } }, `module.exports = context => { global.needsStallsRan = true; };`);
    write('fine', {}, `module.exports = context => { context.handle('ok', () => 'ok'); };`);
    const failed = new Set();
    const started = Date.now();
    const results = await host.activateEntries('plugin', fs.readdirSync(root).map(id => ({ id, path: path.join(root, id) })), {
      timeoutMs: 150,
      onFailed: (kind, id) => failed.add(id),
      skip: (kind, id) => (id === 'needs-stalls' && failed.has('stalls') ? 'Needs Stalls, which failed to start' : null),
    });
    assert.ok(Date.now() - started < 5000);
    const by = Object.fromEntries(results.map(item => [item.id, item.result]));
    assert.deepEqual(by, { stalls: 'timed-out', throws: 'failed', 'needs-stalls': 'skipped', fine: 'activated' });
    assert.match(results.find(item => item.id === 'stalls').error, /within 0 s|within/);
    assert.deepEqual([...failed].sort(), ['stalls', 'throws']);
    assert.equal(global.needsStallsRan, undefined);
    assert.deepEqual(removed, ['atmos-extension:plugin:stalls:early']);
    assert.equal(handlers.has('atmos-extension:plugin:stalls:early'), false);
    assert.throws(() => global.lateRegister(), /failed to start/);
    assert.equal(await handlers.get('atmos-extension:plugin:fine:ok')(), 'ok');
  } finally {
    delete global.lateRegister;
    delete global.needsStallsRan;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the activation timeout is about ten seconds', () => {
  const { ACTIVATION_TIMEOUT_MS } = require('./extension-host.cjs');
  assert.equal(ACTIVATION_TIMEOUT_MS, 10_000);
});

test('IPC handlers: every call carries its caller, and a refusal stops it before the handler', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createExtensionHost } = require('./extension-host.cjs');
  const handlers = new Map();
  const asked = [];
  const host = createExtensionHost({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorizeInvoke: (event, caller, target) => {
      asked.push([caller, `${target.kind}:${target.id}`, target.name]);
      return caller === 'plugin:nosy' ? `${target.kind}:${target.id} doesn't share its '${target.name}' handler` : null;
    },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-host-caller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = path.join(root, 'tags');
  fs.mkdirSync(service);
  fs.writeFileSync(path.join(service, 'extension.json'), JSON.stringify({ permissions: { ipc: true } }));
  fs.writeFileSync(path.join(service, 'main.cjs'), "module.exports = context => context.handle('read', (event, file) => `read ${file}`);");
  await host.activateRoot('service', root);
  const handler = handlers.get('atmos-extension:service:tags:read');
  assert.equal(await handler({}, null, 'a.mp3'), 'read a.mp3', 'the Atmos page itself');
  assert.equal(await handler({}, 'plugin:player', 'b.mp3'), 'read b.mp3', 'an extension it shares with; the caller is not passed on');
  assert.throws(() => handler({}, 'plugin:nosy', '/etc/passwd'), /doesn't share its 'read' handler/);
  assert.deepEqual(asked, [[null, 'service:tags', 'read'], ['plugin:player', 'service:tags', 'read'], ['plugin:nosy', 'service:tags', 'read']]);
});

test('compatibility: "engines.atmos" against this Atmos, then the extension API and capabilities', () => {
  const { checkCompatibility, CORE_API_VERSION } = require('./extension-host.cjs');
  const at = (manifest, appVersion = '0.15.0') => checkCompatibility(manifest, { appVersion });
  assert.equal(CORE_API_VERSION, 4);
  assert.equal(at({}).compatible, true);
  assert.equal(at({ apiVersion: 3, requires: { 'extensions.frames': 3 } }).compatible, true, 'packages made before SDK 1.0 still run');
  assert.equal(at({ apiVersion: 4, engines: { atmos: '>=0.15.0' } }).compatible, true);
  assert.equal(at({ apiVersion: 4, engines: { atmos: '>=0.15.0' } }, '0.14.1').reason, 'Needs Atmos 0.15.0 or later; this is 0.14.1');
  assert.match(at({ engines: { atmos: 'soon' } }).reason, /isn't a version range/);
  assert.match(at({ engines: ['atmos'] }).reason, /must be an object/);
  assert.equal(at({ engines: { node: '>=20' } }).compatible, true, 'other engines are not Atmos\'s business');
  assert.match(at({ apiVersion: 5 }).reason, /Needs a newer Atmos/);
  assert.match(at({ requires: { 'panel.pass-through': 1 } }).reason, /capability this Atmos doesn't have/);
  assert.equal(checkCompatibility({ engines: { atmos: '>=9.0.0' } }).compatible, true, 'no known Atmos version: not checked');
});

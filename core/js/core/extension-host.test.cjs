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

test('sidebar sizing requirements do not prevent main-process activation', async () => {
  const handlers = new Map();
  const host = createExtensionHost({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-extension-sidebar-capability-'));
  try {
    const plugin = path.join(root, 'resizable-plugin');
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, 'extension.json'), JSON.stringify({
      apiVersion: 2,
      requires: { 'sidebar.resizable-sections': 1 },
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
    write('capability', { uses: [] }, "global.permissionProbe.capability = 'reached'; context.use('thing');");
    await host.activateRoot('plugin', root);
    assert.deepEqual(seen.declared, { shell: true, dialog: false, ipcMain: false, protocol: false });
    assert.equal(handlers.has('atmos-extension:plugin:declared:ok'), true);
    assert.equal(handlers.has('atmos-extension:plugin:undeclared:sneaky'), false);
    assert.equal(seen.capability, 'reached');
  } finally {
    console.error = originalError;
    delete global.permissionProbe;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

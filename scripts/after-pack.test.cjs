'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packOptionalExtensions } = require('./after-pack.cjs');
const { trustedKeyEntry, loadTrustedKeys, checkIndexSignature } = require('../core/js/core/extension-signing.cjs');
const { readPackage } = require('../core/js/core/extension-package.cjs');

test('a build keeps the system services built in and packs every other extension, signed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-afterpack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (kind, id, manifest) => {
    fs.mkdirSync(path.join(root, kind, id), { recursive: true });
    fs.writeFileSync(path.join(root, kind, id, 'extension.json'), JSON.stringify({ apiVersion: 3, version: '1.0.0', publisher: 'atmos', permissions: {}, ...manifest }));
    fs.writeFileSync(path.join(root, kind, id, 'boot.js'), '// boot');
  };
  add('services', 'wallpaper', { tier: 'system' });
  add('services', 'charting', { version: '1.2.0' });
  add('plugins', 'finance', { dependencies: { charting: '^1.2.0' } });
  const key = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, 'keys.json'), JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey)] }));
  const trustedKeys = loadTrustedKeys([path.join(root, 'keys.json')], () => {});

  const packed = await packOptionalExtensions(root, { privateKey: key.privateKey, trustedKeys });
  assert.deepEqual(packed.map(item => `${item.kind}:${item.id}`).sort(), ['plugin:finance', 'service:charting']);
  assert.ok(fs.existsSync(path.join(root, 'services', 'wallpaper', 'extension.json')), 'system services stay built in');
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'finance')), false);
  assert.equal(fs.existsSync(path.join(root, 'services', 'charting')), false);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'index.json'), 'utf8'));
  assert.equal(index.name, 'Comes with Atmos');
  assert.equal(checkIndexSignature(index, trustedKeys).ok, true);
  const names = readPackage(fs.readFileSync(path.join(root, 'packages', 'finance-1.0.0.atmos'))).map(entry => entry.name);
  assert.ok(names.includes('signature.json') && names.includes('boot.js'));

  // A key that isn't official stops the build rather than shipping community packages.
  add('plugins', 'notes', {});
  await assert.rejects(packOptionalExtensions(root, { privateKey: crypto.generateKeyPairSync('ed25519').privateKey, trustedKeys }), /official key/);
});

test('a release build keeps only the system services; the rest is downloaded', t => {
  const { dropOptionalExtensions } = require('./after-pack.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-afterpack-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [kind, id, tier] of [['services', 'audio', 'system'], ['services', 'charting', 'first-party'], ['plugins', 'finance', 'first-party']]) {
    fs.mkdirSync(path.join(root, kind, id), { recursive: true });
    fs.writeFileSync(path.join(root, kind, id, 'extension.json'), JSON.stringify({ tier, version: '1.0.0' }));
  }
  assert.deepEqual(dropOptionalExtensions(root).sort(), ['charting', 'finance']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'services')), ['audio']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'plugins')), []);
  assert.equal(fs.existsSync(path.join(root, 'packages')), false);
});

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

test('a personal build packs every bundled extension but the built-in ones, signed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-afterpack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (kind, id, manifest) => {
    fs.mkdirSync(path.join(root, kind, id), { recursive: true });
    fs.writeFileSync(path.join(root, kind, id, 'extension.json'), JSON.stringify({ apiVersion: 3, version: '1.0.0', publisher: 'atmos', permissions: {}, ...manifest }));
    fs.writeFileSync(path.join(root, kind, id, 'boot.js'), '// boot');
  };
  add('services', 'charting', { version: '1.2.0' });
  add('plugins', 'finance', { dependencies: { charting: '^1.2.0' } });
  add('plugins', 'browser', {});
  const key = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, 'keys.json'), JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey)] }));
  const trustedKeys = loadTrustedKeys([path.join(root, 'keys.json')], () => {});
  const builtIn = { plugins: new Set(['browser']), services: new Set() };

  const packed = await packOptionalExtensions(root, { privateKey: key.privateKey, trustedKeys, builtIn });
  assert.deepEqual(packed.map(item => `${item.kind}:${item.id}`).sort(), ['plugin:finance', 'service:charting']);
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'finance')), false);
  assert.equal(fs.existsSync(path.join(root, 'services', 'charting')), false);
  // Atmos Browser, built in: stays part of the build, not a package.
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'browser', 'extension.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'packages', 'browser-1.0.0.atmos')), false);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'index.json'), 'utf8'));
  assert.equal(index.name, 'Comes with Atmos');
  assert.equal(checkIndexSignature(index, trustedKeys).ok, true);
  const names = readPackage(fs.readFileSync(path.join(root, 'packages', 'finance-1.0.0.atmos'))).map(entry => entry.name);
  assert.ok(names.includes('signature.json') && names.includes('boot.js'));

  // A key that isn't official stops the build rather than shipping community packages.
  add('plugins', 'notes', {});
  await assert.rejects(packOptionalExtensions(root, { privateKey: crypto.generateKeyPairSync('ed25519').privateKey, trustedKeys, builtIn }), /official key/);
  // System services are part of Core (core/system), never bundled extensions.
  fs.rmSync(path.join(root, 'plugins', 'notes'), { recursive: true });
  add('services', 'wallpaper', { tier: 'system' });
  await assert.rejects(packOptionalExtensions(root, { privateKey: key.privateKey, trustedKeys, builtIn }), /system services live in core\/system/);
});

test('a release build bundles only the built-in extensions; the rest are downloaded', t => {
  const { dropOptionalExtensions } = require('./after-pack.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-afterpack-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [kind, id, tier] of [['services', 'charting', 'first-party'], ['plugins', 'finance', 'first-party'], ['plugins', 'browser', 'first-party']]) {
    fs.mkdirSync(path.join(root, kind, id), { recursive: true });
    fs.writeFileSync(path.join(root, kind, id, 'extension.json'), JSON.stringify({ tier, version: '1.0.0' }));
  }
  const builtIn = { plugins: new Set(['browser']), services: new Set() };
  assert.deepEqual(dropOptionalExtensions(root, builtIn).sort(), ['charting', 'finance']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'services')), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'plugins')), ['browser']);
  assert.equal(fs.existsSync(path.join(root, 'packages')), false);
  // A built-in extension that isn't released (not in the build) stops it.
  fs.rmSync(path.join(root, 'plugins', 'browser'), { recursive: true });
  assert.throws(() => dropOptionalExtensions(root, builtIn), /built in .* but not in the build/);
});

test('Core\'s list of built-in extensions names Atmos Browser, which release.json releases', () => {
  const { readBuiltIn } = require('./after-pack.cjs');
  const builtIn = readBuiltIn();
  assert.deepEqual([...builtIn.plugins], ['browser']);
  assert.deepEqual([...builtIn.services], []);
  const release = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release.json'), 'utf8'));
  for (const id of builtIn.plugins) assert.ok(release.plugins.includes(id), `${id} is built in, so it must be released`);
  for (const id of builtIn.services) assert.ok(release.services.includes(id), `${id} is built in, so it must be released`);
});

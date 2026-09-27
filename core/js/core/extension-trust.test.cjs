'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExtensionCatalog } = require('./extension-catalog.cjs');
const { createExtensionTrust } = require('./extension-trust.cjs');
const { writeIntegrityList } = require('./extension-integrity.cjs');

function fixture(trustedKeys = new Map()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-trust-'));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const bundled = kind => path.join(dir, 'bundled', kind);
  const installed = kind => path.join(dir, 'installed', kind);
  const setup = () => {
    const catalog = createExtensionCatalog({ bundledRoot: bundled, installedRoot: installed, trustedKeys, warn() {} });
    const trust = createExtensionTrust({
      approvalsFile: path.join(dir, 'user', 'approvals.json'),
      hashCacheFile: path.join(dir, 'user', 'hash-cache.json'),
      bundledRoot: bundled,
      trustedKeys,
      warn() {},
    });
    trust.assessAll(catalog);
    return { catalog, trust };
  };
  return { dir, write, setup };
}

test('bundled extensions are unverified without integrity.json, verified with it, tampered when changed', () => {
  const { dir, write, setup } = fixture();
  write('bundled/plugins/alpha/extension.json', { apiVersion: 3, permissions: {} });
  write('bundled/plugins/alpha/boot.js', 'export default 1;');
  write('bundled/services/beta/extension.json', { apiVersion: 3, tier: 'system', permissions: {} });

  let { catalog, trust } = setup();
  assert.equal(trust.get(catalog.find('plugins', 'alpha')).status, 'unverified');
  assert.equal(trust.get(catalog.find('plugins', 'alpha')).loadable, true);

  writeIntegrityList(path.join(dir, 'bundled'));
  ({ catalog, trust } = setup());
  assert.equal(trust.get(catalog.find('plugins', 'alpha')).status, 'verified');
  assert.equal(trust.get(catalog.find('services', 'beta')).status, 'verified');

  write('bundled/plugins/alpha/boot.js', 'export default 2;');
  write('bundled/services/beta/extra.js', 'steal()');
  write('bundled/services/beta/Thumbs.db', 'ignored');
  ({ catalog, trust } = setup());
  const alpha = trust.get(catalog.find('plugins', 'alpha'));
  assert.equal(alpha.status, 'tampered');
  assert.match(alpha.reason, /changed boot\.js/);
  assert.equal(alpha.loadable, false);
  // System extensions are not exempt.
  const beta = trust.get(catalog.find('services', 'beta'));
  assert.equal(beta.status, 'tampered');
  assert.match(beta.reason, /added extra\.js/);
});

test('third-party extensions need approval, and changes need it again', () => {
  const { write, setup } = fixture();
  write('installed/plugins/gamma/extension.json', { apiVersion: 3, permissions: { network: ['api.example.net'] } });
  write('installed/plugins/gamma/boot.js', 'export default 1;');

  let { catalog, trust } = setup();
  let gamma = trust.get(catalog.find('plugins', 'gamma'));
  assert.equal(gamma.status, 'pending');
  assert.equal(gamma.loadable, false);
  assert.deepEqual(gamma.permissionSummary, ['Connect to api.example.net']);

  assert.throws(() => trust.approve('plugins', catalog.find('plugins', 'gamma'), 'stale'), /changed while you were reviewing/);
  trust.approve('plugins', catalog.find('plugins', 'gamma'), gamma.fingerprint);
  assert.equal(trust.get(catalog.find('plugins', 'gamma')).approvalChanged, true);

  ({ catalog, trust } = setup());
  gamma = trust.get(catalog.find('plugins', 'gamma'));
  assert.equal(gamma.status, 'approved');
  assert.equal(gamma.loadable, true);

  // A code change alone needs re-approval, with no new permissions listed.
  write('installed/plugins/gamma/boot.js', 'export default 2;');
  ({ catalog, trust } = setup());
  gamma = trust.get(catalog.find('plugins', 'gamma'));
  assert.equal(gamma.status, 'changed');
  assert.deepEqual(gamma.newPermissions, []);

  // Asking for more is reported as such.
  write('installed/plugins/gamma/extension.json', { apiVersion: 3, permissions: { network: ['*'], browser: ['geolocation'] } });
  ({ catalog, trust } = setup());
  gamma = trust.get(catalog.find('plugins', 'gamma'));
  assert.equal(gamma.status, 'changed');
  assert.deepEqual(gamma.newPermissions, ['Use your location', 'Connect to any website or server']);

  trust.revoke(catalog.find('plugins', 'gamma'));
  ({ catalog, trust } = setup());
  assert.equal(trust.get(catalog.find('plugins', 'gamma')).status, 'pending');
});

test('third-party extensions cannot have main-process code or permissions', () => {
  const { write, setup } = fixture();
  write('installed/services/delta/extension.json', { apiVersion: 3, permissions: {} });
  write('installed/services/delta/main.cjs', 'module.exports = {}');
  write('installed/services/epsilon/extension.json', { apiVersion: 3, permissions: { node: ['fs'] } });
  write('installed/services/zeta/boot.js', 'export default 1;');
  write('installed/services/eta/extension.json', { apiVersion: 3, permissions: { network: 'everything' } });
  const { catalog, trust } = setup();
  const status = id => trust.get(catalog.find('services', id));
  assert.equal(status('delta').status, 'blocked');
  assert.match(status('delta').reason, /main\.cjs/);
  assert.equal(status('epsilon').status, 'blocked');
  assert.match(status('epsilon').reason, /main-process permissions \(node\)/);
  assert.match(status('zeta').reason, /no extension\.json/);
  assert.match(status('eta').reason, /permissions are invalid/);
  assert.throws(() => trust.approve('services', catalog.find('services', 'delta'), 'x'), /main\.cjs/);
});

test('an installed copy of a bundled extension is ignored, not approvable', () => {
  const { write, setup } = fixture();
  write('bundled/plugins/alpha/extension.json', { apiVersion: 3, permissions: {} });
  write('installed/plugins/alpha/extension.json', { apiVersion: 3, permissions: {} });
  const { catalog, trust } = setup();
  const alpha = catalog.find('plugins', 'alpha');
  assert.equal(alpha.source, 'bundled');
  assert.throws(() => trust.approve('plugins', alpha, 'x'), /Only community/);
});

// ── Signed (official) packages ──────────────────────────────────────────

const crypto = require('crypto');
const { trustedKeyEntry, loadTrustedKeys, signExtension } = require('./extension-signing.cjs');
const { createHasher } = require('./extension-integrity.cjs');

function signedFixture() {
  const official = crypto.generateKeyPairSync('ed25519');
  const stranger = crypto.generateKeyPairSync('ed25519');
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-keys-'));
  fs.writeFileSync(path.join(keysDir, 'k.json'), JSON.stringify({ format: 1, keys: [trustedKeyEntry(official.publicKey)] }));
  const trustedKeys = loadTrustedKeys([path.join(keysDir, 'k.json')], () => {});
  const f = fixture(trustedKeys);
  const sign = (rel, key = official.privateKey) => {
    const [, kind, id] = rel.split('/');
    signExtension(path.join(f.dir, rel), { kind: kind === 'plugins' ? 'plugin' : 'service', id, privateKey: key, hasher: createHasher(null) });
  };
  return { ...f, sign, stranger };
}

test('an installed extension signed with an official key is official, main.cjs and all', () => {
  const { write, setup, sign } = signedFixture();
  write('installed/plugins/sounds/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: { ipc: true } });
  write('installed/plugins/sounds/main.cjs', 'module.exports = { activate() {} };');
  sign('installed/plugins/sounds');
  let { catalog, trust } = setup();
  let sounds = catalog.find('plugins', 'sounds');
  assert.equal(sounds.tier, 'first-party');
  assert.equal(sounds.source, 'installed');
  assert.equal(trust.get(sounds).status, 'verified');
  assert.equal(trust.get(sounds).loadable, true);
  assert.equal(trust.get(sounds).signature.publisher, 'atmos');
  assert.throws(() => trust.approve('plugins', sounds, 'x'), /Only community/);

  // One changed byte: tampered, not loaded, and not demoted to community.
  write('installed/plugins/sounds/main.cjs', 'module.exports = { activate() { steal(); } };');
  ({ catalog, trust } = setup());
  sounds = catalog.find('plugins', 'sounds');
  assert.equal(sounds.tier, 'first-party');
  assert.equal(trust.get(sounds).status, 'tampered');
  assert.match(trust.get(sounds).reason, /changed main\.cjs/);
  assert.equal(trust.get(sounds).loadable, false);
});

test('signatures from unknown keys are ignored: the extension is community', () => {
  const { write, setup, sign, stranger } = signedFixture();
  write('installed/plugins/clock/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: {} });
  write('installed/plugins/clock/boot.js', '');
  sign('installed/plugins/clock', stranger.privateKey);
  const { catalog, trust } = setup();
  const clock = catalog.find('plugins', 'clock');
  assert.equal(clock.tier, 'third-party');
  assert.equal(clock.signature.status, 'untrusted');
  assert.equal(trust.get(clock).status, 'pending');
});

test('the highest official version wins over the bundled copy, which stays as the fallback', () => {
  const { write, setup, sign } = signedFixture();
  write('bundled/plugins/sounds/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: {} });
  write('bundled/plugins/sounds/boot.js', 'export default "bundled";');
  write('installed/plugins/sounds/extension.json', { version: '1.1.0', publisher: 'atmos', permissions: {} });
  write('installed/plugins/sounds/boot.js', 'export default "update";');
  sign('installed/plugins/sounds');
  let { catalog, trust } = setup();
  let sounds = catalog.find('plugins', 'sounds');
  assert.equal(sounds.source, 'installed');
  assert.equal(sounds.version, '1.1.0');
  assert.equal(sounds.fallback.source, 'bundled');
  assert.equal(trust.get(sounds).status, 'verified');

  // The update is damaged: Atmos falls back to the bundled 1.0.0.
  write('installed/plugins/sounds/boot.js', 'export default "damaged";');
  ({ catalog, trust } = setup());
  sounds = catalog.find('plugins', 'sounds');
  assert.equal(sounds.source, 'bundled');
  assert.equal(sounds.version, '1.0.0');
  assert.equal(sounds.replaced.version, '1.1.0');
  const result = trust.get(sounds);
  assert.equal(result.loadable, true);
  assert.equal(result.fellBackFrom.status, 'tampered');

  // An older signed copy never beats the bundled one.
  write('installed/plugins/sounds/extension.json', { version: '0.9.0', publisher: 'atmos', permissions: {} });
  write('installed/plugins/sounds/boot.js', 'export default "old";');
  sign('installed/plugins/sounds');
  ({ catalog } = setup());
  assert.equal(catalog.find('plugins', 'sounds').source, 'bundled');
});

test('a community copy never replaces an official extension, and a broken signature never becomes community', () => {
  const { write, setup, sign } = signedFixture();
  write('bundled/services/charting/extension.json', { version: '1.2.0', publisher: 'atmos', permissions: {} });
  write('installed/services/charting/extension.json', { version: '9.0.0', publisher: 'atmos', permissions: {} });
  write('installed/services/notes/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: {} });
  write('installed/services/notes/boot.js', '');
  sign('installed/services/notes');
  write('installed/services/notes/signature.json', '{ broken');
  const { catalog, trust } = setup();
  const charting = catalog.find('services', 'charting');
  assert.equal(charting.source, 'bundled');
  assert.equal(charting.tier, 'first-party');
  const notes = catalog.find('services', 'notes');
  assert.equal(notes.tier, 'first-party');
  assert.equal(trust.get(notes).status, 'tampered');
  assert.match(trust.get(notes).reason, /unreadable/);
});

test('a bundled extension without integrity.json is checked against its own signature', () => {
  const { write, setup, sign } = signedFixture();
  write('bundled/plugins/sounds/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: {} });
  write('bundled/plugins/sounds/boot.js', '1');
  sign('bundled/plugins/sounds');
  let { catalog, trust } = setup();
  assert.equal(trust.get(catalog.find('plugins', 'sounds')).status, 'verified');
  write('bundled/plugins/sounds/boot.js', '2');
  ({ catalog, trust } = setup());
  assert.equal(trust.get(catalog.find('plugins', 'sounds')).status, 'tampered');
});

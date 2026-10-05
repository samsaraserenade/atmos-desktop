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
  const setup = (options = {}) => {
    const catalog = createExtensionCatalog({ bundledRoot: bundled, installedRoot: installed, trustedKeys, warn() {} });
    const trust = createExtensionTrust({
      approvalsFile: path.join(dir, 'user', 'approvals.json'),
      hashCacheFile: path.join(dir, 'user', 'hash-cache.json'),
      bundledRoot: bundled,
      trustedKeys,
      warn() {},
      ...options,
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
  // The rev/ commands it adds are on the list it's approved on.
  {
    const { write: put, setup: start } = fixture();
    put('installed/plugins/delta/extension.json', { apiVersion: 3, contributes: { commands: [{ name: 'roll', about: 'Roll a die' }, { name: 'switch' }, { name: 'flip' }] } });
    put('installed/plugins/delta/panel.js', 'export default 1;');
    const started = start();
    assert.deepEqual(started.trust.get(started.catalog.find('plugins', 'delta')).permissionSummary,
      ['Adds commands to Atmos\'s command bar: rev/roll, rev/flip'], 'what it adds, not "No special permissions" above it');
  }

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

test('web pages ("web": true) are for official extensions only: a community one asking is blocked, whatever else', () => {
  const { write, setup } = fixture();
  write('installed/plugins/surfer/extension.json', { apiVersion: 4, permissions: { web: true } });
  write('installed/plugins/surfer/panel.js', 'export default 1;');
  write('installed/plugins/plain/extension.json', { apiVersion: 4, permissions: { web: false } });
  write('installed/plugins/plain/panel.js', 'export default 1;');
  const { catalog, trust } = setup();
  const surfer = trust.get(catalog.find('plugins', 'surfer'));
  assert.equal(surfer.status, 'blocked');
  assert.match(surfer.reason, /\(web\) only official, signed extensions/);
  assert.throws(() => trust.approve('plugins', catalog.find('plugins', 'surfer'), 'x'));
  assert.equal(trust.get(catalog.find('plugins', 'plain')).status, 'pending', '"web": false asks for nothing');
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

test('an extension made for another Atmos is incompatible, and an official update that is falls back', () => {
  const { checkCompatibility } = require('./extension-host.cjs');
  const { write, setup, sign } = signedFixture();
  const compatibility = manifest => checkCompatibility(manifest, { appVersion: '0.15.0' });
  write('installed/plugins/later/extension.json', { apiVersion: 4, engines: { atmos: '>=0.16.0' }, permissions: {} });
  write('installed/plugins/later/panel.js', 'export {};');
  write('installed/plugins/fine/extension.json', { apiVersion: 4, engines: { atmos: '>=0.15' }, permissions: {} });
  write('installed/plugins/fine/panel.js', 'export {};');
  write('installed/plugins/future-api/extension.json', { apiVersion: 5, permissions: {} });
  write('bundled/plugins/sounds/extension.json', { version: '1.0.0', publisher: 'atmos', permissions: {} });
  write('installed/plugins/sounds/extension.json', { version: '1.1.0', publisher: 'atmos', engines: { atmos: '^0.16.0' }, permissions: {} });
  sign('installed/plugins/sounds');
  const { catalog, trust } = setup({ compatibility });

  const later = trust.get(catalog.find('plugins', 'later'));
  assert.equal(later.status, 'incompatible');
  assert.equal(later.loadable, false);
  assert.equal(later.reason, 'Needs Atmos 0.16.0 or later; this is 0.15.0');
  assert.equal(later.fingerprint, undefined, 'nothing to approve');
  assert.equal(trust.get(catalog.find('plugins', 'fine')).status, 'pending', 'a compatible community extension still needs approval');
  assert.match(trust.get(catalog.find('plugins', 'future-api')).reason, /Needs a newer Atmos \(extension API 5/);

  const sounds = catalog.find('plugins', 'sounds');
  assert.equal(sounds.source, 'bundled', 'the update needs Atmos 0.16, so the bundled 1.0.0 runs');
  assert.equal(trust.get(sounds).fellBackFrom.status, 'incompatible');
});

test('an update is compared with what was approved as data: a swapped host is named', () => {
  const { dir, write, setup } = fixture();
  const five = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'];
  write('installed/plugins/hosts/extension.json', { apiVersion: 3, permissions: { network: five } });
  write('installed/plugins/hosts/panel.js', 'export {};');
  let { catalog, trust } = setup();
  let hosts = trust.get(catalog.find('plugins', 'hosts'));
  assert.deepEqual(hosts.permissionSummary, [`Connect to ${five.join(', ')}`], 'a community extension is approved on every host, named');
  trust.approve('plugins', catalog.find('plugins', 'hosts'), hosts.fingerprint);

  write('installed/plugins/hosts/extension.json', { apiVersion: 3, permissions: { network: [...five.slice(0, 4), 'evil.example'] } });
  ({ catalog, trust } = setup());
  hosts = trust.get(catalog.find('plugins', 'hosts'));
  assert.equal(hosts.status, 'changed');
  assert.match(hosts.reason, /now asks for more/);
  assert.deepEqual(hosts.newPermissions, ['Connect to evil.example']);

  // Narrowed: changed files, nothing more asked for.
  write('installed/plugins/hosts/extension.json', { apiVersion: 3, permissions: { network: five.slice(0, 2) } });
  ({ catalog, trust } = setup());
  hosts = trust.get(catalog.find('plugins', 'hosts'));
  assert.equal(hosts.reason, 'Its files changed since you approved it');
  assert.deepEqual(hosts.newPermissions, []);

  // An approval an older Atmos wrote, with a permission that no longer exists: readable, and everything is new.
  const approvals = JSON.parse(fs.readFileSync(path.join(dir, 'user', 'approvals.json'), 'utf8'));
  approvals['plugin:hosts'].permissions = { uses: ['old-capability'], network: five };
  fs.writeFileSync(path.join(dir, 'user', 'approvals.json'), JSON.stringify(approvals));
  ({ catalog, trust } = setup());
  hosts = trust.get(catalog.find('plugins', 'hosts'));
  assert.equal(hosts.status, 'changed');
  assert.deepEqual(hosts.newPermissions, ['Connect to a.example.com, b.example.com']);
});

test('a developer folder loads as community without approval, and never stands in for an installed copy', () => {
  const { dir, write } = fixture();
  write('dev/weather/extension.json', { apiVersion: 4, permissions: { network: ['api.test.example'] } });
  write('dev/weather/panel.js', 'export {};');
  write('dev/sneaky/extension.json', { permissions: { ipc: true } });
  write('dev/sneaky/main.cjs', 'module.exports = () => {};');
  write('dev/alpha/extension.json', { permissions: {} });
  write('installed/plugins/taken/extension.json', { permissions: {} });
  write('dev/taken/extension.json', { permissions: { network: ['api.test.example'] } });
  write('bundled/plugins/alpha/extension.json', { permissions: {} });
  const catalog = createExtensionCatalog({
    bundledRoot: kind => path.join(dir, 'bundled', kind),
    installedRoot: kind => path.join(dir, 'installed', kind),
    developerFolders: kind => (kind === 'plugins' ? ['weather', 'sneaky', 'alpha', 'taken', 'Not_An_Id'].map(name => path.join(dir, 'dev', name)) : []),
    warn() {},
  });
  const trust = createExtensionTrust({ approvalsFile: path.join(dir, 'user', 'approvals.json'), bundledRoot: kind => path.join(dir, 'bundled', kind), warn() {} });
  trust.assessAll(catalog);

  const weather = catalog.find('plugins', 'weather');
  assert.equal(weather.source, 'developer');
  assert.equal(weather.tier, 'third-party');
  assert.equal(weather.path, path.join(dir, 'dev', 'weather'));
  assert.equal(trust.get(weather).status, 'developer');
  assert.equal(trust.get(weather).loadable, true);
  assert.throws(() => trust.approve('plugins', weather, 'x'), /without approval/);

  assert.equal(trust.get(catalog.find('plugins', 'sneaky')).status, 'blocked', 'community rules still apply: no main.cjs');
  assert.equal(catalog.find('plugins', 'alpha').source, 'bundled', 'an official copy wins');
  assert.equal(catalog.find('plugins', 'alpha').developerIgnored, path.join(dir, 'dev', 'alpha'));
  // An installed community copy wins too: the folder would otherwise run in
  // its origin, with its storage and state, without being approved.
  const taken = catalog.find('plugins', 'taken');
  assert.equal(taken.source, 'installed');
  assert.equal(taken.developerIgnored, path.join(dir, 'dev', 'taken'));
  assert.equal(trust.get(taken).status, 'pending');

  // A changed manifest is read again.
  write('dev/weather/extension.json', { apiVersion: 4, permissions: { network: ['api.test.example', 'other.test.example'] } });
  weather.manifest = JSON.parse(fs.readFileSync(path.join(dir, 'dev', 'weather', 'extension.json'), 'utf8'));
  assert.deepEqual(trust.reassess('plugins', weather).permissions.network, ['api.test.example', 'other.test.example']);
  assert.deepEqual(trust.get(weather).permissions.network, ['api.test.example', 'other.test.example']);
});

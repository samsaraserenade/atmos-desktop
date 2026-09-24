'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExtensionCatalog } = require('./extension-catalog.cjs');
const { createExtensionTrust } = require('./extension-trust.cjs');
const { writeIntegrityList } = require('./extension-integrity.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-trust-'));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const bundled = kind => path.join(dir, 'bundled', kind);
  const installed = kind => path.join(dir, 'installed', kind);
  const setup = () => {
    const catalog = createExtensionCatalog({ bundledRoot: bundled, installedRoot: installed, warn() {} });
    const trust = createExtensionTrust({
      approvalsFile: path.join(dir, 'user', 'approvals.json'),
      hashCacheFile: path.join(dir, 'user', 'hash-cache.json'),
      bundledRoot: bundled,
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
  assert.throws(() => trust.approve('plugins', alpha, 'x'), /Only third-party/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHasher, listFiles } = require('./extension-integrity.cjs');
const { signExtension, trustedKeyEntry, loadTrustedKeys, signIndex } = require('./extension-signing.cjs');
const { packFolder } = require('./extension-package.cjs');
const { createExtensionCatalog } = require('./extension-catalog.cjs');
const { createExtensionTrust } = require('./extension-trust.cjs');
const { createExtensionManager } = require('./extension-manager.cjs');

/** A temp world: a key, a source folder, bundled and installed roots, user data. */
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-manager-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const official = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ format: 1, keys: [trustedKeyEntry(official.publicKey)] }));
  const trustedKeys = loadTrustedKeys([path.join(dir, 'keys.json')], () => {});
  const source = path.join(dir, 'source');
  const userData = path.join(dir, 'user');
  fs.mkdirSync(source, { recursive: true });
  const root = (where, kind) => path.join(dir, where, kind);

  /** Publish kind/id@version (files) to the source folder, and re-sign the index. */
  function publish(kind, id, version, { files = {}, dependencies = {}, key = official.privateKey, apiVersion = 3, engines = undefined } = {}) {
    const ext = path.join(dir, 'build', `${id}-${version}`);
    fs.rmSync(ext, { recursive: true, force: true });
    fs.mkdirSync(ext, { recursive: true });
    const manifest = { apiVersion, version, publisher: 'atmos', displayName: id, dependencies, permissions: {}, ...(engines ? { engines } : {}) };
    fs.writeFileSync(path.join(ext, 'extension.json'), JSON.stringify(manifest));
    for (const [name, content] of Object.entries({ 'boot.js': `export default '${version}';`, ...files })) fs.writeFileSync(path.join(ext, name), content);
    signExtension(ext, { kind, id, privateKey: key, hasher: createHasher(null) });
    const buffer = packFolder(ext, listFiles);
    const file = `${id}-${version}.atmos`;
    fs.writeFileSync(path.join(source, file), buffer);
    const indexFile = path.join(source, 'index.json');
    const packages = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).packages : [];
    packages.push({ kind, id, version, publisher: 'atmos', displayName: id, apiVersion, requires: {}, ...(engines ? { engines } : {}), dependencies, file, size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    fs.writeFileSync(indexFile, JSON.stringify(signIndex({ format: 1, name: 'Test', generated: 'now', packages }, official.privateKey)));
  }

  function bundle(kind, id, version, manifestExtra = {}) {
    const ext = path.join(root('bundled', `${kind}s`), id);
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'extension.json'), JSON.stringify({ apiVersion: 3, version, publisher: 'atmos', displayName: id, permissions: {}, ...manifestExtra }));
    fs.writeFileSync(path.join(ext, 'boot.js'), `export default 'bundled ${version}';`);
  }

  /** One "start of Atmos": apply pending changes, then catalog + trust + manager. */
  function start({ seed = false, appVersion = null, builtIn = undefined } = {}) {
    let entries = [];
    const installedRoot = kind => root('installed', kind);
    const manager = createExtensionManager({
      userData, installedRoot, trustedKeys, installed: () => entries, warn() {}, appVersion, ...(builtIn ? { builtIn } : {}),
      ...(seed ? { seedSources: [{ location: source }] } : { extraSources: [source] }),
    });
    const applied = manager.applyPending();
    const catalog = createExtensionCatalog({
      bundledRoot: kind => root('bundled', kind), installedRoot, previousRoot: manager.previousRoot, trustedKeys, warn() {},
    });
    const trust = createExtensionTrust({ approvalsFile: path.join(userData, 'approvals.json'), bundledRoot: kind => root('bundled', kind), trustedKeys, warn() {} });
    trust.assessAll(catalog);
    entries = [...catalog.list('plugins'), ...catalog.list('services')].map(entry => ({ ...entry, loadable: trust.get(entry).loadable }));
    manager.confirmApplied((kind, id) => {
      const entry = catalog.find(`${kind}s`, id);
      return entry ? { entry, loadable: trust.get(entry).loadable } : null;
    });
    const find = (kind, id) => entries.find(entry => entry.kind === kind && entry.id === id) || null;
    return { manager, catalog, trust, applied, find, entries };
  }

  /** Re-sign the source's index with another "generated" time. */
  function resign(generated) {
    const indexFile = path.join(source, 'index.json');
    const { keyId: _k, signature: _s, ...body } = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    fs.writeFileSync(indexFile, JSON.stringify(signIndex({ ...body, generated }, official.privateKey)));
  }

  /** Re-sign the source's index with body changes (a "core" entry, say). */
  function resignWith(changes) {
    const indexFile = path.join(source, 'index.json');
    const { keyId: _k, signature: _s, ...body } = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    fs.writeFileSync(indexFile, JSON.stringify(signIndex({ ...body, ...changes }, official.privateKey)));
  }

  return { dir, source, userData, publish, bundle, start, root, resign, resignWith, stranger: crypto.generateKeyPairSync('ed25519') };
}

test('install stages a verified package and applies it at the next start, dependencies first', async t => {
  const w = world(t);
  w.publish('service', 'charting', '1.2.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: { charting: '^1.2.0', 'market-data': { version: '*', optional: true } } });
  let s = w.start();
  const status = await s.manager.checkForUpdates();
  assert.equal(status.sources[0].ok, true);
  assert.deepEqual(status.packages.map(p => `${p.id}:${p.action}`).sort(), ['charting:install', 'finance:install']);

  const result = await s.manager.install('plugin', 'finance');
  assert.deepEqual(result.changes.map(c => `${c.id}:${c.reason}`), ['charting:dependency', 'finance:install']);
  assert.equal(s.find('plugin', 'finance'), null, 'nothing changes until a restart');
  assert.equal(s.manager.status().pending.length, 2);

  s = w.start();
  assert.deepEqual(s.applied.map(a => `${a.action} ${a.id}`), ['install charting', 'install finance']);
  assert.equal(s.find('plugin', 'finance').tier, 'first-party');
  assert.equal(s.find('plugin', 'finance').loadable, true);
  assert.equal(s.find('service', 'charting').version, '1.2.0');
  assert.deepEqual(s.manager.status().pending, []);
  assert.deepEqual(s.manager.status().applied, []);
});

test('update keeps the previous version until the new one loads, and falls back to it if it can\'t', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  w.publish('plugin', 'sounds', '1.1.0');
  let status = await s.manager.checkForUpdates();
  assert.equal(status.updates, 1);
  assert.equal(status.packages[0].installedVersion, '1.0.0');
  await s.manager.install('plugin', 'sounds');

  // Tamper with the staged copy before the restart: the update can't load,
  // and Atmos runs the kept 1.0.0 instead.
  const staged = path.join(w.userData, s.manager.status().pending[0].staged);
  fs.appendFileSync(path.join(staged, 'boot.js'), '// changed');
  s = w.start();
  const sounds = s.find('plugin', 'sounds');
  assert.equal(sounds.version, '1.0.0');
  assert.equal(sounds.source, 'previous');
  assert.equal(sounds.loadable, true);
  assert.equal(s.manager.status().applied[0].failed, true);

  // Updating again with a good package: 1.1.0 loads and the kept copy goes.
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.1.0');
  assert.equal(s.find('plugin', 'sounds').source, 'installed');
  s = w.start();
  assert.equal(fs.existsSync(path.join(w.userData, 'extension-previous', 'plugins', 'sounds')), false);
  assert.deepEqual(s.manager.status().applied, []);
});

test('an update of a bundled extension goes into the installed folder and wins by version', async t => {
  const w = world(t);
  w.bundle('plugin', 'sounds', '1.0.0');
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  let status = await s.manager.checkForUpdates();
  assert.equal(status.packages[0].action, 'none');
  w.publish('plugin', 'sounds', '1.2.0');
  status = await s.manager.checkForUpdates();
  assert.equal(status.packages[0].action, 'update');
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.2.0');
  // Removing the update goes back to the bundled copy; the bundled one can't be removed.
  s.manager.remove('plugin', 'sounds');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').source, 'bundled');
  assert.throws(() => s.manager.remove('plugin', 'sounds'), /comes with Atmos; switch it off instead/);
});

test('remove refuses while something needs it, and can delete the extension\'s data', async t => {
  const w = world(t);
  w.publish('service', 'charting', '1.2.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: { charting: '^1.2.0' } });
  let s = w.start();
  await s.manager.install('plugin', 'finance');
  s = w.start();
  assert.throws(() => s.manager.remove('service', 'charting'), /finance needs it; remove that first/);

  fs.mkdirSync(path.join(w.userData, 'finance'), { recursive: true });
  fs.writeFileSync(path.join(w.userData, 'finance', 'connection.bin'), 'secret');
  s.manager.remove('plugin', 'finance', { deleteData: true });
  s.manager.remove('service', 'charting'); // finance is going too, so this is fine now
  s = w.start();
  assert.equal(s.find('plugin', 'finance'), null);
  assert.equal(s.find('service', 'charting'), null);
  assert.equal(fs.existsSync(path.join(w.userData, 'finance')), false);
  assert.deepEqual(s.manager.takeDataCleanup(), [{ kind: 'plugin', id: 'finance' }]);
  assert.deepEqual(s.manager.takeDataCleanup(), [], 'handed over once');
});

test('keeping data leaves the folder; cancel undoes a pending change', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s.manager.cancel('plugin', 'sounds');
  assert.deepEqual(s.manager.status().pending, []);
  s = w.start();
  assert.equal(s.find('plugin', 'sounds'), null);
  assert.deepEqual(fs.readdirSync(path.join(w.userData, 'extension-staging')), [], 'cancelled download cleaned up');

  await s.manager.install('plugin', 'sounds');
  s = w.start();
  fs.mkdirSync(path.join(w.userData, 'sounds'));
  s.manager.remove('plugin', 'sounds');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds'), null);
  assert.equal(fs.existsSync(path.join(w.userData, 'sounds')), true);
  assert.deepEqual(s.manager.takeDataCleanup(), []);
});

test('sources must be signed with an official key, and packages must match the index and their signature', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  const indexFile = path.join(w.source, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

  // An index edited after signing is refused.
  fs.writeFileSync(indexFile, JSON.stringify({ ...index, packages: [{ ...index.packages[0], version: '9.9.9' }] }));
  let s = w.start();
  let status = await s.manager.checkForUpdates();
  assert.equal(status.sources[0].ok, false);
  assert.match(status.sources[0].error, /signature does not match/);
  assert.equal(status.packages.length, 0);

  // A package swapped on the server no longer matches the index: a bigger
  // one is refused before more than the signed size is read, one of the
  // same size by its hash.
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const packageFile = path.join(w.source, 'sounds-1.0.0.atmos');
  const original = fs.readFileSync(packageFile);
  fs.appendFileSync(packageFile, 'x');
  await s.manager.checkForUpdates();
  await assert.rejects(s.manager.install('plugin', 'sounds'), /is too large/);
  const swapped = Buffer.from(original);
  swapped[swapped.length - 1] ^= 0xff;
  fs.writeFileSync(packageFile, swapped);
  await assert.rejects(s.manager.install('plugin', 'sounds'), /doesn't match the source's index/);
  fs.writeFileSync(packageFile, original);

  // A package signed with an unknown key, listed by an official index, is refused.
  w.publish('plugin', 'clock', '1.0.0', { key: w.stranger.privateKey });
  await s.manager.checkForUpdates();
  await assert.rejects(s.manager.install('plugin', 'clock'), /not an official package/);

  // Unsatisfiable dependencies are named.
  w.publish('plugin', 'needs', '1.0.0', { dependencies: { weather: '^2.0.0' } });
  await s.manager.checkForUpdates();
  assert.throws(() => s.manager.plan('plugin', 'needs'), /needs needs weather \^2\.0\.0, which none of your sources has/);

  // Packages this Core can't run are not offered.
  w.publish('plugin', 'future', '1.0.0', { apiVersion: 99 });
  status = await s.manager.checkForUpdates();
  assert.equal(status.packages.some(p => p.id === 'future'), false);
});

test('a package is offered only to an Atmos its "engines.atmos" includes', async t => {
  const w = world(t);
  w.publish('plugin', 'widget', '1.0.0', { apiVersion: 4, engines: { atmos: '>=0.15.0' } });
  w.publish('plugin', 'widget', '2.0.0', { apiVersion: 4, engines: { atmos: '>=0.16.0' } });
  const offered = async appVersion => (await w.start({ appVersion }).manager.checkForUpdates()).packages.filter(p => p.id === 'widget').map(p => p.version);
  assert.deepEqual(await offered('0.15.0'), ['1.0.0'], 'the newest one this Atmos can run');
  assert.deepEqual(await offered('0.16.2'), ['2.0.0']);
  assert.deepEqual(await offered('0.14.1'), []);
});

test('user sources are validated and remembered', async t => {
  const w = world(t);
  const s = w.start();
  assert.throws(() => s.manager.addSource('http://example.com/atmos'), /must use https/);
  assert.throws(() => s.manager.addSource('relative/folder'), /full path/);
  const list = s.manager.addSource(path.join(w.dir, 'elsewhere'));
  assert.deepEqual(list.map(item => item.origin), ['user', 'session']);
  const status = await s.manager.checkForUpdates();
  assert.equal(status.sources[0].ok, false);
  assert.equal(status.sources[0].error, 'Not found');
  assert.deepEqual(s.manager.removeSource(path.join(w.dir, 'elsewhere')).map(item => item.origin), ['session']);
});

test('optional dependencies are offered, never pulled in, and stop being offered once installed or on the way', async t => {
  const w = world(t);
  w.publish('service', 'charting', '1.2.0');
  w.publish('service', 'market-data', '0.4.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: { charting: '^1.2.0', 'market-data': { version: '^0.4.0', optional: true } } });
  let s = w.start();
  let status = await s.manager.checkForUpdates();
  assert.deepEqual(status.optional['plugin:finance'].map(o => `${o.kind}:${o.id} ${o.version}`), ['service:market-data 0.4.0']);

  const result = await s.manager.install('plugin', 'finance');
  assert.deepEqual(result.changes.map(c => c.id), ['charting', 'finance'], 'the optional one is not installed');
  assert.equal(result.status.optional['plugin:finance'].length, 1, 'still offered beside the pending Finance');

  s = w.start();
  status = await s.manager.checkForUpdates();
  assert.equal(status.optional['plugin:finance'].length, 1, 'offered on the installed Finance');
  status = (await s.manager.install('service', 'market-data')).status;
  assert.equal(status.optional['plugin:finance'], undefined, 'not offered while it waits for a restart');
  s = w.start();
  status = await s.manager.checkForUpdates();
  assert.equal(status.optional['plugin:finance'], undefined, 'not offered once installed');

  // An optional dependency outside the range isn't offered.
  const w2 = world(t);
  w2.publish('service', 'market-data', '0.3.0');
  w2.publish('plugin', 'finance', '1.0.0', { dependencies: { 'market-data': { version: '^0.4.0', optional: true } } });
  status = await w2.start().manager.checkForUpdates();
  assert.equal(status.optional['plugin:finance'], undefined);
});

test('a recommended optional dependency comes with a first install, but not with an update, and is never required', async t => {
  const w = world(t);
  const deps = { charting: '^1.2.0', 'market-data': { version: '^0.4.0', optional: true, recommended: true } };
  w.publish('service', 'charting', '1.2.0');
  w.publish('service', 'market-data', '0.4.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: deps });
  let s = w.start();
  await s.manager.checkForUpdates();
  let result = await s.manager.install('plugin', 'finance');
  assert.deepEqual(result.changes.map(c => `${c.id}:${c.reason}`), ['charting:dependency', 'market-data:recommended', 'finance:install']);
  assert.equal(result.status.optional['plugin:finance'], undefined);

  // Removed by the user: it stays removed through an update of Finance, and is offered again.
  s = w.start();
  s.manager.remove('service', 'market-data');
  s = w.start();
  assert.equal(s.find('service', 'market-data'), null);
  w.publish('plugin', 'finance', '1.0.1', { dependencies: deps });
  await s.manager.checkForUpdates();
  result = await s.manager.install('plugin', 'finance');
  assert.deepEqual(result.changes.map(c => `${c.id}:${c.reason}`), ['finance:update']);
  assert.equal(result.status.optional['plugin:finance'][0].id, 'market-data');

  // A source without it: Finance installs anyway.
  const w2 = world(t);
  w2.publish('plugin', 'finance', '1.0.0', { dependencies: { 'market-data': { version: '^0.4.0', optional: true, recommended: true } } });
  const s2 = w2.start();
  await s2.manager.checkForUpdates();
  assert.deepEqual((await s2.manager.install('plugin', 'finance')).changes.map(c => c.id), ['finance']);
});

test('the packages that come with Atmos: first-run choice, upgrade install, never over a newer copy', async t => {
  const w = world(t);
  w.publish('service', 'charting', '1.2.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: { charting: '^1.2.0' } });
  w.publish('plugin', 'sounds', '0.9.0');
  let s = w.start({ seed: true });
  assert.equal(s.manager.setupDone(), false);
  assert.deepEqual((await s.manager.seedPackages()).map(p => p.id).sort(), ['charting', 'finance', 'sounds']);
  assert.equal(s.manager.sources()[0].name, 'Comes with Atmos');

  // The picker: Finance only; Charting comes with it.
  const changes = await s.manager.installFromSeed([{ kind: 'plugin', id: 'finance' }]);
  assert.deepEqual(changes.map(c => c.id), ['charting', 'finance']);
  s.manager.finishSetup('chosen');
  s = w.start({ seed: true });
  assert.equal(s.manager.setupDone(), true);
  assert.equal(s.find('plugin', 'finance').tier, 'first-party');
  assert.equal(s.find('plugin', 'sounds'), null);

  // Everything (the upgrade path), with a newer Sounds already installed: it stays.
  const newer = world(t);
  newer.publish('plugin', 'sounds', '0.9.1');
  let n = newer.start();
  await n.manager.install('plugin', 'sounds');
  n = newer.start();
  fs.rmSync(newer.source, { recursive: true, force: true });
  fs.mkdirSync(newer.source);
  newer.publish('plugin', 'sounds', '0.9.0');
  n = newer.start({ seed: true });
  assert.deepEqual(await n.manager.installFromSeed(), []);
  assert.equal(newer.start({ seed: true }).find('plugin', 'sounds').version, '0.9.1');
});

test('what Atmos ships with (Atmos Browser) is never offered in the picker, nor installed over by the setup', async t => {
  const builtIn = (kind, id) => kind === 'plugin' && id === 'browser';
  const w = world(t);
  w.bundle('plugin', 'browser', '1.0.3');
  w.publish('plugin', 'browser', '1.0.3');
  w.publish('plugin', 'finance', '1.0.0');
  let s = w.start({ seed: true, builtIn });
  assert.deepEqual((await s.manager.seedPackages()).map(p => p.id), ['finance'], 'the picker lists what else there is');
  // The upgrade install (everything) and a list naming it anyway: nothing goes over the copy Atmos brought.
  assert.deepEqual((await s.manager.installFromSeed()).map(change => change.id), ['finance']);
  assert.deepEqual(await s.manager.installFromSeed([{ kind: 'plugin', id: 'browser' }]), []);
  s = w.start({ seed: true, builtIn });
  assert.equal(s.find('plugin', 'browser').source, 'bundled');
  assert.equal(s.find('plugin', 'finance').source, 'installed');
  assert.throws(() => s.manager.remove('plugin', 'browser'), /comes with Atmos; switch it off instead/);
  // A newer version still comes as an update, into the installed folder, and wins.
  w.publish('plugin', 'browser', '1.0.4');
  s = w.start({ builtIn });
  const status = await s.manager.checkForUpdates();
  assert.equal(status.packages.find(item => item.id === 'browser').action, 'update');
  await s.manager.install('plugin', 'browser');
  s = w.start({ builtIn });
  assert.equal(s.find('plugin', 'browser').version, '1.0.4');
  assert.equal(s.find('plugin', 'browser').source, 'installed');
  // An Atmos without the bundled copy (a build from before 0.18) is offered it like any other.
  const older = world(t);
  older.publish('plugin', 'browser', '1.0.3');
  assert.deepEqual((await older.start({ seed: true, builtIn }).manager.seedPackages()).map(p => p.id), ['browser']);
});

test('first run from a web source: offline it says so and stays pending; online it installs', async t => {
  const w = world(t);
  w.publish('service', 'charting', '1.2.0');
  w.publish('plugin', 'finance', '1.0.0', { dependencies: { charting: '^1.2.0' } });
  let online = false;
  const fetchUrl = async url => {
    if (!online) throw new Error('getaddrinfo ENOTFOUND github.com');
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
    return fs.readFileSync(path.join(w.source, file));
  };
  const manager = () => createExtensionManager({
    userData: w.userData, installedRoot: kind => w.root('installed', kind), trustedKeys: loadTrustedKeys([path.join(w.dir, 'keys.json')], () => {}),
    setupSources: [{ location: 'https://github.com/example/atmos/releases/latest/download/' }], fetchUrl, installed: () => [], warn() {},
  });
  let m = manager();
  assert.equal(m.setupDone(), false);
  await assert.rejects(m.seedPackages(), /ENOTFOUND/);
  await assert.rejects(m.installFromSeed(), /ENOTFOUND/);
  assert.equal(m.setupDone(), false, 'nothing is marked done, so the next start tries again');

  online = true;
  m = manager();
  assert.deepEqual((await m.seedPackages()).map(p => p.id).sort(), ['charting', 'finance']);
  const changes = await m.installFromSeed([{ kind: 'plugin', id: 'finance' }]);
  assert.deepEqual(changes.map(c => c.id), ['charting', 'finance']);
  m.finishSetup('chosen');
  assert.equal(manager().setupDone(), true);
  // No setup sources (running from source): no first run at all.
  assert.equal(createExtensionManager({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-nosetup-')), installedRoot: () => w.dir, trustedKeys: new Map() }).setupDone(), true);
});

test('a first run stays a first run across restarts until the choice is made', t => {
  const w = world(t);
  const m = createExtensionManager({ userData: w.userData, installedRoot: kind => w.root('installed', kind), trustedKeys: new Map(), setupSources: [{ location: w.source }] });
  assert.equal(m.setupPending(), false);
  m.beginSetup();
  assert.equal(m.setupPending(), true);
  assert.equal(m.setupDone(), false);
  m.beginSetup();
  m.finishSetup('skipped');
  assert.equal(m.setupPending(), false);
  assert.equal(m.setupDone(), true);
});

test('a source can\'t be rolled back to an index older than one already seen', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  w.resign('2026-10-01T12:00:00.000Z');
  const s = w.start();
  assert.equal((await s.manager.checkForUpdates()).sources[0].ok, true);

  // An older, genuinely signed index (say, an earlier release marked latest again).
  w.resign('2026-09-01T12:00:00.000Z');
  const old = await s.manager.checkForUpdates();
  assert.equal(old.sources[0].ok, false);
  assert.match(old.sources[0].error, /older than one Atmos has already seen/);
  assert.equal(old.packages.length, 0);
  // Remembered across starts.
  assert.equal((await w.start().manager.checkForUpdates()).sources[0].ok, false);

  // The same index again, or a newer one, is fine.
  w.resign('2026-10-01T12:00:00.000Z');
  assert.equal((await s.manager.checkForUpdates()).sources[0].ok, true);
  w.resign('2026-11-01T12:00:00.000Z');
  assert.equal((await s.manager.checkForUpdates()).sources[0].ok, true);
  w.resign('2026-10-01T12:00:00.000Z');
  assert.equal((await s.manager.checkForUpdates()).sources[0].ok, false);
});

test('a signed index naming a newer Atmos offers it; an older, equal or malformed one does not', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');

  // No "core" entry (an index from before this was added): nothing offered.
  let status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  assert.deepEqual(status.core, { current: '0.12.0', available: null });

  w.resignWith({ core: { version: '0.13.0' } });
  status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  assert.deepEqual(status.core, { current: '0.12.0', available: '0.13.0' });
  assert.equal(status.packages.length, 1, 'the packages are read as before');

  for (const [version, app] of [['0.12.0', '0.12.0'], ['0.11.0', '0.12.0'], ['not a version', '0.12.0'], ['0.13.0', null]]) {
    w.resignWith({ core: { version } });
    status = await w.start({ appVersion: app }).manager.checkForUpdates();
    assert.equal(status.core.available, null, `index ${version}, Atmos ${app}`);
  }
});

test('"core" is covered by the index signature', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  w.resignWith({ core: { version: '0.13.0' } });
  const indexFile = path.join(w.source, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.core.version = '9.9.9';
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  assert.equal(status.core.available, null);
  assert.equal(status.sources[0].ok, false);
});

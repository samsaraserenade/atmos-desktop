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

  /**
   * One "start of Atmos": apply pending changes, then catalog + trust + manager.
   * `off`: ids switched off. `failsToStart`: ids whose main.cjs throws.
   * `stops`: Atmos stops (a crash, a hang) while these ids' main.cjs start.
   */
  function start({ seed = false, appVersion = null, builtIn = undefined, off = [], failsToStart = [], stops = [] } = {}) {
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
    trust.assessAll(catalog, { refuse: entry => manager.failedUpdate?.(entry) ?? null });
    entries = [...catalog.list('plugins'), ...catalog.list('services')].map(entry => ({ ...entry, loadable: trust.get(entry).loadable, active: !off.includes(entry.id) }));
    manager.markStarting?.(entries.filter(entry => entry.active && entry.loadable));
    const find = (kind, id) => entries.find(entry => entry.kind === kind && entry.id === id) || null;
    if (stops.length) return { manager, catalog, trust, applied, find, entries };
    manager.confirmApplied((kind, id) => {
      const entry = catalog.find(`${kind}s`, id);
      const failed = failsToStart.includes(id);
      const loadable = trust.get(entry)?.loadable;
      return entry ? { entry, loadable: loadable && !failed, problem: failed ? 'boom' : null, inactive: loadable && !failed && off.includes(id) } : null;
    });
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

test('an update that can\'t be moved into place keeps the version it was to replace, however often it fails (R3)', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  w.publish('plugin', 'sounds', '1.1.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  // Moving the staged 1.1.0 into place fails (a folder locked by another
  // program), at two starts in a row.
  const rename = fs.renameSync;
  const staging = path.join(w.userData, 'extension-staging');
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from).startsWith(staging)) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    return rename(from, to);
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    s = w.start();
    const sounds = s.find('plugin', 'sounds');
    assert.equal(sounds?.version, '1.0.0', `attempt ${attempt}: the kept version runs`);
    assert.equal(sounds.loadable, true);
    assert.equal(s.manager.status().pending.length, 1, 'the update is tried again at the next start');
  }
  // Once it can be moved, the update goes in and the old version is kept until it loads.
  t.mock.restoreAll();
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.1.0');
  assert.deepEqual(s.manager.status().pending, []);
});

test('a folder that can\'t be moved is never half-moved: no copy left part-deleted (R3)', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  w.publish('plugin', 'sounds', '1.1.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  // Windows: a file in the installed folder held open, so the folder can't
  // be renamed, and deleting it stops part-way.
  const installed = path.join(w.root('installed', 'plugins'), 'sounds');
  const rename = fs.renameSync;
  const rm = fs.rmSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === installed) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return rename(from, to);
  });
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.resolve(target) === installed) {
      fs.unlinkSync(path.join(installed, 'boot.js'));
      throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
    }
    return rm(target, options);
  });
  s = w.start();
  assert.equal(s.find('plugin', 'sounds')?.version, '1.0.0', 'the installed version still runs');
  assert.equal(s.find('plugin', 'sounds').loadable, true, 'whole');
  // Next start: the folder is free, but the update can't be moved in.
  t.mock.restoreAll();
  const staging = path.join(w.userData, 'extension-staging');
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from).startsWith(staging)) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    return rename(from, to);
  });
  s = w.start();
  assert.equal(s.find('plugin', 'sounds')?.version, '1.0.0', 'the installed version still runs, whole');
  assert.equal(s.find('plugin', 'sounds').loadable, true);
  t.mock.restoreAll();
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.1.0', 'and the update goes in once it can');
});

test('an update is confirmed only once it has started: one whose frame or main.cjs fails falls back to the version it replaced (R4)', async t => {
  const w = world(t);
  const previous = path.join(w.userData, 'extension-previous', 'plugins', 'sounds');
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  w.publish('plugin', 'sounds', '1.1.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  // Signed and verified, so it loads; its frames haven't run yet.
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.1.0');
  assert.ok(fs.existsSync(previous), 'the version it replaced is kept until the update has started');
  // Its background frame then fails to load.
  assert.equal(s.manager.startFailed('plugin', 'sounds', 'its background frame failed to load: boom'), true);
  s = w.start();
  let sounds = s.find('plugin', 'sounds');
  assert.equal(sounds.version, '1.0.0', 'the next start runs the version before');
  assert.equal(sounds.source, 'previous');
  assert.equal(s.trust.get(sounds).fellBackFrom.version, '1.1.0');
  assert.match(s.trust.get(sounds).fellBackFrom.reason, /background frame failed to load/);
  assert.equal(s.manager.status().applied[0].failed, true);

  // An update whose main.cjs throws: the same.
  w.publish('plugin', 'sounds', '1.2.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start({ failsToStart: ['sounds'] });
  assert.ok(fs.existsSync(previous));
  assert.match(s.manager.status().applied[0].reason, /boom/);
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').source, 'previous');

  // One that starts and runs a whole session: the kept version goes at the next start.
  w.publish('plugin', 'sounds', '1.3.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.3.0');
  assert.ok(fs.existsSync(previous), 'kept through its first session');
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.3.0');
  assert.equal(fs.existsSync(previous), false);
  assert.deepEqual(s.manager.status().applied, []);
  assert.equal(s.manager.startFailed('plugin', 'sounds', 'late'), false, 'nothing to fail once confirmed');
});

test('after an update fell back, updating again keeps the working version; a first install that fails once isn\'t failed for good (R4)', async t => {
  const w = world(t);
  const previous = path.join(w.userData, 'extension-previous', 'plugins', 'sounds');
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  // A first install whose main.cjs fails: nothing to fall back to, so it's
  // not kept as a failed update (Settings shows that start's failure).
  s = w.start({ failsToStart: ['sounds'] });
  assert.deepEqual(s.manager.status().applied, []);
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.0.0');

  w.publish('plugin', 'sounds', '1.1.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start({ failsToStart: ['sounds'] });
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.0.0', 'fell back');
  // Update pressed again (the same 1.1.0), and it fails again: 1.0.0 is still kept and runs.
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start({ failsToStart: ['sounds'] });
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.0.0', 'the working version, not the failed one, is the fallback');
  assert.equal(s.find('plugin', 'sounds').source, 'previous');
});

test('an update while Atmos stops as it starts falls back; one switched off isn\'t confirmed before it has run (R4)', async t => {
  const w = world(t);
  const previous = path.join(w.userData, 'extension-previous', 'plugins', 'sounds');
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  w.publish('plugin', 'sounds', '1.1.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  // Atmos stops (a crash, or a main.cjs that hangs) while 1.1.0 starts.
  s = w.start({ stops: ['sounds'] });
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.0.0', 'the next start runs the version before');
  assert.match(s.manager.status().applied[0].reason, /stopped while it was starting/);

  // Switched off when an update is applied: it hasn't run, so it isn't confirmed.
  w.publish('plugin', 'sounds', '1.2.0');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'sounds');
  s = w.start({ off: ['sounds'] });
  s = w.start({ off: ['sounds'] });
  assert.ok(fs.existsSync(previous), 'still kept: it has never run');
  assert.equal(s.manager.status().applied.length, 1);
  s = w.start();
  assert.equal(s.find('plugin', 'sounds').version, '1.2.0');
  s = w.start();
  assert.equal(fs.existsSync(previous), false, 'confirmed after a session it ran');
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
  assert.deepEqual(s.manager.dataCleanup(), [{ kind: 'plugin', id: 'finance' }]);
  s.manager.finishDataCleanup('plugin', 'finance');
  assert.deepEqual(s.manager.dataCleanup(), [], 'gone once done');
});

test('data to delete stays listed, start after start, until it has been deleted (R5)', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  let s = w.start();
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  s.manager.remove('plugin', 'sounds', { deleteData: true });
  // What main.js does at each start: read the list, try to delete; here the
  // delete fails, so it says nothing more.
  const listed = manager => (manager.dataCleanup ? manager.dataCleanup() : manager.takeDataCleanup());
  s = w.start();
  assert.deepEqual(listed(s.manager), [{ kind: 'plugin', id: 'sounds' }]);
  s = w.start();
  assert.deepEqual(listed(s.manager), [{ kind: 'plugin', id: 'sounds' }], 'still there to retry after a failed delete');
  // Removed with its data again before the retry worked: listed once.
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  s.manager.remove('plugin', 'sounds', { deleteData: true });
  s = w.start();
  assert.deepEqual(listed(s.manager), [{ kind: 'plugin', id: 'sounds' }]);
  s.manager.finishDataCleanup('plugin', 'sounds');
  assert.deepEqual(listed(s.manager), []);
  // A delete that keeps failing is given up after three starts (each try
  // can take a minute before the window opens).
  await s.manager.install('plugin', 'sounds');
  s = w.start();
  s.manager.remove('plugin', 'sounds', { deleteData: true });
  s = w.start();
  assert.equal(s.manager.dataCleanupFailed('plugin', 'sounds'), false);
  assert.equal(s.manager.dataCleanupFailed('plugin', 'sounds'), false);
  assert.equal(s.manager.dataCleanupFailed('plugin', 'sounds'), true, 'given up');
  assert.deepEqual(listed(s.manager), []);
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
  assert.deepEqual(s.manager.dataCleanup(), []);
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

test('a recommended optional dependency comes with a first install or the update that first recommends it, never once you removed or cancelled it, and is never required', async t => {
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

  // An update that first recommends one brings it (it wasn't removed: it
  // didn't exist); the next update doesn't, once it's removed.
  w.publish('service', 'now-playing', '1.0.0');
  w.publish('plugin', 'finance', '1.1.0', { dependencies: { ...deps, 'now-playing': { version: '^1.0.0', optional: true, recommended: true } } });
  s = w.start();
  await s.manager.checkForUpdates();
  result = await s.manager.install('plugin', 'finance');
  assert.deepEqual(result.changes.map(c => `${c.id}:${c.reason}`), ['now-playing:recommended', 'finance:update'], 'Market Data, removed before, stays removed');

  // Its install cancelled: no other extension's recommendation brings it
  // back (nor Market Data, removed), and planning Finance again doesn't either.
  s.manager.cancel('service', 'now-playing');
  w.publish('plugin', 'audio-player', '1.2.0', { dependencies: {
    'now-playing': { version: '^1.0.0', optional: true, recommended: true },
    'market-data': { version: '^0.4.0', optional: true, recommended: true },
  } });
  s = w.start();
  await s.manager.checkForUpdates();
  assert.deepEqual((await s.manager.install('plugin', 'audio-player')).changes.map(c => `${c.id}:${c.reason}`), ['audio-player:install']);
  assert.deepEqual((await s.manager.install('plugin', 'finance')).changes.map(c => `${c.id}:${c.reason}`), ['finance:update']);
  // Installed by hand, it's wanted again.
  assert.deepEqual((await s.manager.install('service', 'now-playing')).changes.map(c => c.id), ['now-playing']);
  s.manager.cancel('service', 'now-playing');
  s.manager.cancel('plugin', 'audio-player');
  s.manager.cancel('plugin', 'finance');
  const declined = () => JSON.parse(fs.readFileSync(path.join(w.userData, 'extension-declined.json'), 'utf8')).declined;
  assert.deepEqual(declined(), ['plugin:audio-player', 'service:market-data', 'service:now-playing'],
    'a cancelled first install is declined, a cancelled update (Finance) isn\'t');

  // A plain optional one that becomes recommended counts as new.
  const w3 = world(t);
  w3.publish('service', 'market-data', '0.4.0');
  w3.publish('plugin', 'finance', '1.0.0', { dependencies: { 'market-data': { version: '^0.4.0', optional: true } } });
  let s3 = w3.start();
  await s3.manager.checkForUpdates();
  assert.deepEqual((await s3.manager.install('plugin', 'finance')).changes.map(c => c.id), ['finance']);
  s3 = w3.start();
  w3.publish('plugin', 'finance', '1.0.1', { dependencies: { 'market-data': { version: '^0.4.0', optional: true, recommended: true } } });
  await s3.manager.checkForUpdates();
  assert.deepEqual((await s3.manager.install('plugin', 'finance')).changes.map(c => `${c.id}:${c.reason}`), ['market-data:recommended', 'finance:update']);

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

test('what Atmos Browser recommends comes once: with the first start\'s choice, or after an Atmos update; removed, it stays removed', async t => {
  const builtIn = (kind, id) => kind === 'plugin' && id === 'browser';
  const recommends = { dependencies: { 'now-playing': { version: '^1.0.0', optional: true, recommended: true } } };
  const w = world(t);
  w.bundle('plugin', 'browser', '1.2.0', recommends);
  w.publish('service', 'now-playing', '1.0.0');
  w.publish('plugin', 'finance', '1.0.0');
  // The first start's choice (Finance): Now Playing comes with the browser, at the same restart.
  let s = w.start({ seed: true, builtIn });
  assert.deepEqual((await s.manager.installFromSeed([{ kind: 'plugin', id: 'finance' }])).map(c => `${c.id}:${c.reason}`), ['finance:install', 'now-playing:recommended']);
  s = w.start({ seed: true, builtIn });
  assert.equal(s.find('service', 'now-playing').source, 'installed');
  // Removed: no later check brings it back.
  s.manager.remove('service', 'now-playing');
  s = w.start({ builtIn });
  assert.equal(s.find('service', 'now-playing'), null);
  await s.manager.checkForUpdates();
  assert.deepEqual(await s.manager.installBuiltInRecommendations(), []);

  // An Atmos update whose browser first recommends it: staged after the
  // check, said to come with Atmos Browser, once.
  const u = world(t);
  u.bundle('plugin', 'browser', '1.1.0');
  let su = u.start({ builtIn });
  await su.manager.checkForUpdates();
  assert.deepEqual(await su.manager.installBuiltInRecommendations(), []);
  u.bundle('plugin', 'browser', '1.2.0', recommends);
  su = u.start({ builtIn });
  await su.manager.checkForUpdates();
  assert.deepEqual(await su.manager.installBuiltInRecommendations(), [], 'no source has it yet: nothing, and looked at again next time');
  u.publish('service', 'now-playing', '1.0.0');
  await su.manager.checkForUpdates();
  assert.deepEqual((await su.manager.installBuiltInRecommendations()).map(c => `${c.id}:${c.reason}`), ['now-playing:recommended']);
  assert.deepEqual(await su.manager.installBuiltInRecommendations(), [], 'once');
  su.manager.cancel('service', 'now-playing');
  su = u.start({ builtIn });
  await su.manager.checkForUpdates();
  assert.deepEqual(await su.manager.installBuiltInRecommendations(), [], 'cancelled: not again');
  assert.equal(su.find('service', 'now-playing'), null);
});

test('an extension that reads the location brings Location once, now that it is a package (0.21); removed, it stays removed', async t => {
  const w = world(t);
  w.bundle('plugin', 'weather', '1.0.0', { permissions: { invokes: ['service:location'] } });
  w.bundle('plugin', 'clock', '1.0.0');
  // One that names it chose already: an optional dependency is its call.
  w.bundle('plugin', 'radar', '1.0.0', { permissions: { invokes: ['service:location'] }, dependencies: { location: { version: '^1.0.0', optional: true } } });
  let s = w.start();
  await s.manager.checkForUpdates();
  assert.deepEqual(await s.manager.installBuiltInRecommendations(), [], 'no source has it yet: looked at again next time');
  w.publish('service', 'location', '1.0.0');
  await s.manager.checkForUpdates();
  // Even after "Just Atmos Browser": the reader was installed since.
  s.manager.finishSetup('skipped');
  assert.deepEqual((await s.manager.installBuiltInRecommendations()).map(c => `${c.id}:${c.reason}`), ['location:recommended']);
  assert.deepEqual(await s.manager.installBuiltInRecommendations(), [], 'once');
  s = w.start();
  assert.equal(s.find('service', 'location').source, 'installed');
  s.manager.remove('service', 'location');
  s = w.start();
  await s.manager.checkForUpdates();
  assert.deepEqual(await s.manager.installBuiltInRecommendations(), [], 'removed: not again');
  assert.equal(s.find('service', 'location'), null);

  // Nothing reads it (or only one that names it): nothing comes. Any
  // version from the first does (readers talk to Core).
  const quiet = world(t);
  quiet.bundle('plugin', 'clock', '1.0.0');
  quiet.bundle('plugin', 'radar', '1.0.0', { permissions: { invokes: ['service:location'] }, dependencies: { location: { version: '^1.0.0', optional: true } } });
  quiet.publish('service', 'location', '2.0.0');
  const sq = quiet.start();
  await sq.manager.checkForUpdates();
  assert.deepEqual(await sq.manager.installBuiltInRecommendations(), []);
  quiet.bundle('plugin', 'weather', '1.0.0', { permissions: { invokes: ['service:location'] } });
  const off = quiet.start({ off: ['weather'] });
  await off.manager.checkForUpdates();
  assert.deepEqual(await off.manager.installBuiltInRecommendations(), [], 'switched off: not until it runs');
  const sq2 = quiet.start();
  await sq2.manager.checkForUpdates();
  assert.deepEqual((await sq2.manager.installBuiltInRecommendations()).map(c => `${c.id}:${c.version}`), ['location:2.0.0']);
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
  assert.deepEqual(status.core, { current: '0.12.0', available: null, offer: null, seen: false });

  w.resignWith({ core: { version: '0.13.0' } });
  status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  assert.deepEqual(status.core, {
    current: '0.12.0', available: '0.13.0', seen: true,
    offer: { version: '0.13.0', installer: null, installers: [], source: w.source },
  });
  assert.equal(status.packages.length, 1, 'the packages are read as before');

  // The installer an index names comes with the offer, from that source;
  // only its known fields (atmos-update.cjs checks them).
  const installer = { file: 'Atmos.Setup.0.13.0.exe', size: 1234, sha256: 'a'.repeat(64), platform: 'win32', arch: 'x64', url: 'https://elsewhere.example/x.exe' };
  w.resignWith({ core: { version: '0.13.0', installer } });
  status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  const { url: _ignored, ...fields } = installer;
  assert.deepEqual(status.core.offer, { version: '0.13.0', installer: fields, installers: [], source: w.source });

  // Every platform's (0.24): "installers", the same fields each, at most 8.
  const appImage = { file: 'Atmos-0.13.0.AppImage', size: 4321, sha256: 'b'.repeat(64), platform: 'linux', arch: 'x64', extra: true };
  w.resignWith({ core: { version: '0.13.0', installer, installers: [installer, appImage, 'junk', ...Array(10).fill(appImage)] } });
  status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  const { extra: _extra, ...linux } = appImage;
  assert.deepEqual(status.core.offer.installers.slice(0, 2), [fields, linux]);
  assert.equal(status.core.offer.installers.length, 7, 'at most 8 looked at; one not an entry');

  for (const [version, app] of [['0.12.0', '0.12.0'], ['0.11.0', '0.12.0'], ['not a version', '0.12.0'], ['0.13.0', null]]) {
    w.resignWith({ core: { version } });
    status = await w.start({ appVersion: app }).manager.checkForUpdates();
    assert.equal(status.core.available, null, `index ${version}, Atmos ${app}`);
    assert.equal(status.core.offer, null, `index ${version}, Atmos ${app}`);
  }
  // A source that answered with an older "core" counts as seen: nothing newer.
  w.resignWith({ core: { version: '0.11.0' } });
  assert.equal((await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates()).core.seen, true);
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
  assert.equal(status.core.seen, false, 'a source that failed has said nothing either way');
  assert.equal(status.sources[0].ok, false);
});

test('the installer\'s hash is covered by the index signature', async t => {
  const w = world(t);
  w.publish('plugin', 'sounds', '1.0.0');
  w.resignWith({ core: { version: '0.13.0', installer: { file: 'Atmos.Setup.0.13.0.exe', size: 10, sha256: 'a'.repeat(64), platform: 'win32', arch: 'x64' } } });
  const indexFile = path.join(w.source, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.core.installer.sha256 = 'b'.repeat(64);
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const status = await w.start({ appVersion: '0.12.0' }).manager.checkForUpdates();
  assert.equal(status.core.offer, null);
  assert.equal(status.sources[0].ok, false);
});

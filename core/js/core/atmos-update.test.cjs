'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAtmosUpdater, readInstallerEntry } = require('./atmos-update.cjs');

const WIN = { platform: 'win32', arch: 'x64' };
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * An updater on a scratch folder. The "web" is a map of URL → bytes the
 * download stub writes; spawned installers are recorded, not run.
 */
function world(t, { appVersion = '0.19.0', install = { perMachine: false }, web = new Map(), now = () => Date.now() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned = [];
  const downloads = [];
  const changes = { count: 0 };
  const options = {
    appVersion,
    stateFile: path.join(dir, 'user', 'atmos-update.json'),
    downloadDir: path.join(dir, 'downloads'),
    install,
    ...WIN,
    now,
    warn() {},
    onChange: () => { changes.count += 1; },
    download: async (url, file, { maxBytes, signal, onProgress }) => {
      downloads.push(url);
      if (!web.has(url)) throw new Error('HTTP 404');
      const bytes = web.get(url);
      if (typeof bytes === 'function') return bytes({ file, maxBytes, signal, onProgress });
      fs.writeFileSync(file, bytes);
      onProgress(bytes.length);
    },
    spawnInstaller: (file, args) => spawned.push({ file, args, bytes: fs.readFileSync(file) }),
  };
  const make = (overrides = {}) => createAtmosUpdater({ ...options, ...overrides });
  return { dir, web, spawned, downloads, changes, options, make, updater: make() };
}

const SOURCE = 'https://github.com/someone/atmos/releases/latest/download/';
function release(version, bytes = Buffer.from(`installer ${version} `.repeat(1000)), overrides = {}) {
  const installer = { file: `Atmos.Setup.${version}.exe`, size: bytes.length, sha256: sha(bytes), ...WIN, ...overrides };
  return { core: { version, installer, source: SOURCE }, bytes, url: `${SOURCE}${installer.file}` };
}

test('an installer entry needs a plain file name, a bounded size, a SHA-256, and this platform', () => {
  const good = { file: 'Atmos.Setup.0.20.0.exe', size: 100, sha256: 'a'.repeat(64), ...WIN };
  assert.deepEqual(readInstallerEntry(good, WIN), good);
  for (const file of ['../Atmos.exe', 'a/b.exe', 'a\\b.exe', '.Atmos.exe', 'Atmos.msi', 'Atmos.exe ', 'Atmos..exe', '', 'C:Atmos.exe', `${'a'.repeat(130)}.exe`]) {
    assert.equal(readInstallerEntry({ ...good, file }, WIN), null, file);
  }
  for (const size of [0, -1, 1.5, '100', 2 * 1024 * 1024 * 1024]) assert.equal(readInstallerEntry({ ...good, size }, WIN), null, String(size));
  for (const hash of ['A'.repeat(64), 'a'.repeat(63), null]) assert.equal(readInstallerEntry({ ...good, sha256: hash }, WIN), null, String(hash));
  assert.equal(readInstallerEntry({ ...good, platform: 'linux' }, WIN), null);
  assert.equal(readInstallerEntry({ ...good, arch: 'arm64' }, WIN), null);
  assert.equal(readInstallerEntry({ ...good, arch: undefined }, WIN), null, 'the architecture must be named');
  assert.equal(readInstallerEntry(null, WIN), null);
});

test('a newer version downloads by itself, is checked, and installs when Atmos quits', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  assert.equal(await w.updater.consider(r.core), true);
  assert.deepEqual(w.downloads, [r.url], 'from the index\'s own source');
  const state = w.updater.state();
  assert.equal(state.phase, 'ready');
  assert.equal(state.version, '0.20.0');
  assert.equal(state.installsOnQuit, true);
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), ['Atmos.Setup.0.20.0.exe']);

  assert.equal(w.updater.installOnQuit(), true);
  assert.equal(w.spawned.length, 1);
  assert.deepEqual(w.spawned[0].args, ['--updated', '/S'], 'silent, and not started again: the user quit');
  assert.ok(w.spawned[0].bytes.equals(r.bytes));
  const saved = JSON.parse(fs.readFileSync(w.options.stateFile, 'utf8'));
  assert.equal(saved.attempt.version, '0.20.0');
  assert.equal(saved.attempt.from, '0.19.0');
});

test('Restart to update installs now and starts Atmos again', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  assert.equal(w.updater.installNow(), true);
  assert.deepEqual(w.spawned[0].args, ['--updated', '/S', '--force-run']);
});

test('the same, older or no version offers nothing', async t => {
  const w = world(t);
  for (const version of ['0.19.0', '0.18.9', 'nope']) {
    const r = release(version);
    w.web.set(r.url, r.bytes);
    assert.equal(await w.updater.consider(r.core), false, version);
  }
  assert.equal(await w.updater.consider(null), false);
  assert.deepEqual(w.downloads, []);
  assert.equal(w.updater.state().phase, 'idle');
  assert.equal(w.updater.state().version, null);
});

test('a download that doesn\'t match the signed hash or size is thrown away, and tried again at the next check', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, Buffer.from('something else entirely'));
  assert.equal(await w.updater.consider(r.core), false);
  let state = w.updater.state();
  assert.equal(state.phase, 'error');
  assert.match(state.error, /doesn't match the signed index/);
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), [], 'no partial file left');
  assert.equal(w.updater.installOnQuit(), false);
  assert.throws(() => w.updater.installNow(), /No update is ready/);

  // Larger than signed (a downloader that didn't stop at maxBytes).
  w.web.set(r.url, Buffer.concat([r.bytes, Buffer.from('x')]));
  assert.equal(await w.updater.consider(r.core), false);
  assert.equal(w.updater.state().phase, 'error');

  w.web.set(r.url, r.bytes);
  assert.equal(await w.updater.consider(r.core), true, 'the next check tries again');
  assert.equal(w.updater.state().phase, 'ready');
  assert.equal(w.spawned.length, 0);
});

test('the download is limited to the signed size', async t => {
  const w = world(t);
  const r = release('0.20.0');
  let limit = null;
  w.web.set(r.url, ({ file, maxBytes, onProgress }) => { limit = maxBytes; fs.writeFileSync(file, r.bytes); onProgress(r.bytes.length); });
  await w.updater.consider(r.core);
  assert.equal(limit, r.bytes.length);
});

test('only https sources, and a folder source by copy', async t => {
  const w = world(t);
  const r = release('0.20.0');
  assert.equal(await w.updater.consider({ ...r.core, source: 'http://example.com/' }), false);
  assert.match(w.updater.state().error, /https/);
  assert.deepEqual(w.downloads, []);

  const folder = path.join(w.dir, 'source');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, r.core.installer.file), r.bytes);
  assert.equal(await w.updater.consider({ ...r.core, source: folder }), true);
  assert.equal(w.updater.state().phase, 'ready');
});

test('an installer for another platform, or none, is offered but not downloaded', async t => {
  const w = world(t);
  const r = release('0.20.0', undefined, { platform: 'darwin' });
  w.web.set(r.url, r.bytes);
  assert.equal(await w.updater.consider(r.core), false);
  const state = w.updater.state();
  assert.equal(state.version, '0.20.0');
  assert.equal(state.installable, false);
  assert.equal(await w.updater.consider({ version: '0.20.1', source: SOURCE }), false);
  assert.equal(w.updater.state().installable, false);
  assert.deepEqual(w.downloads, []);
});

test('a copy that can\'t update itself never downloads or runs anything', async t => {
  const w = world(t, { install: null });
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  assert.equal(await w.updater.consider(r.core), false);
  assert.equal(await w.updater.download(), false);
  assert.equal(w.updater.installOnQuit(), false);
  assert.throws(() => w.updater.installNow());
  const state = w.updater.state();
  assert.equal(state.canInstall, false);
  assert.equal(state.version, '0.20.0', 'still says a version is available');
  assert.deepEqual(w.downloads, []);
  assert.equal(w.spawned.length, 0);
});

test('with automatic updates off: nothing downloads until asked, nothing installs on quit', async t => {
  const w = world(t);
  assert.equal(w.updater.setAuto(false).auto, false);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  assert.equal(await w.updater.consider(r.core), false);
  assert.deepEqual(w.downloads, []);
  assert.equal(w.updater.state().phase, 'idle');

  assert.equal(await w.updater.download(), true);
  assert.equal(w.updater.state().phase, 'ready');
  assert.equal(w.updater.state().installsOnQuit, false);
  assert.equal(w.updater.installOnQuit(), false);
  assert.equal(w.updater.installNow(), true, 'Restart to update still works');

  // The setting is kept.
  assert.equal(w.make().state().auto, false);
});

test('turning automatic updates on starts the download', async t => {
  const w = world(t);
  w.updater.setAuto(false);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  w.updater.setAuto(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(w.updater.state().phase, 'ready');
});

test('a per-machine install never installs on quit (Windows would ask), only from Restart to update', async t => {
  const w = world(t, { install: { perMachine: true } });
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  assert.equal(w.updater.state().phase, 'ready');
  assert.equal(w.updater.state().perMachine, true);
  assert.equal(w.updater.installOnQuit(), false);
  assert.equal(w.updater.installNow(), true);
  assert.deepEqual(w.spawned[0].args, ['--updated', '/S', '--force-run']);
});

test('an installer changed after it was checked is never run', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  const file = path.join(w.options.downloadDir, r.core.installer.file);
  const changed = Buffer.from(r.bytes);
  changed[10] ^= 1;
  fs.writeFileSync(file, changed);
  assert.equal(w.updater.installOnQuit(), false, 'never throws on quit');
  assert.equal(w.updater.state().phase, 'error');
  assert.match(w.updater.state().error, /changed since it was checked/);
  assert.throws(() => w.updater.installNow(), /No update is ready/);
  assert.equal(w.spawned.length, 0);
});

test('an installer already downloaded and still matching is used without downloading again', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  const next = w.make();
  w.downloads.length = 0;
  assert.equal(await next.consider(r.core), true);
  assert.deepEqual(w.downloads, []);
  assert.equal(next.state().phase, 'ready');
});

test('older downloads are cleared, and all of them when nothing newer is offered', async t => {
  const w = world(t);
  const a = release('0.20.0');
  const b = release('0.20.1');
  w.web.set(a.url, a.bytes).set(b.url, b.bytes);
  await w.updater.consider(a.core);
  await w.updater.consider(b.core);
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), ['Atmos.Setup.0.20.1.exe']);
  await w.updater.consider(release('0.19.0').core);
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), []);
  assert.equal(w.updater.state().phase, 'idle');
});

test('a newer offer during a download replaces it', async t => {
  // (Before the download starts too: see the next test.)
  const w = world(t);
  const a = release('0.20.0');
  const b = release('0.20.1');
  let aborted = false;
  let started = null;
  const downloading = new Promise(resolve => { started = resolve; });
  w.web.set(a.url, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    started();
  }));
  w.web.set(b.url, b.bytes);
  const first = w.updater.consider(a.core);
  assert.equal(w.updater.state().phase, 'downloading');
  await downloading;
  const second = w.updater.consider(b.core);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(aborted, true);
  assert.equal(w.updater.state().version, '0.20.1');
  assert.equal(w.updater.state().phase, 'ready');
});

test('a newer offer before the download began cancels it', async t => {
  const w = world(t);
  const a = release('0.20.0');
  const b = release('0.20.1');
  w.web.set(a.url, a.bytes).set(b.url, b.bytes);
  const first = w.updater.consider(a.core);
  const second = w.updater.consider(b.core);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(w.downloads, [b.url]);
});

test('the next start: running the new version clears the download and says so', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  w.updater.installOnQuit();

  const after = w.make({ appVersion: '0.20.0' });
  assert.deepEqual(after.startup(), { installed: { version: '0.20.0', from: '0.19.0' }, failed: null });
  assert.deepEqual(after.state().justInstalled, { version: '0.20.0', from: '0.19.0' });
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), []);
  const saved = JSON.parse(fs.readFileSync(w.options.stateFile, 'utf8'));
  assert.equal(saved.attempt, null);
  assert.equal(saved.installed.version, '0.20.0');
  assert.deepEqual(w.make({ appVersion: '0.20.0' }).startup(), { installed: null, failed: null }, 'once');
});

test('the next start still on the old version: the attempt failed, and quitting won\'t try it again', async t => {
  let clock = Date.parse('2026-10-02T08:00:00Z');
  const w = world(t, { now: () => clock });
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  w.updater.installOnQuit();

  // Opened again while the installer may still be running: not a failure yet.
  clock += 60 * 1000;
  assert.equal(w.make().startup().failed, null);

  clock += 10 * 60 * 1000;
  const after = w.make();
  assert.equal(after.startup().failed, '0.20.0');
  await after.consider(r.core);
  const state = after.state();
  assert.equal(state.phase, 'ready');
  assert.equal(state.failedBefore, true);
  assert.equal(state.installsOnQuit, false);
  assert.equal(after.installOnQuit(), false);
  assert.equal(after.installNow(), true, 'the user can still try');

  // A newer version is tried on quit as usual.
  const next = release('0.20.1');
  w.web.set(next.url, next.bytes);
  const later = w.make();
  await later.consider(next.core);
  assert.equal(later.state().installsOnQuit, true);
});

test('an installer that can\'t be started leaves no attempt behind', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  const updater = w.make({ spawnInstaller: () => { throw new Error('spawn EACCES'); } });
  await updater.consider(r.core);
  assert.throws(() => updater.installNow(), /EACCES/);
  assert.equal(updater.installOnQuit(), false);
  assert.equal(JSON.parse(fs.readFileSync(w.options.stateFile, 'utf8')).attempt, null);
});

test('an offer stands until its own source answers without it', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core, { answered: [SOURCE] });
  assert.equal(w.updater.state().phase, 'ready');

  // The official source didn't answer; another one did, with nothing newer.
  assert.equal(await w.updater.consider(null, { answered: ['/somewhere/else'] }), true);
  assert.equal(w.updater.state().phase, 'ready');
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), ['Atmos.Setup.0.20.0.exe'], 'the download is kept');
  // Nobody answered.
  await w.updater.consider(null, { answered: [] });
  assert.equal(w.updater.state().version, '0.20.0');
  // Something newer from elsewhere still replaces it.
  const next = release('0.20.1');
  w.web.set(next.url, next.bytes);
  await w.updater.consider({ ...next.core }, { answered: [SOURCE] });
  assert.equal(w.updater.state().version, '0.20.1');
  // Its own source answering without it withdraws it.
  await w.updater.consider(null, { answered: [SOURCE] });
  assert.equal(w.updater.state().version, null);
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), []);
});

test('checkReady says whether the downloaded installer still matches, before Atmos quits for it', async t => {
  const w = world(t);
  assert.throws(() => w.updater.checkReady(), /No update is ready/);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  assert.equal(w.updater.checkReady(), true);
  fs.rmSync(path.join(w.options.downloadDir, r.core.installer.file));
  assert.throws(() => w.updater.checkReady(), /changed since it was checked/);
  assert.equal(w.spawned.length, 0);
});

test('an update still waiting two days after it was ready is worth one reminder', async t => {
  let clock = Date.parse('2026-10-02T08:00:00Z');
  const w = world(t, { now: () => clock });
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core);
  assert.equal(w.updater.nudgeDue(), null);
  clock += 47 * 60 * 60 * 1000;
  assert.equal(w.updater.nudgeDue(), null);
  // Restarted in between: the wait counts from when it was first ready.
  const later = w.make();
  await later.consider(r.core);
  clock += 2 * 60 * 60 * 1000;
  assert.equal(later.nudgeDue(), '0.20.0');
  assert.equal(later.nudgeDue(), null, 'once');
  assert.equal(w.make().nudgeDue(), null);

  // Not when updating by hand.
  const manual = world(t, { now: () => clock });
  manual.updater.setAuto(false);
  manual.web.set(r.url, r.bytes);
  await manual.updater.consider(r.core);
  await manual.updater.download();
  clock += 3 * 24 * 60 * 60 * 1000;
  assert.equal(manual.updater.nudgeDue(), null);
});

test('an installer that can\'t start is reported at once (Node only says so later)', () => {
  const { spawnDetached } = require('./atmos-update.cjs');
  assert.throws(() => spawnDetached(path.join(os.tmpdir(), 'no-such-installer.exe'), ['--updated', '/S'], undefined, () => {}), /couldn't be started/);
  assert.doesNotThrow(() => spawnDetached(process.execPath, ['-e', '0']));
});

test('main.js knows the registry key electron-builder gives Atmos\'s install (UUID v5 of the appId)', () => {
  const repo = path.resolve(__dirname, '..', '..', '..');
  const appId = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).build.appId;
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex'); // electron-builder's (NsisTarget)
  const bytes = crypto.createHash('sha1').update(Buffer.concat([namespace, Buffer.from(appId, 'utf8')])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const main = fs.readFileSync(path.join(repo, 'core', 'main.js'), 'utf8');
  assert.equal(main.match(/const _INSTALL_GUID = '([0-9a-f-]+)'/)?.[1], guid);
});

test('a new start whose first check can\'t reach the source keeps the download', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  await w.updater.consider(r.core, { answered: [SOURCE] });
  const next = w.make();
  next.startup();
  await next.consider(null, { answered: [] });
  await next.consider(null, { answered: ['/a/folder/of/packages'] });
  assert.deepEqual(fs.readdirSync(w.options.downloadDir), ['Atmos.Setup.0.20.0.exe']);
  w.downloads.length = 0;
  assert.equal(await next.consider(r.core, { answered: [SOURCE] }), true);
  assert.deepEqual(w.downloads, [], 'and uses it once the source answers');
});

test('an installer that couldn\'t start is said after the restart, and cleared by the next attempt', async t => {
  const w = world(t);
  const r = release('0.20.0');
  w.web.set(r.url, r.bytes);
  const failing = w.make({ spawnInstaller: () => { throw new Error("The installer couldn't be started"); } });
  await failing.consider(r.core);
  assert.throws(() => failing.installNow());
  const after = w.make();
  after.startup();
  await after.consider(r.core);
  assert.match(after.state().startFailed, /couldn't be started/);
  after.installNow();
  assert.equal(JSON.parse(fs.readFileSync(w.options.stateFile, 'utf8')).startFailed, null);
});

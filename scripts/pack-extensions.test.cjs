'use strict';
// pack:extensions and the installer: the signed index names it, a release
// can't forget it, and what it writes is what an installed Atmos accepts
// (the manager reads the index, the updater downloads and checks the file).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { trustedKeyEntry, loadTrustedKeys, checkIndexSignature } = require('../core/js/core/extension-signing.cjs');
const { createExtensionManager } = require('../core/js/core/extension-manager.cjs');
const { createAtmosUpdater } = require('../core/js/core/atmos-update.cjs');

const repo = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'pack-extensions.cjs');

/** A tree to pack (one plugin, Atmos 1.2.3) and a key outside the repo. */
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pack-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'public');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  fs.mkdirSync(path.join(from, 'plugins', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(from, 'package.json'), JSON.stringify({ ...pkg, version: '1.2.3' }));
  fs.writeFileSync(path.join(from, 'release.json'), JSON.stringify({ plugins: ['hello'], services: [] }));
  fs.writeFileSync(path.join(from, 'plugins', 'hello', 'extension.json'), JSON.stringify({
    id: 'hello', name: 'Hello', version: '1.0.0', publisher: 'atmos', apiVersion: 4, displayName: 'Hello',
  }));
  fs.writeFileSync(path.join(from, 'plugins', 'hello', 'index.js'), 'export default {};\n');
  const key = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(dir, 'key.pem');
  fs.writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test' }));
  const trusted = path.join(dir, 'trusted-keys.json');
  fs.writeFileSync(trusted, JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey)] }));
  const out = path.join(dir, 'out');
  const pack = (...extra) => spawnSync(process.execPath, [script, '--from', from, '--out', out, '--key', keyFile, '--untrusted', '--previous', path.join(dir, 'none'), ...extra], {
    encoding: 'utf8', env: { ...process.env, ATMOS_SIGNING_PASSPHRASE: 'test' },
  });
  const index = () => JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  const installer = bytes => {
    fs.mkdirSync(path.join(from, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(from, 'dist', 'Atmos Setup 1.2.3.exe'), bytes);
  };
  const appImage = bytes => {
    fs.mkdirSync(path.join(from, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(from, 'dist', 'Atmos-1.2.3.AppImage'), bytes);
  };
  return { dir, from, out, pack, index, installer, appImage, trustedKeys: loadTrustedKeys([trusted]) };
}

test('a release without its installer stops; --no-installer packs without one', t => {
  const w = world(t);
  const run = w.pack();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no installer at .*Atmos Setup 1\.2\.3\.exe/);
  assert.equal(fs.existsSync(path.join(w.out, 'index.json')), false);

  assert.equal(w.pack('--no-installer').status, 0);
  assert.deepEqual(w.index().core, { version: '1.2.3' });
});

test('the installer is copied under its release name and named in the signed index', async t => {
  const w = world(t);
  const bytes = crypto.randomBytes(300 * 1024);
  w.installer(bytes);
  const run = w.pack();
  assert.equal(run.status, 0, run.stderr);
  const index = w.index();
  const windows = {
    file: 'Atmos.Setup.1.2.3.exe', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), platform: 'win32', arch: 'x64',
  };
  // "installer" for Atmos 0.19 to 0.23, "installers" (every platform's) for 0.24 on.
  assert.deepEqual(index.core, { version: '1.2.3', installer: windows, installers: [windows] });
  assert.ok(fs.readFileSync(path.join(w.out, 'Atmos.Setup.1.2.3.exe')).equals(bytes));
  assert.equal(checkIndexSignature(index, w.trustedKeys).ok, true, 'the installer entry is signed with the rest');

  // What an installed Atmos 1.2.2 on Windows does with it: offered, downloaded, checked, ready.
  const userData = path.join(w.dir, 'user');
  const manager = createExtensionManager({
    userData, installedRoot: kind => path.join(userData, kind), trustedKeys: w.trustedKeys, extraSources: [w.out], appVersion: '1.2.2',
  });
  const status = await manager.checkForUpdates();
  assert.equal(status.core.available, '1.2.3');
  const spawned = [];
  const updater = createAtmosUpdater({
    appVersion: '1.2.2', stateFile: path.join(userData, 'atmos-update.json'), downloadDir: path.join(w.dir, 'downloads'),
    install: { perMachine: false }, platform: 'win32', arch: 'x64', warn() {},
    download: async () => { throw new Error('a folder source is copied, not downloaded'); },
    spawnInstaller: (file, args) => spawned.push({ file, args }),
  });
  assert.equal(await updater.consider(status.core.offer), true);
  assert.equal(updater.installOnQuit(), true);
  assert.deepEqual(spawned.map(item => [path.basename(item.file), item.args]), [['Atmos.Setup.1.2.3.exe', ['--updated', '/S']]]);
});

test('an installer named with --installer, and the old one cleared on the next run', t => {
  const w = world(t);
  const elsewhere = path.join(w.dir, 'built.exe');
  fs.writeFileSync(elsewhere, 'first');
  assert.equal(w.pack('--installer', elsewhere).status, 0);
  assert.equal(w.index().core.installer.file, 'Atmos.Setup.1.2.3.exe');
  assert.equal(w.index().core.installer.size, 5);

  fs.writeFileSync(path.join(w.out, 'Atmos.Setup.1.2.2.exe'), 'stale');
  assert.equal(w.pack('--no-installer').status, 0);
  assert.deepEqual(fs.readdirSync(w.out).filter(name => name.endsWith('.exe')), [], 'no installer left beside an index that names none');
});

test('--installer that doesn\'t exist stops the run', t => {
  const w = world(t);
  const run = w.pack('--installer', path.join(w.dir, 'missing.exe'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no installer at/);
});

test('a missing installer stops the run before anything already there is cleared', t => {
  const w = world(t);
  w.installer(Buffer.from('first'));
  assert.equal(w.pack().status, 0);
  const before = fs.readdirSync(w.out).sort();
  fs.rmSync(path.join(w.from, 'dist'), { recursive: true });
  assert.equal(w.pack().status, 1);
  assert.deepEqual(fs.readdirSync(w.out).sort(), before, 'the last good output is left as it was');
});

test('an installer older than the last commit in --from is refused (built before publishing)', t => {
  const w = world(t);
  w.installer(Buffer.from('old build'));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(w.from, 'dist', 'Atmos Setup 1.2.3.exe'), old, old);
  const git = (...args) => spawnSync('git', args, { cwd: w.from, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'published');
  const run = w.pack();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /older than the last commit/);
  assert.equal(w.pack('--any-installer').status, 0);
});

test('the signed index names the commit --from is checked out at (its own checkout only)', t => {
  const w = world(t);
  const git = (...args) => spawnSync('git', args, { cwd: w.from, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('no git');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'release');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const run = w.pack('--no-installer');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(w.index().core, { version: '1.2.3', commit: head });
  assert.equal(checkIndexSignature(w.index(), w.trustedKeys).ok, true, 'the commit is signed with the rest');
  // A folder inside a checkout isn't that checkout's commit.
  const inner = path.join(w.from, 'inner');
  fs.mkdirSync(inner);
  fs.copyFileSync(path.join(w.from, 'package.json'), path.join(inner, 'package.json'));
  const { coreOf } = require('./pack-extensions.cjs');
  assert.deepEqual(coreOf(inner), { version: '1.2.3' });
});

test('an unreachable previous index stops the run before anything is written; --offline packs without comparing', t => {
  const w = world(t);
  const unreachable = 'https://127.0.0.1:9/';
  const pack = (...extra) => spawnSync(process.execPath, [script, '--from', w.from, '--out', w.out, '--key', path.join(w.dir, 'key.pem'), '--untrusted', '--no-installer', '--previous', unreachable, ...extra], {
    encoding: 'utf8', env: { ...process.env, ATMOS_SIGNING_PASSPHRASE: 'test' },
  });
  const stopped = pack();
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /couldn't read the previous index at https:\/\/127\.0\.0\.1:9\/.*--offline/);
  assert.equal(fs.existsSync(w.out) && fs.readdirSync(w.out).length > 0, false, 'nothing written');
  const offline = pack('--offline');
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /versions not compared \(--offline\)/);
  assert.equal(w.index().packages.length, 1);
});

test('the Linux AppImage beside the installer is named in "installers", and a Linux copy replaces itself with it', async t => {
  const w = world(t);
  const exe = crypto.randomBytes(200 * 1024);
  const image = crypto.randomBytes(250 * 1024);
  w.installer(exe);
  w.appImage(image);
  const run = w.pack();
  assert.equal(run.status, 0, run.stderr);
  const index = w.index();
  const linux = { file: 'Atmos-1.2.3.AppImage', size: image.length, sha256: crypto.createHash('sha256').update(image).digest('hex'), platform: 'linux', arch: 'x64' };
  assert.equal(index.core.installer.file, 'Atmos.Setup.1.2.3.exe', 'the Windows one stays where 0.19 to 0.23 read it');
  assert.deepEqual(index.core.installers, [index.core.installer, linux]);
  assert.ok(fs.readFileSync(path.join(w.out, 'Atmos-1.2.3.AppImage')).equals(image));
  assert.equal(checkIndexSignature(index, w.trustedKeys).ok, true);

  // An AppImage of Atmos 1.2.2 on Linux: offered, downloaded, checked, put in place on quit.
  const userData = path.join(w.dir, 'user');
  const manager = createExtensionManager({
    userData, installedRoot: kind => path.join(userData, kind), trustedKeys: w.trustedKeys, extraSources: [w.out], appVersion: '1.2.2',
  });
  const status = await manager.checkForUpdates();
  const target = path.join(w.dir, 'bin', 'Atmos.AppImage');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'Atmos 1.2.2');
  const updater = createAtmosUpdater({
    appVersion: '1.2.2', stateFile: path.join(userData, 'atmos-update.json'), downloadDir: path.join(w.dir, 'downloads'),
    install: { perMachine: false, appImage: target }, platform: 'linux', arch: 'x64', warn() {},
    download: async () => { throw new Error('a folder source is copied, not downloaded'); },
    spawnInstaller: () => { throw new Error('nothing is run on Linux'); },
  });
  assert.equal(await updater.consider(status.core.offer), true);
  assert.equal(updater.installOnQuit(), true);
  assert.ok(fs.readFileSync(target).equals(image));

  // The next run without an AppImage clears the old one from <out>.
  fs.rmSync(path.join(w.from, 'dist', 'Atmos-1.2.3.AppImage'));
  assert.equal(w.pack().status, 0);
  assert.deepEqual(fs.readdirSync(w.out).filter(name => name.endsWith('.AppImage')), []);
  assert.deepEqual(w.index().core.installers.map(entry => entry.platform), ['win32']);
});

test('--appimage that doesn\'t exist stops the run; one older than the last commit is refused', t => {
  const w = world(t);
  w.installer(Buffer.from('exe'));
  const missing = w.pack('--appimage', path.join(w.dir, 'missing.AppImage'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no AppImage at/);
  assert.equal(fs.existsSync(path.join(w.out, 'index.json')), false);

  spawnSync('git', ['init', '-q'], { cwd: w.from });
  w.appImage(Buffer.from('old build'));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(w.from, 'dist', 'Atmos-1.2.3.AppImage'), old, old);
  fs.utimesSync(path.join(w.from, 'dist', 'Atmos Setup 1.2.3.exe'), new Date(), new Date());
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'package.json'], { cwd: w.from });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'release'], { cwd: w.from });
  fs.utimesSync(path.join(w.from, 'dist', 'Atmos Setup 1.2.3.exe'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const stale = w.pack('--allow-dirty');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Atmos-1\.2\.3\.AppImage is older than the last commit/);
});

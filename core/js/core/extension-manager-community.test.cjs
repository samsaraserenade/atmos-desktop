'use strict';
// Community extensions from GitHub repositories: added as a source,
// checked before they're staged, installed as community extensions that
// load once approved (and again after every update), bound to their repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHasher, listFiles } = require('./extension-integrity.cjs');
const { signExtension, trustedKeyEntry, loadTrustedKeys, signIndex } = require('./extension-signing.cjs');
const { packFolder, writePackage } = require('./extension-package.cjs');
const { createExtensionCatalog } = require('./extension-catalog.cjs');
const { createExtensionTrust } = require('./extension-trust.cjs');
const { createExtensionManager, parseGitHub } = require('./extension-manager.cjs');

const RELEASES = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/(.+)$/;

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-community-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const official = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ format: 1, keys: [trustedKeyEntry(official.publicKey)] }));
  const trustedKeys = loadTrustedKeys([path.join(dir, 'keys.json')], () => {});
  const officialSource = path.join(dir, 'official');
  fs.mkdirSync(officialSource, { recursive: true });
  const userData = path.join(dir, 'user');
  const root = (where, kind) => path.join(dir, where, kind);
  const repoDir = repo => path.join(dir, 'github', ...repo.split('/'));
  const fetched = [];
  // GitHub's latest-release downloads, served from folders.
  const fetchUrl = async (url, maxBytes) => {
    fetched.push(url);
    const match = RELEASES.exec(url);
    if (!match) throw new Error(`unexpected ${url}`);
    const file = path.join(repoDir(match[1]), match[2]);
    if (!fs.existsSync(file)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    const buffer = fs.readFileSync(file);
    if (buffer.length > maxBytes) throw new Error('too large');
    return buffer;
  };

  /** Build kind/id@version; sign with `key` (an author's key, embedded) or not. */
  function build(kind, id, version, { files = {}, permissions = {}, publisher = 'someone', key = null, embed = true, dependencies = {} } = {}) {
    const ext = path.join(dir, 'build', `${id}-${version}-${crypto.randomUUID()}`);
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'extension.json'), JSON.stringify({ apiVersion: 3, version, publisher, displayName: id, permissions, dependencies }));
    for (const [name, content] of Object.entries({ 'panel.js': `export default '${version}';`, ...files })) fs.writeFileSync(path.join(ext, name), content);
    if (key) signExtension(ext, { kind, id, privateKey: key, hasher: createHasher(null), embedPublicKey: embed });
    return ext;
  }

  /** Publish a built folder to a repo's latest release (unsigned index). */
  function release(repo, kind, id, version, ext, { generated = new Date().toISOString(), extra = {}, entries = [] } = {}) {
    const out = repoDir(repo);
    fs.mkdirSync(out, { recursive: true });
    // `entries`: files a crafted package adds that Atmos's own listing leaves out.
    const buffer = entries.length
      ? writePackage([...listFiles(ext).map(name => ({ name, data: fs.readFileSync(path.join(ext, name)) })), ...entries])
      : packFolder(ext, listFiles);
    const file = `${id}-${version}.atmos`;
    fs.writeFileSync(path.join(out, file), buffer);
    const indexFile = path.join(out, 'index.json');
    const packages = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).packages : [];
    packages.push({ kind, id, version, publisher: 'someone', displayName: id, apiVersion: 3, requires: {}, dependencies: {}, file, size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'), ...extra });
    fs.writeFileSync(indexFile, JSON.stringify({ format: 1, name: repo, generated, packages }));
  }

  function publishOfficial(kind, id, version, { dependencies = {} } = {}) {
    const ext = path.join(dir, 'build', `official-${id}-${version}`);
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'extension.json'), JSON.stringify({ apiVersion: 3, version, publisher: 'atmos', displayName: id, permissions: {}, dependencies }));
    fs.writeFileSync(path.join(ext, 'boot.js'), 'export default 1;');
    signExtension(ext, { kind, id, privateKey: official.privateKey, hasher: createHasher(null) });
    const buffer = packFolder(ext, listFiles);
    const file = `${id}-${version}.atmos`;
    fs.writeFileSync(path.join(officialSource, file), buffer);
    const indexFile = path.join(officialSource, 'index.json');
    const packages = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).packages : [];
    packages.push({ kind, id, version, publisher: 'atmos', displayName: id, apiVersion: 3, requires: {}, dependencies, file, size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    fs.writeFileSync(indexFile, JSON.stringify(signIndex({ format: 1, name: 'Atmos', generated: 'now', packages }, official.privateKey)));
  }

  function start({ withOfficial = false } = {}) {
    let entries = [];
    const installedRoot = kind => root('installed', kind);
    const manager = createExtensionManager({
      userData, installedRoot, trustedKeys, installed: () => entries, warn() {}, fetchUrl,
      extraSources: withOfficial ? [officialSource] : [],
    });
    const applied = manager.applyPending();
    const catalog = createExtensionCatalog({ bundledRoot: kind => root('bundled', kind), installedRoot, previousRoot: manager.previousRoot, trustedKeys, warn() {} });
    const trust = createExtensionTrust({ approvalsFile: path.join(userData, 'approvals.json'), bundledRoot: kind => root('bundled', kind), trustedKeys, warn() {} });
    trust.assessAll(catalog);
    entries = [...catalog.list('plugins'), ...catalog.list('services')].map(entry => ({ ...entry, loadable: trust.get(entry).loadable }));
    // As main.js does: a community extension waiting for approval hasn't failed to update.
    manager.confirmApplied((kind, id) => {
      const entry = catalog.find(`${kind}s`, id);
      const result = entry ? trust.get(entry) : null;
      return entry ? { entry, loadable: result.loadable, awaitingApproval: entry.tier === 'third-party' && ['pending', 'changed'].includes(result.status) } : null;
    });
    const find = (kind, id) => entries.find(entry => entry.kind === kind && entry.id === id) || null;
    const assessed = (kind, id) => trust.get(find(kind, id));
    return { manager, catalog, trust, applied, find, assessed };
  }

  return { dir, userData, build, release, publishOfficial, start, official, fetched, author: crypto.generateKeyPairSync('ed25519') };
}

test('a GitHub repository, however it is written, is read from its latest release', () => {
  const expected = { repo: 'someone/weather-widget', location: 'https://github.com/someone/weather-widget/releases/latest/download/' };
  for (const input of ['github:someone/weather-widget', 'https://github.com/someone/weather-widget', 'github.com/someone/weather-widget/',
    'https://github.com/someone/weather-widget.git', 'https://www.github.com/someone/weather-widget/tree/main/src']) {
    assert.deepEqual(parseGitHub(input), expected, input);
  }
  assert.deepEqual(parseGitHub('github:SomeOne/Weather-Widget'), expected, 'GitHub names ignore case');
  for (const input of ['https://gitlab.com/a/b', 'github:a', 'github:../b', 'https://github.com/-bad/x', 'C:\\folder', 'https://example.com/index.json']) {
    assert.equal(parseGitHub(input), null, input);
  }
});

test('install from a repository: community, unsigned, waits for approval, and asks again after an update', async t => {
  const w = world(t);
  w.release('someone/weather', 'plugin', 'weather', '1.0.0', w.build('plugin', 'weather', '1.0.0', { permissions: { network: ['api.open-meteo.com'] } }));
  let s = w.start();
  s.manager.addSource('https://github.com/someone/weather');
  assert.deepEqual(s.manager.sources().map(source => [source.location, source.community, source.repo]),
    [['https://github.com/someone/weather/releases/latest/download/', true, 'someone/weather']]);
  let status = await s.manager.checkForUpdates();
  assert.equal(status.sources[0].ok, true, status.sources[0].error);
  assert.deepEqual(status.packages.map(p => [p.id, p.action, p.community, p.repo]), [['weather', 'install', true, 'someone/weather']]);

  const result = await s.manager.install('plugin', 'weather');
  assert.deepEqual(result.changes[0].community, {
    source: 'https://github.com/someone/weather/releases/latest/download/', repo: 'someone/weather', keyId: null, key: null, lastKey: null, keyChanged: false,
  });

  s = w.start();
  assert.deepEqual(s.applied.map(a => `${a.action} ${a.id}`), ['install weather']);
  assert.equal(s.find('plugin', 'weather').tier, 'third-party');
  let assessed = s.assessed('plugin', 'weather');
  assert.equal(assessed.status, 'pending', 'loads only once approved');
  assert.deepEqual(s.manager.status().applied, [], 'waiting for approval is not a failed install');
  assert.deepEqual(assessed.authorSignature, { status: 'unsigned', keyId: null, reason: null });
  assert.equal(s.manager.communityOrigin('plugin', 'weather').repo, 'someone/weather');
  s.trust.approve('plugins', s.find('plugin', 'weather'), assessed.fingerprint);
  s = w.start();
  assert.equal(s.assessed('plugin', 'weather').status, 'approved');

  // An update is offered as one, and needs approving again.
  w.release('someone/weather', 'plugin', 'weather', '1.1.0', w.build('plugin', 'weather', '1.1.0', { permissions: { network: ['api.open-meteo.com'] } }));
  status = await s.manager.checkForUpdates();
  assert.deepEqual(status.packages.map(p => [p.id, p.action, p.installedVersion]), [['weather', 'update', '1.0.0']]);
  await s.manager.install('plugin', 'weather');
  s = w.start();
  assessed = s.assessed('plugin', 'weather');
  assert.equal(s.find('plugin', 'weather').version, '1.1.0');
  assert.equal(assessed.status, 'changed');
  assert.equal(assessed.loadable, false);
  assert.deepEqual(s.manager.status().applied, []);
});

test('an author\'s signature: shown as signed with its key; an update with another key is pointed out', async t => {
  const w = world(t);
  const other = crypto.generateKeyPairSync('ed25519');
  w.release('someone/clock', 'plugin', 'clock', '1.0.0', w.build('plugin', 'clock', '1.0.0', { key: w.author.privateKey }));
  let s = w.start();
  s.manager.addSource('github:someone/clock');
  await s.manager.checkForUpdates();
  const first = await s.manager.install('plugin', 'clock');
  assert.match(first.changes[0].community.keyId, /^[0-9a-f]{16}$/);
  s = w.start();
  const assessed = s.assessed('plugin', 'clock');
  assert.equal(assessed.authorSignature.status, 'signed');
  assert.equal(assessed.authorSignature.keyId, first.changes[0].community.keyId);
  assert.equal(s.manager.communityOrigin('plugin', 'clock').keyChanged, false);

  w.release('someone/clock', 'plugin', 'clock', '1.0.1', w.build('plugin', 'clock', '1.0.1', { key: other.privateKey }));
  await s.manager.checkForUpdates();
  const update = await s.manager.install('plugin', 'clock');
  assert.equal(update.changes[0].community.keyChanged, true);
  s = w.start();
  assert.equal(s.manager.communityOrigin('plugin', 'clock').keyChanged, true);
  assert.notEqual(s.assessed('plugin', 'clock').authorSignature.keyId, first.changes[0].community.keyId);
});

test('what could never be approved is refused before it is staged', async t => {
  const w = world(t);
  const s = w.start();
  s.manager.addSource('github:someone/bad');
  w.release('someone/bad', 'plugin', 'with-main', '1.0.0', w.build('plugin', 'with-main', '1.0.0', { files: { 'main.cjs': 'module.exports = () => {};' } }));
  w.release('someone/bad', 'plugin', 'asks-node', '1.0.0', w.build('plugin', 'asks-node', '1.0.0', { permissions: { node: ['fs'] } }));
  w.release('someone/bad', 'plugin', 'asks-web', '1.0.0', w.build('plugin', 'asks-web', '1.0.0', { permissions: { web: true } }));
  w.release('someone/bad', 'plugin', 'claims-official', '1.0.0', w.build('plugin', 'claims-official', '1.0.0', { key: w.official.privateKey, publisher: 'atmos' }));
  const tampered = w.build('plugin', 'tampered', '1.0.0', { key: w.author.privateKey });
  fs.writeFileSync(path.join(tampered, 'panel.js'), 'export default "changed after signing";');
  w.release('someone/bad', 'plugin', 'tampered', '1.0.0', tampered);
  await s.manager.checkForUpdates();
  await assert.rejects(s.manager.install('plugin', 'with-main'), /main-process code/);
  await assert.rejects(s.manager.install('plugin', 'asks-node'), /main-process permissions \(node\)/);
  await assert.rejects(s.manager.install('plugin', 'asks-web'), /permissions \(web\) only official/);
  await assert.rejects(s.manager.install('plugin', 'claims-official'), /publisher is Atmos/);
  await assert.rejects(s.manager.install('plugin', 'tampered'), /signature doesn't match its files.*panel\.js/);
  assert.deepEqual(s.manager.status().pending, [], 'nothing staged');
  assert.deepEqual(fs.existsSync(path.join(w.userData, 'extension-staging')) ? fs.readdirSync(path.join(w.userData, 'extension-staging')) : [], []);
});

test('an id that isn\'t the repository\'s to use is refused, and one installed stays bound to its repository', async t => {
  const w = world(t);
  w.publishOfficial('service', 'charting', '1.0.0');
  w.publishOfficial('plugin', 'finance', '1.0.0', { dependencies: { 'only-community': '*' } });
  w.release('someone/a', 'service', 'charting', '9.0.0', w.build('service', 'charting', '9.0.0'));
  w.release('someone/a', 'plugin', 'notes', '1.0.0', w.build('plugin', 'notes', '1.0.0'));
  w.release('someone/a', 'service', 'only-community', '1.0.0', w.build('service', 'only-community', '1.0.0'));
  w.release('someone/b', 'plugin', 'notes', '2.0.0', w.build('plugin', 'notes', '2.0.0'));
  let s = w.start({ withOfficial: true });
  s.manager.addSource('github:someone/a');
  s.manager.addSource('github:someone/b');
  let status = await s.manager.checkForUpdates();
  const byLocation = new Map(status.sources.map(source => [source.repo || 'official', source]));
  assert.deepEqual(byLocation.get('someone/a').refused, [{ kind: 'service', id: 'charting', reason: 'an official extension has this id' }]);
  assert.deepEqual(byLocation.get('someone/b').refused, [{ kind: 'plugin', id: 'notes', reason: 'another repository you added has this id' }]);
  const charting = status.packages.find(p => p.id === 'charting');
  assert.equal(charting.version, '1.0.0', 'the official one');
  assert.equal(charting.community, undefined);
  // An official extension never pulls in a community one.
  assert.throws(() => s.manager.plan('plugin', 'finance'), /needs only-community, which none of your sources has/);

  await s.manager.install('plugin', 'notes');
  s = w.start({ withOfficial: true });
  // Installed from a: b's notes stays refused even if a's index drops it.
  status = await s.manager.checkForUpdates();
  assert.deepEqual(status.sources.find(source => source.repo === 'someone/b').refused,
    [{ kind: 'plugin', id: 'notes', reason: 'already installed from someone/a' }]);
  // Removing it frees the id.
  s.manager.remove('plugin', 'notes');
  s = w.start({ withOfficial: true });
  assert.equal(s.manager.communityOrigin('plugin', 'notes'), null);
});

test('an official package replaces a community copy and frees its id', async t => {
  const w = world(t);
  w.release('someone/a', 'plugin', 'notes', '1.0.0', w.build('plugin', 'notes', '1.0.0'));
  let s = w.start();
  // Any github.com address of the repository is the repository.
  s.manager.addSource('https://github.com/someone/a/releases/latest/download/');
  assert.deepEqual(s.manager.sources().map(source => source.repo), ['someone/a']);
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'notes');
  s = w.start();
  assert.ok(s.manager.communityOrigin('plugin', 'notes'));
  w.publishOfficial('plugin', 'notes', '1.0.0');
  s = w.start({ withOfficial: true });
  const status = await s.manager.checkForUpdates();
  const notes = status.packages.find(p => p.id === 'notes');
  assert.equal(notes.community, undefined);
  assert.equal(notes.action, 'install', 'installs over the community copy');
  await s.manager.install('plugin', 'notes');
  s = w.start({ withOfficial: true });
  assert.equal(s.find('plugin', 'notes').tier, 'first-party');
  assert.equal(s.manager.communityOrigin('plugin', 'notes'), null);
});

test('what the SDK\'s pack.cjs writes installs from a release: unsigned, then signed with a key it made', async t => {
  const { spawnSync } = require('node:child_process');
  const w = world(t);
  const packScript = path.join(__dirname, '..', 'sdk', 'pack.cjs');
  const repoFolder = path.join(w.dir, 'author', 'weather');
  fs.mkdirSync(path.join(repoFolder, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repoFolder, '.atmos-sdk'), { recursive: true });
  fs.mkdirSync(path.join(repoFolder, 'src'), { recursive: true });
  const manifest = version => JSON.stringify({ apiVersion: 3, version, publisher: 'someone', displayName: 'Weather', permissions: { network: ['api.open-meteo.com'] } });
  fs.writeFileSync(path.join(repoFolder, 'extension.json'), manifest('1.0.0'));
  fs.writeFileSync(path.join(repoFolder, 'package.json'), JSON.stringify({ name: 'weather', scripts: {} }));
  fs.writeFileSync(path.join(repoFolder, 'panel.js'), 'export default 1;');
  fs.writeFileSync(path.join(repoFolder, 'src', 'forecast.js'), 'export const f = 1;');
  fs.writeFileSync(path.join(repoFolder, 'tests', 'a.test.js'), '');
  fs.writeFileSync(path.join(repoFolder, '.atmos-sdk', 'x.d.ts'), '');
  const pack = (...args) => spawnSync(process.execPath, [packScript, ...args], { cwd: repoFolder, encoding: 'utf8', env: { ...process.env, ATMOS_SIGNING_PASSPHRASE: '' } });
  const publish = () => {
    const out = path.join(w.dir, 'github', 'someone', 'weather');
    fs.mkdirSync(out, { recursive: true });
    for (const name of fs.readdirSync(path.join(repoFolder, 'dist'))) fs.copyFileSync(path.join(repoFolder, 'dist', name), path.join(out, name));
  };

  let run = pack();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /weather-1\.0\.0\.atmos .*unsigned/);
  publish();
  let s = w.start();
  s.manager.addSource('github.com/someone/weather');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'weather');
  s = w.start();
  const installed = s.find('plugin', 'weather');
  assert.deepEqual(fs.readdirSync(installed.path).sort(), ['extension.json', 'panel.js', 'src'], 'no tests, dot folders or package.json');
  assert.equal(s.assessed('plugin', 'weather').authorSignature.status, 'unsigned');

  // Signed, with a key made outside the folder.
  fs.writeFileSync(path.join(repoFolder, 'extension.json'), manifest('1.1.0'));
  assert.match(pack('--new-key', path.join(repoFolder, 'key.pem')).stderr, /outside the extension's folder/);
  run = pack('--new-key', path.join(w.dir, 'author-key.pem'));
  assert.equal(run.status, 0, run.stderr);
  const keyId = /signed \(key ([0-9a-f]{16})\)/.exec(run.stdout)?.[1];
  assert.ok(keyId, run.stdout);
  publish();
  await s.manager.checkForUpdates();
  const update = await s.manager.install('plugin', 'weather');
  assert.equal(update.changes[0].community.keyId, keyId);
  assert.equal(update.changes[0].community.keyChanged, false, 'unsigned before: nothing to compare with');
  s = w.start();
  const assessed = s.assessed('plugin', 'weather');
  assert.deepEqual([assessed.authorSignature.status, assessed.authorSignature.keyId, assessed.status], ['signed', keyId, 'pending']);

  // An official publisher name or a main.cjs is refused when packing.
  fs.writeFileSync(path.join(repoFolder, 'main.cjs'), '');
  assert.match(pack().stderr, /can't have a main\.cjs/);
});

test('the security review\'s cases: ids across kinds, official ids remembered, freshness, key continuity, hidden files, odd file names', async t => {
  const w = world(t);
  w.publishOfficial('plugin', 'finance', '1.0.0');
  w.publishOfficial('plugin', 'notes', '1.0.0');
  let s = w.start({ withOfficial: true });
  await s.manager.install('plugin', 'finance');
  s = w.start({ withOfficial: true });
  fs.mkdirSync(path.join(w.userData, 'finance'), { recursive: true });
  fs.writeFileSync(path.join(w.userData, 'finance', 'connection.bin'), 'secret');

  // A service can't take an official plugin's id (their data folder is named by id).
  w.release('evil/x', 'service', 'finance', '1.0.0', w.build('service', 'finance', '1.0.0'));
  // Official ids are remembered: with the official source gone, notes still can't be taken.
  w.release('evil/x', 'plugin', 'notes', '9.0.0', w.build('plugin', 'notes', '9.0.0'));
  // A name that resolves elsewhere on github.com is no package.
  const odd = w.build('plugin', 'odd', '1.0.0');
  w.release('evil/x', 'plugin', 'odd', '1.0.0', odd, { extra: { file: '%2e%2e/%2e%2e/login.atmos' } });
  // A file neither the signature nor an approval would cover.
  w.release('evil/x', 'plugin', 'thumbs', '1.0.0', w.build('plugin', 'thumbs', '1.0.0', { key: w.author.privateKey }), { entries: [{ name: 'Thumbs.db', data: Buffer.from('self.postMessage(1)') }] });
  s = w.start();
  s.manager.addSource('github:Evil/X');
  let status = await s.manager.checkForUpdates();
  const source = status.sources.find(item => item.repo === 'evil/x');
  assert.ok(source, 'the repository, in lower case');
  assert.deepEqual(source.refused.map(item => `${item.kind}:${item.id}`).sort(), ['plugin:notes', 'service:finance']);
  assert.deepEqual(status.packages.map(p => p.id).sort(), ['thumbs']);
  await assert.rejects(s.manager.install('plugin', 'thumbs'), /contains Thumbs\.db/);

  // Removing a community copy with "delete its data" never takes another kind's folder.
  w.release('someone/svc', 'service', 'shared-id', '1.0.0', w.build('service', 'shared-id', '1.0.0'));
  fs.mkdirSync(path.join(w.dir, 'installed', 'plugins', 'shared-id'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'installed', 'plugins', 'shared-id', 'extension.json'), JSON.stringify({ apiVersion: 3, version: '1.0.0', publisher: 'me' }));
  fs.mkdirSync(path.join(w.userData, 'shared-id'));
  fs.writeFileSync(path.join(w.userData, 'shared-id', 'keep.txt'), 'keep');
  s = w.start();
  s.manager.addSource('github:someone/svc');
  status = await s.manager.checkForUpdates();
  assert.deepEqual(status.sources.find(item => item.repo === 'someone/svc').refused, [{ kind: 'service', id: 'shared-id', reason: 'another installed extension has this id' }]);

  // A far-future time in an unsigned index doesn't stop later ones.
  w.release('someone/clock', 'plugin', 'clock', '1.0.0', w.build('plugin', 'clock', '1.0.0', { key: w.author.privateKey }), { generated: '9999-01-01T00:00:00.000Z' });
  s.manager.addSource('github:someone/clock');
  await s.manager.checkForUpdates();
  await s.manager.install('plugin', 'clock');
  s = w.start();
  // Key continuity survives an unsigned version: K1, unsigned, K2 is a change.
  const k2 = crypto.generateKeyPairSync('ed25519');
  fs.rmSync(path.join(w.dir, 'github', 'someone', 'clock'), { recursive: true });
  w.release('someone/clock', 'plugin', 'clock', '1.0.1', w.build('plugin', 'clock', '1.0.1'), { generated: '2026-01-01T00:00:00.000Z' });
  status = await s.manager.checkForUpdates();
  assert.equal(status.sources.find(item => item.repo === 'someone/clock').ok, true, 'an older time is fine for a repository');
  assert.equal((await s.manager.install('plugin', 'clock')).changes[0].community.keyChanged, true, 'no longer signed');
  s = w.start();
  fs.rmSync(path.join(w.dir, 'github', 'someone', 'clock'), { recursive: true });
  w.release('someone/clock', 'plugin', 'clock', '1.0.2', w.build('plugin', 'clock', '1.0.2', { key: k2.privateKey }));
  await s.manager.checkForUpdates();
  assert.equal((await s.manager.install('plugin', 'clock')).changes[0].community.keyChanged, true, 'a different key after an unsigned version');

  assert.equal(fs.readFileSync(path.join(w.userData, 'finance', 'connection.bin'), 'utf8'), 'secret');
});

// Official packages: signature-driven trust, precedence by version, fallback
// and dependencies, in the real Atmos.
//
//  1. Sample (an official-style fixture, scripts/e2e/fixtures/official), packed and signed
//     as a .atmos (scripts/pack-extensions.cjs), unpacked into the installed
//     folder: it loads as Official, in first-party frames of its own origin.
//     A signed plugin with a main.cjs is activated; an unsigned one is not.
//  2. One changed file: tampered, not loaded, not demoted to Community.
//  3. The same files unsigned, or signed with an unknown key: Community,
//     waiting for approval.
//  4. A signed newer version (patch + 1) installed next to a bundled copy
//     wins; damaged, it
//     falls back to the bundled copy and Settings says so.
//  5. Charting switched off: Finance (which needs it) doesn't load and says
//     why; Charting lists Finance under "Used by".
//
// Usage: node scripts/e2e/official-packages.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'official-packages'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { createHasher, listFiles } = require(path.join(repo, 'core/js/core/extension-integrity.cjs'));
const { signExtension, trustedKeyEntry } = require(path.join(repo, 'core/js/core/extension-signing.cjs'));
const { packFolder, unpackTo } = require(path.join(repo, 'core/js/core/extension-package.cjs'));
const { bundleFilters, copyBundled } = require(path.join(repo, 'scripts/pack-extensions.cjs'));
// An official-style plugin that isn't bundled with Atmos: what these checks install.
const FIXTURES = path.join(__dirname, 'fixtures', 'official');
const SAMPLE = 'sample';
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot: cfg } = isolatedEnv('atmos-official-');

// A test key, trusted only through --trusted-keys (honoured unpackaged only).
const official = crypto.generateKeyPairSync('ed25519');
const stranger = crypto.generateKeyPairSync('ed25519');
const trustedFile = path.join(home, 'trusted-keys.json');
fs.writeFileSync(trustedFile, JSON.stringify({ format: 1, keys: [trustedKeyEntry(official.publicKey, { note: 'e2e test key' })] }));

/** Pack <kind>/<id> from `root` the way pack:extensions does, as a .atmos buffer. */
function pack(root, kind, id, privateKey = official.privateKey, edit = null) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pack-'));
  const dir = path.join(staging, id);
  copyBundled(root, kind, id, dir, bundleFilters(repo));
  if (edit) edit(dir);
  signExtension(dir, { kind: kind === 'plugins' ? 'plugin' : 'service', id, privateKey, hasher: createHasher(null) });
  const buffer = packFolder(dir, listFiles);
  fs.rmSync(staging, { recursive: true, force: true });
  return buffer;
}
const install = (kind, id, buffer) => {
  const dest = path.join(cfg, kind, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return unpackTo(buffer, dest).length;
};
/** The repo manifest's version with its patch number raised: newer than the bundled copy. */
const nextPatch = (kind, id) => {
  const [major, minor, patch] = JSON.parse(fs.readFileSync(path.join(FIXTURES, kind, id, 'extension.json'), 'utf8')).version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};
const bumpVersion = version => dir => {
  const file = path.join(dir, 'extension.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
};

// Bundled extensions as in the repo (no integrity.json: from source).
const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-bundled-'));
for (const kind of ['plugins', 'services']) {
  fs.cpSync(path.join(repo, kind), path.join(bundled, kind), { recursive: true, filter: src => !/node_modules|[\\/]tests[\\/]|_to_delete|backups/.test(src) });
}
for (const id of fs.readdirSync(path.join(repo, 'services'))) {
  const nm = path.join(repo, 'services', id, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(bundled, 'services', id, 'node_modules'), 'dir');
}
// The same with Sample bundled too, for step 4.
const bundledWithSample = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-bundled-sample-'));
fs.cpSync(bundled, bundledWithSample, { recursive: true, verbatimSymlinks: true });
fs.cpSync(path.join(FIXTURES, 'plugins', SAMPLE), path.join(bundledWithSample, 'plugins', SAMPLE), { recursive: true });

// A signed plugin with main-process code, and the same plugin unsigned.
const marker = path.join(home, 'SIGNED_MAIN_RAN');
const mainPlugin = id => ({
  'extension.json': JSON.stringify({ apiVersion: 3, version: '1.0.0', publisher: 'atmos', displayName: id, permissions: { node: ['fs'] } }),
  'main.cjs': `module.exports = { activate() { require('fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${id}\n`)}); } };`,
});
const source = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-src-'));
for (const id of ['signed-main', 'unsigned-main']) {
  for (const [file, content] of Object.entries(mainPlugin(id))) {
    fs.mkdirSync(path.join(source, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(source, 'plugins', id, file), content);
  }
}
install('plugins', 'signed-main', pack(source, 'plugins', 'signed-main'));
fs.cpSync(path.join(source, 'plugins', 'unsigned-main'), path.join(cfg, 'plugins', 'unsigned-main'), { recursive: true });

async function launch(root) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${root}`, `--trusted-keys=${trustedFile}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::/.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { app, page, logs, errors };
}
const describe = (page, ids) => page.evaluate(async wanted => {
  const all = [...await window.atmosCore.listPlugins(), ...await window.atmosCore.listServices()];
  return Object.fromEntries(all.filter(p => wanted.includes(p.id)).map(p => [p.id, {
    state: `${p.tier}/${p.status}/${p.active ? 'active' : 'off'}`,
    source: p.source, version: p.version, reason: p.statusReason || undefined,
    fellBackFrom: p.fellBackFrom || undefined,
    dependencyProblems: p.dependencyProblems.length ? p.dependencyProblems : undefined,
    usedBy: p.usedBy.length ? p.usedBy.map(u => u.name) : undefined,
  }]));
}, ids);
/** Settings → Extensions, scrolled to its Plugins or Services. */
async function openSettings(page, section, name) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionManager());
  await page.waitForTimeout(800);
  await page.evaluate(label => [...document.querySelectorAll('#settings-menu-list .sm-manager-heading')].find(el => el.textContent.trim() === label)?.scrollIntoView(), section);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll('.sm-permissions').forEach(d => { d.open = true; }));
  await page.screenshot({ path: path.join(out, name) });
}
const cards = (page, pattern) => page.evaluate(p => [...document.querySelectorAll('.sm-extension-card')]
  .filter(c => new RegExp(p).test(c.textContent)).map(c => c.innerText.replace(/\s+/g, ' ').trim()), pattern);
const bootFrame = (page, id) => {
  const frame = page.frames().find(f => f.url().includes(`ext=plugin%3A${id}`) && f.url().includes('surface=boot'));
  return frame ? new URL(frame.url()).host : null;
};

(async () => {
  const r = { home };
  const report = (step, value) => { r[step] = value; };

  // 1. Signed Sample in the installed folder only.
  report('1-installedFiles', install('plugins', SAMPLE, pack(FIXTURES, 'plugins', SAMPLE)));
  let s = await launch(bundled);
  report('1-list', await describe(s.page, [SAMPLE, 'signed-main', 'unsigned-main']));
  report('1-bootFrameOrigin', bootFrame(s.page, SAMPLE));
  report('1-mainActivated', fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
  await s.page.evaluate(() => window.atmosCore?.openPanel?.('sample'));
  await openSettings(s.page, 'Plugins', '10-official-installed.png');
  report('1-cards', await cards(s.page, 'Sample|signed-main|unsigned-main'));
  report('1-errors', s.errors);
  await s.app.close();

  // 2. One changed file.
  fs.appendFileSync(path.join(cfg, 'plugins/sample/boot.js'), '\n// changed\n');
  s = await launch(bundled);
  report('2-list', await describe(s.page, [SAMPLE]));
  report('2-bootFrameOrigin', bootFrame(s.page, SAMPLE));
  await openSettings(s.page, 'Plugins', '20-tampered.png');
  report('2-cards', await cards(s.page, 'Sample'));
  await s.app.close();

  // 3. Unsigned, then signed by a key Atmos doesn't know.
  fs.rmSync(path.join(cfg, 'plugins/sample/signature.json'));
  s = await launch(bundled);
  report('3-unsigned', await describe(s.page, [SAMPLE]));
  await s.app.close();
  install('plugins', SAMPLE, pack(FIXTURES, 'plugins', SAMPLE, stranger.privateKey));
  s = await launch(bundled);
  report('3-unknownKey', await describe(s.page, [SAMPLE]));
  await s.app.close();

  // 4. A newer signed version beside the bundled one, then damaged.
  install('plugins', SAMPLE, pack(FIXTURES, 'plugins', SAMPLE, official.privateKey, bumpVersion(nextPatch('plugins', SAMPLE))));
  s = await launch(bundledWithSample);
  report('4-newer', await describe(s.page, [SAMPLE]));
  await s.app.close();
  fs.appendFileSync(path.join(cfg, 'plugins/sample/engine.js'), '\n// damaged\n');
  s = await launch(bundledWithSample);
  report('4-fallback', await describe(s.page, [SAMPLE]));
  report('4-bootFrameOrigin', bootFrame(s.page, SAMPLE));
  await openSettings(s.page, 'Plugins', '40-fallback.png');
  report('4-cards', await cards(s.page, 'Sample'));
  await s.app.close();

  // 5. Charting off: Finance needs it.
  s = await launch(repo);
  await s.page.evaluate(() => window.atmosCore.setExtensionEnabled('service', 'charting', false));
  await s.app.close();
  s = await launch(repo);
  report('5-list', await describe(s.page, ['finance', 'charting', 'market-data']));
  await openSettings(s.page, 'Plugins', '50-dependency-plugins.png');
  report('5-financeCard', await cards(s.page, 'Finance'));
  await openSettings(s.page, 'Services', '51-dependency-services.png');
  report('5-chartingCard', await cards(s.page, 'Charting'));
  report('5-errors', s.errors);
  await s.page.evaluate(() => window.atmosCore.setExtensionEnabled('service', 'charting', true));
  await s.app.close();

  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

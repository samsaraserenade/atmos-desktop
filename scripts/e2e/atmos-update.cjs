// Atmos updating itself (core/js/core/atmos-update.cjs), through Settings →
// Atmos, with a local source whose signed index names Atmos 99.0.0 and
// its installer. Unpackaged, --update-test-install=<file> stands in for an
// installed copy: the installer isn't run, what would have run is written to
// <file>.
//
//  1. The check finds 99.0.0, downloads (copies) and checks the installer by
//     itself: "Atmos 99.0.0 is ready to install … installs when you quit";
//     the footer's version says it's ready. "Update Atmos
//     automatically" is on.
//  2. Switched off, the row says Restart to install, and quitting installs
//     nothing. Switched on again.
//  3. Quitting installs: `--updated /S`, the installer that was checked.
//  4. The next start (still 99.0.0's predecessor, but within the grace for
//     an installer still running) finds the download again without copying
//     it; Restart to update: `--updated /S --force-run`, and Atmos quits.
//  5. Restart to apply (the extensions' restart) with an update waiting
//     installs it instead of relaunching.
//  6. The source's installer changed after the index was signed: "It
//     couldn't be downloaded … doesn't match the signed index", with Try
//     again and the download page, and nothing is installed on quit.
//  7. Automatic updates off from the start: "Atmos 99.0.0 is available"
//     with Download; Download makes it ready.
//  8. The source unreachable at the next check: the update waiting stands,
//     its download is kept, and it installs on quit. At a new start with
//     the source unreachable: "Couldn't check", the download kept, and
//     ready again from it once the source is back.
//
// Usage: node scripts/e2e/atmos-update.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'atmos-update'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { trustedKeyEntry } = require(path.join(repo, 'core/js/core/extension-signing.cjs'));
const { buildIndex, installerEntry } = require(path.join(repo, 'scripts/pack-extensions.cjs'));
fs.mkdirSync(out, { recursive: true });

const key = crypto.generateKeyPairSync('ed25519');
const checks = [];
const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === null ? '' : `: ${JSON.stringify(detail)}`}`); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A home with a trusted test key and a source naming Atmos 99.0.0 and its installer. */
async function world(prefix) {
  const iso = isolatedEnv(prefix);
  const trustedFile = path.join(iso.home, 'trusted-keys.json');
  fs.writeFileSync(trustedFile, JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey, { note: 'e2e test key' })] }));
  const source = path.join(iso.home, 'source');
  fs.mkdirSync(source, { recursive: true });
  const installer = path.join(source, 'Atmos.Setup.99.0.0.exe');
  fs.writeFileSync(installer, crypto.randomBytes(2 * 1024 * 1024));
  // This platform's, so that the updater takes it (a release names win32/x64).
  const entry = await installerEntry(installer, { platform: process.platform, arch: process.arch });
  buildIndex(source, key.privateKey, 'Test source', { core: { version: '99.0.0', installer: entry } });
  const record = path.join(iso.home, 'installer-run.json');
  return { ...iso, trustedFile, source, installer, entry, record };
}

async function launch(w) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--trusted-keys=${w.trustedFile}`, `--extension-source=${w.source}`, `--update-test-install=${w.record}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env: w.env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return { app, page, logs };
}

/** Settings → Atmos, where its version and updates are. */
async function openManager(page) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openAtmosSettings());
  await page.waitForSelector('.sm-manager-row[data-key="atmos"]', { timeout: 10000 });
}
/** Check the sources now: "Check now" when Atmos is up to date, the manager itself when an update is shown. */
async function checkNow(page) {
  const link = await page.$('.sm-manager-row[data-key="atmos"] [data-manager-action="check"]');
  if (link) return link.click();
  return page.evaluate(() => window.atmosCore.extensionManager.checkForUpdates());
}
const atmosRow = page => page.evaluate(() => {
  const row = document.querySelector('.sm-manager-row[data-key="atmos"]');
  const auto = document.querySelector('.sm-manager-row[data-key="atmos-auto"] input[type="checkbox"]');
  return {
    text: row ? row.innerText.replace(/\s+/g, ' ').trim() : null,
    buttons: row ? [...row.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
    auto: auto ? auto.checked : null,
  };
});
const waitRow = (page, pattern) => page.waitForFunction(source => {
  const row = document.querySelector('.sm-manager-row[data-key="atmos"]');
  return row && new RegExp(source).test(row.innerText);
}, pattern.source, { timeout: 30000 });
const footerTitle = page => page.evaluate(() => document.getElementById('sidebar-footer-version')?.title || null);
const readRecord = w => { try { return JSON.parse(fs.readFileSync(w.record, 'utf8')); } catch { return null; } };
const quit = async s => { await s.app.close(); };
const exited = app => new Promise(resolve => {
  if (app.process().exitCode !== null) return resolve(true);
  app.process().once('exit', () => resolve(true));
  setTimeout(() => resolve(false), 15000);
});

(async () => {
  const w = await world('atmos-update-');

  // 1. Downloaded and checked by itself.
  let s = await launch(w);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /ready to install/);
  let row = await atmosRow(s.page);
  await s.page.screenshot({ path: path.join(out, '1-ready.png') });
  check('1 ready to install, installs on quit', /Atmos 99\.0\.0 is ready to install/.test(row.text) && /installs when you quit Atmos/.test(row.text), row);
  check('1 Restart to update offered', row.buttons.includes('Restart to update'), row.buttons);
  check('1 automatic updates on by default', row.auto === true, row.auto);
  check('1 footer tooltip', /Atmos 99\.0\.0 is ready: restart to update/.test(await footerTitle(s.page) || ''), await footerTitle(s.page));
  const downloaded = path.join(w.installRoot, 'atmos-updates', 'Atmos.Setup.99.0.0.exe');
  check('1 the installer downloaded and matching', fs.existsSync(downloaded) && sha(downloaded) === w.entry.sha256);

  // 2. Off: Restart to install; on again.
  await s.page.click('.sm-manager-row[data-key="atmos-auto"] .sm-toggle');
  await waitRow(s.page, /Restart to install it/);
  row = await atmosRow(s.page);
  check('2 off: restart to install, not on quit', row.auto === false && /Restart to install it/.test(row.text), row);
  check('2 the setting is saved', JSON.parse(fs.readFileSync(path.join(w.installRoot, 'atmos-update.json'), 'utf8')).auto === false);
  await s.page.click('.sm-manager-row[data-key="atmos-auto"] .sm-toggle');
  await waitRow(s.page, /installs when you quit/);
  check('2 on again', (await atmosRow(s.page)).auto === true);

  // 3. Quitting installs.
  await quit(s);
  let record = readRecord(w);
  check('3 quitting ran the installer silently, without starting Atmos again', JSON.stringify(record?.args) === JSON.stringify(['--updated', '/S']), record);
  check('3 the installer run is the checked one', record && path.resolve(record.file) === downloaded && sha(record.file) === w.entry.sha256, record?.file);
  const attempt = JSON.parse(fs.readFileSync(path.join(w.installRoot, 'atmos-update.json'), 'utf8')).attempt;
  check('3 the attempt is recorded', attempt?.version === '99.0.0' && attempt?.from === require(path.join(repo, 'package.json')).version, attempt);

  // 4. Next start: found again; Restart to update.
  fs.rmSync(w.record, { force: true });
  const before = fs.statSync(downloaded).mtimeMs;
  s = await launch(w);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /ready to install/);
  check('4 the download is used again, not copied again', fs.statSync(downloaded).mtimeMs === before);
  await s.page.screenshot({ path: path.join(out, '4-ready-again.png') });
  await s.page.click('.sm-manager-row[data-key="atmos"] [data-manager-action="install-atmos"]');
  check('4 Restart to update quits Atmos', await exited(s.app));
  record = readRecord(w);
  check('4 Restart to update: silent, and Atmos starts again', JSON.stringify(record?.args) === JSON.stringify(['--updated', '/S', '--force-run']), record);
  await s.app.close().catch(() => {});

  // 5. Restart to apply, with an update waiting, installs it.
  fs.rmSync(w.record, { force: true });
  s = await launch(w);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /ready to install/);
  await s.page.evaluate(() => window.atmosCore.restartAtmos()).catch(() => {});
  check('5 Restart to apply quits Atmos', await exited(s.app));
  record = readRecord(w);
  check('5 Restart to apply installs the update instead of relaunching', JSON.stringify(record?.args) === JSON.stringify(['--updated', '/S', '--force-run']), record);
  await s.app.close().catch(() => {});

  // 6. An installer that doesn't match the signed index.
  const w6 = await world('atmos-update-bad-');
  fs.writeFileSync(w6.installer, crypto.randomBytes(w6.entry.size)); // same size, other bytes
  s = await launch(w6);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /couldn't be downloaded/);
  row = await atmosRow(s.page);
  await s.page.screenshot({ path: path.join(out, '6-mismatch.png') });
  check('6 refused with the reason', /doesn't match the signed index/.test(row.text), row.text);
  check('6 Try again and the download page offered', row.buttons.includes('Try again'), row.buttons);
  check('6 nothing kept', !fs.existsSync(path.join(w6.installRoot, 'atmos-updates', 'Atmos.Setup.99.0.0.exe'))
    && !fs.readdirSync(path.join(w6.installRoot, 'atmos-updates')).some(name => name.endsWith('.part')));
  await quit(s);
  check('6 nothing installed on quit', readRecord(w6) === null, readRecord(w6));

  // 7. Automatic updates off from the start.
  const w7 = await world('atmos-update-manual-');
  fs.writeFileSync(path.join(w7.installRoot, 'atmos-update.json'), JSON.stringify({ format: 1, auto: false }));
  s = await launch(w7);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /is available/);
  row = await atmosRow(s.page);
  await s.page.screenshot({ path: path.join(out, '7-available.png') });
  check('7 available, not downloaded', row.buttons.includes('Download') && !fs.existsSync(path.join(w7.installRoot, 'atmos-updates', 'Atmos.Setup.99.0.0.exe')), row);
  await s.page.click('.sm-manager-row[data-key="atmos"] [data-manager-action="get-atmos"]');
  await waitRow(s.page, /ready to install/);
  row = await atmosRow(s.page);
  check('7 Download makes it ready, to install on restart', /Restart to install it/.test(row.text), row.text);
  await quit(s);
  check('7 nothing installed on quit with automatic updates off', readRecord(w7) === null, readRecord(w7));

  // 8. The source unreachable at the next check: the update waiting stands.
  const w8 = await world('atmos-update-offline-');
  s = await launch(w8);
  await openManager(s.page);
  await checkNow(s.page);
  await waitRow(s.page, /ready to install/);
  fs.renameSync(w8.source, `${w8.source}-gone`);
  await checkNow(s.page);
  await s.page.waitForTimeout(1500);
  row = await atmosRow(s.page);
  check('8 offline: the update waiting stands', /ready to install/.test(row.text), row.text);
  check('8 offline: its download is kept', fs.existsSync(path.join(w8.installRoot, 'atmos-updates', 'Atmos.Setup.99.0.0.exe')));
  await quit(s);
  check('8 offline: it still installs on quit', JSON.stringify(readRecord(w8)?.args) === JSON.stringify(['--updated', '/S']), readRecord(w8));
  // A new session whose first check can't reach the source: the download stays for later.
  fs.writeFileSync(path.join(w8.installRoot, 'atmos-update.json'), JSON.stringify({ format: 1 })); // as if never attempted
  s = await launch(w8);
  await openManager(s.page);
  await checkNow(s.page);
  await s.page.waitForTimeout(1500);
  row = await atmosRow(s.page);
  check('8 offline at a new start: says it couldn\'t check', /Couldn't check/.test(row.text), row.text);
  check('8 offline at a new start: the download is kept', fs.existsSync(path.join(w8.installRoot, 'atmos-updates', 'Atmos.Setup.99.0.0.exe')));
  fs.renameSync(`${w8.source}-gone`, w8.source);
  await checkNow(s.page);
  await waitRow(s.page, /ready to install/);
  check('8 back online: ready again from the kept download', true);
  await quit(s);

  const failed = checks.filter(item => !item.ok);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, failed: failed.length }, null, 2));
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.map(item => item.name) }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });

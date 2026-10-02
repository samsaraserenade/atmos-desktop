// An installed Atmos's first start, with every extension but the system
// services and the built-in ones (Atmos Browser, core/built-in-extensions.json)
// optional (packed by scripts/after-pack.cjs into "the packages that come
// with Atmos"; here a signed folder passed as --seed-packages):
//
//  1. A first start shows the picker with the released plugins but Atmos
//     Browser, which is already there and opens first. Ticking
//     Finance and Audio Player and pressing Install and restart installs
//     them and the services they need, nothing else.
//  2. After the restart they run as installed official extensions (the
//     Extensions page lists them with Remove); Matrix Chat is Available from
//     "Comes with Atmos"; no picker.
//  3. "Start with none" on another first start installs nothing and the
//     picker doesn't come back.
//  4. Upgrading an Atmos that bundled everything (user data already used,
//     Matrix Chat switched off): everything is installed at once, Matrix
//     Chat stays switched off, and there is no picker.
//  (1–4 are a personal build, which carries its packages.)
//  5. A release build, which carries only Atmos Browser (--setup-source stands in for the
//     GitHub release): unreachable, the picker offers Try again / Start with
//     none and nothing is marked done; reachable, it lists and installs.
//  6. Upgrading to a release build: Atmos starts, downloads in the
//     background, opens Settings → Extensions waiting for a restart; after
//     it everything is installed, with no picker.
//
// Usage: node scripts/e2e/first-run.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'first-run'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { trustedKeyEntry, loadTrustedKeys } = require(path.join(repo, 'core/js/core/extension-signing.cjs'));
const { packOptionalExtensions } = require(path.join(repo, 'scripts/after-pack.cjs'));
const { bundleFilters, copyBundled } = require(path.join(repo, 'scripts/pack-extensions.cjs'));
fs.mkdirSync(out, { recursive: true });
const step = message => { if (process.env.E2E_STEPS) console.error('[step]', message); };

// A build's resources/extensions, made the way after-pack.cjs makes it: the
// released extensions, packed and signed (the system services are part of Core).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-first-run-'));
const key = crypto.generateKeyPairSync('ed25519');
const trustedFile = path.join(work, 'trusted-keys.json');
fs.writeFileSync(trustedFile, JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey, { note: 'e2e test key' })] }));
const build = path.join(work, 'extensions');
const release = JSON.parse(fs.readFileSync(path.join(repo, 'release.json'), 'utf8'));
const filters = bundleFilters(repo);
for (const kind of ['plugins', 'services']) {
  fs.mkdirSync(path.join(build, kind), { recursive: true });
  for (const id of release[kind]) copyBundled(repo, kind, id, path.join(build, kind, id), filters);
}

// A release build carries no packages: --setup-source stands in for the
// GitHub release (the same signed index and packages, in a folder).
const released = path.join(work, 'released');
async function launch(env, { setupSource = null } = {}) {
  const where = setupSource
    ? [`--extensions-root=${released}`, `--setup-source=${setupSource}`]
    : [`--extensions-root=${build}`, `--seed-packages=${path.join(build, 'packages')}`];
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, ...where, `--trusted-keys=${trustedFile}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  if (process.env.E2E_LOGS) app.process().stdout.on('data', d => process.stderr.write(d)), app.process().stderr.on('data', d => process.stderr.write(d));
  // Install and restart relaunches Atmos; here the script starts it again itself.
  await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = () => {}; });
  let page = await atmosWindow(app);
  // The first start after an upgrade can replace the window's page once
  // (an extension's one-time fresh start); follow it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ok = await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 }).then(() => true, () => false);
    if (ok) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
    page = await atmosWindow(app);
  }
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::|Electron Security Warning|\[market-data\]|WebSocket|VPS/.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { app, page, logs, errors };
}
const list = page => page.evaluate(async () => {
  const all = [...await window.atmosCore.listPlugins(), ...await window.atmosCore.listServices()];
  return Object.fromEntries(all.filter(p => p.tier !== 'system').map(p => [p.id, `${p.tier}/${p.active ? 'active' : 'off'} ${p.source}`]));
});
const picker = page => page.evaluate(() => {
  const root = document.querySelector('#settings-menu.open .sm-picker, .sm-picker');
  return root && root.offsetParent !== null ? [...root.querySelectorAll('.sm-picker-item')].map(item => item.innerText.replace(/\s+/g, ' ').trim()) : null;
});
// The panel Atmos shows: Atmos Browser, built in, on a first start (0.18).
const activePanel = page => page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId());
const readSetup = cfg => { try { return JSON.parse(fs.readFileSync(path.join(cfg, 'extension-setup.json'), 'utf8')).how; } catch { return null; } };

const r = {};
(async () => {
  r.packed = (await packOptionalExtensions(build, { privateKey: key.privateKey, trustedKeys: loadTrustedKeys([trustedFile], () => {}) })).map(item => item.id).sort();
  r.builtIn = ['plugins', 'services'].flatMap(kind => fs.readdirSync(path.join(build, kind)).map(id => `${kind}/${id}`));

  // 1. A first start: the picker; Finance and Audio Player.
  step('1');
  const fresh = isolatedEnv('atmos-first-run-fresh-');
  let s = await launch(fresh.env);
  await s.page.waitForSelector('.sm-picker', { timeout: 10000 });
  await s.page.screenshot({ path: path.join(out, '10-picker.png') });
  r['1-picker'] = await picker(s.page);
  r['1-pickerText'] = await s.page.evaluate(() => ({
    intro: document.querySelector('.sm-picker p')?.innerText,
    skip: document.querySelector('[data-picker="skip"]')?.textContent,
  }));
  r['1-installBeforeTicking'] = await s.page.evaluate(() => document.querySelector('[data-picker="install"]').disabled);
  for (const id of ['finance', 'audio-player']) await s.page.check(`.sm-picker-item input[value="plugin:${id}"]`);
  await Promise.all([s.app.waitForEvent('close', { timeout: 30000 }), s.page.click('[data-picker="install"]')]);
  r['1-pending'] = JSON.parse(fs.readFileSync(path.join(fresh.installRoot, 'extension-pending.json'), 'utf8')).changes.map(c => c.id).sort();
  r['1-setup'] = readSetup(fresh.installRoot);
  r['1-errors'] = s.errors;

  // 2. After the restart.
  step('2');
  s = await launch(fresh.env);
  r['2-list'] = await list(s.page);
  r['2-picker'] = await picker(s.page);
  r['2-panel'] = await activePanel(s.page);
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionManager());
  await s.page.waitForSelector('.sm-manager-heading', { timeout: 10000 });
  await s.page.click('[data-manager-action="check"]');
  await s.page.waitForFunction(() => /^Checked/.test(document.querySelector('#sm-header-actions [data-manager-action="check"]:not([disabled])')?.title || ''), null, { timeout: 20000 });
  await s.page.waitForTimeout(400);
  await s.page.screenshot({ path: path.join(out, '20-extensions.png') });
  r['2-extensionsPage'] = await s.page.evaluate(() => [...document.querySelectorAll('#settings-menu-list .sm-manager-heading, #settings-menu-list .sm-manager-row, #settings-menu-list .sm-manager-source')]
    .map(el => el.innerText.replace(/\s+/g, ' ').trim()));
  r['2-errors'] = s.errors;
  await s.app.close();

  // 3. Start with none.
  step('3');
  const none = isolatedEnv('atmos-first-run-none-');
  s = await launch(none.env);
  await s.page.waitForSelector('.sm-picker', { timeout: 10000 });
  await s.page.click('[data-picker="skip"]');
  await s.page.waitForTimeout(800);
  r['3-settingsOpen'] = await s.page.evaluate(() => document.getElementById('settings-menu')?.classList.contains('open') ?? false);
  r['3-setup'] = readSetup(none.installRoot);
  await s.app.close();
  s = await launch(none.env);
  r['3-list'] = await list(s.page);
  r['3-picker'] = await picker(s.page);
  r['3-panel'] = await activePanel(s.page);
  r['3-errors'] = s.errors;
  await s.app.close();

  // 4. Upgrading an Atmos that bundled everything.
  step('4');
  const upgrade = isolatedEnv('atmos-first-run-upgrade-');
  fs.mkdirSync(path.join(upgrade.installRoot, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(upgrade.installRoot, 'extension-preferences.json'), JSON.stringify({ plugin: { 'matrix-chat': false } }));
  s = await launch(upgrade.env);
  r['4-list'] = await list(s.page);
  r['4-picker'] = await picker(s.page);
  r['4-setup'] = readSetup(upgrade.installRoot);
  r['4-log'] = s.logs.join('').split('\n').filter(line => /upgrade: installing/.test(line)).map(line => line.trim());
  r['4-errors'] = s.errors;
  await s.app.close();

  // 5. A release build: only the built-in extensions bundled (Atmos
  //    Browser), the rest come from the source.
  step('5');
  fs.cpSync(path.join(build, 'plugins'), path.join(released, 'plugins'), { recursive: true });
  fs.cpSync(path.join(build, 'services'), path.join(released, 'services'), { recursive: true });
  const source = path.join(build, 'packages');
  const offline = isolatedEnv('atmos-first-run-offline-');
  s = await launch(offline.env, { setupSource: path.join(work, 'no-such-source') });
  await s.page.waitForSelector('.sm-picker [data-picker="retry"]', { timeout: 10000 });
  await s.page.screenshot({ path: path.join(out, '50-offline.png') });
  r['5-offline'] = await s.page.evaluate(() => document.querySelector('.sm-picker p')?.innerText);
  r['5-offlineSetup'] = readSetup(offline.installRoot);
  await s.app.close();
  s = await launch(offline.env, { setupSource: source });
  await s.page.waitForSelector('.sm-picker-item', { timeout: 10000 }).catch(async error => {
    await s.page.screenshot({ path: path.join(out, '51-debug.png') });
    r['5-debug'] = { setup: await s.page.evaluate(() => window.atmosCore.extensionManager.setup()), log: s.logs.join('').split('\n').filter(l => /extensions|setup/.test(l)).slice(-8) };
    throw error;
  });
  r['5-picker'] = await picker(s.page);
  await s.page.check('.sm-picker-item input[value="plugin:finance"]');
  await Promise.all([s.app.waitForEvent('close', { timeout: 30000 }), s.page.click('[data-picker="install"]')]);
  s = await launch(offline.env, { setupSource: source });
  r['5-list'] = await list(s.page);
  r['5-errors'] = s.errors;
  await s.app.close();

  // 6. Upgrading to a release build: Atmos starts without the extensions,
  //    downloads them in the background and opens Extensions for a restart.
  step('6');
  const up = isolatedEnv('atmos-first-run-release-upgrade-');
  fs.mkdirSync(path.join(up.installRoot, 'Local Storage'), { recursive: true });
  s = await launch(up.env, { setupSource: source });
  r['6-listAtStart'] = await list(s.page);
  await s.page.waitForSelector('.sm-manager-heading', { timeout: 20000 });
  await s.page.waitForTimeout(500);
  await s.page.screenshot({ path: path.join(out, '60-upgrade-downloaded.png') });
  r['6-page'] = await s.page.evaluate(() => [...document.querySelectorAll('#settings-menu-list .sm-manager-heading, #settings-menu-list .sm-manager-row')]
    .map(el => el.innerText.replace(/\s+/g, ' ').trim()).slice(0, 4));
  r['6-setup'] = readSetup(up.installRoot);
  r['6-errors'] = s.errors;
  await s.app.close();
  s = await launch(up.env, { setupSource: source });
  r['6-afterRestart'] = await list(s.page);
  r['6-picker'] = await picker(s.page);
  await s.app.close();

  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.log(JSON.stringify(r, null, 1)); console.error(e); process.exit(1); });

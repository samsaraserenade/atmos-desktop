// The extension manager with Sample (an official-style fixture,
// scripts/e2e/fixtures/official), through Settings → Extensions:
//
//  1. A local source (a folder with a signed index.json and .atmos packages,
//     as pack:extensions writes them). The footer's Extensions button opens
//     the page; Sample is Available; Install stages it, the button
//     turns the attention colour and asks for a restart.
//  2. After the restart it loads as Official from the installed folder. A
//     value saved in its state stands in for its data.
//  3. 0.9.1 is published: the update shows (nothing downloads until
//     Update), Update, restart: 0.9.1 runs, and the kept 0.9.0 stays
//     through that first session and is gone at the next start (R4).
//  4. Remove, keeping its data (the default), restart: gone. Install again:
//     its saved value is still there.
//  5. Remove, deleting its data: after reinstalling, the value is gone.
//  6. A package changed on the source after its index was signed is refused
//     with the reason shown.
//  7. The index names a newer Atmos: "Atmos 99.0.0 is available" on the
//     page and in the footer's tooltip.
//  8. A signed 0.9.4 whose background frame fails to load: it loads, its
//     frame fails, Settings says the update didn't start; at the next start
//     the kept 0.9.1 runs instead (R4).
//
// Usage: node scripts/e2e/extension-manager.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'extension-manager'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { createHasher, listFiles } = require(path.join(repo, 'core/js/core/extension-integrity.cjs'));
const { signExtension, trustedKeyEntry } = require(path.join(repo, 'core/js/core/extension-signing.cjs'));
const { packFolder } = require(path.join(repo, 'core/js/core/extension-package.cjs'));
const { bundleFilters, copyBundled, buildIndex } = require(path.join(repo, 'scripts/pack-extensions.cjs'));
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot: cfg } = isolatedEnv('atmos-manager-');
const userData = cfg; // Electron's user data and the install folder are both ~/.config/atmos here

const key = crypto.generateKeyPairSync('ed25519');
const trustedFile = path.join(home, 'trusted-keys.json');
fs.writeFileSync(trustedFile, JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey, { note: 'e2e test key' })] }));

// The source: Sample packed and signed as pack:extensions does.
const source = path.join(home, 'source');
fs.mkdirSync(source, { recursive: true });
function publish(version, { broken = false } = {}) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pack-'));
  const dir = path.join(staging, 'sample');
  copyBundled(path.join(__dirname, 'fixtures', 'official'), 'plugins', 'sample', dir, bundleFilters(repo));
  const manifest = path.join(dir, 'extension.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
  // Signed and verified, but its background frame throws as it loads.
  if (broken) fs.writeFileSync(path.join(dir, 'boot.js'), "throw new Error('broken on purpose');\n");
  signExtension(dir, { kind: 'plugin', id: 'sample', privateKey: key.privateKey, hasher: createHasher(null) });
  fs.writeFileSync(path.join(source, `sample-${version}.atmos`), packFolder(dir, listFiles));
  fs.rmSync(staging, { recursive: true, force: true });
  buildIndex(source, key.privateKey, 'Test source');
}
publish('0.9.0');

// Bundled extensions as in the repo (Sample isn't one).
const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-bundled-'));
for (const kind of ['plugins', 'services']) {
  fs.cpSync(path.join(repo, kind), path.join(bundled, kind), { recursive: true, filter: src => !/node_modules|[\\/]tests[\\/]|_to_delete|backups/.test(src) });
}
for (const id of fs.readdirSync(path.join(repo, 'services'))) {
  const nm = path.join(repo, 'services', id, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(bundled, 'services', id, 'node_modules'), 'dir');
}

async function launch() {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${bundled}`, `--trusted-keys=${trustedFile}`, `--extension-source=${source}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::/.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return { app, page, logs, errors };
}
const sample = page => page.evaluate(async () => {
  const p = (await window.atmosCore.listPlugins()).find(item => item.id === 'sample');
  return p ? `${p.tier}/${p.status}/${p.active ? 'active' : 'off'} ${p.source} ${p.version}` : null;
});
const footer = page => page.evaluate(() => {
  const b = document.getElementById('sidebar-footer-extensions');
  return b ? { attention: b.classList.contains('attention'), title: b.title } : null;
});
/** Open Settings → Extensions from the footer button (opening the sidebar drawer first). */
async function openManager(page, shot) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionManager());
  await page.waitForSelector('.sm-manager-heading', { timeout: 10000 });
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: path.join(out, shot) });
}
const rows = page => page.evaluate(() => [...document.querySelectorAll('#settings-menu-list .sm-manager-heading, #settings-menu-list .sm-manager-row, #settings-menu-list .sm-manager-source, #settings-menu-list .sm-manager-problem')]
  .map(el => el.innerText.replace(/\s+/g, ' ').trim()));
async function press(page, key, action) {
  await page.click(`.sm-manager-row[data-key="${key}"] [data-manager-action="${action}"]`);
}
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });
const sampleState = async page => {
  const frame = page.frames().find(f => f.url().includes('ext=plugin%3Asample') && f.url().includes('surface=boot'));
  if (!frame) return 'no frame';
  return frame.evaluate(async () => (await (await import('atmos-sdk')).default.state.get()).e2eMarker ?? null);
};
async function setSampleState(page, value) {
  const frame = page.frames().find(f => f.url().includes('ext=plugin%3Asample') && f.url().includes('surface=boot'));
  await frame.evaluate(async v => (await import('atmos-sdk')).default.state.update({ e2eMarker: v }), value);
  await page.waitForTimeout(800); // the page saves state after 250 ms
}

const r = { home };
(async () => {

  // 1. Available → Install.
  let s = await launch();
  r['1-before'] = await sample(s.page);
  await s.page.click('#sidebar-footer-extensions').catch(async () => {
    await s.page.evaluate(() => document.getElementById('sidebar-footer-extensions').click());
  });
  await s.page.waitForSelector('.sm-manager-heading', { timeout: 10000 });
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => [...document.querySelectorAll('.sm-manager-row')].some(row => /Sample/.test(row.textContent)));
  await s.page.screenshot({ path: path.join(out, '10-available.png') });
  r['1-available'] = await rows(s.page);
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  await s.page.screenshot({ path: path.join(out, '11-pending.png') });
  r['1-pending'] = await rows(s.page);
  r['1-footer'] = await footer(s.page);
  // The footer button in the open sidebar, in the attention colour.
  await s.page.evaluate(async () => {
    (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu();
    document.getElementById('settings-drawer')?.classList.add('open');
  });
  await s.page.waitForTimeout(600);
  const footerBox = await s.page.locator('#sidebar-footer').boundingBox();
  if (footerBox) await s.page.screenshot({ path: path.join(out, '12-footer.png'), clip: { x: footerBox.x, y: footerBox.y - 10, width: footerBox.width, height: footerBox.height + 20 } });
  r['1-footerColour'] = await s.page.evaluate(() => getComputedStyle(document.getElementById('sidebar-footer-extensions')).color);
  r['1-errors'] = s.errors;
  await s.app.close();

  // 2. Installed and running; save a value in its state.
  s = await launch();
  r['2-after'] = await sample(s.page);
  r['2-footer'] = await footer(s.page);
  await setSampleState(s.page, 'kept');
  r['2-state'] = await sampleState(s.page);
  await s.app.close();

  // 3. An update.
  publish('0.9.1');
  s = await launch();
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => /Updates/.test(document.getElementById('settings-menu-list').textContent));
  await s.page.screenshot({ path: path.join(out, '30-update.png') });
  r['3-update'] = await rows(s.page);
  r['3-footer'] = await footer(s.page);
  r['3-downloadedBeforeUpdate'] = fs.existsSync(path.join(userData, 'extension-staging')) ? fs.readdirSync(path.join(userData, 'extension-staging')) : [];
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => /Update to 0\.9\.1/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['3-after'] = await sample(s.page);
  r['3-previousKept'] = fs.existsSync(path.join(userData, 'extension-previous', 'plugins', 'sample'));
  r['3-state'] = await sampleState(s.page);
  await s.app.close();
  s = await launch();
  r['3-previousGoneNextStart'] = !fs.existsSync(path.join(userData, 'extension-previous', 'plugins', 'sample'));

  // 4. Remove, keeping its data (the default choice).
  await openManager(s.page);
  r['4-page'] = await rows(s.page);
  await press(s.page, 'plugin:sample', 'ask-remove');
  await s.page.screenshot({ path: path.join(out, '40-remove-confirm.png') });
  r['4-confirm'] = await s.page.evaluate(() => document.querySelector('.sm-manager-confirm')?.innerText.replace(/\s+/g, ' ').trim());
  r['4-defaultChoice'] = await s.page.evaluate(() => document.querySelector('.sm-manager-confirm input:checked')?.value);
  await press(s.page, 'plugin:sample', 'remove');
  await waitFor(s.page, () => /Remove, keeping its data/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['4-afterRemove'] = await sample(s.page);
  r['4-folderGone'] = !fs.existsSync(path.join(cfg, 'plugins', 'sample'));
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => document.querySelector('.sm-manager-row[data-key="plugin:sample"] [data-manager-action="install"]'));
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['4-reinstalled'] = await sample(s.page);
  r['4-stateKept'] = await sampleState(s.page);

  // 5. Remove, deleting its data.
  await openManager(s.page);
  await press(s.page, 'plugin:sample', 'ask-remove');
  await s.page.check('.sm-manager-confirm input[value="delete"]');
  await press(s.page, 'plugin:sample', 'remove');
  await waitFor(s.page, () => /Remove, and delete its data/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['5-afterRemove'] = await sample(s.page);
  await s.page.waitForTimeout(500);
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => document.querySelector('.sm-manager-row[data-key="plugin:sample"] [data-manager-action="install"]'));
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['5-reinstalled'] = await sample(s.page);
  r['5-stateAfterDelete'] = await sampleState(s.page);

  // 6. A package changed on the source after the index was signed.
  publish('0.9.2');
  fs.appendFileSync(path.join(source, 'sample-0.9.2.atmos'), 'x');
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => /Updates/.test(document.getElementById('settings-menu-list').textContent));
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => document.querySelector('.sm-manager-row[data-key="plugin:sample"] .sm-trust-error'));
  await s.page.screenshot({ path: path.join(out, '60-refused.png') });
  r['6-error'] = await s.page.evaluate(() => document.querySelector('.sm-manager-row[data-key="plugin:sample"] .sm-trust-error')?.textContent);
  r['6-pending'] = await s.page.evaluate(async () => (await window.atmosCore.extensionManager.status()).status.pending.length);

  // 7. The source's signed index names a newer Atmos: the footer's version
  //    and Settings → Atmos say so, with a Download button (not pressed: it
  //    opens the browser at Core's own download page).
  fs.rmSync(path.join(source, 'sample-0.9.2.atmos'));
  buildIndex(source, key.privateKey, 'Test source', { core: { version: '99.0.0' } });
  await s.page.click('[data-manager-action="check"]');
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openAtmosSettings());
  await waitFor(s.page, () => /Atmos 99\.0\.0 is available/.test(document.getElementById('settings-menu-list').textContent));
  await s.page.screenshot({ path: path.join(out, '70-atmos-update.png') });
  r['7-atmosRow'] = await s.page.evaluate(() => document.querySelector('.sm-manager-row[data-key="atmos"]')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  r['7-download'] = await s.page.evaluate(() => !!document.querySelector('.sm-manager-row[data-key="atmos"] [data-manager-action="download-atmos"]'));
  r['7-footer'] = await s.page.evaluate(() => { const v = document.getElementById('sidebar-footer-version'); return { text: v.textContent, title: v.title }; });
  r['errors'] = s.errors;

  // 8. An update that loads but doesn't start: its background frame throws.
  buildIndex(source, key.privateKey, 'Test source');
  publish('0.9.4', { broken: true });
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => /0\.9\.4/.test(document.getElementById('settings-menu-list').textContent));
  await press(s.page, 'plugin:sample', 'install');
  await waitFor(s.page, () => /Update to 0\.9\.4/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['8-loaded'] = await sample(s.page);
  const failedRecord = async () => (await s.page.evaluate(async () => (await window.atmosCore.extensionManager.status()).status.applied))
    .find(record => record.id === 'sample' && record.failed) || null;
  for (let i = 0; i < 50 && !(await failedRecord()); i++) await s.page.waitForTimeout(200);
  r['8-recorded'] = await failedRecord();
  await openManager(s.page);
  r['8-says'] = await s.page.evaluate(() => [...document.querySelectorAll('.sm-manager-problem')].map(el => el.textContent.trim()).find(text => /sample/.test(text)) || null);
  await s.app.close();
  s = await launch();
  r['8-next'] = await sample(s.page);
  r['8-state'] = await sampleState(s.page);
  await s.app.close();
  // What this script checks for R4 (the rest is read from its report).
  r.ok = r['3-previousKept'] === true && r['3-previousGoneNextStart'] === true
    && /installed 0\.9\.4$/.test(r['8-loaded'] || '') && r['8-recorded']?.failed === true
    && /didn't start/.test(r['8-says'] || '') && /previous 0\.9\.1$/.test(r['8-next'] || '');

  console.log(JSON.stringify(r, null, 1));
  if (!r.ok) process.exit(1);
})().catch(e => { console.log(JSON.stringify(r, null, 1)); console.error(e); process.exit(1); });

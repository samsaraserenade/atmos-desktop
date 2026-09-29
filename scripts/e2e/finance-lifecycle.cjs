// Finance through the extension manager, on a minimal Atmos (Core and the
// system services only), against the synthetic VPS (fake-vps.cjs):
//
//  1. A source has Finance, Charting, Currency and Market Data, signed.
//     Installing Finance brings Charting and Currency (required) and Market
//     Data (optional, "recommended": installed with it for now).
//  2. After the restart: a watchlist click opens the market chart. Finance
//     pairs with the VPS (portfolio-vps.json moved into the sealed
//     connection file) and a value is saved in its state.
//  3. Market Data removed: Finance still runs, with the chart switcher
//     hidden, the panel on Portfolio and a watchlist click opening nothing,
//     and offers "Optional: Market Data"; installed from that offer, the
//     charts are back.
//  4. A newer Finance (patch + 1) is published: only Finance updates; its connection and
//     state stay.
//  5. Remove Finance, keeping its data: gone after the restart, its
//     dependencies and connection file still there; installed again, it is
//     connected with its state, without pairing again.
//  6. An official service whose main.cjs never finishes starting, and a
//     plugin that needs it: after 10 s the service is failed, the plugin
//     skipped, the services after it still start, Finance works, and
//     Settings says why.
//  7. Remove Finance deleting its data, with the services only it used
//     (offered, ticked): all four gone, and its connection file.
//
// Usage: node scripts/e2e/finance-lifecycle.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'finance-lifecycle'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { createHasher, listFiles } = require(path.join(repo, 'core/js/core/extension-integrity.cjs'));
const { signExtension, trustedKeyEntry } = require(path.join(repo, 'core/js/core/extension-signing.cjs'));
const { packFolder, unpackTo } = require(path.join(repo, 'core/js/core/extension-package.cjs'));
const { bundleFilters, copyBundled, buildIndex } = require(path.join(repo, 'scripts/pack-extensions.cjs'));
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot: cfg } = isolatedEnv('atmos-finance-lifecycle-');
const userData = cfg; // Electron's user data and the install folder are both ~/.config/atmos here
const FAKE_VPS = path.join(__dirname, 'fake-vps.cjs');
const step = message => { if (process.env.E2E_STEPS) console.error('[step]', message); };

const key = crypto.generateKeyPairSync('ed25519');
const trustedFile = path.join(home, 'trusted-keys.json');
fs.writeFileSync(trustedFile, JSON.stringify({ format: 1, keys: [trustedKeyEntry(key.publicKey, { note: 'e2e test key' })] }));

/** Pack and sign <kind>/<id> from `root` as pack:extensions does; `edit(dir)` changes the copy first. */
function pack(root, kind, id, edit = null) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pack-'));
  const dir = path.join(staging, id);
  copyBundled(root, kind, id, dir, bundleFilters(repo));
  if (edit) edit(dir);
  signExtension(dir, { kind: kind === 'plugins' ? 'plugin' : 'service', id, privateKey: key.privateKey, hasher: createHasher(null) });
  const buffer = packFolder(dir, listFiles);
  fs.rmSync(staging, { recursive: true, force: true });
  return buffer;
}
const setVersion = version => dir => {
  const file = path.join(dir, 'extension.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
};
const manifestOf = (kind, id) => JSON.parse(fs.readFileSync(path.join(repo, kind, id, 'extension.json'), 'utf8'));
/** The repo manifest's version with its patch number raised. */
const nextPatch = (kind, id) => {
  const [major, minor, patch] = manifestOf(kind, id).version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

// The source: Finance and the three services it uses, at their repo versions.
const source = path.join(home, 'source');
fs.mkdirSync(source, { recursive: true });
function publish(kind, id, edit = null) {
  const buffer = pack(repo, kind, id, edit);
  const version = edit ? null : manifestOf(kind, id).version;
  const file = `${id}-${version || edit.version}.atmos`;
  fs.writeFileSync(path.join(source, file), buffer);
  buildIndex(source, key.privateKey, 'Test source');
}
for (const id of ['charting', 'currency', 'market-data']) publish('services', id);
publish('plugins', 'finance');

// A minimal Atmos: Core (with its system services) and no bundled extensions.
const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-minimal-'));
fs.mkdirSync(path.join(bundled, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(bundled, 'services'), { recursive: true });

async function launch({ timeout = 60000 } = {}) {
  const started = Date.now();
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${bundled}`, `--trusted-keys=${trustedFile}`, `--extension-source=${source}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env, timeout,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app, { timeout });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::|Electron Security Warning|\[market-data\]|WebSocket/.test(m.text())) errors.push(m.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  const bootMs = Date.now() - started;
  await page.waitForTimeout(600);
  return { app, page, logs, errors, bootMs };
}

/** The synthetic VPS in the main process, then a reload so Finance starts against it. */
async function withVps(s, { seedLegacy = false } = {}) {
  if (seedLegacy) fs.writeFileSync(path.join(userData, 'portfolio-vps.json'), JSON.stringify({ baseUrl: 'http://100.100.1.1:8080/', token: 'x'.repeat(40) }));
  await s.app.evaluate((_, file) => (process.mainModule?.require ?? globalThis.require)(file), FAKE_VPS);
  await s.page.reload();
  await s.page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await s.page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).openSidebar());
  await s.page.waitForTimeout(600);
}

const describe = (page, ids) => page.evaluate(async wanted => {
  const all = [...await window.atmosCore.listPlugins(), ...await window.atmosCore.listServices()];
  return Object.fromEntries(wanted.map(id => {
    const p = all.find(item => item.id === id);
    return [id, p ? `${p.tier}/${p.status}/${p.active ? 'active' : 'off'} ${p.source} ${p.version}${p.dependencyProblems?.length ? ` · ${p.dependencyProblems.join('; ')}` : ''}` : null];
  }));
}, ids);
const FINANCE_SET = ['finance', 'charting', 'currency', 'market-data'];

async function openManager(page, shot) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionManager());
  await page.waitForSelector('.sm-manager-heading', { timeout: 10000 });
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: path.join(out, shot) });
}
const rows = page => page.evaluate(() => [...document.querySelectorAll('#settings-menu-list .sm-manager-heading, #settings-menu-list .sm-manager-row, #settings-menu-list .sm-manager-problem')]
  .map(el => el.innerText.replace(/\s+/g, ' ').trim()));
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });
const press = (page, rowKey, action) => page.click(`.sm-manager-row[data-key="${rowKey}"] [data-manager-action="${action}"]`);
async function check(page) {
  await page.click('[data-manager-action="check"]');
  await waitFor(page, () => !document.querySelector('[data-manager-action="check"][disabled]') && /Checked/.test(document.getElementById('settings-menu-list').textContent));
  await page.waitForTimeout(300);
}
const pendingIds = page => page.evaluate(async () => (await window.atmosCore.extensionManager.status()).status.pending.map(c => `${c.action} ${c.id} ${c.version || ''}`.trim()));

async function frameFor(page, title, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const handle = await page.$(`iframe[data-extension="plugin:finance"][title="${title}"]`);
    const frame = await handle?.contentFrame();
    if (frame && await frame.evaluate(() => document.querySelector('.finance-frame-root')?.childElementCount > 0).catch(() => false)) return frame;
    await page.waitForTimeout(200);
  }
  return null;
}
const text = frame => frame?.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()).catch(e => e.message) ?? null;
async function waitForText(page, frame, pattern, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await text(frame); if (pattern.test(value || '')) return value; await page.waitForTimeout(250); }
  return text(frame);
}
const bootFrame = (page, id) => page.frames().find(f => f.url().includes(`ext=plugin%3A${id}`) && f.url().includes('surface=boot'));
const financeState = async page => bootFrame(page, 'finance')?.evaluate(async () => (await (await import('atmos-sdk')).default.state.get()).e2eMarker ?? null).catch(e => e.message) ?? 'no frame';
async function setFinanceState(page, value) {
  await bootFrame(page, 'finance').evaluate(async v => (await import('atmos-sdk')).default.state.update({ e2eMarker: v }), value);
  await page.waitForTimeout(800); // the page saves state after 250 ms
}

/** The Finance panel and watchlist: is the chart switcher there, and what does a watchlist click open? */
async function marketCharts(page, shot) {
  await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('portfolio-tracker'));
  const panel = await frameFor(page, 'Finance');
  const watchlist = await frameFor(page, 'Watchlist');
  const result = {
    switcher: await panel?.evaluate(() => { const el = document.querySelector('.finance-ticker-picker'); return el ? !el.hidden : null; }).catch(e => e.message),
    marketDataClass: await panel?.evaluate(() => document.documentElement.classList.contains('finance-no-market-data')).catch(e => e.message),
    rowTitle: await watchlist?.evaluate(() => document.querySelector('.watchlist-row[data-symbol="SOL"]')?.title ?? null).catch(e => e.message),
  };
  await watchlist?.evaluate(() => document.querySelector('.watchlist-row[data-symbol="SOL"]')?.click());
  await page.waitForTimeout(2500);
  const panelNow = await frameFor(page, 'Finance');
  result.afterClick = await panelNow?.evaluate(() => (document.querySelector('.mq-toolbar') ? 'markets' : document.querySelector('.finance-portfolio-toolbar') ? 'portfolio' : 'none')).catch(e => e.message);
  if (shot) await page.screenshot({ path: path.join(out, shot) });
  return result;
}

const r = { home };
(async () => {

  // 1. Minimal Atmos; install Finance from the source.
  step('1');
  let s = await launch();
  r['1-before'] = await describe(s.page, FINANCE_SET);
  r['1-services'] = (await s.page.evaluate(async () => (await window.atmosCore.listServices()).map(p => p.id))).sort();
  await openManager(s.page);
  await check(s.page);
  await s.page.screenshot({ path: path.join(out, '10-available.png') });
  r['1-available'] = await rows(s.page);
  await press(s.page, 'plugin:finance', 'install');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  await s.page.screenshot({ path: path.join(out, '11-pending.png') });
  r['1-pending'] = await pendingIds(s.page);
  r['1-optionalOffer'] = await s.page.evaluate(() => document.querySelector('.sm-manager-row[data-key="plugin:finance"] .sm-manager-optional')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  r['1-errors'] = s.errors;
  // A watchlist symbol that isn't held (so its row opens a chart), left in
  // the page the way an older in-page Finance would have; Finance copies it
  // on its first run.
  await s.page.evaluate(() => {
    const blob = JSON.parse(localStorage.getItem('samsara_v4') || '{}');
    blob.extensionState ??= {};
    blob.extensionState.watchlist = { version: 1, data: { tickers: ['BTC', 'ETH', 'SOL'], activeT: 'SOL', tickerSource: {}, cgIdCache: {} } };
    localStorage.setItem('samsara_v4', JSON.stringify(blob));
    Storage.prototype.setItem = () => {};
  });
  await s.app.close();

  // 2. Finance with Market Data; pair with the VPS; save a value.
  step('2');
  s = await launch();
  r['2-after'] = await describe(s.page, FINANCE_SET);
  await withVps(s, { seedLegacy: true });
  r['2-charts'] = await marketCharts(s.page, '20-with-market-data.png');
  const connections = await frameFor(s.page, 'Portfolio Connections');
  r['2-connections'] = await waitForText(s.page, connections, /Server: 100\.100\.1\.1:8080/);
  r['2-balance'] = await waitForText(s.page, await frameFor(s.page, 'Balance'), /\d,\d{3}/);
  r['2-sealed'] = fs.existsSync(path.join(userData, 'finance', 'connection.bin'));
  await setFinanceState(s.page, 'kept');
  r['2-state'] = await financeState(s.page);
  r['2-errors'] = s.errors;

  // 3. Market Data removed: Finance carries on without market charts, and
  //    offers Market Data; installed again from that offer, they're back.
  step('3');
  await openManager(s.page);
  await press(s.page, 'service:market-data', 'ask-remove');
  await press(s.page, 'service:market-data', 'remove');
  await waitFor(s.page, () => /Remove, keeping its data/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['3-withoutMarketData'] = await describe(s.page, FINANCE_SET);
  await withVps(s);
  r['3-chartsWithout'] = await marketCharts(s.page, '30-without-market-data.png');
  await openManager(s.page);
  await check(s.page);
  await s.page.screenshot({ path: path.join(out, '31-installed-offer.png') });
  r['3-installedOffer'] = await s.page.evaluate(() => document.querySelector('.sm-manager-row[data-key="plugin:finance"] .sm-manager-optional')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  await s.page.click('.sm-manager-row[data-key="plugin:finance"] .sm-manager-optional [data-manager-action="install-optional"]');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  r['3-pending'] = await pendingIds(s.page);
  r['3-errorsWithout'] = s.errors;
  await s.app.close();
  s = await launch();
  r['3-after'] = await describe(s.page, FINANCE_SET);
  await withVps(s);
  r['3-charts'] = await marketCharts(s.page, '32-market-data-again.png');
  r['3-errors'] = s.errors;

  // 4. A newer Finance: only Finance updates.
  step('4');
  const newer = nextPatch('plugins', 'finance');
  const bump = setVersion(newer); bump.version = newer;
  publish('plugins', 'finance', bump);
  await openManager(s.page);
  await check(s.page);
  await s.page.screenshot({ path: path.join(out, '40-update.png') });
  r['4-updates'] = await s.page.evaluate(async () => (await window.atmosCore.extensionManager.status()).status.packages
    .filter(p => p.action === 'update').map(p => `${p.id} ${p.installedVersion} → ${p.version}`));
  await press(s.page, 'plugin:finance', 'install');
  await waitFor(s.page, text => document.getElementById('settings-menu-list').textContent.includes(`Update to ${text}`), newer);
  r['4-pending'] = await pendingIds(s.page);
  await s.app.close();
  s = await launch();
  r['4-after'] = await describe(s.page, FINANCE_SET);
  r['4-previousKept'] = fs.existsSync(path.join(userData, 'extension-previous', 'plugins', 'finance'));
  await withVps(s);
  r['4-connections'] = await waitForText(s.page, await frameFor(s.page, 'Portfolio Connections'), /Server: 100\.100\.1\.1:8080/);
  r['4-state'] = await financeState(s.page);
  r['4-errors'] = s.errors;

  // 5. Remove Finance keeping its data, then install it again.
  step('5');
  await openManager(s.page);
  await press(s.page, 'plugin:finance', 'ask-remove');
  r['5-defaultChoice'] = await s.page.evaluate(() => document.querySelector('.sm-manager-confirm input[type="radio"]:checked')?.value);
  // Offered: the services nothing else uses. Kept here (unticked); step 7 removes them.
  r['5-alsoOffered'] = await s.page.evaluate(() => [...document.querySelectorAll('.sm-manager-confirm input[data-also-remove]')].map(input => `${input.dataset.alsoRemove}${input.checked ? ' ✓' : ''}`));
  // Untick and press in one step: a background refresh of the page in
  // between would draw the offer again, ticked (seen once, 29 September).
  await s.page.evaluate(() => {
    document.querySelectorAll('.sm-manager-confirm input[data-also-remove]').forEach(input => { input.checked = false; });
    document.querySelector('.sm-manager-row[data-key="plugin:finance"] [data-manager-action="remove"]').click();
  });
  await waitFor(s.page, () => /Remove, keeping its data/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['5-afterRemove'] = await describe(s.page, FINANCE_SET);
  r['5-connectionFileKept'] = fs.existsSync(path.join(userData, 'finance', 'connection.bin'));
  await openManager(s.page);
  await check(s.page);
  await press(s.page, 'plugin:finance', 'install');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  r['5-pendingReinstall'] = await pendingIds(s.page);
  await s.app.close();
  s = await launch();
  r['5-reinstalled'] = await describe(s.page, FINANCE_SET);
  await withVps(s);
  const connections5 = await frameFor(s.page, 'Portfolio Connections');
  r['5-connections'] = await waitForText(s.page, connections5, /Server: 100\.100\.1\.1:8080/);
  r['5-state'] = await financeState(s.page);
  r['5-errors'] = s.errors;
  await s.app.close();

  // 6. A service whose main.cjs never finishes starting, and a plugin that needs it.
  step('6');
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-stall-'));
  const write = (kind, id, files) => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(fixtures, kind, id), { recursive: true });
      fs.writeFileSync(path.join(fixtures, kind, id, name), content);
    }
  };
  // 'early-stall' starts before Market Data (alphabetical among services), so
  // Market Data starting afterwards shows startup carried on.
  write('services', 'early-stall', {
    'extension.json': JSON.stringify({ apiVersion: 3, version: '1.0.0', publisher: 'atmos', displayName: 'Early Stall', permissions: { ipc: true } }, null, 2),
    'main.cjs': "module.exports = { activate(context) { context.handle('ping', () => 'pong'); return new Promise(() => {}); } };\n",
  });
  write('plugins', 'needs-stall', {
    'extension.json': JSON.stringify({
      apiVersion: 3, version: '1.0.0', publisher: 'atmos', displayName: 'Needs Stall', runtime: 'frame',
      requires: { 'extensions.frames': 3 }, contributes: { boot: { entry: 'boot.js' } },
      dependencies: { 'early-stall': '^1.0.0' }, permissions: { invokes: ['service:early-stall'] },
    }, null, 2),
    'boot.js': "console.log('needs-stall booted');\n",
  });
  for (const [kind, id] of [['services', 'early-stall'], ['plugins', 'needs-stall']]) {
    const dest = path.join(cfg, kind, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    unpackTo(pack(fixtures, kind, id), dest);
  }
  s = await launch({ timeout: 90000 });
  r['6-bootMs'] = s.bootMs;
  r['6-list'] = await describe(s.page, ['early-stall', 'needs-stall', ...FINANCE_SET]);
  r['6-needsStallBootFrame'] = !!bootFrame(s.page, 'needs-stall');
  r['6-log'] = s.logs.join('').split('\n').filter(line => /early-stall|needs-stall|activated service 'market-data'/.test(line)).map(line => line.trim());
  r['6-ipcWithdrawn'] = await s.app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers?.has?.('atmos-extension:service:early-stall:ping') ?? 'unknown');
  r['6-footer'] = await s.page.evaluate(() => { const b = document.getElementById('sidebar-footer-extensions'); return b ? { attention: b.classList.contains('attention'), title: b.title } : null; });
  await withVps(s);
  r['6-connections'] = await waitForText(s.page, await frameFor(s.page, 'Portfolio Connections'), /Server: 100\.100\.1\.1:8080/);
  await openManager(s.page, '60-stalled.png');
  r['6-attention'] = (await rows(s.page)).filter(line => /Stall/.test(line));
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
  await s.page.evaluate(() => [...document.querySelectorAll('#settings-menu *')].find(el => el.children.length <= 2 && /^\s*Services\s*$/.test(el.textContent || ''))?.click());
  await s.page.waitForTimeout(400);
  r['6-serviceCard'] = await s.page.evaluate(() => [...document.querySelectorAll('.sm-extension-card')].filter(c => /Early Stall/.test(c.textContent)).map(c => c.innerText.replace(/\s+/g, ' ').trim()));
  await s.page.screenshot({ path: path.join(out, '61-stalled-card.png') });
  r['6-errors'] = s.errors;
  await s.app.close();
  fs.rmSync(path.join(cfg, 'services', 'early-stall'), { recursive: true, force: true });
  fs.rmSync(path.join(cfg, 'plugins', 'needs-stall'), { recursive: true, force: true });

  // 7. Remove Finance deleting its data.
  step('7');
  s = await launch();
  await openManager(s.page);
  await press(s.page, 'plugin:finance', 'ask-remove');
  await s.page.check('.sm-manager-confirm input[value="delete"]');
  await press(s.page, 'plugin:finance', 'remove');
  await waitFor(s.page, () => /Remove, and delete its data/.test(document.getElementById('settings-menu-list').textContent));
  r['7-pending'] = await pendingIds(s.page);
  await s.app.close();
  s = await launch();
  r['7-afterRemove'] = await describe(s.page, FINANCE_SET);
  r['7-connectionFileGone'] = !fs.existsSync(path.join(userData, 'finance'));
  r['7-errors'] = s.errors;
  await s.app.close();

  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.log(JSON.stringify(r, null, 1)); console.error(e); process.exit(1); });

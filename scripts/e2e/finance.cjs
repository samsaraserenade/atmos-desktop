// Finance in frames, end to end: settings, chart settings and history
// carried over from what the in-page Finance saved; one engine frame reading
// the VPS for the panel and six widgets; settings changed in one frame
// reaching the others; a widget header menu; the chart's menu (ticks,
// dropdowns); an Appearance font inside the frames; opening a watchlist
// symbol's chart from a widget; the ']' toggle; state after a restart.
// A synthetic VPS (fake-vps.cjs) stands in for the real one.
// Usage: node scripts/e2e/finance.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'finance'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-finance-');
const FAKE_VPS = path.join(__dirname, 'fake-vps.cjs');

async function launch({ vps = true } = {}) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|tag-recovery|Failed to load resource/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  if (vps) {
    // Finance's main process asks this "VPS"; reload so Finance starts against it.
    fs.writeFileSync(path.join(installRoot, 'portfolio-vps.json'), JSON.stringify({ baseUrl: 'http://100.100.1.1:8080/', token: 'x'.repeat(40) }));
    await app.evaluate((_, file) => (process.mainModule?.require ?? globalThis.require)(file), FAKE_VPS);
    await page.reload();
    await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  }
  await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).openSidebar());
  return { app, page, errors };
}
const financeFrames = page => page.frames().filter(f => f.url().includes('ext=plugin%3Afinance'));
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
const text = frame => frame?.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()).catch(e => e.message);
const activePanel = page => page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId());

const step = message => { if (process.env.E2E_STEPS) console.error('[step]', message); };

(async () => {
  const r = { home };

  // 1. What the in-page Finance left behind: its three state namespaces,
  //    hidden chart ranges in the page's shared asset database, and
  //    Charting's settings. Then clear what this setup run's framed Finance
  //    saved, as if it were starting for the first time.
  step('let s = await launch({ vps: false });');
  let s = await launch({ vps: false });
  step('seeding the page');
  await s.page.evaluate(async () => {
    const blob = JSON.parse(localStorage.getItem('samsara_v4') || '{}');
    blob.extensionState ??= {};
    // No outputCurrency here: it is still in the Currency service's old namespace.
    blob.extensionState.currency = { version: 1, data: { outputCurrency: 'EUR' } };
    blob.extensionState['portfolio-tracker'] = { version: 1, data: {
      tickerEnabled: { 'wallet-b': false }, miniChartVisible: true,
      chartMode: 'portfolio', customBalanceFonts: [], balanceFontFamily: 'bebas',
    } };
    blob.extensionState.watchlist = { version: 1, data: { tickers: ['BTC', 'ETH', 'SOL'], activeT: 'SOL', tickerSource: {}, cgIdCache: {} } };
    blob.extensionState.markets = { version: 2, data: { lastQuery: 'SOLUSDT overview', exchanges: ['binance'], recentQueries: [] } };
    delete blob.extensionState.finance;
    localStorage.setItem('samsara_v4', JSON.stringify(blob));
    localStorage.setItem('atmos:charting-instance:e2e-probe', JSON.stringify({ seeded: true }));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('samsara_db', 1);
      request.onupgradeneeded = e => e.target.result.createObjectStore('assets');
      request.onsuccess = () => {
        const tx = request.result.transaction('assets', 'readwrite');
        tx.objectStore('assets').put([{ from: 1, to: 2 }], 'portfolio-tracker:chart-hidden');
        tx.objectStore('assets').put('private wallpaper', 'wallpaper'); // someone else's; must not be copied
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    Storage.prototype.setItem = () => {};
  });
  step('clearing the frames');
  for (const frame of financeFrames(s.page)) {
    step(`clearing ${frame.url().split('surface=')[1]}`);
    await frame.evaluate(async () => {
      for (const key of Object.keys(localStorage)) localStorage.removeItem(key);
      Storage.prototype.setItem = () => {};
      IDBObjectStore.prototype.put = function () { return { set onsuccess(_) {}, set onerror(_) {} }; };
      // Empty Finance's asset store (shared by all its frames; open elsewhere, so not deleted).
      await Promise.race([new Promise(resolve => setTimeout(resolve, 2000)), new Promise(resolve => {
        const request = indexedDB.open('finance-assets', 1);
        request.onupgradeneeded = e => e.target.result.createObjectStore('assets');
        request.onsuccess = () => { const tx = request.result.transaction('assets', 'readwrite'); tx.objectStore('assets').clear(); tx.oncomplete = () => { request.result.close(); resolve(); }; };
        request.onerror = resolve;
      })]);
    }).catch(() => {});
  }
  step('await s.app.close();');
  await s.app.close();

  // 2. Framed Finance against the synthetic VPS.
  step('s = await launch();');
  s = await launch();
  r.surfaces = await s.page.evaluate(async () => (await window.atmosCore.listPlugins()).find(p => p.id === 'finance').frame?.contributions.map(c => `${c.surface}:${c.id}`));
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('portfolio-tracker'));
  const balance = await frameFor(s.page, 'Balance');
  const connections = await frameFor(s.page, 'Portfolio Connections');
  const watchlist = await frameFor(s.page, 'Watchlist');
  const panel = await frameFor(s.page, 'Finance');
  await balance?.waitForFunction(() => /[0-9]/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await s.page.waitForTimeout(2000);
  r.balance = await text(balance);
  r.connections = await text(connections);
  r.watchlist = await text(watchlist);
  r.spot = await text(await frameFor(s.page, 'Spot'));
  r.performance = await text(await frameFor(s.page, 'Performance'));
  r.panel = await panel?.evaluate(() => ({ mode: document.querySelector('.finance-portfolio-toolbar') ? 'portfolio' : 'other', text: document.body.innerText.slice(0, 80) })).catch(e => e.message);
  r.copied = await panel?.evaluate(async () => ({
    charting: localStorage.getItem('atmos:charting-instance:e2e-probe'),
    hidden: await new Promise(resolve => {
      const request = indexedDB.open('finance-assets', 1);
      request.onsuccess = () => {
        const store = request.result.transaction('assets').objectStore('assets');
        const hidden = store.get('portfolio-tracker:chart-hidden');
        const wallpaper = store.get('wallpaper');
        hidden.onsuccess = () => { wallpaper.onsuccess = () => resolve({ hidden: hidden.result, wallpaper: wallpaper.result ?? null }); };
      };
      request.onerror = () => resolve('no db');
    }),
  }));
  await s.page.screenshot({ path: path.join(out, '95-finance.png') });

  step('// One engine:');
  // One engine: the VPS is read once per minute, not once per frame.
  r.vpsCalls = await s.app.evaluate(() => globalThis.__vpsCalls);

  step("// The Balance widget's header");
  // The Balance widget's header menu (right-click its title), and its
  // Currency dropdown changing the totals in every Finance frame.
  const header = s.page.locator('#fin-section-portfolio-balance-ticker .fin-section-label');
  await header.click({ button: 'right' }).catch(e => { r.menuError = e.message; });
  await s.page.waitForTimeout(400);
  r.balanceMenu = await s.page.evaluate(() => [...document.querySelectorAll('.ctx-menu-surface .ctx-item')].map(el => el.textContent.trim()));
  const balanceBefore = r.balance;
  await s.page.locator('.ctx-menu-surface .ctx-item', { hasText: 'Currency' }).locator('select').selectOption('CHF').catch(e => { r.currencyError = e.message; });
  await s.page.keyboard.press('Escape');
  await s.page.waitForTimeout(1500);
  r.balanceAfterCurrencyToggle = await text(balance);
  r.currencyChangedInOtherFrame = balanceBefore !== r.balanceAfterCurrencyToggle;
  r.connectionsAfterCurrency = await text(connections);

  step('// Private mode');
  // Private mode (Balance menu > Hide balances): amounts, positions and the
  // server address are masked in every widget, and the portfolio chart's
  // value labels too; the chart line stays. Then back again.
  const togglePrivate = async () => {
    await header.click({ button: 'right' });
    await s.page.waitForTimeout(400);
    await s.page.locator('.ctx-menu-surface .ctx-item', { hasText: 'Hide balances' }).click();
    await s.page.waitForTimeout(1500);
  };
  const axisLabels = async () => (await frameFor(s.page, 'Finance'))?.evaluate(() => [...document.querySelectorAll('.atmos-chart__axes-layer text[text-anchor="end"]')].map(el => el.textContent).slice(0, 3)).catch(e => e.message);
  await togglePrivate();
  const spotFrame = await frameFor(s.page, 'Spot');
  r.privateMode = {
    balance: await text(balance),
    spot: await text(spotFrame),
    connections: await text(connections),
    axis: await axisLabels(),
    performance: await text(await frameFor(s.page, 'Performance')),
  };
  await togglePrivate();
  r.privateMode.balanceAfter = await text(balance);
  r.privateMode.axisAfter = await axisLabels();

  step('// Opening a watchlist');
  // Opening a watchlist symbol from the widget shows its chart in the panel.
  await watchlist?.evaluate(() => {
    const row = [...document.querySelectorAll('[data-symbol], .wl-row, .mk-row')].find(el => /SOL/.test(el.textContent));
    row?.click();
  });
  await s.page.waitForTimeout(2500);
  const panelNow = await frameFor(s.page, 'Finance');
  r.panelAfterWatchlistClick = await panelNow?.evaluate(() => ({ markets: !!document.querySelector('.mq-toolbar'), text: document.body.innerText.slice(0, 60) })).catch(e => e.message);

  step('// The chart menu');
  // The chart's right-click menu: ticks and dropdowns drawn by Atmos.
  const panelBox = await (await s.page.$('iframe[data-extension="plugin:finance"][title="Finance"]'))?.boundingBox();
  if (panelBox) {
    await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('portfolio-tracker'));
    await s.page.waitForTimeout(1500);
    const chartMenu = () => s.page.evaluate(() => [...document.querySelectorAll('.ctx-menu-surface .ctx-item')].map(el => ({
      label: el.querySelector('.ctx-lbl2')?.textContent, ticked: el.querySelector('.ctx-ico')?.textContent === '✓', select: el.querySelector('select')?.value,
    })));
    await s.page.mouse.click(panelBox.x + 300, panelBox.y + 250, { button: 'right' });
    await s.page.waitForTimeout(500);
    const before = await chartMenu();
    await s.page.locator('.ctx-menu-surface .ctx-item', { hasText: 'MA Opacity' }).locator('select').selectOption('40').catch(() => {});
    await s.page.waitForTimeout(500);
    await s.page.mouse.click(panelBox.x + 300, panelBox.y + 250, { button: 'right' });
    await s.page.waitForTimeout(500);
    const sessionsBefore = (await chartMenu()).find(item => item.label === 'Sessions')?.ticked;
    await s.page.locator('.ctx-menu-surface .ctx-item', { hasText: 'Sessions' }).click();
    await s.page.waitForTimeout(500);
    await s.page.mouse.click(panelBox.x + 300, panelBox.y + 250, { button: 'right' });
    await s.page.waitForTimeout(500);
    const after = await chartMenu();
    await s.page.keyboard.press('Escape');
    r.chartMenu = {
      ticked: before.filter(item => item.ticked).length,
      selects: before.filter(item => item.select !== undefined).map(item => item.label),
      opacityAfterChoosing: after.find(item => item.label === 'MA Opacity')?.select,
      sessionsToggled: sessionsBefore !== after.find(item => item.label === 'Sessions')?.ticked,
    };
  }

  step('// An app font');
  // A font imported in Appearance reaches Finance's frames.
  await s.page.evaluate(async ttf => {
    const appearance = await import('atmos-core/core/appearance.js');
    const blob = await fetch(ttf).then(res => res.blob());
    const { id } = await appearance.importAppFont(new File([blob], 'E2E App Font.ttf', { type: 'font/ttf' }));
    appearance.setAppFont(id);
  }, 'data:font/ttf;base64,' + fs.readFileSync(path.join(repo, 'plugins/finance/assets/fonts/BebasNeue-Regular.ttf')).toString('base64'));
  await s.page.waitForTimeout(1500);
  r.appFontInWidget = await balance?.evaluate(async () => { await document.fonts.ready; return document.fonts.check('12px "E2E App Font"'); }).catch(e => e.message);

  step("// ']' closes");
  // ']' closes and reopens the Finance panel.
  await s.page.evaluate(() => document.body.focus());
  await s.page.keyboard.press(']');
  await s.page.waitForTimeout(600);
  r.afterToggleOff = await activePanel(s.page);
  await s.page.keyboard.press(']');
  await s.page.waitForTimeout(600);
  r.afterToggleOn = await activePanel(s.page);
  r.errors = s.errors;
  await s.page.evaluate(async () => (await import('atmos-core/persist.js')).flushPendingSave());
  await s.page.waitForTimeout(500);
  await s.app.close();

  step('// 3. After a restart');
  // 3. After a restart: the settings changed above stayed.
  s = await launch();
  const connections3 = await frameFor(s.page, 'Portfolio Connections');
  await s.page.waitForTimeout(2000);
  r.afterRestart = { connections: await text(connections3), watchlist: await text(await frameFor(s.page, 'Watchlist')) };
  r.errorsAfterRestart = s.errors;

  step('// 4. Disconnect, then pair again');
  // 4. The connection: portfolio-vps.json was moved into the sealed file on
  //    first run; Disconnect (asked twice) clears it and shows the pairing
  //    form; pasting a pairing code connects again.
  r.connection = { sealed: fs.existsSync(path.join(installRoot, 'finance', 'connection.bin')) };
  const waitForText = async (frame, pattern, timeout = 15000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await text(frame); if (pattern.test(value)) return value; await s.page.waitForTimeout(250); }
    return await text(frame);
  };
  await connections3.evaluate(() => [...document.querySelectorAll('.fin-conn button')].find(b => b.textContent === 'Disconnect')?.click());
  await connections3.evaluate(() => [...document.querySelectorAll('.fin-conn button')].find(b => /Click again/.test(b.textContent))?.click());
  r.connection.afterDisconnect = await waitForText(connections3, /Pairing code/);
  r.connection.filesAfterDisconnect = [
    fs.existsSync(path.join(installRoot, 'finance', 'connection.bin')), fs.existsSync(path.join(installRoot, 'portfolio-vps.json')),
  ];
  const balanceFrame = await frameFor(s.page, 'Balance');
  r.connection.balanceAfterDisconnect = await text(balanceFrame);
  const { createPairingCode } = require(path.join(repo, 'plugins/finance/main.cjs'));
  const code = createPairingCode('http://100.100.1.1:8080', 'y'.repeat(40));
  await connections3.evaluate(value => { const area = document.querySelector('.fin-conn textarea'); area.value = value; }, code);
  await connections3.evaluate(() => [...document.querySelectorAll('.fin-conn button')].find(b => b.textContent === 'Test')?.click());
  r.connection.test = await waitForText(connections3, /Found|refused|reach/);
  await connections3.evaluate(() => [...document.querySelectorAll('.fin-conn button')].find(b => b.textContent === 'Connect')?.click());
  r.connection.afterPairing = await waitForText(connections3, /Server: 100\.100\.1\.1:8080/);
  r.connection.balanceAfterPairing = await waitForText(balanceFrame, /\d,\d{3}/);
  r.connection.infoCalls = (await s.app.evaluate(() => globalThis.__vpsCalls))['/v1/info'] || 0;
  r.connection.sealedAgain = fs.existsSync(path.join(installRoot, 'finance', 'connection.bin'));
  r.connection.errors = s.errors;
  await s.app.close();
  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

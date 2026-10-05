// Finance in frames, end to end: settings, chart settings and history
// carried over from what the in-page Finance saved; one engine frame reading
// the VPS for the panel and six widgets; settings changed in one frame
// reaching the others; a widget header menu; the chart's menu (ticks,
// dropdowns); an Appearance font inside the frames; opening a watchlist
// symbol from the panel's ticker picker (where the watchlist lives);
// symbol's chart from a widget; state after a restart.
// A synthetic VPS (fake-vps.cjs) stands in for the real one.
// Usage: node scripts/e2e/finance.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, forgetFrameState, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'finance'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-finance-');
const FAKE_VPS = path.join(__dirname, 'fake-vps.cjs');

async function launch({ vps = true } = {}) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await atmosWindow(app);
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
  // Its state file from this setup run goes too (Atmos 0.12 keeps it apart from the page).
  forgetFrameState(installRoot, 'plugin', 'finance');

  // 2. Framed Finance against the synthetic VPS.
  step('s = await launch();');
  s = await launch();
  r.surfaces = await s.page.evaluate(async () => (await window.atmosCore.listPlugins()).find(p => p.id === 'finance').frame?.contributions.map(c => `${c.surface}:${c.id}`));
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('portfolio-tracker'));
  const balance = await frameFor(s.page, 'Balance');
  const connections = await frameFor(s.page, 'Portfolio Connections');
  const panel = await frameFor(s.page, 'Finance');
  await balance?.waitForFunction(() => /[0-9]/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await s.page.waitForTimeout(2000);
  r.balance = await text(balance);
  r.connections = await text(connections);
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

  step('// Opening a watchlist symbol');
  // The watchlist lives in the panel's ticker picker: open it, pick SOL.
  await panel?.evaluate(() => document.querySelector('.finance-ticker-picker-button')?.click());
  await s.page.waitForTimeout(400);
  r.pickerRows = await panel?.evaluate(() => [...document.querySelectorAll('.finance-ticker-picker-row[data-symbol]')].map(row => row.dataset.symbol)).catch(e => e.message);
  await panel?.evaluate(() => [...document.querySelectorAll('.finance-ticker-picker-row[data-symbol]')].find(row => row.dataset.symbol === 'SOL')?.click());
  await s.page.waitForTimeout(2500);
  const panelNow = await frameFor(s.page, 'Finance');
  r.panelAfterWatchlistClick = await panelNow?.evaluate(() => ({ markets: !!document.querySelector('.mq-toolbar'), text: document.body.innerText.slice(0, 60) })).catch(e => e.message);

  step('// The ticker picker in every chart of a multi-chart layout');
  // Each chart's picker rises from its own toolbar. In two rows, the top
  // charts' toolbars sit mid-panel: the sheet must still be drawn there,
  // fully inside its chart, not placed by window coordinates and clipped.
  r.pickerInLayouts = {};
  for (const layout of [{ count: 4 }, { count: 2, orientation: 'vertical' }, { count: 3 }, { count: 1 }]) {
    const frame = await frameFor(s.page, 'Finance');
    await frame?.evaluate(({ count, orientation }) => {
      document.querySelector('.finance-layout-button')?.click();
      [...document.querySelectorAll('.finance-layout-menu button')].find(b => Number(b.dataset.count) === count && (!orientation || b.dataset.orientation === orientation))?.click();
    }, layout);
    await s.page.waitForTimeout(1800);
    const charts = await frame?.evaluate(() => document.querySelectorAll('.finance-ticker-picker-button').length).catch(() => 0);
    const results = [];
    for (let i = 0; i < charts; i++) {
      results.push(await frame.evaluate(async index => {
        const button = document.querySelectorAll('.finance-ticker-picker-button')[index];
        const picker = button.closest('.finance-ticker-picker');
        const sheet = picker.querySelector('.finance-ticker-picker-panel');
        const chart = picker.closest('.finance-extra-chart, .finance-chart-stage');
        button.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = sheet.getBoundingClientRect();
        const chartBox = chart.getBoundingClientRect();
        const dock = picker.closest('.finance-portfolio-toolbar, .mq-toolbar').getBoundingClientRect();
        // What's really drawn there: the sheet's search box, near its top, and the middle of its list.
        const search = sheet.querySelector('.finance-ticker-picker-search').getBoundingClientRect();
        const atSearch = document.elementFromPoint(search.left + search.width / 2, search.top + search.height / 2);
        const atMiddle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const out = {
          chart: { top: Math.round(chartBox.top), bottom: Math.round(chartBox.bottom), left: Math.round(chartBox.left) },
          sheet: { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), height: Math.round(box.height) },
          dockTop: Math.round(dock.top),
          searchVisible: sheet.contains(atSearch),
          middleVisible: sheet.contains(atMiddle),
          insideChart: box.top >= chartBox.top - 1 && box.bottom <= chartBox.bottom + 1 && box.left >= chartBox.left - 1,
          flushWithDock: Math.abs(box.bottom - dock.top) <= 2,
          rows: sheet.querySelectorAll('.finance-ticker-picker-row').length,
        };
        button.click(); // close it again
        return out;
      }, i).catch(e => ({ error: e.message })));
    }
    r.pickerInLayouts[`${layout.count}${layout.orientation ? '-' + layout.orientation : ''}`] = results;
    if (layout.count === 4) {
      // A picture of the top-right chart's picker open, for a look.
      await frame.evaluate(() => document.querySelectorAll('.finance-ticker-picker-button')[1]?.click());
      await s.page.waitForTimeout(300);
      await s.page.screenshot({ path: path.join(out, '96-picker-top-chart.png') });
      await frame.evaluate(() => document.querySelectorAll('.finance-ticker-picker-button')[1]?.click());
    }
  }

  step('// Rearranging widgets keeps their frames running');
  // A widget is moved within the sidebar (dragged, or docked and released):
  // its frame must not reload, nor a docked widget's when another moves.
  // Moving an element holding an iframe reloads the iframe unless it's
  // moved with moveBefore().
  {
    const sectionOf = title => `iframe[data-extension="plugin:finance"][title="${title}"]`;
    const mark = async title => (await frameFor(s.page, title))?.evaluate(() => { window.__notReloaded = true; }).catch(() => {});
    const kept = async title => {
      const frame = await (await s.page.$(sectionOf(title)))?.contentFrame();
      return frame ? frame.evaluate(() => window.__notReloaded === true).catch(() => false) : false;
    };
    // Dock Balance to the bottom, as the sidebar's own menu does.
    await s.page.evaluate(async selector => {
      const { sidebarState } = await import('atmos-core/core/sidebar-state.js');
      const section = document.querySelector(selector)?.closest('.fin-section');
      const id = section?.dataset.sid;
      if (!id) return;
      sidebarState.dockedSections = [...sidebarState.dockedSections.filter(item => item !== id), id];
      (await import('atmos-core/core/sidebar-shell.js')).restoreSidebarOrder();
    }, sectionOf('Balance'));
    await s.page.waitForTimeout(2500);
    await mark('Balance');
    await mark('Spot');
    await mark('Performance');
    // Drag Spot below Performance (dragstart, dragover, dragend), as a mouse does.
    const moved = await s.page.evaluate(([spotSel, perfSel]) => {
      const spot = document.querySelector(spotSel)?.closest('.fin-section');
      const perf = document.querySelector(perfSel)?.closest('.fin-section');
      if (!spot || !perf || spot.parentElement !== perf.parentElement) return 'not side by side';
      const data = new DataTransfer();
      spot.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      const box = perf.getBoundingClientRect();
      perf.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 10, clientY: box.bottom - 2 }));
      spot.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return [...spot.parentElement.querySelectorAll(':scope > .fin-section')].indexOf(spot) > [...perf.parentElement.querySelectorAll(':scope > .fin-section')].indexOf(perf) ? 'moved' : 'not moved';
    }, [sectionOf('Spot'), sectionOf('Performance')]);
    await s.page.waitForTimeout(1500);
    r.rearranging = {
      moved,
      balanceDocked: await s.page.evaluate(selector => !!document.querySelector(selector)?.closest('#sidebar-bottom-dock'), sectionOf('Balance')),
      dockedBalanceKept: await kept('Balance'),
      draggedSpotKept: await kept('Spot'),
      performanceKept: await kept('Performance'),
    };
    // Release Balance from the dock again.
    await s.page.evaluate(async selector => {
      const { sidebarState } = await import('atmos-core/core/sidebar-state.js');
      const id = document.querySelector(selector)?.closest('.fin-section')?.dataset.sid;
      sidebarState.dockedSections = sidebarState.dockedSections.filter(item => item !== id);
      (await import('atmos-core/core/sidebar-shell.js')).restoreSidebarOrder();
    }, sectionOf('Balance'));
    await s.page.waitForTimeout(1500);
    r.rearranging.releasedBalanceKept = await kept('Balance');
  }

  step('// Alt + double-click resets every chart');
  // A double-click on a chart's plot snaps it to its optimal view (the
  // charting service's own handler). With Alt, like the other Alt gestures,
  // it must reach every chart's plot, each resetting itself. Plain, only the
  // one clicked; with Ctrl too (which clears hidden ranges), every chart.
  {
    const frame = await frameFor(s.page, 'Finance');
    await frame?.evaluate(() => {
      document.querySelector('.finance-layout-button')?.click();
      [...document.querySelectorAll('.finance-layout-menu button')].find(b => Number(b.dataset.count) === 4)?.click();
    });
    await s.page.waitForTimeout(2500);
    const frameBox = await (await s.page.$('iframe[data-extension="plugin:finance"][title="Finance"]'))?.boundingBox();
    const plotInfo = await frame.evaluate(() => {
      const plots = [...document.querySelectorAll('.atmos-chart__price-host')];
      window.__dbl = plots.map(() => []);
      plots.forEach((plot, i) => plot.addEventListener('dblclick', event => window.__dbl[i].push({ alt: event.altKey, ctrl: event.ctrlKey })));
      return plots.map(plot => { const box = plot.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    });
    const at = i => ({ x: frameBox.x + plotInfo[i].x, y: frameBox.y + plotInfo[i].y });
    const received = () => frame.evaluate(() => window.__dbl.map(list => list.length));
    const reset = () => frame.evaluate(() => window.__dbl.forEach(list => { list.length = 0; }));
    await s.page.mouse.dblclick(at(0).x, at(0).y);
    await s.page.waitForTimeout(500);
    const plain = await received();
    await reset();
    await s.page.keyboard.down('Alt');
    await s.page.mouse.dblclick(at(1).x, at(1).y);
    await s.page.keyboard.up('Alt');
    await s.page.waitForTimeout(500);
    const alt = await received();
    await reset();
    await s.page.keyboard.down('Alt'); await s.page.keyboard.down('Control');
    await s.page.mouse.dblclick(at(2).x, at(2).y);
    await s.page.keyboard.up('Control'); await s.page.keyboard.up('Alt');
    await s.page.waitForTimeout(500);
    const altCtrl = await frame.evaluate(() => window.__dbl.map(list => list.map(item => item.ctrl)));
    r.altDoubleClick = { plots: plotInfo.length, plain, alt, altCtrl };

    // Timeframes: TradingView's list, no range buttons. A click picks the
    // candle; Ctrl+click shows that much time and keeps the candle; Alt+Ctrl
    // does it on every chart. Real clicks, on the charts that have data (a
    // market chart here has none: no exchanges in the test).
    const views = () => frame.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('atmos:charting-instance:finance-extra'))
      .sort().map(key => { const value = JSON.parse(localStorage.getItem(key)); return [key.split(':').pop(), { bucketMs: value.bucketMs, range: value.activeRangeKey }]; })));
    const toolbars = await frame.evaluate(() => [...document.querySelectorAll('.finance-toolbar-scroll')].map((toolbar, index) => ({
      index,
      bound: !!toolbar.querySelector('[data-interval][aria-pressed="true"]'),
      timeframes: [...toolbar.querySelectorAll('[data-interval]')].map(item => item.textContent),
      ranges: toolbar.querySelectorAll('[data-range]').length,
      title: toolbar.querySelector('[data-interval="1h"]')?.title,
    })));
    const [first, second] = toolbars.filter(item => item.bound).map(item => item.index);
    const chartInfo = index => frame.evaluate(index => {
      const toolbar = document.querySelectorAll('.finance-toolbar-scroll')[index];
      const chart = toolbar?.closest('.finance-portfolio-chart, .mq-market');
      return {
        pressed: [...toolbar.querySelectorAll('[data-interval][aria-pressed="true"]')].map(item => item.dataset.interval),
        visiblePoints: chart?.querySelector('.atmos-chart__stats')?.textContent.trim().split(/\s+/)[0],
      };
    }, index);
    const button = async (index, value) => {
      const box = await frame.evaluate(([index, value]) => {
        const element = document.querySelectorAll('.finance-toolbar-scroll')[index]?.querySelector(`[data-interval="${value}"]`);
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = element?.getBoundingClientRect();
        return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      }, [index, value]);
      return box && { x: frameBox.x + box.x, y: frameBox.y + box.y };
    };
    const click = async (index, value, keys = []) => {
      const point = await button(index, value);
      if (!point) return false;
      for (const key of keys) await s.page.keyboard.down(key);
      await s.page.mouse.click(point.x, point.y);
      for (const key of [...keys].reverse()) await s.page.keyboard.up(key);
      await s.page.waitForTimeout(600);
      return true;
    };
    const before = { chart: await chartInfo(first), views: await views() };
    const clicked = [await click(first, '1h')];
    const afterClick = { chart: await chartInfo(first), views: await views() };
    clicked.push(await click(first, '6h', ['Control']));
    const afterCtrl = { chart: await chartInfo(first), views: await views() };
    await s.page.screenshot({ path: path.join(out, '97-timeframes-ctrl.png') });
    await frame.evaluate(() => { window.__tf = []; document.querySelectorAll('[data-interval="1w"]').forEach((item, i) => item.addEventListener('click', event => window.__tf.push({ i, ctrl: event.ctrlKey, alt: event.altKey }))); });
    clicked.push(await click(second, '1w', ['Alt', 'Control']));
    const afterAltCtrl = { first: await chartInfo(first), second: await chartInfo(second), views: await views(), events: await frame.evaluate(() => window.__tf) };
    clicked.push(await click(first, 'auto', ['Control']));
    const afterCtrlAuto = { chart: await chartInfo(first), views: await views() };
    r.timeframes = { toolbars: toolbars.map(({ timeframes, ...rest }) => ({ ...rest, timeframes: timeframes.join(' ') })), charts: [first, second], clicked, before, afterClick, afterCtrl, afterAltCtrl, afterCtrlAuto };
    await s.page.screenshot({ path: path.join(out, '97-timeframes.png') });
    await frame.evaluate(() => {
      document.querySelector('.finance-layout-button')?.click();
      [...document.querySelectorAll('.finance-layout-menu button')].find(b => Number(b.dataset.count) === 1)?.click();
    });
    await s.page.waitForTimeout(1500);
  }

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

  r.errors = s.errors;
  await s.page.evaluate(async () => (await import('atmos-core/persist.js')).flushPendingSave());
  await s.page.waitForTimeout(500);
  await s.app.close();

  step('// 3. After a restart');
  // 3. After a restart: the settings changed above stayed.
  s = await launch();
  const connections3 = await frameFor(s.page, 'Portfolio Connections');
  await s.page.waitForTimeout(2000);
  r.afterRestart = { connections: await text(connections3) };
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

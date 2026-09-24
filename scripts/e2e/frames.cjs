// Framed third-party extensions end to end: approval, sandbox isolation, CSP,
// SDK calls, context menus, layouts, settings, theme, state across restarts.
// Usage: node scripts/e2e/frames.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'frames'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-frames-');
fs.cpSync(path.join(__dirname, 'fixtures'), installRoot, { recursive: true });

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const frameFor = (page, ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`));

(async () => {
  const r = { home };
  // 1. Approve both fixtures.
  let s = await launch();
  r.statusBefore = await s.page.evaluate(async () => {
    const all = [...(await window.atmosCore.listPlugins()).map(p => ({ ...p, kind: 'plugin' })), ...(await window.atmosCore.listServices()).map(p => ({ ...p, kind: 'service' }))];
    const out = {};
    for (const e of all.filter(e => e.tier === 'third-party')) {
      out[e.id] = `${e.status}/${e.runtime}/${JSON.stringify(e.frame?.contributions.map(c => c.surface))}`;
      await window.atmosCore.approveExtension(e.kind, e.id, e.fingerprint);
    }
    return out;
  });
  await s.app.close();

  // 2. Run them.
  s = await launch();
  r.list = await s.page.evaluate(async () => {
    const all = [...await window.atmosCore.listPlugins(), ...await window.atmosCore.listServices()];
    return Object.fromEntries(all.filter(e => e.runtime === 'frame' || e.libraryBase).map(e => [e.id, `${e.status}/${e.runtime}/${e.active}/${e.frame?.origin || e.libraryBase}`]));
  });
  r.panels = await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().map(p => p.id));
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('hello-frame'));
  await s.page.waitForTimeout(500);
  let panel;
  for (let i = 0; i < 40 && !(panel = frameFor(s.page, 'plugin:hello-frame', 'panel')); i++) await s.page.waitForTimeout(100);
  await panel.waitForFunction(() => window.__results?.done === true, null, { timeout: 15000 }).catch(() => {});
  r.panel = await panel.evaluate(() => window.__results).catch(e => `no panel frame: ${e.message}`);
  await s.page.waitForTimeout(600);
  await s.page.screenshot({ path: path.join(out, '70-frame-panel.png') });

  // Context menu from inside the frame, rendered by Core.
  const box = await s.page.locator('iframe.atmos-extension-frame-panel').boundingBox();
  await s.page.mouse.click(box.x + 200, box.y + 300, { button: 'right' });
  await s.page.waitForTimeout(400);
  r.menuInCore = await s.page.evaluate(() => [...document.querySelectorAll('.ctx-menu-surface .ctx-item')].map(el => el.textContent.trim()));
  await s.page.screenshot({ path: path.join(out, '71-frame-menu.png') });
  r.menuItemFound = await s.page.evaluate(() => { const el = document.querySelector('.ctx-menu-surface [data-context-menu-item="say"]'); el?.click(); return !!el; });
  await s.page.waitForTimeout(600);
  r.menuResult = await panel.evaluate(() => ({ choice: window.__results.menuChoice, ran: window.__results.menuRan }));

  // Navigation attempts from inside the frame.
  await panel.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
  await s.page.waitForTimeout(800);
  r.panelUrlAfterNavigate = frameFor(s.page, 'plugin:hello-frame', 'panel')?.url() ?? 'gone';
  await panel.evaluate(() => { try { top.location.href = 'https://example.com/'; return 'no error'; } catch (e) { return e.name; } }).then(v => { r.topNavigate = v; }).catch(() => {});
  r.mainUrl = s.page.url();

  // Sidebar widget and background frames.
  r.sidebarFrame = !!frameFor(s.page, 'plugin:hello-frame', 'sidebar');
  r.sidebarHeight = await s.page.evaluate(() => document.querySelector('iframe.atmos-extension-frame-sidebar')?.style.height ?? null);
  r.sidebarText = await frameFor(s.page, 'plugin:hello-frame', 'sidebar')?.evaluate(() => document.body.innerText).catch(e => e.message);
  // A widget that changes while its section is collapsed (Chromium stops
  // rendering the frame) still reports its new height.
  r.collapsedWidget = await (async () => {
    const sel = 'iframe.atmos-extension-frame-sidebar[data-extension="plugin:hello-frame"]';
    const widget = () => s.page.evaluate(sel => { const f = document.querySelector(sel); return { open: f.closest('.fin-section').classList.contains('open'), height: parseInt(f.style.height, 10) }; }, sel);
    const toggle = () => s.page.evaluate(sel => document.querySelector(sel).closest('.fin-section').querySelector('.fin-section-label').click(), sel);
    if ((await widget()).open) { await toggle(); await s.page.waitForTimeout(400); }
    const before = await widget();
    const frame = frameFor(s.page, 'plugin:hello-frame', 'sidebar');
    await frame.evaluate(() => { const d = document.createElement('div'); d.id = 'grow'; d.style.height = '150px'; document.body.appendChild(d); });
    await s.page.waitForTimeout(800);
    const grown = await widget();
    await frame.evaluate(() => document.getElementById('grow').remove());
    await s.page.waitForTimeout(400);
    return { open: grown.open, grewBy: grown.height - before.height, restored: (await widget()).height === before.height };
  })().catch(e => e.message);
  r.bootFrames = await s.page.evaluate(() => [...document.querySelectorAll('#atmos-extension-boot-frames iframe')].map(f => f.dataset.extension));

  // Theme change reaches the frame.
  await s.page.evaluate(async () => (await import('atmos-core/core/appearance.js')).setAppTheme('atmos-light'));
  await s.page.waitForTimeout(400);
  r.inkAfterLightTheme = await frameFor(s.page, 'plugin:hello-frame', 'panel')?.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink-rgb').trim()).catch(e => e.message);
  await s.page.screenshot({ path: path.join(out, '72-frame-light.png') });
  await s.page.evaluate(async () => (await import('atmos-core/core/appearance.js')).setAppTheme('atmos-dark'));

  // In a split layout, beside a first-party panel.
  await s.page.evaluate(async () => {
    const reg = await import('atmos-core/core/panel-registry.js');
    reg.setPanelLayout('columns');
    reg.activatePanelPlugin('audio-player');
    reg.assignPanelPlugin('right', 'hello-frame');
  });
  await s.page.waitForTimeout(1500);
  const tile = s.page.frames().filter(f => f.url().includes('ext=plugin%3Ahello-frame') && f.url().includes('surface=panel')).pop();
  r.tile = await tile?.evaluate(() => ({ presentation: window.__results?.presentation, visits: window.__results?.visits, w: innerWidth, h: innerHeight })).catch(e => e.message);
  await s.page.screenshot({ path: path.join(out, '73-frame-tile.png') });
  await s.page.evaluate(async () => { const reg = await import('atmos-core/core/panel-registry.js'); reg.setPanelLayout('single'); });
  await s.page.waitForTimeout(500);
  r.framesAfterSingle = await s.page.evaluate(async () => (await import('atmos-core/core/extension-frame-host.js')).listExtensionFrames());

  // Settings → Appearance shows the extension's settings frame.
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
  await s.page.waitForTimeout(500);
  await s.page.evaluate(() => document.querySelector('button[aria-label="Appearance"]')?.click());
  await s.page.waitForTimeout(1500);
  const settingsFrame = frameFor(s.page, 'plugin:hello-frame', 'settings');
  r.settingsFrame = settingsFrame ? await settingsFrame.evaluate(() => document.body.innerText.trim()) : 'missing';
  r.settingsHeight = await s.page.evaluate(() => document.querySelector('iframe.atmos-extension-frame-settings')?.style.height);
  await s.page.screenshot({ path: path.join(out, '74-frame-settings.png') });
  await s.page.keyboard.press('Escape');

  // Memory.
  r.metrics = await s.app.evaluate(({ app }) => {
    const m = app.getAppMetrics();
    const tabs = m.filter(p => p.type === 'Tab');
    return { processes: m.length, renderers: tabs.length, rendererMB: Math.round(tabs.reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024) };
  });
  r.errors = s.errors;
  r.log = s.logs.join('').split('\n').filter(l => /blocked|denied|extension-frames|atmos-ext|browser permissions/.test(l));
  await s.page.evaluate(async () => (await import('atmos-core/persist.js')).flushPendingSave());
  await s.app.close();

  // 3. Relaunch: state survived.
  s = await launch();
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('hello-frame'));
  for (let i = 0; i < 40 && !(panel = frameFor(s.page, 'plugin:hello-frame', 'panel')); i++) await s.page.waitForTimeout(100);
  await panel.waitForFunction(() => window.__results?.visits, null, { timeout: 15000 }).catch(() => {});
  r.visitsAfterRestart = await panel.evaluate(() => window.__results.visits).catch(e => e.message);
  await s.app.close();
  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

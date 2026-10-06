// Atmos's keyboard shortcuts end to end (keymap.mjs, shortcuts.js, the SDK,
// task-view.js), with a developer-folder extension that tries to keep every
// key for itself:
//   - Alt+` the switcher, as Windows' Alt+Tab: it shows at once; a quick
//     tap flips between the last two panels; held, it shows the
//     panels, ` moves on, letting go of Alt switches, Esc lets go without;
//   - from inside the extension's text field (which calls preventDefault on
//     every key): Alt+`, Ctrl+` (Settings), Ctrl+Shift+` (the sidebar) and
//     Alt+\ (the command bar) are still Atmos's, and the extension never
//     sees them; Tab, Ctrl+Tab and Ctrl+Shift+V are left alone;
//   - Escape closes what's on top only (a menu over Settings);
//   - Ctrl+R in an extension's frame reloads that frame, not Atmos;
//   - rev/sidebar-side; Settings → Atmos listing the shortcuts.
// Usage: node scripts/e2e/keys.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'keys'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-keys-');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value || Date.now() > deadline) return value;
    await wait(every);
  }
}

// A community extension whose field keeps every key it can.
const probe = path.join(home, 'key-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 3, displayName: 'Key Probe', version: '1.0.0',
  contributes: { panel: { label: 'Key Probe' } },
}, null, 2));
fs.writeFileSync(path.join(probe, 'panel.js'), `
import 'atmos-sdk';
document.body.innerHTML = '<input id="field" style="margin:40px;width:300px">';
window.__probe = { keys: [], loadedAt: Date.now() };
// Every key but a modifier on its own, kept: preventDefault, as early as it can.
const greedy = event => {
  event.preventDefault();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  window.__probe.keys.push([event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key].filter(Boolean).join('+'));
};
window.addEventListener('keydown', greedy, true);
`);

/**
 * Real X input (xinput.py): keys go through the OS, so Electron's
 * before-input-event sees them (Ctrl+R) and a held Alt is held.
 */
function xinput() {
  const proc = spawn('python3', [path.join(__dirname, 'xinput.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      waiting.shift()?.(line);
    }
  });
  const send = line => new Promise(resolve => { waiting.push(resolve); proc.stdin.write(`${line}\n`); });
  return {
    click: (x, y) => send(`click ${Math.round(x)} ${Math.round(y)} 1`),
    key: combo => send(`key ${combo}`),
    down: key => send(`keydown ${key}`),
    up: key => send(`keyup ${key}`),
    type: text => send(`type ${text}`),
    close: () => proc.kill(),
  };
}

const report = { home, checks: {}, details: {} };
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (!ok && detail !== undefined) report.details[name] = detail;
};

(async () => {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${repo}`, `--dev-extension=${probe}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|VPS unavailable|portfolio|developing|Atmos Browser|nothing to paste/i.test(message.text())) errors.push(`${message.type()}: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 45000 });
  await wait(2000);

  const show = id => page.evaluate(async panel => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin(panel), id);
  const active = () => page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId());
  const probeFrame = () => page.frames().find(frame => frame.url().includes('ext=plugin%3Akey-probe') && frame.url().includes('surface=panel'));
  const ui = () => page.evaluate(() => ({
    switcher: document.getElementById('task-view')?.classList.contains('open') === true,
    selected: document.querySelector('.task-view-card.selected')?.dataset.pluginId ?? null,
    cards: [...document.querySelectorAll('.task-view-card')].map(card => card.dataset.pluginId),
    settings: document.getElementById('settings-menu')?.classList.contains('open') === true,
    sidebar: document.body.classList.contains('drawer-open'),
    bar: !!document.getElementById('command-bar-input')?.isConnected || document.getElementById('sidebar-footer')?.classList.contains('is-commanding') === true,
    menu: !!document.querySelector('body > .ctx-menu-surface:not(#ctx-menu), #ctx-menu.visible'),
  }));
  const x = xinput();
  const focusWindow = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    if (win && !win.isFocused()) win.focus();
  }).catch(() => {});
  const intoField = async () => {
    await focusWindow();
    await probeFrame().focus('#field');
    await wait(150);
  };
  const probeKeys = async () => (await probeFrame()?.evaluate(() => window.__probe.keys.splice(0))) || [];

  try {
    // Panels shown: Atmos Browser (at start), then the probe, then Finance.
    const panels = await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().map(plugin => plugin.id));
    await show('key-probe');
    await until(async () => probeFrame());
    await wait(800);
    await show('portfolio-tracker');
    await wait(500);
    report.details.panels = panels;

    // ── The switcher ──
    // Seen open during a quick tap? (It should be: it shows at once.)
    await page.evaluate(() => {
      window.__shownDuringTap = false;
      new MutationObserver(() => { if (document.getElementById('task-view').classList.contains('open')) window.__shownDuringTap = true; })
        .observe(document.getElementById('task-view'), { attributes: true });
    });
    await focusWindow(); await x.click(640, 400);
    await x.down('alt');
    await x.key('grave');
    await x.up('alt');
    await wait(400);
    const afterTap = await active();
    const shownDuringTap = await page.evaluate(() => window.__shownDuringTap);
    check('a quick Alt+` goes back to the panel before (Finance → Key Probe), the switcher shown at once and gone', afterTap === 'key-probe' && shownDuringTap && !(await ui()).switcher, { afterTap, shownDuringTap });
    await x.down('alt');
    await x.key('grave');
    await x.up('alt');
    await wait(400);
    check('again, and it flips back (the last two)', (await active()) === 'portfolio-tracker', await active());

    await x.down('alt');
    await x.key('grave');
    await wait(450);
    const held = await ui();
    check('held, the switcher shows the panels, most recent first, on the one before', held.switcher && held.cards[0] === 'portfolio-tracker' && held.cards[1] === 'key-probe' && held.selected === 'key-probe', held);
    await page.screenshot({ path: path.join(out, '01-switcher.png') });
    await x.key('grave');
    await wait(150);
    const moved = await ui();
    check('` again moves on', moved.selected === held.cards[2], moved);
    await x.up('alt');
    await wait(400);
    const switched = await ui();
    check('letting go of Alt switches to it, and the switcher goes', !switched.switcher && (await active()) === held.cards[2], { switched, active: await active() });

    await x.down('alt');
    await x.key('grave');
    await wait(450);
    const before = held.cards[2];
    await x.key('Escape');
    await x.up('alt');
    await wait(400);
    check('Esc with Alt held lets go without switching', !(await ui()).switcher && (await active()) === before, { active: await active(), before });

    // ── From inside a frame that keeps every key ──
    await show('key-probe');
    await wait(600);
    await intoField();
    await probeKeys();
    await x.type('ab');
    check('the extension gets ordinary typing', JSON.stringify(await probeKeys()) === JSON.stringify(['a', 'b']));

    await x.key('ctrl+grave');
    await wait(500);
    const settingsOpen = (await ui()).settings;
    const keysSettings = await probeKeys();
    check('Ctrl+` in its field opens Settings; the extension never saw it', settingsOpen && keysSettings.length === 0, { settingsOpen, keysSettings });
    // Escape: a menu over Settings closes first, then Settings.
    // The keyboard in Settings (it was in the extension's field, where Esc is the field's).
    await page.evaluate(() => document.querySelector('#settings-menu .sm-nav-item.active')?.focus());
    await page.evaluate(async () => (await import('atmos-core/core/context-menu.js')).openMenu(300, 300, [{ label: 'One', run() {} }]));
    await wait(200);
    await x.key('Escape');
    await wait(300);
    const afterOne = await ui();
    check('Esc closes the menu over Settings, not Settings', !afterOne.menu && afterOne.settings, afterOne);
    await page.screenshot({ path: path.join(out, '02-settings-atmos-shortcuts.png') });
    const listed = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('.sm-keys-row')].map(row => [row.querySelector('.sa-label')?.textContent.trim(), [...row.querySelectorAll('kbd, code')].map(key => key.textContent).join(' ')]),
      title: document.querySelector('.sm-home-keys-title')?.textContent,
    }));
    report.details.listed = listed.rows.slice(0, 8);
    check('Settings → Atmos lists the keyboard shortcuts', listed.title === 'Keyboard shortcuts'
      && listed.rows.some(([label, keys]) => /Switch panels/.test(label) && keys === 'Alt `')
      && listed.rows.some(([, keys]) => keys === 'Ctrl Shift `')
      && listed.rows.some(([, keys]) => keys === 'rev/sidebar-side')
      && listed.rows.some(([label]) => label === 'New tab'), listed);
    await x.key('Escape');
    await wait(400);
    check('a second Esc closes Settings', !(await ui()).settings);

    await intoField();
    await probeKeys();
    const sidebarBefore = (await ui()).sidebar;
    await x.key('ctrl+shift+grave');
    await wait(500);
    const sidebarAfter = (await ui()).sidebar;
    check('Ctrl+Shift+` in its field opens or closes the sidebar; the extension never saw it', sidebarAfter !== sidebarBefore && (await probeKeys()).length === 0, { sidebarBefore, sidebarAfter });
    await x.key('ctrl+shift+grave');
    await wait(400);

    await intoField();
    await x.key('alt+\\');
    await wait(500);
    const barOpen = (await ui()).bar;
    check('Alt+\\ in its field opens the command bar; the extension never saw it', barOpen && (await probeKeys()).length === 0, { barOpen });
    await x.type('rev/sidebar-side');
    await wait(300);
    const sideBefore = await page.evaluate(async () => (await import('atmos-core/core/appearance.js')).appearanceState.sidebarPosition);
    await x.key('Return');
    await wait(500);
    const sideAfter = await page.evaluate(async () => (await import('atmos-core/core/appearance.js')).appearanceState.sidebarPosition);
    check('rev/sidebar-side moves the sidebar to the other side', sideBefore !== sideAfter && ['left', 'right'].includes(sideAfter), { sideBefore, sideAfter });

    await intoField();
    await x.down('alt');
    await x.key('grave');
    await x.up('alt');
    await wait(500);
    check('Alt+` from its field switches panels (to the one before)', (await active()) !== 'key-probe' && (await probeKeys()).length === 0, await active());

    // Keys that aren't Atmos's stay the extension's.
    await show('key-probe');
    await wait(500);
    await intoField();
    await probeKeys();
    const sidebarAsWas = (await ui()).sidebar;
    await x.key('Tab');
    await x.key('ctrl+Tab');
    await x.key('ctrl+shift+v');
    await wait(300);
    const kept = await probeKeys();
    const noise = await ui();
    check('Tab, Ctrl+Tab and Ctrl+Shift+V are the extension\'s (no sidebar, no Task View)', kept.includes('Tab') && kept.includes('Ctrl+Tab') && kept.includes('Ctrl+Shift+V') && !noise.switcher && noise.sidebar === sidebarAsWas, { kept, noise });
    await focusWindow(); await x.click(1000, 700);
    await x.key('ctrl+Tab');
    await wait(400);
    check('Ctrl+Tab on Atmos\'s page opens nothing', !(await ui()).switcher);

    // ── Ctrl+R reloads what has the keyboard ──
    await page.evaluate(() => { window.__notReloaded = true; });
    const loadedAt = await probeFrame().evaluate(() => window.__probe.loadedAt);
    await intoField();
    await x.key('ctrl+r');
    const reloaded = await until(async () => {
      const at = await probeFrame()?.evaluate(() => window.__probe?.loadedAt).catch(() => null);
      return at && at !== loadedAt ? at : null;
    });
    const pageKept = await page.evaluate(() => window.__notReloaded === true).catch(() => false);
    check('Ctrl+R in an extension\'s frame reloads that frame, not Atmos', !!reloaded && pageKept, { reloaded, pageKept });
    await wait(800);
    await intoField();
    await x.key('alt+\\');
    await wait(500);
    check('the reloaded frame still hands Atmos its keys', (await ui()).bar);
    await x.key('Escape');
  } catch (error) {
    report.error = error.stack || String(error);
  }

  report.errors = errors;
  const total = Object.keys(report.checks).length;
  const passed = Object.values(report.checks).filter(Boolean).length;
  report.summary = `${passed}/${total} checks passed`;
  report.failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: report.summary, failed: report.failed, error: report.error, errors }, null, 2));
  x.close();
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(passed === total && !report.error && total > 0 ? 0 : 1);
})();

// Links from a community extension (the A5 fix), with a probe extension
// approved like any community one:
//
//  1. window.open from the frame with no click: Atmos asks ("Link Probe
//     wants to open example.com"); Don't open opens nothing.
//  2. A real click on a link in the frame: it opens, without asking.
//  3. No click again, and Open: it opens.
//  4. Don't open with "Block links from Link Probe": later links are
//     refused without asking, until a restart.
//  5. The frame can't open a window itself (no allow-popups): a form with
//     target=_blank opens nothing and asks nothing.
//
// The question (dialog.showMessageBox) and the system browser
// (shell.openExternal) are stubbed in the main process and recorded.
// Usage: node scripts/e2e/extension-links.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

// Real X input (xinput.py, as browser.cjs): Playwright's clicks don't reach
// Electron's input events, which is where Atmos sees a click.
function xclick(x, y) {
  return new Promise(resolve => {
    const proc = spawn('python3', [path.join(__dirname, 'xinput.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout.once('data', () => { proc.kill(); resolve(); });
    proc.stdin.write(`click ${Math.round(x)} ${Math.round(y)} 1\n`);
  });
}

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'extension-links'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-links-');

const probe = path.join(installRoot, 'plugins', 'link-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 4, version: '1.0.0', publisher: 'someone', displayName: 'Link Probe',
  contributes: { panel: { label: 'Link Probe' } },
}));
fs.writeFileSync(path.join(probe, 'panel.js'), `
document.body.innerHTML = '<p style="padding:40px"><a id="link" href="https://example.com/clicked" target="_blank" style="font-size:28px;color:#8cf">Open example.com</a></p>'
  + '<form id="form" action="https://example.com/form" target="_blank" method="get"></form>';
window.__ready = true;
`);

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await atmosWindow(app);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page };
}
const frameFor = page => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent('plugin:link-probe')}`) && f.url().includes('surface=panel'));

const r = { home };
(async () => {
  let s = await launch();
  r.approve = await s.page.evaluate(async () => {
    const p = (await window.atmosCore.listPlugins()).find(e => e.id === 'link-probe');
    await window.atmosCore.approveExtension('plugin', 'link-probe', p.fingerprint);
    return `${p.tier}/${p.status}`;
  });
  await s.app.close();

  s = await launch();
  // Record the question and the system browser; answers come from __answers.
  await s.app.evaluate(({ dialog, shell }) => {
    globalThis.__asked = [];
    globalThis.__opened = [];
    globalThis.__answers = [];
    dialog.showMessageBox = async (...args) => {
      const question = args.find(arg => arg && typeof arg === 'object' && 'buttons' in arg);
      globalThis.__asked.push({ message: question.message, checkbox: question.checkboxLabel, defaultId: question.defaultId, buttons: question.buttons });
      return globalThis.__answers.shift() || { response: 1, checkboxChecked: false };
    };
    shell.openExternal = async url => { globalThis.__opened.push(url); };
  });
  await s.page.evaluate(() => window.atmosCore.web.setOptions({ openLinks: false }));
  const state = () => s.app.evaluate(() => ({ asked: globalThis.__asked.map(q => q.message), opened: [...globalThis.__opened] }));
  const answer = value => s.app.evaluate((_, v) => { globalThis.__answers.push(v); }, value);
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('link-probe'));
  let frame;
  for (let i = 0; i < 50 && !(frame = frameFor(s.page)); i++) await s.page.waitForTimeout(100);
  await frame.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  r.sandbox = await s.page.evaluate(() => document.querySelector('iframe.atmos-extension-frame-panel')?.getAttribute('sandbox'));

  // 1. No click: asked, and nothing opens.
  await s.page.waitForTimeout(5500); // past any click from starting up
  await frame.evaluate(() => { window.open('https://example.com/timer'); });
  await s.page.waitForTimeout(800);
  r['1-noClick'] = await state();
  r['1-question'] = await s.app.evaluate(() => globalThis.__asked[0]);

  // 2. A real click on the link: opens, no question.
  const focusWindow = () => s.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    if (win && !win.isFocused()) win.focus();
  });
  await focusWindow();
  const origin = await s.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    return win.getContentBounds();
  });
  const box = await frame.locator('#link').boundingBox();
  await xclick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2);
  await s.page.waitForTimeout(800);
  r['2-click'] = await state();
  await s.page.screenshot({ path: path.join(out, '20-probe.png') });

  // 3. No click, Open.
  await focusWindow();
  await xclick(origin.x + 1130, origin.y + 300); // a click outside the frame (the sidebar): focus leaves it
  await s.page.waitForTimeout(5500);
  await answer({ response: 0, checkboxChecked: false });
  await frame.evaluate(() => { window.open('https://example.com/asked'); });
  await s.page.waitForTimeout(800);
  r['3-open'] = await state();

  // 4. Blocked until a restart.
  await answer({ response: 1, checkboxChecked: true });
  await frame.evaluate(() => { window.open('https://example.com/blocked'); });
  await s.page.waitForTimeout(800);
  await frame.evaluate(() => { window.open('https://example.com/after-block'); });
  await s.page.waitForTimeout(800);
  r['4-blocked'] = await state();

  // 5. The frame's own window opening is refused by the sandbox.
  await frame.evaluate(() => document.getElementById('form').submit());
  await s.page.waitForTimeout(800);
  r['5-form'] = await state();
  await s.app.close();

  const last = r['5-form'];
  r.ok = r.sandbox === 'allow-scripts allow-same-origin allow-forms'
    && r['1-noClick'].asked.length === 1 && /^Link Probe wants to open example\.com$/.test(r['1-noClick'].asked[0]) && r['1-noClick'].opened.length === 0
    && r['1-question'].defaultId === 1
    && r['2-click'].opened.includes('https://example.com/clicked') && r['2-click'].asked.length === 1
    && r['3-open'].opened.includes('https://example.com/asked') && r['3-open'].asked.length === 2
    && r['4-blocked'].asked.length === 3 && !r['4-blocked'].opened.some(u => /block/.test(u))
    && last.asked.length === 3 && !last.opened.some(u => /form/.test(u));
})().catch(error => { r.error = error.stack || String(error); }).finally(() => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error || !r.ok ? 1 : 0);
});

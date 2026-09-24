// Security checks: third-party approval and re-approval, the main.cjs ban,
// bundled tamper detection, link and window.open handling, browser permissions.
// Usage: node scripts/e2e/security.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'security'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
const { writeIntegrityList } = require(path.join(repo, 'core/js/core/extension-integrity.cjs'));
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot: cfg } = isolatedEnv('atmos-sec-');
const marker = path.join(home, 'SNEAKY_RAN');

const mk = (rel, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(cfg, rel, f)), { recursive: true }); fs.writeFileSync(path.join(cfg, rel, f), c); } };
mk('plugins/hello-third', {
  'extension.json': JSON.stringify({ apiVersion: 3, displayName: 'Hello Third', permissions: { network: ['api.example.net'], browser: ['notifications'] } }),
  // Declares "notifications": shows one through Core and hears its click.
  'boot.js': [
    "import atmos from 'atmos-sdk';",
    "window.__helloThird = 'loaded';",
    "window.__clicks = [];",
    "atmos.notifications.onClick(click => window.__clicks.push(click));",
    "window.__notify = atmos.notifications.show({ title: 'Hello', body: 'from a frame', tag: 't1' }).then(shown => `shown ${shown}`, e => `${e.name}: ${e.message}`);",
  ].join('\n'),
});
mk('plugins/sneaky-main', {
  'extension.json': JSON.stringify({ apiVersion: 3, permissions: {} }),
  // If the ban failed, this would write the marker file.
  'main.cjs': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); module.exports = { activate() {} };`,
  'boot.js': "window.__sneaky = 'loaded';",
});

// A copy of the bundled extensions with integrity.json, then one tampered file.
const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-bundled-'));
for (const kind of ['plugins', 'services']) fs.cpSync(path.join(repo, kind), path.join(bundled, kind), { recursive: true, filter: src => !/node_modules|[\\/]tests[\\/]|_to_delete|backups/.test(src) });
for (const id of fs.readdirSync(path.join(repo, 'services'))) {
  const nm = path.join(repo, 'services', id, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(bundled, 'services', id, 'node_modules'), 'dir');
}
writeIntegrityList(bundled);
fs.appendFileSync(path.join(bundled, 'plugins', 'audio-player', 'panel.js'), '\n// tampered\n');

async function launch(root) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${root}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch/.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const list = page => page.evaluate(async () => {
  const all = [...await window.atmosCore.listPlugins(), ...await window.atmosCore.listServices()];
  return Object.fromEntries(all.map(p => [p.id, `${p.tier}/${p.status}/${p.active ? 'active' : 'off'}${p.approvalChanged ? '/changed-approval' : ''}`]));
});
async function openPlugins(page, name) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
  await page.waitForTimeout(500);
  await page.evaluate(() => [...document.querySelectorAll('#settings-menu *')].find(el => el.children.length <= 2 && /^\s*Plugins\s*$/.test(el.textContent || ''))?.click());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, name) });
}
const frameLoaded = (page, id) => page.frames().some(f => f.url().includes(`ext=plugin%3A${id}`) && f.url().includes('surface=boot'));

(async () => {
  const r = { home };
  // 1. Third-party extensions before approval.
  let s = await launch(repo);
  r.run1 = { 'hello-third': (await list(s.page))['hello-third'], 'sneaky-main': (await list(s.page))['sneaky-main'] };
  r.run1BootFrames = { hello: frameLoaded(s.page, 'hello-third'), sneaky: frameLoaded(s.page, 'sneaky-main') };
  r.sneakyMainRan = fs.existsSync(marker);
  r.pageProtocol = await s.page.evaluate(() => fetch('atmos-plugin://hello-third/boot.js').then(res => res.status, () => 'error'));
  // Hardening.
  r.windowOpen = await s.page.evaluate(() => String(window.open('https://example.com/')));
  r.windowCount = s.app.windows().length;
  await s.page.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.com/'; document.body.appendChild(a); a.click(); a.remove(); });
  await s.page.waitForTimeout(500);
  r.urlAfterLinkClick = s.page.url();
  r.permissions = await s.page.evaluate(async () => {
    const out = {};
    for (const name of ['geolocation', 'notifications', 'camera', 'clipboard-read']) {
      try { out[name] = (await navigator.permissions.query({ name })).state; } catch (e) { out[name] = 'err ' + e.message; }
    }
    out.notificationRequest = await Notification.requestPermission();
    return out;
  });
  await openPlugins(s.page, '60-pending.png');
  r.cardText = await s.page.evaluate(() => [...document.querySelectorAll('.sm-extension-card')].filter(c => /Hello Third|Sneaky/.test(c.textContent)).map(c => c.innerText.replace(/\s+/g, ' ').trim()));
  // Approve hello-third with the Settings button.
  await s.page.evaluate(() => [...document.querySelectorAll('.sm-extension-card')].find(c => /Hello Third/.test(c.textContent))?.querySelector('[data-trust-action="approve"]')?.click());
  await s.page.waitForTimeout(500);
  await s.page.screenshot({ path: path.join(out, '61-approved-restart.png') });
  r.afterApprove = (await list(s.page))['hello-third'];
  r.approvals = JSON.parse(fs.readFileSync(path.join(cfg, 'extension-approvals.json'), 'utf8'));
  r.errors1 = s.errors;
  await s.app.close();

  // 2. Restart: the approved extension loads (in a frame).
  s = await launch(repo);
  r.run2 = (await list(s.page))['hello-third'];
  r.run2BootFrame = frameLoaded(s.page, 'hello-third');
  const helloBoot = s.page.frames().find(f => f.url().includes('ext=plugin%3Ahello-third') && f.url().includes('surface=boot'));
  r.notify = await helloBoot?.evaluate(() => window.__notify).catch(e => e.message);
  // What main sends when the user clicks it (the toast itself can't be clicked from here).
  await s.app.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.getURL().startsWith('atmos-app://'))?.send('extensions:notification-click', 'plugin', 'hello-third', 't1'));
  await s.page.waitForTimeout(300);
  r.notifyClicks = await helloBoot?.evaluate(() => window.__clicks).catch(e => e.message);
  r.notifyFromPageForOther = await s.page.evaluate(() => window.atmosCore.showExtensionNotification('plugin', 'sneaky-main', { title: 'x' }).then(v => `shown ${v}`, e => 'refused'));
  await s.app.close();

  // 3. Change its code and permissions: it needs approval again.
  fs.appendFileSync(path.join(cfg, 'plugins/hello-third/boot.js'), "\nwindow.__helloThird = 'changed';");
  fs.writeFileSync(path.join(cfg, 'plugins/hello-third/extension.json'), JSON.stringify({ apiVersion: 3, displayName: 'Hello Third', permissions: { network: ['*'], browser: ['notifications', 'geolocation'] } }));
  s = await launch(repo);
  r.run3 = (await list(s.page))['hello-third'];
  r.run3BootFrame = frameLoaded(s.page, 'hello-third');
  await openPlugins(s.page, '62-changed.png');
  await s.app.close();

  // 4. Bundled copy with integrity.json and a tampered file.
  s = await launch(bundled);
  const l4 = await list(s.page);
  r.run4 = { 'audio-player': l4['audio-player'], wallpaper: l4.wallpaper, audio: l4.audio, location: l4.location };
  await openPlugins(s.page, '63-tampered.png');
  r.errors4 = s.errors;
  await s.app.close();
  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

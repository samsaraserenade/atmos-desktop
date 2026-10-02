// Community extensions copied in by hand, as someone sharing one would:
// the footer and Settings → Extensions say they wait for approval; Review
// opens each one's card, which says what it shares and flags that it can
// read the location and shares with every extension; approving loads it at
// once (and one approved earlier that needed it), with no restart;
// what another extension may use of it names what that gives; its icon is
// in Settings; after a restart both load as usual.
// Usage: node scripts/e2e/approval.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'approval'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, installRoot, env } = isolatedEnv('atmos-approval-');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 15000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(every);
  }
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
function write(folder, files) {
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

// Skyloom: reads the location, shares a snapshot and its events with every extension.
write(path.join(installRoot, 'plugins', 'skyloom'), {
  'extension.json': {
    apiVersion: 4, engines: { atmos: '>=0.16.0' }, version: '0.1.0', displayName: 'Skyloom',
    contributes: { panel: { label: 'Sky', icon: 'icon.svg' }, boot: {} },
    permissions: { invokes: ['service:location'] },
    exports: { methods: { snapshot: { with: 'all', description: "The sky's colours now, without your location" } }, events: { sky: 'all' } },
  },
  'icon.svg': ICON,
  'boot.js': "import atmos from 'atmos-sdk';\nawait atmos.expose({ snapshot: () => ({ palette: ['#224466', '#ffcc88'] }) });\n",
  'panel.js': "document.body.textContent = 'Skyloom panel';\n",
});
// Sky Reader: needs Skyloom, and can't read the location itself.
write(path.join(installRoot, 'plugins', 'sky-reader'), {
  'extension.json': {
    apiVersion: 4, engines: { atmos: '>=0.16.0' }, version: '0.1.0', displayName: 'Sky Reader',
    contributes: { panel: { label: 'Reader' } },
    dependencies: { 'plugin:skyloom': '^0.1.0' },
    permissions: { invokes: ['plugin:skyloom'] },
  },
  'panel.js': [
    "import atmos from 'atmos-sdk';",
    'const results = {};',
    "results.snapshot = await atmos.call('plugin:skyloom', 'snapshot').catch(error => `refused: ${error.message}`);",
    "results.location = await atmos.location.get().then(() => 'read', error => error.name);",
    'window.__results = results;',
    "document.body.textContent = 'Sky Reader panel';",
  ].join('\n'),
});

async function launch() {
  const noBundled = path.join(home, 'no-bundled');
  fs.mkdirSync(noBundled, { recursive: true });
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${noBundled}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, errors };
}
const list = page => page.evaluate(async () => Object.fromEntries((await window.atmosCore.listPlugins())
  .filter(item => item.tier === 'third-party').map(item => [item.id, `${item.status}/${item.active ? 'active' : 'off'}`])));
const footer = page => page.evaluate(() => {
  const button = document.getElementById('sidebar-footer-extensions');
  return { attention: button.classList.contains('attention'), title: button.title };
});
const card = (page, name) => page.evaluate(label => [...document.querySelectorAll('.sm-extension-card')]
  .find(item => item.querySelector('.sm-card-name')?.textContent.includes(label))?.innerText.replace(/\s+/g, ' ').trim() || null, name);
const frameFor = (page, ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`));

(async () => {
  const r = { home };
  let s = await launch();
  r.before = await list(s.page);
  r.footerBefore = await until(async () => { const value = await footer(s.page); return value.attention ? value : null; }, { timeout: 5000 }) || await footer(s.page);

  // The footer opens Settings → Extensions, which lists both with Review.
  await s.page.evaluate(() => document.getElementById('sidebar-footer-extensions').click()); // the sidebar is closed
  r.managerWaiting = await until(() => s.page.evaluate(() => {
    const heading = [...document.querySelectorAll('.sm-manager-heading')].find(item => /Waiting for your approval/.test(item.textContent));
    return heading ? heading.nextElementSibling.innerText.replace(/\s+/g, ' ').trim() : null;
  }));
  await s.page.screenshot({ path: path.join(out, '10-waiting.png') });

  // Review: Skyloom's own card, with what it shares and the flag.
  await s.page.evaluate(() => document.querySelector('.sm-manager-row[data-key="plugin:skyloom"] [data-manager-action="review"]')?.click());
  r.reviewOpened = await until(() => s.page.evaluate(() => {
    const item = document.querySelector('.sm-extension-card[data-key="plugin:skyloom"]');
    return item ? { highlighted: item.classList.contains('sm-card-highlight'), page: document.querySelector('.sm-nav-item.active')?.innerText.trim().split('\n')[0] } : null;
  }));
  r.skyloomPrompt = await card(s.page, 'Skyloom');
  r.skyloomCaution = await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:skyloom"] .sm-trust-caution')?.textContent || null);
  await s.page.screenshot({ path: path.join(out, '20-review.png') });

  // Sky Reader first: it needs Skyloom, which isn't approved, so it waits for a restart.
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:sky-reader"] [data-trust-action="approve"]')?.click());
  r.readerAlone = await until(async () => { const text = await card(s.page, 'Sky Reader'); return /Restart Atmos to apply/.test(text || '') ? text : null; });
  r.afterReaderAlone = await list(s.page);

  // Skyloom: loads now, and brings Sky Reader with it.
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:skyloom"] [data-trust-action="approve"]')?.click());
  r.afterSkyloom = await until(async () => { const now = await list(s.page); return now.skyloom === 'approved/active' && now['sky-reader'] === 'approved/active' ? now : null; }) || await list(s.page);
  r.panels = await until(() => s.page.evaluate(async () => {
    const ids = (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().map(item => item.id);
    return ids.includes('skyloom') && ids.includes('sky-reader') ? ids : null;
  }));
  r.bootFrame = !!(await until(async () => frameFor(s.page, 'plugin:skyloom', 'boot'), { timeout: 5000 }));
  await wait(500);
  r.skyloomCard = await card(s.page, 'Skyloom');
  r.readerCard = await card(s.page, 'Sky Reader');
  await s.page.evaluate(() => document.querySelectorAll('.sm-extension-card details').forEach(details => { details.open = true; }));
  r.readerDetails = await card(s.page, 'Sky Reader');
  r.skyloomDetails = await card(s.page, 'Skyloom');
  r.icons = await s.page.evaluate(() => Object.fromEntries(['skyloom', 'sky-reader'].map(id => [id,
    !!document.querySelector(`.sm-extension-card[data-key="plugin:${id}"] .sm-icon .atmos-extension-icon`)])));
  await s.page.screenshot({ path: path.join(out, '30-approved.png') });
  r.footerAfter = await footer(s.page);

  // Sky Reader's panel: Skyloom's shared snapshot, and no location of its own.
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('sky-reader'));
  const reader = await until(async () => frameFor(s.page, 'plugin:sky-reader', 'panel'));
  r.readerPanel = reader ? await until(() => reader.evaluate(() => window.__results)) : 'no frame';
  r.errors1 = s.errors;
  await s.app.close();

  // 2. Restart: both load as any approved extension does.
  s = await launch();
  r.afterRestart = await list(s.page);
  r.footerAfterRestart = await footer(s.page);
  r.errors2 = s.errors;
  await s.app.close();
  console.log(JSON.stringify(r, null, 2));
})().catch(error => { console.error(error); process.exit(1); });

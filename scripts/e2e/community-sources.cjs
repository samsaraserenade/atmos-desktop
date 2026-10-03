// Community extensions from a GitHub repository, through Settings →
// Extensions (GitHub's releases served from a folder: --github-releases):
//
//  1. Sources: Add a source with github.com/someone/weather. Its card names
//     the repository, says Community and how many packages.
//  2. Weather shows under Available with a Community badge; Install stages
//     it ("from someone/weather, you'll review it after the restart").
//  3. After the restart it waits for approval; its card says Signed, where
//     it's from and what it asks for. Approve: it runs.
//  4. 1.1.0, signed with another key: the update says it asks for approval
//     again; after Update and a restart it is off until reviewed, and the
//     review says the key changed.
//
// Usage: node scripts/e2e/community-sources.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'community-sources'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-community-');

// The author's repository, packed with the SDK's pack.cjs.
const author = path.join(home, 'author', 'weather');
const releases = path.join(home, 'github');
fs.mkdirSync(author, { recursive: true });
fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ name: 'weather' }));
fs.writeFileSync(path.join(author, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>');
fs.writeFileSync(path.join(author, 'panel.js'), "document.body.textContent = 'Weather';\n");
function release(version, keyFile, newKey = false) {
  fs.writeFileSync(path.join(author, 'extension.json'), JSON.stringify({
    apiVersion: 4, version, publisher: 'someone', displayName: 'Weather', description: 'Forecasts',
    contributes: { panel: { label: 'Weather', icon: 'icon.svg' } },
    permissions: { network: ['api.open-meteo.com'] },
  }, null, 1));
  const run = spawnSync(process.execPath, [path.join(repo, 'core/js/sdk/pack.cjs'), newKey ? '--new-key' : '--key', keyFile], { cwd: author, encoding: 'utf8', env: { ...process.env, ATMOS_SIGNING_PASSPHRASE: '' } });
  if (run.status !== 0) throw new Error(run.stderr);
  const target = path.join(releases, 'someone', 'weather');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name));
  for (const name of fs.readdirSync(path.join(author, 'dist'))) fs.copyFileSync(path.join(author, 'dist', name), path.join(target, name));
  return run.stdout;
}
release('1.0.0', path.join(home, 'key-1.pem'), true);

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
    args: [repo, `--extensions-root=${bundled}`, `--github-releases=${releases}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::/.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return { app, page, logs, errors };
}
async function openManager(page) {
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionManager());
  await page.waitForSelector('[data-extensions-mode]', { timeout: 10000 });
  await page.waitForTimeout(300);
}
const text = page => page.evaluate(() => document.getElementById('settings-menu-list').innerText.replace(/\s+/g, ' ').trim());
const card = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.innerText.replace(/\s+/g, ' ').trim() ?? null, selector);
const weather = page => page.evaluate(async () => {
  const p = (await window.atmosCore.listPlugins()).find(item => item.id === 'weather');
  return p ? `${p.tier}/${p.status}/${p.active ? 'active' : 'off'} ${p.version} ${p.authorSignature?.status || '-'} ${p.origin?.repo || '-'}${p.origin?.keyChanged ? ' key-changed' : ''}` : null;
});
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });
const shot = (page, name) => page.screenshot({ path: path.join(out, name) });

const r = { home };
(async () => {
  // 1. Add the repository as a source.
  let s = await launch();
  await openManager(s.page);
  await s.page.click('[data-extensions-mode="sources"]');
  await s.page.click('[data-manager-action="show-add-source"]');
  await s.page.fill('.sm-manager-add-source input', 'github.com/someone/weather');
  await shot(s.page, '10-add-source.png');
  await s.page.click('.sm-manager-add-source [data-manager-action="add-source"]');
  await waitFor(s.page, () => /someone\/weather/.test(document.getElementById('settings-menu-list').textContent) && /1 package/.test(document.getElementById('settings-menu-list').textContent));
  await shot(s.page, '11-source.png');
  r['1-source'] = await card(s.page, '.sm-manager-source[data-location*="someone/weather"]');

  // 2. Available, then Install.
  await s.page.click('[data-extensions-mode="installed"]');
  await waitFor(s.page, () => document.querySelector('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="install"]'));
  r['2-available'] = await card(s.page, '.sm-manager-row[data-key="plugin:weather"]');
  await shot(s.page, '20-available.png');
  await s.page.click('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="install"]');
  await waitFor(s.page, () => /Waiting for a restart/.test(document.getElementById('settings-menu-list').textContent));
  r['2-pending'] = await card(s.page, '.sm-manager-row[data-key="plugin:weather"]');
  await shot(s.page, '21-pending.png');
  r['1-errors'] = s.errors;
  await s.app.close();

  // 3. After the restart: waits for approval, signed, from the repository.
  s = await launch();
  r['3-before'] = await weather(s.page);
  await openManager(s.page);
  r['3-page'] = await text(s.page);
  await s.page.click('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="review"]').catch(() => {});
  await waitFor(s.page, () => document.querySelector('.sm-extension-card[data-key="plugin:weather"] [data-trust-action="approve"]'));
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:weather"]')?.scrollIntoView({ block: 'center' }));
  await s.page.waitForTimeout(300);
  r['3-review'] = await card(s.page, '.sm-extension-card[data-key="plugin:weather"]');
  await shot(s.page, '30-review.png');
  await s.page.click('.sm-extension-card[data-key="plugin:weather"] [data-trust-action="approve"]');
  await waitFor(s.page, async () => (await window.atmosCore.listPlugins()).find(item => item.id === 'weather')?.active === true);
  r['3-approved'] = await weather(s.page);
  await s.page.waitForTimeout(400);
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:weather"]')?.scrollIntoView({ block: 'center' }));
  await shot(s.page, '31-approved.png');
  r['3-errors'] = s.errors;
  await s.app.close();

  // 4. An update signed with another key.
  release('1.1.0', path.join(home, 'key-2.pem'), true);
  s = await launch();
  await openManager(s.page);
  await s.page.click('[data-manager-action="check"]');
  await waitFor(s.page, () => document.querySelector('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="install"]'));
  r['4-update'] = await card(s.page, '.sm-manager-row[data-key="plugin:weather"]');
  await shot(s.page, '40-update.png');
  await s.page.click('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="install"]');
  await waitFor(s.page, () => /Update to 1\.1\.0/.test(document.getElementById('settings-menu-list').textContent));
  await s.app.close();
  s = await launch();
  r['4-after'] = await weather(s.page);
  await openManager(s.page);
  await s.page.click('.sm-manager-row[data-key="plugin:weather"] [data-manager-action="review"]').catch(() => {});
  await waitFor(s.page, () => document.querySelector('.sm-extension-card[data-key="plugin:weather"] [data-trust-action="approve"]'));
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:weather"]')?.scrollIntoView({ block: 'center' }));
  await s.page.waitForTimeout(300);
  r['4-review'] = await card(s.page, '.sm-extension-card[data-key="plugin:weather"]');
  await shot(s.page, '41-review-key-changed.png');
  r['4-errors'] = s.errors;
  await s.app.close();
})().catch(error => { r.error = error.stack || String(error); }).finally(() => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error ? 1 : 0);
});

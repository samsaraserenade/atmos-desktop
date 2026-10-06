// An extension's atmos.state that couldn't be written is written later
// (R43): a developer-folder probe sets a value while its state file can't be
// written (a directory where its temporary file goes), then Atmos quits once
// it can be: the value is on disk after the quit. Before, the failed write
// was forgotten and the file kept the value before it.
// Usage: node scripts/e2e/state-retry.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, savedFrameState, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'state-retry'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-state-retry-');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const probe = path.join(home, 'dev', 'state-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({ apiVersion: 4, displayName: 'State Probe', permissions: {}, contributes: { boot: {} } }));
fs.writeFileSync(path.join(probe, 'boot.js'), "import atmos from 'atmos-sdk';\nwindow.__atmos = atmos;\n");
const noBundled = path.join(home, 'no-bundled');
fs.mkdirSync(noBundled);

(async () => {
  const r = { home };
  const app = await electron.launch({
    executablePath: ELECTRON, args: [repo, `--extensions-root=${noBundled}`, `--dev-extension=${probe}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env,
  });
  const page = await atmosWindow(app);
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  let boot;
  for (let i = 0; i < 100 && !(boot = page.frames().find(f => f.url().includes('ext=plugin%3Astate-probe') && f.url().includes('surface=boot'))); i++) await wait(100);
  await boot.waitForFunction(() => !!window.__atmos, null, { timeout: 10000 });
  const set = value => boot.evaluate(v => window.__atmos.state.set({ value: v }), value);
  const file = path.join(installRoot, 'extension-state', 'plugin-state-probe.json');

  await set('first');
  await wait(1000);
  r.first = savedFrameState(installRoot, 'plugin', 'state-probe')?.value ?? null;

  // The next write fails: a directory where its temporary file goes.
  const blocked = `${file}.${app.process().pid}.tmp`;
  fs.mkdirSync(blocked);
  await set('second');
  await wait(1000);
  r.whileBlocked = savedFrameState(installRoot, 'plugin', 'state-probe')?.value ?? null;
  fs.rmSync(blocked, { recursive: true, force: true });

  // Writable again; Atmos quits soon after (before any later change).
  await app.close();
  r.afterQuit = savedFrameState(installRoot, 'plugin', 'state-probe')?.value ?? null;
  r.ok = r.first === 'first' && r.whileBlocked === 'first' && r.afterQuit === 'second';
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });

// The SDK contract in a real Atmos: scripts/sdk-contract/contract.js run in
// the panels of two developer folders, one declaring the system services
// and notifications and one declaring nothing, compared with
// scripts/sdk-contract/expected.json and with the fake Atmos running the same
// script (scripts/sdk-contract.test.mjs checks the fake alone).
// Usage: node scripts/e2e/contract.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'contract'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-contract-');
const contractFile = path.join(repo, 'scripts', 'sdk-contract', 'contract.js');
const expected = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'sdk-contract', 'expected.json'), 'utf8'));

const PERMISSIONS = {
  all: { invokes: ['service:audio', 'service:wallpaper', 'service:location', 'service:now-playing'], browser: ['notifications'] },
  none: {},
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 20000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(every);
  }
}

/** Where two reports differ: ["audio.state.id: expected string, got undefined", …]. */
function differences(want, got, at = '') {
  if (JSON.stringify(want) === JSON.stringify(got)) return [];
  if (want && got && typeof want === 'object' && typeof got === 'object' && !Array.isArray(want)) {
    return [...new Set([...Object.keys(want), ...Object.keys(got)])].flatMap(key => differences(want[key], got[key], at ? `${at}.${key}` : key));
  }
  return [`${at}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

(async () => {
  // Two developer folders whose panels run the contract.
  const dev = path.join(home, 'dev');
  for (const declared of ['all', 'none']) {
    const folder = path.join(dev, `contract-${declared}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'extension.json'), JSON.stringify({
      apiVersion: 4, engines: { atmos: '>=0.16.0' }, version: '0.1.0', displayName: `Contract ${declared}`,
      contributes: { panel: { label: `Contract ${declared}` } }, permissions: PERMISSIONS[declared],
    }, null, 2));
    fs.copyFileSync(contractFile, path.join(folder, 'contract.js'));
    fs.writeFileSync(path.join(folder, 'panel.js'), [
      "import atmos from 'atmos-sdk';",
      "import { runContract } from './contract.js';",
      `window.__contract = await runContract(atmos, { declared: '${declared}' }).catch(error => ({ crashed: String(error?.stack || error) }));`,
      "document.body.textContent = 'contract done';",
    ].join('\n'));
  }
  const noBundled = path.join(home, 'no-bundled');
  fs.mkdirSync(noBundled);

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${noBundled}`, `--dev-extension=${path.join(dev, 'contract-all')}`, `--dev-extension=${path.join(dev, 'contract-none')}`,
      '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    cwd: repo, env,
  });
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  const frameFor = (ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`));

  const { createFakeAtmos } = await import(pathToFileURL(path.join(repo, 'core', 'js', 'sdk', 'testing', 'fake-atmos.mjs')).href);
  const { runContract } = await import(pathToFileURL(contractFile).href);
  const r = { home };
  for (const declared of ['all', 'none']) {
    const id = `contract-${declared}`;
    await page.evaluate(async panelId => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin(panelId), id);
    const frame = await until(async () => frameFor(`plugin:${id}`, 'panel'));
    const runtime = frame ? await until(() => frame.evaluate(() => window.__contract), { timeout: 30000 }) : null;
    const quiet = console.error;
    console.error = () => {};
    const fake = await runContract(createFakeAtmos({ extension: { id }, permissions: PERMISSIONS[declared] }), { declared });
    console.error = quiet;
    r[declared] = {
      runtimeMatchesExpected: differences(expected[declared], runtime),
      fakeMatchesExpected: differences(expected[declared], fake),
      runtimeMatchesFake: differences(fake, runtime),
    };
    fs.writeFileSync(path.join(out, `${declared}-runtime.json`), JSON.stringify(runtime, null, 2));
    fs.writeFileSync(path.join(out, `${declared}-fake.json`), JSON.stringify(fake, null, 2));
  }
  await page.screenshot({ path: path.join(out, 'contract.png') });
  r.errors = errors;
  await app.close();
  console.log(JSON.stringify(r, null, 2));
})().catch(error => { console.error(error); process.exit(1); });

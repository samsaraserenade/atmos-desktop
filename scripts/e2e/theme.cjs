// Atmos's theme beyond its own panels: with the wallpaper removed, what's
// behind everything is the theme's workspace colour (light with Atmos
// Light, not black); and Chromium's light or dark (web pages' and frames'
// prefers-color-scheme) follows the theme, not the system.
// Usage: node scripts/e2e/theme.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'theme'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-theme-');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = { home, checks: {}, details: {} };
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (!ok && detail !== undefined) report.details[name] = detail;
};

(async () => {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env,
    // Playwright emulates a light prefers-color-scheme by default; Atmos's own is what's checked.
    colorScheme: 'no-override' });
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 45000 });
  await wait(1500);
  try {
    const theme = id => page.evaluate(async value => (await import('atmos-core/core/appearance.js')).setAppTheme(value), id);
    const colours = () => page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      behindImage: getComputedStyle(document.querySelector('.wallpaper-image')).backgroundColor,
      image: document.querySelector('.wallpaper-image')?.style.backgroundImage,
      pageDark: matchMedia('(prefers-color-scheme: dark)').matches,
      panelGlass: (() => {
        const probe = document.createElement('div');
        probe.className = 'atmos-frame-glass';
        probe.dataset.material = 'panel';
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      })(),
    }));
    await page.evaluate(async () => (await import('./system/wallpaper/engine.js')).removeWallpaper());
    await wait(400);
    await theme('atmos-light');
    await wait(400);
    const light = await colours();
    const native = await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
    await page.screenshot({ path: path.join(out, '01-light-no-wallpaper.png') });
    check('no wallpaper with Atmos Light: light behind everything, not black', light.image === 'none' && light.body === 'rgb(228, 229, 233)' && light.behindImage === 'rgb(228, 229, 233)', light);
    check('Atmos Light tints panels\' glass white, not black (its ink is dark)', /^(color\(srgb 0\.98|rgba?\(250, 250, 252)/.test(light.panelGlass), light.panelGlass);
    check('Atmos Light makes Chromium light (pages, frames, dialogs)', native.source === 'light' && !native.dark && !light.pageDark, { native, light });
    await theme('atmos-dark');
    await wait(400);
    const dark = await colours();
    const nativeDark = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    check('and Atmos Dark: near-black, dark pages, black glass', /^(color\(srgb 0 0 0|rgba?\(0, 0, 0)/.test(dark.panelGlass) && dark.body === 'rgb(5, 5, 6)' && dark.pageDark && nativeDark === 'dark', { dark, nativeDark });
    await theme('amoled');
    await wait(400);
    const amoled = await colours();
    check('and AMOLED Black: black', amoled.body === 'rgb(0, 0, 0)' && amoled.pageDark, amoled);
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
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(passed === total && !report.error && total > 0 ? 0 : 1);
})();

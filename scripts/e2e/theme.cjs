// Atmos's theme beyond its own panels: with the wallpaper removed, what's
// behind everything is the theme's workspace colour (light with Atmos
// Light, not black), and so is the window's own background; and Chromium's
// light or dark (web pages' and frames' prefers-color-scheme) follows the
// theme, not the system. Then the see-through window's end (0.24): no
// See-through, Transparent Window or Opacity in Settings, nothing on the
// page's bridge for them, and a wallpaper saved by 0.23 migrated (removed
// stays removed; See-through at 0% after a new image shows that image).
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
    // The Atmos window's own background (what shows before the page paints).
    const windowColour = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(win => win.webContents.getURL().startsWith('atmos-app://local/'))?.getBackgroundColor()?.toLowerCase());
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
    const lightWindow = await windowColour();
    check('the window itself is opaque, in Atmos Light\'s workspace colour', lightWindow === '#e4e5e9', lightWindow);
    await theme('atmos-dark');
    await wait(400);
    const dark = await colours();
    const nativeDark = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    check('and Atmos Dark: near-black, dark pages, black glass', /^(color\(srgb 0 0 0|rgba?\(0, 0, 0)/.test(dark.panelGlass) && dark.body === 'rgb(5, 5, 6)' && dark.pageDark && nativeDark === 'dark', { dark, nativeDark });
    const darkWindow = await windowColour();
    check('and the window in Atmos Dark\'s', darkWindow === '#050506', darkWindow);
    await theme('amoled');
    await wait(400);
    const amoled = await colours();
    check('and AMOLED Black: black', amoled.body === 'rgb(0, 0, 0)' && amoled.pageDark, amoled);
    await theme('atmos-dark');

    // No see-through window: nothing in Settings → Appearance or on the page's bridge for it.
    await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
    await page.evaluate(() => [...document.querySelectorAll('#settings-menu .sm-nav-item')].find(item => /Appearance/.test(item.textContent))?.click());
    let settings = null;
    for (let tries = 0; tries < 50 && !settings; tries++) {
      settings = await page.evaluate(() => {
        const status = document.querySelector('.wallpaper-image-status');
        if (!status) return null;
        const menu = document.querySelector('#settings-menu');
        return {
          image: status.textContent,
          seeThrough: /See-through|Transparent Window/i.test(menu.textContent),
          modeButtons: menu.querySelectorAll('[data-wallpaper-mode]').length,
          windowToggle: !!menu.querySelector('.wallpaper-window-effects'),
          sliders: [...menu.querySelectorAll('[data-wallpaper-key]')].map(slider => slider.dataset.wallpaperKey),
          bridge: ['getWindowEffects', 'setTransparentWindow', 'setWindowClickThrough', 'beginWindowResize'].filter(name => name in (window.atmosCore || {})),
        };
      });
      if (!settings) await wait(200);
    }
    await page.evaluate(() => {
      const status = document.querySelector('.wallpaper-image-status');
      status?.closest('.sa-row')?.parentElement?.querySelector('details.sa-details')?.setAttribute('open', '');
      status?.scrollIntoView({ block: 'start' });
    });
    await wait(300);
    await page.screenshot({ path: path.join(out, '02-appearance-wallpaper.png') });
    await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());
    check('Settings → Appearance → Wallpaper: no See-through, no Transparent Window, no Opacity', settings && settings.image === 'None'
      && !settings.seeThrough && settings.modeButtons === 0 && !settings.windowToggle
      && !settings.sliders.includes('opacity') && settings.sliders.includes('vignette'), settings);
    check('the page\'s bridge has no window-effects, click-through or resize calls', settings && settings.bridge.length === 0, settings?.bridge);
    const deprecated = await page.evaluate(async () => {
      const engine = await import('./system/wallpaper/engine.js');
      engine.setState({ mode: 'transparent', opacity: 0 });
      const state = engine.getState();
      let typo = null;
      try { engine.setState({ mode: 'see-through' }); } catch (error) { typo = error.name; }
      return { mode: state.mode, opacity: state.opacity, kind: engine.imageKind(), typo };
    });
    check('mode \'transparent\' (and an opacity) still taken, and change nothing; an unknown mode still refused',
      deprecated.mode === 'wallpaper' && deprecated.opacity === 100 && deprecated.kind === 'none' && deprecated.typo === 'TypeError', deprecated);

    // A wallpaper as Atmos 0.23 saved it (version 2), then a restart (a reload).
    const after023 = async data => {
      await page.evaluate(async wallpaper => {
        (await import('atmos-core/persist.js')).save();
        const blob = JSON.parse(localStorage.getItem('samsara_v4') || '{}');
        blob.extensionState = { ...(blob.extensionState || {}), wallpaper: { version: 2, data: wallpaper } };
        localStorage.setItem('samsara_v4', JSON.stringify(blob));
        // As 0.23 left it on disk: the page going away saves its own state,
        // so nothing more is written to it until the reload.
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) { if (key !== 'samsara_v4') setItem.call(this, key, value); };
      }, data);
      await page.reload();
      await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 45000 });
      await wait(800);
      return page.evaluate(async () => {
        const engine = await import('./system/wallpaper/engine.js');
        const state = engine.getPersistentState();
        return { removed: state.wallpaperRemoved, kind: engine.imageKind(), vignette: state.vignette,
          image: document.querySelector('.wallpaper-image')?.style.backgroundImage, body: getComputedStyle(document.body).backgroundColor };
      });
    };
    const removed = await after023({ mode: 'transparent', opacity: 0, wallpaperRemoved: true, vignette: 33 });
    check('0.23\'s Remove (See-through at 0%, removed) stays removed: the workspace colour, its other settings kept',
      removed.removed === true && removed.kind === 'none' && removed.image === 'none' && removed.body === 'rgb(5, 5, 6)' && removed.vignette === 33, removed);
    const chosenAfter = await after023({ mode: 'transparent', opacity: 0, wallpaperRemoved: false });
    check('an image chosen after a Remove (See-through at 0%, not removed) shows',
      chosenAfter.removed === false && chosenAfter.kind === 'default' && /atmos-background\.jpg/.test(chosenAfter.image || ''), chosenAfter);
    const beforeFlag = await after023({ mode: 'transparent', opacity: 0, vignette: 12 });
    check('See-through at 0% saved before the removed flag existed is removed', beforeFlag.removed === true && beforeFlag.kind === 'none' && beforeFlag.vignette === 12, beforeFlag);
    const stored = await page.evaluate(async () => {
      (await import('atmos-core/persist.js')).save();
      return JSON.parse(localStorage.getItem('samsara_v4')).extensionState.wallpaper;
    });
    check('saved again as version 3, with no mode or opacity', stored.version === 3 && !('mode' in stored.data) && !('opacity' in stored.data) && stored.data.wallpaperRemoved === true, stored);
    await page.screenshot({ path: path.join(out, '03-after-migration.png') });
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

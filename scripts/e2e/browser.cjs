// Atmos Browser end to end: the browser plugin (plugins/browser) on Core's
// web layer (web-host.cjs, web-layer.js, web-policy.cjs), against local test
// pages over http and https (browser-pages.cjs; the https server's
// certificate isn't trusted). Real input where it matters (xinput.py: X
// clicks and keys, as the OS would send them), so this needs an X display:
// xvfb-run -a on a machine without one.
//
// Browsing, the address bar, tabs and their shortcuts, pop-ups (only after
// a click, one each; one with an opener, as a sign-in window has), downloads
// (more than one without a click stopped), a permission prompt (no answer
// the moment it appears; a frame's request is the page's), links to other
// programs, the certificate interstitial and client certificates, mixed
// content, fullscreen (a tab's only), Atmos's menus, Settings and Task View
// over a page, switching panels and layouts, private tabs' cookies, pages
// put away, the hostile page (Atmos's own IPC refused to it), links from the
// rest of Atmos, and tabs restored after a restart.
//
// Usage: node scripts/e2e/browser.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');
const { startPages } = require('./browser-pages.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'browser'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });

const report = { checks: {}, details: {} };
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (detail !== undefined) report.details[name] = detail;
  if (!ok) console.error(`[browser e2e] FAILED: ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A promise, or 'timeout' after `ms` (a page waiting on a prompt nobody answers mustn't hang the run). */
const within = (promise, ms = 8000) => Promise.race([promise, wait(ms).then(() => 'timeout')]);
const step = name => console.error(`[browser e2e] ${new Date().toISOString().slice(11, 19)} ${name}`);
async function until(fn, { timeout = 10000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(every);
  }
}

// Local pages only: no proxy for the browser (a proxy couldn't reach them).
const iso = isolatedEnv('atmos-browser-');
for (const name of Object.keys(iso.env)) if (/^(https?|all|no)_proxy$/i.test(name)) delete iso.env[name];
const downloads = path.join(iso.home, 'Downloads');
fs.mkdirSync(downloads, { recursive: true });
// The ad blocker's lists, instead of downloading uBlock Origin's and EasyList
// (--browser-filter-lists): small ones for the test pages' hosts.
const filterLists = path.join(iso.home, 'filter-lists');
fs.mkdirSync(filterLists, { recursive: true });
fs.writeFileSync(path.join(filterLists, 'ublock-filters.txt'), [
  '! Title: uBlock filters (e2e)', '||ads.test^$third-party', 'alpha.test##+js(set-constant, adblockTest, true)',
  '*$removeparam=utm_source', 'beta.test##+js(trusted-set-constant, fromUblock, 42)',
  // X's lines in uBlock Origin's privacy list, in its order: the second
  // stops the first replacing Function.prototype.toString, which X checks.
  'alpha.test##+js(prevent-xhr, /never-requested)', 'alpha.test##+js(proxy-apply-config, {"skipToString":true})',
  // One uBlock Origin runs in its content script's world (rewriting an
  // inline script, as its YouTube rules do), and an argument with a "%".
  "alpha.test##+js(trusted-rpnt, script, /__rewritten = 'no'/, __rewritten = 'yes')", 'alpha.test##+js(trusted-set-constant, __pct, json:"50%")', '',
].join('\n'));
fs.writeFileSync(path.join(filterLists, 'easylist.txt'), [
  '[Adblock Plus 2.0]', '! Title: EasyList (e2e)', '##.ad-slot', '###banner-ad', 'alpha.test##.sponsored',
  '||pixel.test^$image', '||tracker.test^$script,redirect=noop.js', 'beta.test##+js(trusted-set-constant, fromEasylist, 42)', '',
].join('\n'));

/** Real X input: one python process, one command a line. */
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
    click: (x, y, button = 1) => send(`click ${Math.round(x)} ${Math.round(y)} ${button}`),
    move: (x, y) => send(`move ${Math.round(x)} ${Math.round(y)}`),
    key: combo => send(`key ${combo}`),
    type: text => send(`type ${text}`),
    close: () => proc.kill(),
  };
}

const W = 1280, H = 800;
function grab(name) {
  const file = path.join(out, `${name}.png`);
  execFileSync('import', ['-silent', '-window', 'root', '-crop', `${W}x${H}+0+0`, '+repage', file]);
  return file;
}
/** A pixel of the X screen, as [r, g, b]. */
function pixel(x, y) {
  const text = execFileSync('import', ['-silent', '-window', 'root', '-crop', `1x1+${Math.round(x)}+${Math.round(y)}`, '+repage', '-depth', '8', 'txt:-']).toString();
  const match = text.match(/\((\d+),(\d+),(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}
const near = (a, b, tolerance = 24) => !!a && !!b && a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
const hex = value => [0, 2, 4].map(at => parseInt(value.slice(at, at + 2), 16));

async function launch(extra = []) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    // E2E_ELECTRON_ARGS: more switches, e.g. "--use-angle=swiftshader --enable-unsafe-swiftshader"
    // for GPU compositing (in software) where there's no GPU, instead of Chromium's software compositor.
    args: [repo, '--no-sandbox', '--host-resolver-rules=MAP *.test 127.0.0.1, MAP *.test.example 127.0.0.1', `--browser-downloads=${downloads}`,
      `--browser-filter-lists=${filterLists}`,
      ...(process.env.E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean), ...extra],
    cwd: repo,
    env: iso.env,
  });
  const logs = [];
  app.process().stdout.on('data', data => logs.push(String(data)));
  app.process().stderr.on('data', data => logs.push(String(data)));
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 45000 });
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    win.setBounds({ x: 0, y: 0, width, height });
  }, [W, H]);
  await wait(500);
  return { app, page, logs, errors };
}

// A run that hangs still says how far it got.
setTimeout(() => {
  report.error = report.error || 'timed out';
  report.failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}, 12 * 60 * 1000).unref();

(async () => {
  const pages = await startPages();
  const A = pages.http('alpha.test');
  const B = pages.http('beta.test');
  const LOCAL = pages.http('localhost');
  const input = xinput();
  // A first start opens the sidebar with the browser's tabs open
  // (sidebar-state.js), checked in a launch of its own: the rest was written
  // for the panel at the window's width, and with the sidebar open as Atmos
  // started, a page's HTML fullscreen came out the sidebar's width short,
  // centred between black bars, for that whole session (under Xvfb; see
  // HANDOFF). Closed here, it stays closed for the launches below.
  {
    const first = await launch();
    const shown = await until(() => first.page.evaluate(() => document.body.classList.contains('drawer-open')
      && document.getElementById('fin-section-browser')?.classList.contains('open') === true), { timeout: 15000 });
    check('a first start opens the sidebar on the browser\'s tabs', !!shown);
    await first.page.evaluate(async () => {
      (await import('atmos-core/core/sidebar-shell.js')).closeSidebar();
      (await import('atmos-core/persist.js')).flushPendingSave();
    });
    await first.app.close();
  }
  let session = await launch();
  let { app, page } = session;
  // How Chromium draws here (a page's look over Atmos depends on it).
  report.details.gpu = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus()).catch(error => String(error));
  // Under Xvfb there's no window manager to give the Atmos window the X
  // keyboard focus when it's clicked, so the check does before real input.
  const focusWindow = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    if (win && !win.isFocused()) win.focus();
  }).catch(() => {});
  const x = {
    click: async (...args) => { await focusWindow(); return input.click(...args); },
    move: (...args) => input.move(...args),
    key: combo => input.key(combo),
    type: text => input.type(text),
    close: () => input.close(),
  };

  const panelFrame = () => page.frames().find(f => f.url().includes('ext=plugin%3Abrowser') && f.url().includes('surface=panel'));
  const panel = () => until(async () => {
    const frame = panelFrame();
    return frame && await frame.evaluate(() => !!window.__browserPanel) ? frame : null;
  }, { timeout: 15000 });
  const engine = async (fn, arg) => (await panel()).evaluate(new Function('arg', `const engine = window.__browserPanel.engine; return (${fn})(engine, arg);`), arg);
  const selected = () => engine(e => e.selected());
  /** The selected tab is `title`, with its page loaded and showing (a reopened tab has its title before its page). */
  const settled = (title, timeout = 8000) => until(async () => {
    const tab = await selected();
    return tab.title === title && tab.live && !tab.loading;
  }, { timeout });
  const tabs = () => engine(e => e.tabs().map(t => ({ id: t.id, url: t.url, title: t.title, kind: t.kind, live: t.live, selected: t.selected, private: t.private })));
  const registry = fn => page.evaluate(new Function(`return (async () => { const registry = await import('atmos-core/core/panel-registry.js'); return (${fn})(registry); })()`));
  const guests = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getType() === 'webview').map(w => ({ id: w.id, url: w.getURL() })));
  // Script in a tab's page, run from the main process as if the user acted (user gesture).
  const inPage = (prefix, code) => app.evaluate(async ({ webContents }, [start, source]) => {
    const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith(start));
    if (!contents) throw new Error(`no page at ${start}`);
    return contents.executeJavaScript(source, true);
  }, [prefix, code]);
  const layerBox = () => page.evaluate(() => {
    const layer = document.querySelector('.atmos-web-layer');
    if (!layer || layer.style.display === 'none' || layer.style.visibility === 'hidden') return null;
    const box = layer.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  });
  /**
   * A real click on an element of a tab's page, as the user's: its box from
   * the page, the page's place from the layer (near its left edge: a link
   * spans the page's width).
   */
  const clickIn = async (prefix, selector) => {
    const rect = JSON.parse(await inPage(prefix, `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
    const layer = await layerBox();
    await x.click(layer.x + rect.x + Math.min(rect.width / 2, 60), layer.y + rect.y + rect.height / 2);
  };
  /**
   * Watch, from the panel, for `selector` to appear and click its `label`
   * button at once (as a click the user was already making would land):
   * resolves whether it was still showing just after.
   */
  const clickAsItAppears = (selector, label) => panel().then(frame => frame.evaluate(([sel, text]) => new Promise(resolve => {
    const started = performance.now();
    const tick = () => {
      const element = document.querySelector(sel);
      const button = element && !element.hidden ? [...element.querySelectorAll('button')].find(b => b.textContent === text) : null;
      if (button) {
        button.click();
        setTimeout(() => resolve({ stillShown: !element.hidden, at: Math.round(performance.now() - started) }), 120);
        return;
      }
      if (performance.now() - started > 6000) resolve({ stillShown: null, at: 'never appeared' });
      else setTimeout(tick, 5);
    };
    tick();
  }), [selector, label]));
  /**
   * A real click on one of the panel's buttons (a prompt's, a notice's), as
   * the user's: the pointer moves onto it, then clicks. Returns whether
   * the button was there.
   */
  const clickPanelButton = async (selector, label) => {
    const point = await (await panel()).evaluate(([sel, text]) => {
      const button = [...document.querySelectorAll(`${sel} button`)].find(b => b.textContent === text);
      if (!button || button.closest('[hidden]')) return null;
      const box = button.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, [selector, label]);
    if (!point) return false;
    const frame = await page.evaluate(() => {
      const element = [...document.querySelectorAll('iframe')].find(f => f.src.includes('ext=plugin%3Abrowser') && f.src.includes('surface=panel'));
      const box = element.getBoundingClientRect();
      return { x: box.left, y: box.top };
    });
    await x.move(frame.x + point.x - 30, frame.y + point.y + 25);
    await wait(80);
    await x.move(frame.x + point.x - 2, frame.y + point.y);
    await wait(80);
    await x.click(frame.x + point.x, frame.y + point.y);
    return true;
  };
  const atmosWindowDo = fn => app.evaluate(({ BrowserWindow }, source) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/index.html'));
    return new Function('win', `return (${source})(win)`)(win);
  }, fn.toString());
  const go = async url => {
    const result = await engine((e, target) => e.navigate(e.selectedId(), target), url);
    await until(async () => { const tab = await selected(); return tab.url.startsWith(url.split('#')[0]) && !tab.loading; }, { timeout: 8000 });
    await wait(300);
    return result;
  };

  const partitionDir = path.join(iso.installRoot, 'Partitions', 'atmos-browser');
  try {
    // ── The panel ─────────────────────────────────────────────────────────
    step('the panel');
    await wait(1500); // the browser's engine (its boot frame) is running
    check('before its first page, the browser has no session (nothing on disk)', !fs.existsSync(partitionDir));
    // Built in since 0.18 (core/built-in-extensions.json): Atmos opens on the
    // browser. Its key is tried from another panel, below.
    check('Atmos opens on the browser (built in)', await registry(r => r.getActivePanelPluginId()) === 'browser');
    const frame = await panel();
    check('the browser\'s panel is up', !!frame);
    const first = await selected();
    check('a first start has one new-tab page', first?.kind === 'new', first);
    check('the address bar has the keyboard on a new tab', await (await panel()).evaluate(() => document.activeElement?.classList.contains('br-address-input')));
    await wait(400);
    grab('01-new-tab');

    // ── The address bar ───────────────────────────────────────────────────
    step('the address bar');
    await page.keyboard.type(`${A.replace('http://', '')}/solid?title=Alpha&color=1d4ed8`);
    await wait(400);
    const suggestionsShown = await (await panel()).evaluate(() => !document.querySelector('.br-suggestions').hidden && document.querySelectorAll('.br-suggestion').length);
    check('typing shows suggestions', suggestionsShown >= 2, suggestionsShown);
    grab('02-suggestions');
    // The suggestions draw over the page area: the frame keeps them (not clipped).
    const surface = JSON.parse(await (await panel()).evaluate(() => window.__browserPanel.reportSurface() || '{}'));
    check('the suggestions are drawn over the page (an "over" rectangle)', (surface.over || []).length >= 1, surface.over);
    await page.keyboard.press('Enter');
    await settled('Alpha', 8000);
    await wait(500);
    let tab = await selected();
    check('an address typed without http goes there (http for a local name with a port)', tab.url === `${A}/solid?title=Alpha&color=1d4ed8`, tab.url);
    check('the title and the site icon arrive', tab.title === 'Alpha' && /^data:image\/png/.test(tab.favicon || ''), { title: tab.title, favicon: (tab.favicon || '').slice(0, 30) });
    // The site's 16×16 icon, decoded apart from the browser's frames and drawn again by Core: a 32×32 PNG.
    const iconPng = Buffer.from(String(tab.favicon || '').split(',')[1] || '', 'base64');
    const iconSize = iconPng.length > 24 ? [iconPng.readUInt32BE(16), iconPng.readUInt32BE(20)] : null;
    check('…decoded apart, in a page of its own, and drawn again by Core', !!iconSize && iconSize[0] === 32 && iconSize[1] === 32, iconSize);
    check('Back goes nowhere from the first page', tab.canGoBack === false);
    const box = await layerBox();
    check('the page shows in the panel, below its toolbar', !!box && box.y > 80 && box.width > 1200, box);
    check('the page is what shows there', near(pixel(640, 500), hex('1d4ed8')), pixel(640, 500));
    grab('03-page');

    // Search, and an address refused before anything loads.
    await engine(e => e.navigate(e.selectedId(), 'atmos browser test'));
    await wait(300);
    tab = await selected();
    check('words search with the default engine (DuckDuckGo)', tab.url === 'https://duckduckgo.com/?q=atmos%20browser%20test', tab.url);
    await go(`${A}/solid?title=Alpha&color=1d4ed8`);
    const refusedJs = await engine(e => e.navigate(e.selectedId(), 'javascript:document.title="pwned"'));
    await wait(300);
    tab = await selected();
    check('javascript: typed into the address bar is refused', refusedJs.ok === false && tab.title === 'Alpha' && /script/.test(tab.notice?.text || ''), { refusedJs, notice: tab.notice });
    const refusedFile = await engine(e => e.navigate(e.selectedId(), 'file:///etc/passwd'));
    check('file: typed into the address bar is refused', refusedFile.ok === false, refusedFile);
    const refusedApp = await engine(e => e.navigate(e.selectedId(), 'atmos-app://local/index.html'));
    await wait(300);
    tab = await selected();
    check('atmos-app: typed into the address bar is refused by Core', refusedApp.ok === false && tab.url.startsWith(A), { refusedApp, url: tab.url });
    grab('04-refused-notice');

    // Links, back and forward, history.
    await inPage(`${A}/solid`, 'document.getElementById("link").click()');
    await settled('Linked');
    tab = await selected();
    check('a link navigates the tab', tab.title === 'Linked' && tab.canGoBack, tab);
    await engine(e => e.back(e.selectedId()));
    await settled('Alpha');
    await engine(e => e.forward(e.selectedId()));
    await settled('Linked');
    check('back and forward', (await selected()).title === 'Linked');
    const history = await engine(e => e.history.search('').then(list => list.map(item => item.title)));
    check('history keeps the pages visited', history.includes('Alpha') && history.includes('Linked'), history);
    check('failed pages and refused addresses aren’t in history', !history.some(title => /pwned|passwd/.test(title)), history);

    // ── Tabs and shortcuts, with the keyboard in the page ──────────────────
    step('tabs and shortcuts');
    const page1 = await layerBox();
    await x.click(page1.x + 600, page1.y + 400);
    await wait(200);
    await x.key('ctrl+t');
    // Under Xvfb a real key is now and then lost before the window has settled: once more.
    if (!await until(async () => (await tabs()).length === 2, { timeout: 3000 })) {
      report.details.retriedCtrlT = true;
      await x.click(page1.x + 600, page1.y + 400);
      await wait(300);
      await x.key('ctrl+t');
    }
    await until(async () => (await tabs()).length === 2);
    check('Ctrl+T in a page opens a new tab', (await selected()).kind === 'new');
    check('…with the address bar ready', await (await panel()).evaluate(() => document.activeElement?.classList.contains('br-address-input')));
    await x.type(`${B.replace('http://', '')}/solid?title=Beta&color=b91c1c`);
    await x.key('Return');
    await settled('Beta', 8000);
    await wait(300);
    await x.click(page1.x + 600, page1.y + 400);
    await x.key('ctrl+Tab');
    await wait(400);
    check('Ctrl+Tab goes to the next tab (round the end)', (await selected()).title === 'Linked');
    await x.click(page1.x + 600, page1.y + 400);
    await x.key('ctrl+w');
    await wait(500);
    check('Ctrl+W closes the tab', (await tabs()).length === 1 && (await selected()).title === 'Beta');
    await x.click(page1.x + 600, page1.y + 400);
    await x.key('ctrl+T');
    await until(async () => (await tabs()).length === 2);
    await settled('Linked', 8000);
    check('Ctrl+Shift+T reopens it', (await selected()).title === 'Linked');
    await x.click(page1.x + 600, page1.y + 400);
    await wait(300);
    await x.key('ctrl+l');
    const addressFocused = await until(async () => (await panel()).evaluate(() => document.activeElement?.classList.contains('br-address-input')), { timeout: 3000 });
    check('Ctrl+L puts the keyboard in the address bar', addressFocused, await (await panel()).evaluate(() => [document.activeElement?.tagName, document.activeElement?.className, document.hasFocus()]));
    await x.key('Escape');
    // Typing in a page: Atmos's own single keys stay in the page.
    await go(`${A}/solid?title=Typing&color=1d4ed8`);
    const field = JSON.parse(await inPage(`${A}/solid`, 'JSON.stringify(document.getElementById("field").getBoundingClientRect())'));
    const layer = await layerBox();
    await x.click(layer.x + field.x + 20, layer.y + field.y + 10);
    await wait(200);
    // The sidebar is open on a first start (the browser's tabs); Tab in a page mustn't toggle it.
    const sidebarBefore = await page.evaluate(() => document.body.classList.contains('drawer-open'));
    await x.type('a[b]c`d');
    await x.key('Tab');
    await wait(400);
    const typed = JSON.parse(await inPage(`${A}/solid`, 'JSON.stringify({ keys: __keys, value: document.getElementById("field").value })'));
    const stillBrowser = await registry(r => r.getActivePanelPluginId());
    const sidebarOpen = await page.evaluate(() => document.body.classList.contains('drawer-open'));
    check('keys typed in a page reach the page, Atmos\'s single-key shortcuts never fire', typed.value === 'a[b]c`d' && typed.keys.includes('Tab') && stillBrowser === 'browser' && sidebarOpen === sidebarBefore, { typed, stillBrowser, sidebarBefore, sidebarOpen });
    // Zoom, per site.
    await x.key('ctrl+equal');
    await wait(400);
    const zoomed = (await selected()).zoom;
    await engine((e, url) => e.newTab({ url }), `${A}/solid?title=Same%20site`);
    await settled('Same site');
    await wait(300);
    const sameSite = (await selected()).zoom;
    check('Ctrl+= zooms the page, and the site keeps it', zoomed === 1.1 && sameSite === 1.1, { zoomed, sameSite });
    await engine(e => e.zoom(e.selectedId(), 'reset'));
    await engine(e => e.closeTab(e.selectedId()));
    // Find in page.
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Typing').id));
    await wait(300);
    await x.click(layer.x + 600, layer.y + 400);
    await x.key('ctrl+f');
    await wait(300);
    await page.keyboard.type('findme');
    await until(async () => (await selected()).find?.matches === 3);
    await page.keyboard.press('Enter');
    await wait(400);
    tab = await selected();
    check('Ctrl+F finds in the page', tab.find?.matches === 3 && tab.find?.active === 2, tab.find);
    grab('05-find');
    await page.keyboard.press('Escape');

    // ── Pop-ups ───────────────────────────────────────────────────────────
    // Only just after a click or key in the page, one each (Chrome's pop-up
    // blocker; Electron has none). The clicks here are real ones.
    step('pop-ups');
    await go(`${A}/links`);
    let before = (await tabs()).length;
    // Without a click: blocked, and the browser says so (its Open takes no click at once).
    const earlyOpen = clickAsItAppears('[data-test="notice"]', 'Open');
    await inPage(`${A}/links`, 'setTimeout(() => { window.__unasked = window.open("/solid?title=Unasked&color=dc2626") === null; }, 50); true');
    const early = await earlyOpen;
    const blockedNotice = (await selected()).notice;
    check('a pop-up without a click is blocked, and the browser says so, with Open', /Pop-up blocked/.test(blockedNotice?.text || '') && blockedNotice.actions?.[0]?.label === 'Open'
      && (await tabs()).length === before && await inPage(`${A}/links`, 'window.__unasked') === true, { blockedNotice, tabs: (await tabs()).length });
    check('…whose Open takes no click the moment it appears (the page chose the moment)', early.stillShown === true && (await tabs()).length === before, early);
    grab('05a-popup-blocked');
    await wait(650);
    await clickPanelButton('[data-test="notice"]', 'Open');
    await until(async () => (await selected()).title === 'Unasked', { timeout: 5000 });
    check('…and a moment later, Open opens it', (await selected()).title === 'Unasked', await tabs());
    await engine(e => e.closeTab(e.selectedId()));
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);
    // Always allow: the site's pop-ups open without a click from then on (its setting, to take back in Settings).
    await inPage(`${A}/links`, 'setTimeout(() => window.open("/solid?title=Unasked%20again&color=dc2626"), 50); true');
    await until(async () => /Pop-up blocked/.test((await selected()).notice?.text || ''), { timeout: 4000 });
    await wait(650);
    await clickPanelButton('[data-test="notice"]', 'Always allow');
    const allowedSetting = await until(async () => (await engine(e => e.sitePermissions())).find(item => item.origin === A && item.name === 'popups'), { timeout: 3000 });
    await inPage(`${A}/links`, 'setTimeout(() => window.open("/solid?title=Allowed&color=0891b2"), 50); true');
    const allowedTab = await until(async () => (await tabs()).find(t => t.title === 'Allowed'), { timeout: 5000 });
    check('…and Always allow lets the site open pop-ups without a click, kept as its setting', !!allowedTab && allowedSetting?.value === 'allow'
      && !(await tabs()).some(t => t.title === 'Unasked again'), { allowedSetting, tabs: (await tabs()).map(t => t.title) });
    if (allowedTab) await engine((e, id) => e.closeTab(id), allowedTab.id);
    await engine((e, origin) => e.setSitePermission(origin, 'popups', null), A);
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);
    before = (await tabs()).length;
    // With a click.
    await clickIn(`${A}/links`, '#blank');
    await until(async () => (await tabs()).length === before + 1 && (await selected()).title === 'Blank target');
    check('target=_blank opens a tab (a real click)', (await selected()).title === 'Blank target', await tabs());
    await engine(e => e.closeTab(e.selectedId()));
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);
    await clickIn(`${A}/links`, '#open-plain');
    await until(async () => (await tabs()).length === before + 1 && (await selected()).title === 'Opened');
    check('window.open without features opens a tab', (await selected()).title === 'Opened', await tabs());
    await engine(e => e.closeTab(e.selectedId()));
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);
    // One click, two pop-ups asked for: the first.
    await clickIn(`${A}/links`, '#open-two');
    await until(async () => (await tabs()).some(t => t.title === 'First of two'), { timeout: 5000 });
    await wait(800);
    const linksTab = (await engine(e => e.tabs())).find(t => t.title === 'Links');
    check('one click opens one pop-up (the second it asked for is blocked, and said so)', (await tabs()).length === before + 1
      && !(await tabs()).some(t => t.title === 'Second of two') && /Pop-up blocked/.test(linksTab?.notice?.text || ''), { tabs: (await tabs()).map(t => t.title), notice: linksTab?.notice });
    await engine(e => e.closeTab(e.tabs().find(t => t.title === 'First of two').id));
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await engine(e => e.dismissNotice(e.selectedId()));
    await wait(400);
    // A click in a frame of another site (its own process: Electron reports its mouse too).
    const frameProcess = await app.evaluate(({ webContents }, start) => {
      const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith(start));
      const frame = contents.mainFrame.frames.find(f => f.url.includes('/frame-open'));
      return frame ? { own: frame.osProcessId !== contents.mainFrame.osProcessId, url: frame.url } : null;
    }, `${A}/links`);
    await clickIn(`${A}/links`, '#frame');
    await until(async () => (await selected()).title === 'From a frame', { timeout: 5000 });
    check('a click in an embedded frame of another site lets that frame open one', (await selected()).title === 'From a frame' && frameProcess?.own === true, { frameProcess, tabs: (await tabs()).map(t => t.title) });
    await engine(e => e.closeTab(e.selectedId()));
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);
    await clickIn(`${A}/links`, '#signin');
    const popup = await until(() => app.evaluate(({ BrowserWindow, session }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/oauth/authorize'));
      return win && win.getTitle() ? {
        title: win.getTitle(), child: win.getParentWindow() !== null,
        browserSession: win.webContents.session === session.fromPartition('persist:atmos-browser'),
        defaultSession: win.webContents.session === session.defaultSession,
      } : null;
    }), { timeout: 5000 });
    check('a sign-in pop-up is a window of its own, in the browser\'s session, its site in its title', !!popup && popup.browserSession && !popup.defaultSession && popup.title.startsWith(A), popup);
    const message = await until(async () => JSON.parse(await inPage(`${A}/links`, 'JSON.stringify(window.__messages)')).find(item => item.token), { timeout: 5000 });
    check('…with its opener: it answers the page and closes', message?.token === 'secret-token' && message.state === 'xyz', message);
    check('…and Chrome\'s window.chrome members, as a tab has (Core\'s page preload)', message?.chrome === 'loadTimes,csi,app', message);
    check('…and the page\'s tab stays', (await tabs()).length === before);
    // A pop-up window never goes fullscreen: there's no notice over it naming its site.
    await wait(300);
    await clickIn(`${A}/links`, '#window');
    const popupWindow = await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('/fullscreen'))), { timeout: 5000 });
    const popupAsked = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/fullscreen'));
      return Promise.race([
        win.webContents.executeJavaScript('document.getElementById("box").requestFullscreen().then(() => "entered", e => e.name)', true),
        new Promise(resolve => setTimeout(() => resolve('no answer'), 2000)),
      ]);
    });
    await wait(600);
    const popupFullscreen = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/fullscreen'));
      const fullscreen = win ? win.isFullScreen() : null;
      win?.close();
      return fullscreen;
    });
    check('a pop-up window can\'t go fullscreen (only a tab, with Atmos\'s notice over it)', !!popupWindow && popupFullscreen === false && popupAsked !== 'entered', { popupAsked, popupFullscreen });
    await wait(300);

    // ── Downloads ─────────────────────────────────────────────────────────
    step('downloads');
    await clickIn(`${A}/links`, '#download');
    const done = await until(async () => (await engine(e => e.downloads())).find(item => item.state === 'completed' && /report/.test(item.name)), { timeout: 10000 });
    check('a download is saved, its name made safe', !!done && !done.name.includes('/') && fs.existsSync(path.join(downloads, done.name)), done && { name: done.name, path: done.path });
    check('the downloads list opens by itself', await (await panel()).evaluate(() => !document.querySelector('[data-test="downloads"]').hidden));
    grab('06-downloads');
    check('a finished document can be opened', done?.openable === true);
    await (await panel()).evaluate(() => window.__browserPanel.overlays.closeDownloads());
    await wait(300);
    await clickIn(`${A}/links`, '#program');
    const program = await until(async () => (await engine(e => e.downloads())).find(item => item.state === 'completed' && item.name === 'setup.exe'), { timeout: 10000 });
    const openProgram = await engine((e, id) => e.downloadAction(id, 'open').then(() => 'opened', error => error.message), program?.id);
    check('a downloaded program is never opened from Atmos (Open is for documents, media and archives)', program?.openable === false && /opens only documents/.test(openProgram), { openable: program?.openable, openProgram });
    await (await panel()).evaluate(() => window.__browserPanel.overlays.closeDownloads());
    // A page downloading on its own: one file as it opens (as Chrome allows), the next stopped until you say so.
    const autoTab = await engine((e, url) => e.newTab({ url }), `${A}/auto-downloads`);
    const autoOne = await until(async () => (await engine(e => e.downloads())).find(item => item.name === 'auto-one.txt' && item.state === 'completed'), { timeout: 8000 });
    const autoStopped = await until(async () => { const t = await engine((e, id) => e.tab(id), autoTab.id); return /Download blocked/.test(t?.notice?.text || '') ? t.notice : null; }, { timeout: 6000 });
    await wait(400);
    const autoTwoEarly = (await engine(e => e.downloads())).some(item => item.name === 'auto-two.txt') || fs.existsSync(path.join(downloads, 'auto-two.txt'));
    check('a page downloading on its own: the first file goes through, the second is stopped, and the browser says so', !!autoOne && !!autoStopped && autoStopped.actions?.[0]?.label === 'Download' && !autoTwoEarly, { autoOne: !!autoOne, autoStopped, autoTwoEarly });
    grab('06b-download-blocked');
    await (await panel()).evaluate(() => window.__browserPanel.overlays.closeDownloads());
    await wait(650);
    await clickPanelButton('[data-test="notice"]', 'Download');
    const autoTwo = await until(async () => (await engine(e => e.downloads())).find(item => item.name === 'auto-two.txt' && item.state === 'completed'), { timeout: 8000 });
    check('…and its Download fetches it', !!autoTwo && fs.existsSync(path.join(downloads, 'auto-two.txt')), autoTwo && { name: autoTwo.name });
    await (await panel()).evaluate(() => window.__browserPanel.overlays.closeDownloads());
    await engine((e, id) => e.closeTab(id), autoTab.id);
    await engine(e => e.selectTab(e.tabs().find(t => t.title === 'Links').id));
    await wait(400);

    // ── Links to other programs, and refused ones ──────────────────────────
    step('links to other programs');
    await inPage(`${A}/links`, 'document.getElementById("mailto").click()');
    const external = await until(async () => (await selected()).external, { timeout: 4000 });
    check('a mailto: link asks before another program opens it', external?.scheme === 'mailto', external);
    grab('07-external-prompt');
    await engine(e => e.answerExternal(e.selectedId(), false));
    // A file: link Chromium refuses itself (no navigation starts); an atmos-app: one Core refuses, and says so.
    for (const id of ['file', 'app']) {
      await inPage(`${A}/links`, `document.getElementById("${id}").click()`);
      const notice = await until(async () => (await selected()).notice, { timeout: 2000 });
      const where = (await guests()).map(g => g.url);
      check(`a page's ${id === 'app' ? 'atmos-app:' : 'file:'} link is refused`, (id === 'file' || !!notice) && where.includes(`${A}/links`) && !where.some(url => /^(file|atmos-)/.test(url)), { notice, where });
      await engine(e => e.dismissNotice(e.selectedId()));
    }

    // ── A permission prompt (localhost is a secure context) ────────────────
    step('permissions');
    await go(`${LOCAL}/permissions`);
    // A click on Allow the moment the prompt appears (one the user was already making on the page) isn't an answer.
    const earlyAllow = clickAsItAppears('[data-test="permission"]', 'Allow');
    const asking = inPage(`${LOCAL}/permissions`, 'askLocation()');
    const earlyAnswer = await earlyAllow;
    const request = await until(async () => (await selected()).permission, { timeout: 5000 });
    const promptShown = await until(() => panel().then(f => f.evaluate(() => !document.querySelector('[data-test="permission"]').hidden)), { timeout: 3000 });
    check('a site asking for location gets a prompt in the browser', request?.permissions?.includes('geolocation') && promptShown, request);
    check('…which takes no click the moment it appears', earlyAnswer.stillShown === true && (await selected()).permission?.requestId === request?.requestId, earlyAnswer);
    await wait(200);
    grab('08-permission-prompt');
    // An answer as the user gives one: the pointer onto the button, a moment after the prompt appeared.
    const answer = async (requestId, label) => {
      const shown = id => panel().then(f => f.evaluate(want => { const prompt = document.querySelector('[data-test="permission"]'); return !prompt.hidden && prompt.dataset.request === want; }, id));
      if (!await until(() => shown(requestId), { timeout: 4000 })) return false;
      await wait(650);
      await clickPanelButton('[data-test="permission"]', label);
      return until(async () => !await shown(requestId), { timeout: 3000 });
    };
    await answer(request?.requestId, 'Block');
    const blocked = await within(asking);
    const again = await within(inPage(`${LOCAL}/permissions`, 'askLocation()'));
    const noPrompt = !(await selected()).permission;
    check('Block denies it, and it is remembered (no second prompt)', blocked === 'denied:1' && again === 'denied:1' && noPrompt, { blocked, again, noPrompt });
    const notify = inPage(`${LOCAL}/permissions`, 'askNotifications()');
    const notifyRequest = await until(async () => { const p = (await selected()).permission; return p?.permissions?.includes('notifications') ? p : null; }, { timeout: 5000 });
    await answer(notifyRequest?.requestId, 'Allow');
    const granted = await within(notify);
    const stateNow = await inPage(`${LOCAL}/permissions`, 'state("notifications")');
    check('Allow grants it, and the site sees it granted', granted === 'granted' && stateNow === 'granted', { granted, stateNow });
    const sites = await engine(e => e.sitePermissions());
    check('both answers are listed for Settings', sites.length === 2 && sites.some(item => item.name === 'geolocation' && item.value === 'block'), sites);
    await engine((e, origin) => e.setSitePermission(origin, 'notifications', null), LOCAL);
    // Electron can only answer a site's check yes or no: one not answered reads "denied" until it asks.
    const revoked = await inPage(`${LOCAL}/permissions`, 'state("notifications")');
    const askAgain = inPage(`${LOCAL}/permissions`, 'askNotifications()');
    const reprompt = await until(async () => (await selected()).permission, { timeout: 4000 });
    check('taking one back from Settings: the site is asked again', revoked !== 'granted' && reprompt?.permissions?.includes('notifications'), { revoked, reprompt });
    if (reprompt) await engine((e, id) => e.dismissPermission(e.selectedId(), id), reprompt.requestId);
    await within(askAgain);
    const clipboard = inPage(`${LOCAL}/permissions`, 'readClipboard().then(() => __results.clipboard)');
    const clipboardAsk = await until(async () => (await selected()).permission, { timeout: 3000 });
    if (clipboardAsk) await engine((e, id) => e.dismissPermission(e.selectedId(), id), clipboardAsk.requestId);
    const clipboardResult = await within(clipboard.catch(error => String(error)));
    check('reading the clipboard asks first (and a dismissed prompt denies)', (clipboardAsk?.permissions?.includes('clipboard-read') && /denied/.test(clipboardResult)) || /denied/.test(clipboardResult), { clipboardResult, clipboardAsk });
    // A frame of another site the page lets ask (allow="geolocation"): the
    // question names the page you're on and is kept for it, as in Chrome;
    // notifications from such a frame are refused without asking.
    await engine((e, origin) => e.setSitePermission(origin, 'geolocation', null), LOCAL);
    await go(`${LOCAL}/permissions-frame`);
    await wait(500);
    const inFrame = code => app.evaluate(({ webContents }, [start, source]) => {
      const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith(start));
      const frame = contents.mainFrame.frames.find(f => f.url.includes('127.0.0.1'));
      return frame.executeJavaScript(source, true);
    }, [`${LOCAL}/permissions-frame`, code]);
    const frameAsking = inFrame('askLocation()');
    const frameRequest = await until(async () => (await selected()).permission, { timeout: 5000 });
    check('a frame of another site asking for location: the prompt names the page\'s site', frameRequest?.origin === LOCAL && frameRequest.permissions.includes('geolocation'), frameRequest);
    if (frameRequest) await engine((e, id) => e.dismissPermission(e.selectedId(), id), frameRequest.requestId);
    await within(frameAsking.catch(error => String(error)));
    const frameNotify = await within(inFrame('askNotifications()').catch(error => String(error)));
    const noNotifyPrompt = !(await selected()).permission;
    check('…and its notifications are refused without asking', frameNotify === 'denied' && noNotifyPrompt, { frameNotify, noNotifyPrompt });
    await engine((e, origin) => e.setSitePermission(origin, 'geolocation', 'block'), LOCAL);

    // ── Certificates and mixed content ─────────────────────────────────────
    step('certificates');
    await engine((e, url) => e.navigate(e.selectedId(), url), `${pages.https('api.test.example')}/solid?title=Untrusted`);
    await until(async () => (await selected()).kind === 'error', { timeout: 8000 });
    tab = await selected();
    check('an untrusted certificate shows the interstitial', tab.error?.kind === 'certificate', tab.error);
    const interstitial = await until(async () => (await panel()).evaluate(() => {
      const element = document.querySelector('.br-interstitial');
      return element ? { text: element.textContent, buttons: [...element.querySelectorAll('button')].map(b => b.textContent) } : null;
    }), { timeout: 3000 }) || { text: '', buttons: [] };
    check('…with no way to continue to the site', /isn’t private/.test(interstitial.text) && !interstitial.buttons.some(label => /continue|proceed|anyway/i.test(label)), interstitial);
    check('…and Core shows no page there', (await layerBox()) === null);
    grab('09-certificate');
    // A site asking for a TLS client certificate: Electron's default would send the first in the store, unasked.
    const clientCertificate = await app.evaluate(({ app: electronApp }) => {
      let prevented = false;
      let answered = 'not answered';
      electronApp.emit('select-client-certificate', { preventDefault() { prevented = true; } }, null, 'https://client-auth.test.example/',
        [{ subjectName: 'CN=Someone', issuerName: 'CN=Work CA' }], (...args) => { answered = args.length && args[0] ? 'a certificate' : 'none'; });
      return { prevented, answered };
    });
    check('a site asking for a client certificate gets none, without a question', clientCertificate.prevented && clientCertificate.answered === 'none', clientCertificate);
    // Trust the test certificate for one host only (a test hook from outside Core), for mixed content.
    await app.evaluate(({ session }) => {
      session.fromPartition('persist:atmos-browser').setCertificateVerifyProc((request, callback) => callback(request.hostname === 'other.test.example' ? 0 : -3));
    });
    await go(`${pages.https('other.test.example')}/mixed`);
    await wait(900);
    const mixed = JSON.parse(await inPage(pages.https('other.test.example'), 'JSON.stringify({ ran: window.__mixedRan === true, done: window.__mixedDone === true })'));
    check('mixed content stays blocked (an http script on an https page)', mixed.done && !mixed.ran, mixed);
    const ua = await (async () => { await go(`${A}/ua`); return inPage(`${A}/ua`, 'document.getElementById("ua").textContent'); })();
    check('the user agent is Chrome\'s, with no Electron or Atmos token', /Chrome\/\d+/.test(ua) && !/electron|atmos/i.test(ua), ua);
    // What else tells a page (Google's sign-in, say) it's in Chrome, on a secure page.
    await go(`${LOCAL}/identity`);
    const identity = JSON.parse(await inPage(`${LOCAL}/identity`, 'JSON.stringify({ ...window.__identity, hints: JSON.parse(document.getElementById("hints").textContent) })'));
    check('a page has Chrome\'s window.chrome (loadTimes, csi, app) before its own scripts run', identity.chrome.join(',') === 'loadTimes,csi,app' && identity.app === 'object', identity);
    check('…and no FedCM, which has no dialog here (sites use a sign-in pop-up)', identity.fedcm === 'undefined', identity.fedcm);
    const chromeVersion = await app.evaluate(() => process.versions.chrome);
    const brandsHeader = brands => (brands || []).map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');
    check('its navigation carried Chromium\'s client hints, the brands the page reads', identity.hints['sec-ch-ua'] === brandsHeader(identity.brands)
      && identity.hints['sec-ch-ua'] === brandsHeader(require('../../core/js/core/web-policy.cjs').uaBrands(chromeVersion))
      && identity.hints['sec-ch-ua-mobile'] === '?0' && /^"(Windows|macOS|Linux)"$/.test(identity.hints['sec-ch-ua-platform'] || ''), identity);
    // That page sets no background: it's the browser's white, not see-through to Atmos's wallpaper.
    await wait(300);
    const plain = pixel(640, 500);
    check('a page that sets no background is white, not see-through to Atmos', near(plain, [255, 255, 255], 8), plain);

    // ── Ads and trackers ──────────────────────────────────────────────────
    step('ads and trackers');
    const adblockReady = await until(async () => (await engine(e => e.adblockStatus()))?.state === 'ready', { timeout: 20000 });
    check('the blocker builds its engine from the lists (a utility process) and is ready', !!adblockReady, await engine(e => e.adblockStatus()));
    await go(`${A}/ads?utm_source=newsletter&keep=1`);
    await wait(1200); // the late ad, its class sent, its style back; the count in the state
    tab = await selected();
    check('a tracking parameter comes off the address ($removeparam)', tab.url === `${A}/ads?keep=1`, tab.url);
    const adPage = () => inPage(`${A}/ads`, `JSON.stringify({
      ad: window.__adLoaded === true, tracker: window.__trackerLoaded === true, first: window.__firstPartyLoaded === true,
      start: window.__adblockTestAtStart, traces: window.__scriptletTraces, pixel: document.getElementById('pixel').naturalWidth,
      hidden: Object.fromEntries(['slot', 'sponsored', 'banner-ad', 'content', 'late'].map(id => [id, document.getElementById(id) ? getComputedStyle(document.getElementById(id)).display : 'missing'])),
    })`).then(JSON.parse);
    let ads = await adPage();
    check('an ad server\'s script is blocked (a third party), the site\'s own runs', !ads.ad && ads.first, ads);
    check('…a tracker\'s script gets a stand-in that does nothing', !ads.tracker, ads);
    check('…and a tracking pixel is blocked', ads.pixel === 0, ads);
    check('a scriptlet runs in the page before its own scripts', ads.start === 'true', ads);
    check('…all of them together, leaving nothing on the page\'s window, the configuring one first (Function.prototype.toString untouched, as X needs)',
      ads.traces?.globals?.length === 0 && ads.traces.toString === 'function toString() { [native code] }' && ads.traces.open === 'function () { [native code] }', ads.traces);
    check('the site\'s ad slots are hidden as it starts', ads.hidden.sponsored === 'none', ads.hidden);
    check('…generic ones by class and id as the page grows (a late one too)', ads.hidden.slot === 'none' && ads.hidden['banner-ad'] === 'none' && ads.hidden.late === 'none', ads.hidden);
    check('…and nothing else', ads.hidden.content === 'block', ads.hidden);
    tab = await until(async () => { const t = await selected(); return t.blocked >= 3 ? t : null; }, { timeout: 4000 }) || await selected();
    check('the shield counts what was blocked on the page', tab.shield === 'on' && tab.blocked >= 3, { shield: tab.shield, blocked: tab.blocked });
    const shieldText = await (await panel()).evaluate(() => { const button = document.querySelector('.br-shield'); return button && !button.hidden ? button.textContent : null; });
    check('…in the address bar', shieldText === String(tab.blocked), shieldText);
    const byHost = await engine((e, id) => e.blocked(id), tab.id);
    check('…and by site', byHost.hosts.some(item => item.host.startsWith('ads.test')) && byHost.hosts.some(item => item.host.startsWith('pixel.test')), byHost);
    grab('21-shield');
    // A scriptlet uBlock Origin runs in its content script's world, on a page that fights blockers in its own (as YouTube does).
    await go(`${A}/tt`);
    const strict = await inPage(`${A}/tt`, 'JSON.stringify(window.__tt)').then(JSON.parse);
    check('an "isolated" scriptlet runs in a world of its own, before the page\'s scripts and out of their reach (it rewrites an inline script, as uBlock Origin\'s YouTube rules do, on a page that breaks rewriting in its own world)', strict.rewritten === 'yes', strict);
    check('…and scriptlet arguments arrive as the list wrote them (a "%" too)', strict.pct === '50%', strict);
    // What runs in a page: uBlock Origin's own list may use a trusted scriptlet; EasyList may not.
    await go(`${B}/ads`);
    const trustedRan = await inPage(`${B}/ads`, 'JSON.stringify({ ublock: window.fromUblock ?? null, easylist: window.fromEasylist ?? null })').then(JSON.parse);
    check('a trusted scriptlet runs from uBlock Origin\'s own list, never from EasyList', trustedRan.ublock === 42 && trustedRan.easylist === null, trustedRan);
    // A page itself is never blocked.
    await go(`${pages.http('ads.test')}/solid?title=AdServer&color=7c3aed`);
    check('a page on a blocked server still opens (only what pages load is blocked)', (await selected()).title === 'AdServer', (await selected()).title);
    // The shield down for the site, then up.
    await go(`${A}/ads`);
    tab = await selected();
    await engine((e, id) => e.setShield(id, false), tab.id);
    await until(async () => { const t = await selected(); return t.shield === 'off' && !t.loading; }, { timeout: 8000 });
    await wait(800);
    ads = await adPage();
    tab = await selected();
    check('the shield down for a site: its ads load, no scriptlet, no hiding, nothing counted', ads.ad && ads.start === 'unset' && ads.hidden.sponsored === 'block' && ads.hidden.slot === 'block' && tab.blocked === 0, { ads, blocked: tab.blocked });
    const shieldSites = await engine(e => e.sitePermissions());
    check('…kept as the site\'s setting', shieldSites.some(item => item.origin === A && item.name === 'ads' && item.value === 'allow'), shieldSites);
    await engine((e, id) => e.setShield(id, true), tab.id);
    await until(async () => { const t = await selected(); return t.shield === 'on' && !t.loading; }, { timeout: 8000 });
    await wait(800);
    ads = await adPage();
    check('…and up again: blocked again', !ads.ad && ads.hidden.sponsored === 'none', ads);
    // Off for every site, then on.
    await engine(e => e.setOptions({ blockAds: false }));
    await engine(e => e.reload(e.selectedId()));
    await until(async () => { const t = await selected(); return t.shield === 'disabled' && !t.loading; }, { timeout: 8000 });
    await wait(600);
    ads = await adPage();
    check('blocking off for every site: the ads load, the shield says it\'s off', ads.ad && (await selected()).shield === 'disabled', ads);
    await engine(e => e.setOptions({ blockAds: true }));
    // Private tabs are blocked the same (this tab leaves the page first, so it's the private tab's).
    await go(`${A}/solid?title=Alpha&color=1d4ed8`);
    await engine((e, url) => e.newTab({ private: true, url }), `${A}/ads`);
    await until(async () => { const t = await selected(); return t.private && t.live && !t.loading && t.url.startsWith(`${A}/ads`); }, { timeout: 8000 });
    await wait(800);
    const privateAds = await inPage(`${A}/ads`, 'JSON.stringify({ ad: window.__adLoaded === true, start: window.__adblockTestAtStart })').then(JSON.parse);
    check('a private tab is blocked the same', !privateAds.ad && privateAds.start === 'true', privateAds);
    await engine(e => e.closeTab(e.selectedId()));
    await wait(300);
    // A page's first requests can reach Core before the browser knows the
    // page has come (its frame still at the page before): from a site whose
    // shield is down, they mustn't go through on that site's shield.
    await go(`${B}/solid?title=Beta&color=059669`);
    await engine((e, id) => e.setShield(id, false), (await selected()).id);
    await until(async () => { const t = await selected(); return t.shield === 'off' && !t.loading; }, { timeout: 8000 });
    const leaks = [];
    for (let round = 0; round < 6; round++) {
      await go(`${A}/ads?round=${round}`);
      if (await inPage(`${A}/ads`, 'window.__adLoaded === true')) leaks.push(round);
      await go(`${B}/solid?title=Beta&color=059669&round=${round}`);
    }
    check('a page\'s first requests are its own: none go through on the shield of the site before it', leaks.length === 0, leaks);
    await engine((e, id) => e.setShield(id, true), (await selected()).id);
    await until(async () => { const t = await selected(); return t.shield === 'on' && !t.loading; }, { timeout: 8000 });

    // ── Atmos over a page ─────────────────────────────────────────────────
    step('atmos over a page');
    await go(`${A}/solid?title=Under&color=1d4ed8`);
    const under = await layerBox();
    const menuPoint = { x: under.x + 700, y: under.y + 300 };
    await x.click(menuPoint.x, menuPoint.y, 3);
    await wait(600);
    const menuBox = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-context-menu-item]')].filter(el => el.offsetParent !== null);
      const surface = items[0]?.closest('.ctx-menu-surface, #ctx-menu, [class*="menu"]');
      const box = (surface || items[0])?.getBoundingClientRect();
      return box ? { x: box.left, y: box.top, width: box.width, height: box.height, items: items.map(el => el.textContent.trim()) } : null;
    });
    check('a right-click in the page opens Atmos\'s menu where the pointer is', !!menuBox && Math.abs(menuBox.x - menuPoint.x) < 30 && Math.abs(menuBox.y - menuPoint.y) < 30, { menuBox, menuPoint });
    check('…drawn over the page', !!menuBox && !near(pixel(menuBox.x + menuBox.width / 2, menuBox.y + 12), hex('1d4ed8')), menuBox && pixel(menuBox.x + menuBox.width / 2, menuBox.y + 12));
    grab('11-menu-over-page');
    await x.key('Escape');
    await wait(300);
    check('Escape closes it, and the page has the keyboard again', await page.evaluate(() => ![...document.querySelectorAll('[data-context-menu-item]')].some(el => el.offsetParent !== null))
      && await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes('Under'))?.isFocused()));
    await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
    await wait(900);
    check('Settings opens over the page', !near(pixel(640, 400), hex('1d4ed8'), 30), pixel(640, 400));
    grab('12-settings-over-page');
    await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());
    await wait(600);
    await wait(1500); // Task View takes the panel's preview after a page loads
    await page.evaluate(() => window.dispatchEvent(new Event('atmos:open-task-view')));
    await wait(1000);
    const preview = await page.evaluate(async () => {
      const img = document.querySelector('#task-view .task-view-card[data-plugin-id="browser"] img');
      if (!img?.src) return null;
      const image = new Image();
      image.src = img.src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return [...context.getImageData(Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight * 0.7), 1, 1).data].slice(0, 3);
    }).catch(error => String(error));
    check('Task View\'s preview of the browser includes the page', Array.isArray(preview) && near(preview, hex('1d4ed8'), 40), preview);
    grab('13-task-view');
    await page.keyboard.press('Escape');
    await wait(500);

    // ── Panels and layouts ────────────────────────────────────────────────
    // The other panel is Finance's (portfolio-tracker): a released plugin, so
    // this script can go public (release.json).
    step('panels and layouts');
    await inPage(`${A}/solid?title=Under`, 'window.__marker = 42');
    await registry(r => r.activatePanelPlugin('portfolio-tracker'));
    await wait(900);
    check('another panel: the page is hidden', (await layerBox()) === null && !near(pixel(640, 500), hex('1d4ed8')));
    // The panel's key brings the browser back (the keyboard on Atmos, not in a page).
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('[');
    await wait(400);
    check('panel opens with its key', await registry(r => r.getActivePanelPluginId()) === 'browser');
    await panel();
    await wait(900);
    const backPixel = pixel(640, 500);
    check('back to the browser: the same page, not reloaded', near(backPixel, hex('1d4ed8')) && await inPage(`${A}/solid?title=Under`, 'window.__marker') === 42, backPixel);
    await registry(r => { r.setPanelLayout('columns'); r.assignPanelPlugin('main', 'portfolio-tracker'); r.assignPanelPlugin('right', 'browser'); });
    await wait(1500);
    await panel();
    await wait(600);
    const column = await layerBox();
    const iframeBox = await page.evaluate(() => {
      const frameEl = [...document.querySelectorAll('iframe')].find(f => f.src.includes('ext=plugin%3Abrowser') && f.src.includes('surface=panel'));
      const box = frameEl.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    });
    check('in a column, the page stays inside the browser\'s tile', !!column && column.x >= iframeBox.x - 1 && column.x + column.width <= iframeBox.x + iframeBox.width + 1, { column, iframeBox });
    check('…and shows there', near(pixel(column.x + column.width / 2, column.y + column.height / 2), hex('1d4ed8')));
    grab('14-columns');
    await registry(r => { r.setPanelLayout('freeform'); r.assignPanelPlugin('main', 'browser'); r.assignPanelPlugin('floating-2', 'portfolio-tracker'); });
    await wait(1500);
    await panel();
    await page.evaluate(() => {
      const sections = [...document.querySelectorAll('#media-fullscreen .panel-section')];
      const main = sections.find(el => el.dataset.panelSection === 'main');
      const other = sections.find(el => el.dataset.panelSection !== 'main');
      if (main) Object.assign(main.style, { left: '4%', top: '6%', width: '58%', height: '70%', zIndex: '2' });
      if (other) Object.assign(other.style, { left: '40%', top: '35%', width: '50%', height: '55%', zIndex: '9' });
    });
    await wait(900);
    const floating = await layerBox();
    const otherBox = await page.evaluate(() => {
      const other = [...document.querySelectorAll('#media-fullscreen .panel-section')].find(el => el.dataset.panelSection !== 'main');
      const box = other.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    });
    check('in a window, the page follows the window', !!floating && floating.x > 40 && floating.y > 40, floating);
    check('…and a window stacked above covers it', !near(pixel(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2), hex('1d4ed8')));
    grab('15-freeform');
    await registry(r => { r.setPanelLayout('single'); r.activatePanelPlugin('browser'); });
    await wait(1200);
    await panel();

    // ── Sidebar widgets ───────────────────────────────────────────────────
    step('sidebar');
    await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).openSidebar());
    await wait(800);
    // Open the browser's two widgets (they start folded).
    await page.evaluate(() => {
      for (const section of document.querySelectorAll('#settings-drawer .fin-section')) {
        if (/tabs|bookmarks/i.test(section.querySelector('.fin-section-name')?.textContent || '') && !section.classList.contains('open')) section.querySelector('.fin-section-label')?.click();
      }
    });
    await wait(900);
    const widget = page.frames().find(f => f.url().includes('ext=plugin%3Abrowser') && f.url().includes('surface=sidebar'));
    const listed = widget ? await widget.evaluate(() => [...document.querySelectorAll('.br-row .br-row-title')].map(el => el.textContent)) : [];
    check('the Tabs widget lists the tabs', listed.length === (await tabs()).length && listed.includes('Under'), listed);
    grab('16-sidebar');
    await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).closeSidebar?.());
    await wait(500);

    // ── Private tabs ──────────────────────────────────────────────────────
    step('private tabs');
    const P = pages.http('private.test');
    await go(`${P}/cookie/set?v=normal`);
    const privateTab = await engine(e => e.newTab({ private: true }));
    await engine((e, [id, url]) => e.navigate(id, url), [privateTab.id, `${P}/cookie/read`]);
    await settled('Cookie read');
    const privateRead = JSON.parse(await inPage(`${P}/cookie/read`, 'JSON.stringify({ cookie: window.__cookie, stored: window.__stored })'));
    check('a private tab doesn\'t see the ordinary tabs\' cookies or storage', privateRead.cookie === '' && privateRead.stored === null, privateRead);
    await engine((e, [id, url]) => e.navigate(id, url), [privateTab.id, `${P}/cookie/set?v=private`]);
    await settled('Cookie private');
    await engine((e, url) => e.newTab({ url }), `${P}/cookie/read`);
    await until(async () => { const t = await selected(); return t.title === 'Cookie read' && !t.private; });
    const normalRead = JSON.parse(await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes('/cookie/read') && w.session === session.fromPartition('persist:atmos-browser'));
      return contents.executeJavaScript('JSON.stringify({ cookie: window.__cookie, stored: window.__stored })');
    }));
    check('…and a private tab\'s cookies never appear in an ordinary tab', normalRead.cookie === 'probe=normal' && normalRead.stored === 'normal', normalRead);
    const privateRequests = pages.requests.filter(item => item.host === 'private.test' && item.path === '/cookie/read');
    check('…as the site sees it too', privateRequests.length >= 2 && !privateRequests.some(item => /private/.test(item.cookie)) && privateRequests.some(item => item.cookie === 'probe=normal'), privateRequests.map(item => item.cookie));
    const privateHistory = await engine(e => e.history.search('Cookie').then(list => list.map(item => item.url)));
    check('private tabs leave no history', !privateHistory.some(url => url.includes('v=private')), privateHistory);
    // The site's icon is Core's request, not the page's: no cookies go with it.
    const iconRequests = pages.requests.filter(item => item.host === 'private.test' && item.path === '/favicon.png');
    check('a site\'s icon is fetched without its cookies', iconRequests.length >= 1 && iconRequests.every(item => item.cookie === ''), iconRequests.map(item => item.cookie));
    grab('17-private');
    for (const t of (await tabs()).filter(item => item.private)) await engine((e, id) => e.closeTab(id), t.id);
    await wait(800);
    const again2 = await engine(e => e.newTab({ private: true }));
    await engine((e, [id, url]) => e.navigate(id, url), [again2.id, `${P}/cookie/read`]);
    await until(async () => (await selected()).title === 'Cookie read' && (await selected()).private);
    const fresh = JSON.parse(await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.session === session.fromPartition('atmos-browser-private'));
      return contents.executeJavaScript('JSON.stringify({ cookie: document.cookie, stored: localStorage.getItem("probe") })');
    }));
    check('closing the last private tab clears the private session', fresh.cookie === '' && fresh.stored === null, fresh);
    await engine((e, id) => e.closeTab(id), again2.id);

    // ── The hostile page ──────────────────────────────────────────────────
    step('hostile page');
    await go(`${A}/hostile`);
    const hostile = await until(async () => { const value = JSON.parse(await inPage(`${A}/hostile`, 'JSON.stringify(window.__hostile)')); return value?.done ? value : null; }, { timeout: 8000 });
    check('a page can\'t fetch atmos-app://, atmos-ext:// or atmos-resource://', ['fetchApp', 'fetchExt', 'fetchResource'].every(name => /^blocked/.test(hostile?.[name] || '')), hostile);
    check('…nor read file://', /^blocked/.test(hostile?.fetchFile || '') && /^blocked/.test(hostile?.xhrFile || ''), hostile);
    // A refused frame is left blank (about:blank, the page's own origin), never what it pointed at.
    check('…nor frame Atmos, an extension or a file', ['frame-app', 'frame-ext', 'frame-file'].every(name => hostile?.[name] === 'not readable' || hostile?.[name] === 'readable: about:blank'), hostile);
    check('…and has no Atmos, Node or Electron globals', Array.isArray(hostile?.globals) && hostile.globals.length === 0, hostile?.globals);
    const hostileFrames = await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes('/hostile'));
      const urls = [];
      contents.mainFrame.framesInSubtree.forEach(frame => urls.push(frame.url));
      return urls;
    });
    check('…its frames never loaded any of them', !hostileFrames.some(url => /^(atmos-|file:)/.test(url)), hostileFrames);
    for (const target of ['atmos-app://local/index.html', 'atmos-ext://first-party-plugin-browser/boot.js', 'atmos-resource://audio-player-media/x', 'file:///etc/passwd']) {
      await inPage(`${A}/hostile`, `location.href = ${JSON.stringify(target)}`).catch(() => {});
      await wait(400);
      const where = (await guests()).find(g => g.url.includes('/hostile') || /^(atmos-|file:)/.test(g.url));
      check(`a page can't navigate to ${target.split(':')[0]}:`, where && where.url.includes('/hostile'), where);
      await inPage(`${A}/hostile`, `window.open(${JSON.stringify(target)}) === null`).catch(() => {});
      await wait(300);
    }
    const opened = (await tabs()).filter(t => /^(atmos-|file:)/.test(t.url));
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getURL()));
    check('…nor open one in a tab or a window', opened.length === 0 && windows.every(url => url.startsWith('atmos-app://local/') || url.startsWith('http')), { opened, windows });
    const sessions = await app.evaluate(({ session }) => {
      const browser = session.fromPartition('persist:atmos-browser');
      return {
        handled: ['atmos-app', 'atmos-ext', 'atmos-resource'].map(scheme => browser.protocol.isProtocolHandled(scheme)),
        defaultHandled: ['atmos-app', 'atmos-ext'].map(scheme => session.defaultSession.protocol.isProtocolHandled(scheme)),
        separate: browser !== session.defaultSession && browser.storagePath !== session.defaultSession.storagePath,
      };
    });
    check('the browser\'s session is its own: no Atmos schemes in it, its own storage', sessions.handled.every(value => value === false) && sessions.defaultHandled.every(Boolean) && sessions.separate, sessions);
    const cookieJars = await app.evaluate(async ({ session }) => {
      const browser = await session.fromPartition('persist:atmos-browser').cookies.get({});
      const atmos = await session.defaultSession.cookies.get({});
      return { browserHosts: [...new Set(browser.map(c => c.domain))], atmosHasProbe: atmos.some(c => c.name === 'probe') };
    });
    check('…pages\' cookies never land in Atmos\'s own session', !cookieJars.atmosHasProbe, cookieJars);
    // A site whose icon isn't an image: refused, and nothing else is disturbed.
    await go(`${pages.http('broken.test')}/broken-icon`);
    await wait(1500);
    const brokenIcon = await selected();
    check('a broken site icon is refused (no icon), and the browser carries on', !brokenIcon.favicon && brokenIcon.title === 'Broken icon', { favicon: (brokenIcon.favicon || '').slice(0, 40), title: brokenIcon.title });
    // An icon on a local address that isn't the page's host: never fetched.
    await go(`${A}/local-icon`);
    await wait(1200);
    const localIcon = await selected();
    const localIconRequests = pages.requests.filter(item => item.query.includes('local-icon=1')).length;
    check('a site\'s icon on a local address (not its own host) is never fetched', localIcon.title === 'Local icon' && localIconRequests === 0, { title: localIcon.title, localIconRequests });
    // Atmos's own IPC, as a page whose renderer was taken over could send it:
    // the main process answers the Atmos page only (ipc-gate.cjs).
    await go(`${A}/hostile`);
    const asTab = await app.evaluate(({ ipcMain, webContents, BrowserWindow }, [channels, where]) => {
      const tab = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes(where));
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('atmos-app://local/'));
      const invoke = (channel, sender, ...args) => {
        const handler = ipcMain._invokeHandlers?.get(channel);
        if (!handler) return Promise.resolve({ missing: true });
        return Promise.resolve().then(() => handler({ sender, senderFrame: sender.mainFrame, processId: 0, frameId: 0 }, ...args))
          .then(value => ({ answered: typeof value }), error => ({ refused: String(error?.message || error) }));
      };
      return (async () => {
        const out = {};
        for (const channel of channels) out[channel] = await invoke(channel, tab, { x: 0, y: 0, width: 40, height: 40 });
        out.fromAtmos = await invoke('is-maximized', win.webContents);
        const bounds = JSON.stringify(win.getBounds());
        const event = { sender: tab, senderFrame: tab.mainFrame };
        ipcMain.emit('window-resize:start', event, 'se', 100, 100);
        ipcMain.emit('window-resize:update', event, 400, 400);
        ipcMain.emit('window-resize:end', event);
        out.resized = JSON.stringify(win.getBounds()) !== bounds;
        return out;
      })();
    }, [['task-view:capture-preview', 'plugins:list', 'services:list', 'toggle-fullscreen', 'window-effects:set-transparent', 'extensions:manager-status', 'extension-state:load-all', 'web:downloads'], '/hostile']);
    const refusedAll = Object.entries(asTab).filter(([name]) => name.includes(':') || name.includes('-')).every(([, value]) => value?.refused === 'Not allowed');
    check('a tab\'s page gets nothing from Atmos\'s own IPC: no screenshot, no extensions list, no window controls', refusedAll && asTab.fromAtmos?.answered === 'boolean' && asTab.resized === false, asTab);
    grab('18-hostile');

    // ── Links from the rest of Atmos ──────────────────────────────────────
    step('links from atmos');
    await engine(e => e.setOptions({ openLinks: true }));
    let count = (await tabs()).length;
    const onTab = (await selected()).id;
    // No click in Atmos just before: a tab behind, the browser not raised.
    await wait(5200);
    await app.evaluate(({ shell }, url) => shell.openExternal(url), `${B}/solid?title=Behind&color=0f766e`);
    await until(async () => (await tabs()).length === count + 1, { timeout: 5000 });
    await wait(300);
    check('with "Open links in Atmos Browser", a link Atmos opens with no click just before waits in a tab behind', (await selected()).id === onTab
      && (await tabs()).some(t => t.url.includes('title=Behind') && !t.selected), (await tabs()).map(t => [t.title || t.url, t.selected]));
    // A click in Atmos (the browser's address bar), then a link: a new tab, in front.
    const addressPoint = await (await panel()).evaluate(() => { const box = document.querySelector('.br-address-input').getBoundingClientRect(); return { x: box.left + 30, y: box.top + box.height / 2 }; });
    const panelBox = await page.evaluate(() => {
      const element = [...document.querySelectorAll('iframe')].find(f => f.src.includes('ext=plugin%3Abrowser') && f.src.includes('surface=panel'));
      const box = element.getBoundingClientRect();
      return { x: box.left, y: box.top };
    });
    await x.click(panelBox.x + addressPoint.x, panelBox.y + addressPoint.y);
    await wait(200);
    await x.key('Escape');
    count = (await tabs()).length;
    await app.evaluate(({ shell }, url) => shell.openExternal(url), `${B}/solid?title=From%20Atmos&color=0f766e`);
    await settled('From Atmos', 5000);
    check('…and just after a click in Atmos, in front', (await tabs()).length === count + 1 && (await selected()).title === 'From Atmos');
    count = (await tabs()).length;
    await page.evaluate(url => window.open(url), `${B}/solid?title=From%20the%20page&color=0f766e`);
    await until(async () => (await tabs()).length === count + 1, { timeout: 5000 });
    check('…and a link opened in the Atmos page goes there too (behind: that click was spent)', (await tabs()).some(t => t.url.includes('From%20the%20page') && !t.selected) && (await selected()).title === 'From Atmos', (await tabs()).map(t => [t.title || t.url, t.selected]));
    await engine(e => { for (const t of e.tabs().filter(tab => /Behind|From%20the%20page/.test(tab.url))) e.closeTab(t.id); });
    await engine(e => e.setOptions({ openLinks: false }));

    // ── Pages put away ────────────────────────────────────────────────────
    step('put away');
    await engine(e => e.setSettings({ maxLoadedTabs: 5 }));
    for (let i = 0; i < 6; i++) {
      await engine((e, url) => e.newTab({ url }), `${B}/solid?title=Many%20${i}&color=0f766e`);
      await wait(500);
    }
    await wait(800);
    const live = (await tabs()).filter(t => t.live).length;
    const pagesOpen = (await guests()).length;
    check('past the most kept loaded, the tabs used least recently are put away', live <= 5 && pagesOpen <= 5, { live, pagesOpen, tabs: (await tabs()).length });
    const putAway = (await tabs()).find(t => !t.live && t.kind === 'page');
    check('…keeping their address and title', !!putAway && putAway.url.startsWith('http') && !!putAway.title, putAway);
    await engine((e, id) => e.selectTab(id), putAway.id);
    await until(async () => (await selected()).live && !(await selected()).loading, { timeout: 6000 });
    check('…and going back to one loads it again', (await selected()).live);
    await engine(e => e.setSettings({ maxLoadedTabs: 10 }));

    // ── Fullscreen ────────────────────────────────────────────────────────
    step('fullscreen');
    await go(`${A}/fullscreen`);
    const fsBox = await layerBox();
    await x.click(fsBox.x + 300, fsBox.y + 300);
    await inPage(`${A}/fullscreen`, 'document.getElementById("box").requestFullscreen()');
    await until(() => atmosWindowDo(win => win.isFullScreen()), { timeout: 5000 });
    await wait(800);
    const fsLayer = await layerBox();
    const fullBounds = await atmosWindowDo(win => win.getBounds());
    check('HTML fullscreen fills the Atmos window', fsLayer && fsLayer.x === 0 && fsLayer.y === 0 && fsLayer.width >= fullBounds.width - 8, { fsLayer, fullBounds });
    // Over the page, Atmos names the site and how to leave (a fullscreen page could pose as Atmos).
    const notice = await page.evaluate(() => {
      const element = document.getElementById('atmos-web-fullscreen-notice');
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { text: element.textContent, x: box.left + 8, y: box.top + box.height / 2 };
    });
    // Drawn over the page, not under it (the page is in the top layer): the screen there isn't the page's orange.
    const noticePixel = notice ? pixel(notice.x, notice.y) : null;
    check('…with a notice over it naming the site and Esc', !!notice && notice.text.includes(new URL(A).host) && /Esc/.test(notice.text) && !!noticePixel && !near(noticePixel, hex('ea580c'), 40), { notice, noticePixel });
    grab('10-fullscreen');
    await x.key('Escape');
    const left = await until(async () => !(await atmosWindowDo(win => win.isFullScreen())), { timeout: 5000 });
    check('Escape leaves it', left);
    // Atmos takes a page out of fullscreen in a world of its own: a page
    // that replaced document.exitFullscreen in its own can't stay.
    await wait(600);
    await x.click(fsBox.x + 300, fsBox.y + 300);
    await inPage(`${A}/fullscreen`, 'document.exitFullscreen = () => Promise.resolve(); Document.prototype.exitFullscreen = () => Promise.resolve(); document.getElementById("box").requestFullscreen()');
    await until(() => atmosWindowDo(win => win.isFullScreen()), { timeout: 5000 });
    const fsGuest = (await guests()).find(g => g.url.includes('/fullscreen'));
    await page.evaluate(id => window.atmosCore.web.command(id, 'exitFullscreen'), fsGuest?.id);
    const leftAgain = await until(async () => !(await atmosWindowDo(win => win.isFullScreen())), { timeout: 5000 });
    check('…and Atmos takes it out even when the page replaced exitFullscreen', leftAgain, fsGuest);
    await atmosWindowDo(win => { if (win.isFullScreen()) win.setFullScreen(false); });
    await wait(900);
    await atmosWindowDo(win => win.setBounds({ x: 0, y: 0, width: 1280, height: 800 }));
    await wait(600);
    await go(`${A}/solid?title=After%20fullscreen&color=1d4ed8`);
    await wait(500);
    const afterFullscreen = pixel(640, 500);
    check('after fullscreen the page is drawn as it was', near(afterFullscreen, hex('1d4ed8')), afterFullscreen);

    // ── Closing pages ─────────────────────────────────────────────────────
    // A tab closes as Chrome closes one: its page's last events run first,
    // where sites save what they keep (Discord writes its sign-in back then).
    step('closing pages');
    const pageAlive = tag => app.evaluate(({ webContents }, t) => webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL().includes(`tag=${t}`)), tag);
    const savedAs = tag => inPage(A, `Object.keys(localStorage).filter(key => key.startsWith('${tag}:')).map(key => key.slice(${tag.length + 1})).sort()`);
    const closing = await engine((e, url) => e.newTab({ url }), `${A}/unload?tag=close`);
    await settled('Unload');
    await engine((e, id) => e.closeTab(id), closing.id);
    const closedGone = await until(async () => !(await pageAlive('close')), { timeout: 6000 });
    const closedSaved = await savedAs('close');
    check('closing a tab lets its page save first (its beforeunload, pagehide and unload run, as in Chrome)',
      closedGone && ['beforeunload', 'pagehide', 'unload'].every(name => closedSaved.includes(name)), { closedGone, closedSaved });
    // (A page that objects to being left can't be closed here: Playwright,
    // attached to every page, takes its dialog and fails. Checked in a bare
    // Electron: closed, its events run; see CHANGELOG, 1 October.)
    // A page open as Atmos quits saves the same way (read after the restart).
    await engine((e, url) => e.newTab({ url }), `${A}/unload?tag=quit`);
    await settled('Unload');

    // A tab to find selected after the restart, bookmarked.
    const kept = await engine((e, url) => e.newTab({ url }), `${A}/solid?title=Kept&color=1d4ed8`);
    await settled('Kept');
    await engine(e => e.toggleBookmark(e.selectedId()));
    // A private tab left open: it isn't kept.
    await engine((e, url) => e.newTab({ private: true, url }), `${P}/cookie/read`);
    await wait(500);
    const before2 = await tabs();
    await engine((e, id) => e.selectTab(id), kept.id);
    await wait(600);
    report.details.tabsBeforeRestart = before2.map(t => `${t.private ? 'P ' : ''}${t.title || t.url}`);
    // Another panel showing as Atmos closes, so the browser's starts hidden.
    await registry(r => r.activatePanelPlugin('portfolio-tracker'));
    await wait(600);
  } catch (error) {
    report.error = error.stack;
  }

  // ── After a restart ────────────────────────────────────────────────────
  step('restart');
  try {
    await session.app.close();
    try { report.details.savedSession = JSON.parse(fs.readFileSync(path.join(iso.installRoot, 'extension-state', 'plugin-browser.json'), 'utf8')).data?.session; } catch (error) { report.details.savedSession = String(error); }
    session = await launch();
    ({ app, page } = session);
    await wait(2500);
    const beforePanel = await guests();
    check('after a restart nothing loads before the panel shows', beforePanel.length === 0, beforePanel);
    await registry(r => r.activatePanelPlugin('browser'));
    await panel();
    await until(async () => (await selected())?.live, { timeout: 8000 });
    const restored = await tabs();
    const expected = (report.details.tabsBeforeRestart || []).filter(label => !label.startsWith('P '));
    check('the ordinary tabs are back, in order; private ones aren\'t', restored.length === expected.length && restored.every(t => !t.private), { restored: restored.map(t => t.title || t.url), expected });
    check('the selected one is loaded, the others wait', (await selected()).title === 'Kept' && restored.filter(t => t.live).length === 1, restored.map(t => [t.title, t.live]));
    const marks = await engine(e => e.bookmarks.list().then(list => list.map(item => item.title)));
    check('bookmarks and history are kept', marks.includes('Kept') && (await engine(e => e.history.search('Alpha').then(list => list.length))) > 0, marks);
    await until(async () => (await engine(e => e.adblockStatus()))?.state === 'ready', { timeout: 20000 });
    grab('19-restored');
    await go(`${A}/ads`);
    check('the blocker is back after a restart', (await inPage(`${A}/ads`, 'window.__adLoaded === true')) === false);
    const quitSaved = await inPage(`${A}/ads`, 'Object.keys(localStorage).filter(key => key.startsWith("quit:")).map(key => key.slice(5)).sort()');
    check('a page open as Atmos quit saved first, and it was kept', quitSaved.includes('pagehide'), quitSaved);
    await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
    await wait(500);
    await page.evaluate(() => [...document.querySelectorAll('#settings-menu button, #settings-menu [role="tab"], #settings-menu .sm-nav-item')].find(el => /Appearance/.test(el.textContent))?.click());
    await wait(1500);
    const settingsFrame = page.frames().find(f => f.url().includes('ext=plugin%3Abrowser') && f.url().includes('surface=settings'));
    const settingsText = settingsFrame ? await settingsFrame.evaluate(() => document.body.innerText) : '';
    check('the settings page shows (Settings → Appearance → Atmos Browser), with the site permission kept', /search engine/i.test(settingsText) && /site permissions/i.test(settingsText) && /location: blocked/i.test(settingsText), settingsText);
    await page.evaluate(() => document.querySelector('.sm-appearance-contribution:last-of-type')?.scrollIntoView());
    await wait(400);
    grab('20-settings');
  } catch (error) {
    report.restartError = error.stack;
  }

  // ── Removed with its data ──────────────────────────────────────────────
  step('removed with its data');
  try {
    await session.app.close();
    const hadPartition = fs.existsSync(partitionDir);
    const hadSites = fs.existsSync(path.join(iso.installRoot, 'browser', 'sites.json'));
    // What Settings → Extensions leaves for the next start after Remove with
    // "Delete its data" (a bundled copy then starts again, afresh).
    fs.writeFileSync(path.join(iso.installRoot, 'extension-data-cleanup.json'), JSON.stringify({ extensions: [{ kind: 'plugin', id: 'browser' }] }));
    session = await launch();
    ({ app, page } = session);
    await wait(2000);
    check('removing Atmos Browser with its data deletes its session and site settings',
      hadPartition && hadSites && !fs.existsSync(partitionDir) && !fs.existsSync(path.join(iso.installRoot, 'browser', 'sites.json')),
      { hadPartition, hadSites, partitionAfter: fs.existsSync(partitionDir) });
    await registry(r => r.activatePanelPlugin('browser'));
    await panel();
    await wait(800);
    const fresh = await tabs();
    const freshMarks = await engine(e => e.bookmarks.list().then(list => list.length));
    const freshHistory = await engine(e => e.history.search('').then(list => list.length));
    check('…and its tabs, bookmarks and history', fresh.length === 1 && fresh[0].kind === 'new' && freshMarks === 0 && freshHistory === 0,
      { tabs: fresh.map(t => t.title || t.url || t.kind), bookmarks: freshMarks, history: freshHistory });
  } catch (error) {
    report.removeError = error.stack;
  }

  report.errors = session.errors;
  report.failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  report.summary = `${Object.values(report.checks).filter(Boolean).length} of ${Object.keys(report.checks).length} checks passed`;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  x.close();
  await session.app.close().catch(() => {});
  pages.close();
  process.exit(report.failed.length || report.error || report.restartError || report.removeError ? 1 : 0);
})();

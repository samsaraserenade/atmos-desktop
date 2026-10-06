// Putting a browser page to sleep (web-host.cjs sleepPage, R40) in a real
// Electron, with Core's web host and a <webview> as Atmos Browser has them:
// a page with unsaved changes (its beforeunload objects, after the user
// used it) stays awake and no dialog shows; one without goes, its pagehide
// first; a page that doesn't answer goes after a while; closing a tab
// yourself still closes a page that objects.
//
// Not through Atmos: Electron runs this file as its main process, and no
// Playwright is attached (it takes a page's "Leave site?" itself, which is
// why browser.cjs can't check this).
// Usage: xvfb-run -a node_modules/.bin/electron scripts/e2e/web-sleep.cjs --no-sandbox
const electron = require('electron');
const { app, BrowserWindow, webContents } = electron;
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const { createWebHost } = require('../../core/js/core/web-host.cjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-sleep-'));
app.setPath('userData', home);

const checks = [];
const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === null ? '' : `: ${JSON.stringify(detail)}`}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 5000) {
  for (const end = Date.now() + timeout; Date.now() < end; await wait(50)) if (await test()) return true;
  return false;
}

app.whenReady().then(async () => {
  // Pages: one that objects to being left once it's dirty, and saves on pagehide.
  const beacons = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/beacon')) { beacons.push(req.url); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Draft</title><body>
      <script>
        window.dirty = false;
        addEventListener('beforeunload', event => { if (window.dirty) { event.preventDefault(); event.returnValue = ''; } });
        addEventListener('pagehide', () => navigator.sendBeacon('/beacon?tag=' + new URLSearchParams(location.search).get('tag')));
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Core's web host, its IPC handlers kept here; "Leave site?" recorded.
  const handlers = new Map();
  const dialogs = [];
  const dialog = { ...electron.dialog, showMessageBoxSync: (...args) => { dialogs.push(args.at(-1)?.message); return 1; } };
  const host = createWebHost({
    ...electron, dialog,
    ipcMain: { on: (...args) => electron.ipcMain.on(...args), handle: (channel, fn) => handlers.set(channel, fn) },
    isAppUrl: () => true, userData: home, isWebExtension: () => true,
    testOptions: { filterLists: fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-sleep-lists-')) },
  });
  app.on('web-contents-created', (_, contents) => { if (host.isWebSession(contents.session)) host.applyPolicy(contents); });
  const win = new BrowserWindow({ width: 900, height: 700, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => host.attachWebview(win.webContents, event, webPreferences, params));
  host.setWindow(win);
  await win.loadURL('data:text/html,<!doctype html><body style="margin:0">');
  const asAtmos = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const command = (id, name, ...args) => handlers.get('web:do')(asAtmos, id, name, ...args);

  /** A tab's page, loaded and used (a gesture: Chromium asks before leaving only a page the user used). */
  async function tab(tag, { dirty, host = origin }) {
    const id = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const view = document.createElement('webview');
      view.setAttribute('partition', 'persist:atmos-browser');
      view.setAttribute('src', 'about:blank');
      view.style.cssText = 'width:800px;height:600px';
      view.addEventListener('dom-ready', () => resolve(view.getWebContentsId()), { once: true });
      document.body.append(view);
    })`);
    const page = webContents.fromId(id);
    await page.loadURL(`${host}/draft?tag=${tag}`);
    await page.executeJavaScript(`window.dirty = ${dirty}; true`, true);
    return { id, page };
  }

  const dirty = await tab('dirty', { dirty: true });
  const slept = await command(dirty.id, 'sleep');
  await wait(300);
  check('a page with unsaved changes isn\'t put to sleep: sleep says no', slept === false, slept);
  check('…its page is still there, as it was (its changes too)', !dirty.page.isDestroyed() && dirty.page.getURL().includes('tag=dirty')
    && await dirty.page.executeJavaScript('window.dirty') === true);
  check('…and no "Leave site?" was shown for it', dialogs.length === 0, dialogs);

  const clean = await tab('clean', { dirty: false });
  const cleanSlept = await command(clean.id, 'sleep');
  check('a page without unsaved changes is put to sleep', cleanSlept === true && clean.page.isDestroyed(), cleanSlept);
  check('…its pagehide first (sites save there)', await until(() => beacons.some(url => url.includes('tag=clean'))), beacons);

  // A page that doesn't answer at all (its renderer busy for good) isn't
  // refusing: it goes, as closing it would, after a while.
  // (A site of its own, so its renderer is its own: hung, it answers nothing.)
  const hung = await tab('hung', { dirty: true, host: origin.replace('127.0.0.1', 'localhost') });
  void hung.page.executeJavaScript('for (;;) {}').catch(() => {});
  await wait(500);
  const started = Date.now();
  const hungSlept = await Promise.race([command(hung.id, 'sleep'), wait(30000).then(() => 'no answer in 30 s')]);
  check('a page that doesn\'t answer is put to sleep after a while, not waited on for ever', hungSlept === true && await until(() => hung.page.isDestroyed()),
    { hungSlept, seconds: Math.round((Date.now() - started) / 1000) });

  const closed = await command(dirty.id, 'close');
  const gone = await until(() => dirty.page.isDestroyed());
  check('closing the tab yourself still closes a page with unsaved changes', gone, closed);
  check('…with no dialog either (you asked)', dialogs.length === 0, dialogs);

  server.close();
  const failed = checks.filter(c => !c.ok).length;
  console.log(JSON.stringify({ passed: checks.length - failed, failed, checks }, null, 1));
  win.destroy();
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });

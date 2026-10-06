// Private browsing's end and downloads (web-host.cjs) in a real Electron,
// with Core's web host and <webview> tabs as Atmos Browser has them:
// a private page opened while the last one's session is being cleared
// waits for the clearing, and keeps what it stores (R27); a private
// download still running when private browsing ends is forgotten once it
// finishes (R29); two downloads of the same name at once each get a file
// of their own (R30).
//
// Not through Atmos: Electron runs this file as its main process.
// Usage: xvfb-run -a node_modules/.bin/electron scripts/e2e/web-private.cjs --no-sandbox
const electron = require('electron');
const { app, BrowserWindow, session, webContents } = electron;
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const { createWebHost } = require('../../core/js/core/web-host.cjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-private-'));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-private-downloads-'));
app.setPath('userData', home);

const checks = [];
const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === null ? '' : `: ${JSON.stringify(detail)}`}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 5000) {
  for (const end = Date.now() + timeout; Date.now() < end; await wait(50)) if (await test()) return true;
  return false;
}

app.whenReady().then(async () => {
  // Pages that set a cookie, and files that take as long as the test says.
  const held = new Map(); // file name -> responses waiting to finish
  const wasCut = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/file') {
      const name = url.searchParams.get('name');
      // Cut off: Chromium tries to resume it, and the connection drops
      // again (it stays interrupted, and resumable).
      if (wasCut.has(name)) { req.socket.destroy(); return; }
      res.writeHead(200, {
        'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${name}"`, 'content-length': 8192,
        'accept-ranges': 'bytes', etag: '"one"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      });
      res.write('x'.repeat(4096));
      held.set(name, [...(held.get(name) || []), res]);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader('set-cookie', `${url.searchParams.get('tag')}=${url.searchParams.get('tag')}; Path=/`);
    // slow=1: its pagehide takes a while (Atmos waits for a page's last events when it closes it).
    res.end(`<!doctype html><title>Page</title>${url.searchParams.has('slow') ? '<script>addEventListener("pagehide", () => { const end = Date.now() + 1500; while (Date.now() < end); });</script>' : ''}`);
  });
  const cut = name => { wasCut.add(name); for (const res of held.get(name) || []) res.socket.destroy(); held.delete(name); };
  const finish = name => { for (const res of held.get(name) || []) res.end('y'.repeat(4096)); held.delete(name); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const handlers = new Map();
  const testOptions = { filterLists: fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-private-lists-')), downloadsDir };
  const host = createWebHost({
    ...electron,
    ipcMain: { on: (...args) => electron.ipcMain.on(...args), handle: (channel, fn) => handlers.set(channel, fn) },
    isAppUrl: () => true, userData: home, isWebExtension: () => true,
    testOptions,
  });
  app.on('web-contents-created', (_, contents) => { if (host.isWebSession(contents.session)) host.applyPolicy(contents); });
  const win = new BrowserWindow({ width: 900, height: 700, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => host.attachWebview(win.webContents, event, webPreferences, params));
  host.setWindow(win);
  await win.loadURL('data:text/html,<!doctype html><body style="margin:0">');
  // What the web host tells Core's page.
  const events = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => { if (channel === 'web:event') events.push({ type: args[1], payload: args[2] }); return realSend(channel, ...args); };
  const asAtmos = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const command = (id, name, ...args) => handlers.get('web:do')(asAtmos, id, name, ...args);
  const downloads = () => handlers.get('web:downloads')(asAtmos);

  /** A tab as Core's web layer opens one: blank, attached, then sent to its address. */
  async function tab(url, { private: isPrivate = false } = {}) {
    const id = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(isPrivate ? 'atmos-browser-private' : 'persist:atmos-browser')});
      view.setAttribute('src', 'about:blank');
      view.style.cssText = 'width:400px;height:300px';
      view.addEventListener('dom-ready', () => resolve(view.getWebContentsId()), { once: true });
      document.body.append(view);
    })`);
    await command(id, 'attached');
    await command(id, 'navigate', url);
    return id;
  }
  const privateSession = session.fromPartition('atmos-browser-private');

  // R27. Clearing the last private session takes a while (made slow here,
  // as a big profile is); a private page opened meanwhile keeps its cookie.
  const clear = privateSession.clearStorageData.bind(privateSession);
  privateSession.clearStorageData = async (...args) => { await wait(1500); return clear(...args); };
  const first = await tab(`${origin}/page?tag=first`, { private: true });
  await until(() => webContents.fromId(first)?.getURL().includes('tag=first'));
  await command(first, 'close');
  const second = await tab(`${origin}/page?tag=second`, { private: true });
  const ended = await until(() => events.some(event => event.type === 'private-ended'), 10000);
  await until(() => webContents.fromId(second)?.getURL().includes('tag=second'));
  const cookies = await privateSession.cookies.get({});
  check('a private page opened while the last one\'s session is cleared keeps its cookie (R27)', ended && cookies.some(cookie => cookie.value === 'second'),
    { ended, cookies: cookies.map(cookie => cookie.value) });
  check('…and the one before is gone', !cookies.some(cookie => cookie.value === 'first'));

  // R29. A private download still running when private browsing ends.
  await command(second, 'navigate', `${origin}/file?name=secret.bin`);
  const named = name => record => record.url.endsWith(`name=${name}`);
  await until(async () => (await downloads()).some(named('secret.bin')));
  const secret = (await downloads()).find(named('secret.bin'));
  events.length = 0;
  await command(second, 'close');
  await until(() => events.some(event => event.type === 'private-ended'), 10000);
  check('…a private download still running when private browsing ends is still listed while it runs', (await downloads()).some(record => record.id === secret?.id));
  finish('secret.bin');
  await until(() => fs.existsSync(path.join(downloadsDir, 'secret.bin')) && events.some(event => event.type === 'download-removed' && event.payload.id === secret?.id));
  const after = await downloads();
  check('a private download that finishes after private browsing ended is forgotten (R29)', !!secret && !after.some(record => record.id === secret.id),
    after.map(record => `${record.name} ${record.state}`));
  check('…its file is kept', fs.existsSync(path.join(downloadsDir, 'secret.bin')));

  // R27. The last private page closing slowly: a private page opened
  // meanwhile doesn't share what it kept.
  const leaving = await tab(`${origin}/page?tag=leaving&slow=1`, { private: true });
  await until(() => webContents.fromId(leaving)?.getURL().includes('tag=leaving'));
  events.length = 0;
  const leaves = command(leaving, 'close');
  await wait(100);
  const next = await tab(`${origin}/page?tag=next`, { private: true });
  await leaves;
  const endedOnClose = await until(() => events.some(event => event.type === 'private-ended'), 10000);
  await until(() => webContents.fromId(next)?.getURL().includes('tag=next'));
  const jar = (await privateSession.cookies.get({})).map(cookie => cookie.value);
  check('a private page opened while the last one is still closing doesn\'t get what it kept (R27)', endedOnClose && jar.includes('next') && !jar.includes('leaving'),
    { endedOnClose, jar });
  await command(next, 'close');
  await until(() => events.filter(event => event.type === 'private-ended').length === 2, 10000);

  // R27. A clearing that never ends holds new private pages only a while.
  testOptions.privateEndMs = 1000;
  const clearCache = privateSession.clearCache.bind(privateSession);
  privateSession.clearCache = () => new Promise(() => {});
  const stuck = await tab(`${origin}/page?tag=stuck`, { private: true });
  await until(() => webContents.fromId(stuck)?.getURL().includes('tag=stuck'));
  await command(stuck, 'close');
  const asked = Date.now();
  const unstuck = await Promise.race([tab(`${origin}/page?tag=unstuck`, { private: true }), wait(8000).then(() => null)]);
  check('a clearing that never ends holds a new private page only a while (R27)', unstuck !== null, { seconds: (Date.now() - asked) / 1000 });
  privateSession.clearCache = clearCache;
  if (unstuck !== null) await command(unstuck, 'close');

  // R29. One cut off part-way after private browsing ended (resumable, so
  // Electron says it's interrupted, not done).
  delete testOptions.privateEndMs;
  const cutTab = await tab('about:blank', { private: true });
  await command(cutTab, 'navigate', `${origin}/file?name=cut.bin`);
  await until(async () => (await downloads()).some(named('cut.bin')));
  const cutOff = (await downloads()).find(named('cut.bin'));
  events.length = 0;
  await command(cutTab, 'close');
  await until(() => events.some(event => event.type === 'private-ended'), 10000);
  cut('cut.bin');
  await until(async () => !(await downloads()).some(record => record.id === cutOff?.id));
  const left = await downloads();
  check('…and one cut off part-way after it ended is forgotten too (R29)', !!cutOff && !left.some(record => record.id === cutOff.id),
    left.map(record => `${record.name} ${record.state}`));

  // R30. Two downloads of the same name at once.
  // Both started in the same moment, before either's file is on disk
  // (whether Chromium has made it yet is luck; here it never has).
  const [one, two] = await Promise.all([tab('about:blank'), tab('about:blank')]);
  const exists = fs.existsSync;
  fs.existsSync = file => (path.dirname(file) === downloadsDir && path.basename(file).startsWith('report') ? false : exists(file));
  await Promise.all([one, two].map(id => command(id, 'navigate', `${origin}/file?name=report.pdf`)));
  await until(async () => (await downloads()).filter(record => named('report.pdf')(record) && record.path).length === 2);
  fs.existsSync = exists;
  finish('report.pdf');
  await until(async () => (await downloads()).filter(record => named('report.pdf')(record) && record.state === 'completed').length === 2);
  const reports = (await downloads()).filter(named('report.pdf'));
  const files = fs.readdirSync(downloadsDir).filter(name => name.startsWith('report')).sort();
  check('two downloads of the same name at once each get a file of their own (R30)', new Set(reports.map(record => record.path)).size === 2
    && files.length === 2, { paths: reports.map(record => record.path && path.basename(record.path)), files });
  for (const id of [one, two]) await command(id, 'close').catch(() => {});

  // R30. With "Ask where to save" (on by default): each save dialog is
  // offered a name of its own, though neither has a file yet.
  delete testOptions.downloadsDir;
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-web-private-ask-'));
  app.setPath('downloads', askDir);
  const offered = [];
  session.fromPartition('persist:atmos-browser').on('will-download', (_event, item) => setImmediate(() => offered.push(path.basename(item.getSaveDialogOptions().defaultPath || ''))));
  const askOne = await tab(`${origin}/file?name=ask.pdf`);
  await until(() => offered.length === 1);
  await wait(1000);
  const askTwo = await tab(`${origin}/file?name=ask.pdf`);
  await until(() => offered.length === 2);
  check('…and two save dialogs at once are offered a name each (R30)', offered.length === 2 && offered[0] !== offered[1], offered);
  for (const record of (await downloads()).filter(named('ask.pdf'))) await Promise.resolve().then(() => handlers.get('web:download-do')(asAtmos, record.id, 'remove')).catch(() => {});
  for (const id of [askOne, askTwo]) await command(id, 'close').catch(() => {});
  try { fs.rmSync(askDir, { recursive: true, force: true }); } catch { /* the system's temporary folder */ }

  server.close();
  const failed = checks.filter(c => !c.ok).length;
  console.log(JSON.stringify({ passed: checks.length - failed, failed, checks }, null, 1));
  win.destroy();
  // Electron may still be writing in its profile as it goes.
  for (const dir of [home, downloadsDir]) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the system's temporary folder */ }
  app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });

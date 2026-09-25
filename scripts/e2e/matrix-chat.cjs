// Matrix Chat in frames, end to end, against a fake homeserver
// (fake-homeserver.cjs): the one-time fresh start (old devices signed out,
// old key stores deleted, display preferences kept); signing in from the
// Chat panel; the Rooms widget beside Chat only; opening a room from the
// widget; Core-drawn glass; sending, a reaction from the menu's quick row,
// the delete confirmation; an incoming message pinging through the Audio
// service; and the session after a restart.
// Usage: node scripts/e2e/matrix-chat.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv } = require('./isolate.cjs');
const { createHomeserver } = require('./fake-homeserver.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'matrix-chat'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-matrix-');

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(`page: ${e.message}`));
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|VPS unavailable|images\.unsplash\.com/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const framesFor = (page, surface) => page.frames()
  .filter(f => f.url().includes('ext=plugin%3Amatrix-chat') && f.url().includes(`surface=${surface}`));
async function waitFor(page, surface, check = 'true', timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of framesFor(page, surface)) {
      if (await frame.evaluate(check).catch(() => false)) return frame;
    }
    await page.waitForTimeout(150);
  }
  return null;
}
const activate = (page, id) => page.evaluate(async id => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin(id), id);
const savedState = page => page.evaluate(() => JSON.parse(localStorage.getItem('samsara_v4') || '{}').extensionState?.['matrix-chat'] ?? null);
// Open Atmos's sidebar and the Matrix Chat section, as you would.
const openRoomsWidget = page => page.evaluate(async () => {
  (await import('atmos-core/core/sidebar-shell.js')).openSidebar();
  const section = document.getElementById('fin-section-matrix-chat-rooms');
  if (section && !section.classList.contains('open')) section.querySelector('.fin-section-label').click();
  return !!section?.classList.contains('open');
});
const pageDatabases = page => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
const until = async (page, fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await page.waitForTimeout(150);
  }
  return null;
};

const r = {};
(async () => {
  const server = createHomeserver();
  const homeserver = await server.listen();
  server.addToken('old-token');
  r.home = home;

  // 1. What the in-page version left: a signed-in session, display
  //    preferences, and its key store in the Atmos page.
  let s = await launch();
  await s.page.evaluate(async ({ homeserver }) => {
    await new Promise(resolve => {
      const request = indexedDB.open('matrix-js-sdk::matrix-sdk-crypto', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('core');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => resolve();
    });
    const blob = JSON.parse(localStorage.getItem('samsara_v4') || '{}');
    blob.extensionState ??= {};
    const session = { homeserver, userId: '@tester:test', accessToken: 'old-token', deviceId: 'OLDDEVICE' };
    blob.extensionState['matrix-chat'] = { version: 1, data: {
      matrixSession: session, matrixSessions: [session], matrixCryptoStoreOwner: '@tester:test',
      showUsernames: true, chatScale: 1.1, notificationSound: true, railOrder: ['!room:test'],
    } };
    localStorage.setItem('samsara_v4', JSON.stringify(blob));
    Storage.prototype.setItem = () => {}; // nothing else writes before closing
  }, { homeserver });
  r.seededDatabases = await pageDatabases(s.page);
  await s.app.close();

  // 2. Fresh start.
  s = await launch();
  r.list = await s.page.evaluate(async () => {
    const plugins = await window.atmosCore.listPlugins();
    const chat = plugins.find(p => p.id === 'matrix-chat');
    return `${chat.status}/${chat.runtime}`;
  });
  await activate(s.page, 'matrix-chat');
  const login = await waitFor(s.page, 'panel', () => !!document.querySelector('#mx-login-user'));
  r.freshStart = {
    loginShown: !!login,
    oldTokenSignedOut: !!(await until(s.page, async () => server.requests.some(q => q.path.endsWith('/logout') && q.auth === 'old-token'))),
    state: await until(s.page, async () => { const saved = await savedState(s.page); return saved?.data?.framesFreshStart ? saved.data : null; }),
    pageDatabases: await until(s.page, async () => { const names = await pageDatabases(s.page); return names.includes('matrix-js-sdk::matrix-sdk-crypto') ? null : names; }, 8000),
  };
  r.widgetSignedOut = !!(await waitFor(s.page, 'sidebar', () => !!document.querySelector('.mx-rooms-signed-out')));
  r.widgetScope = await s.page.evaluate(async () => {
    const section = document.getElementById('fin-section-matrix-chat-rooms');
    const shownWithChat = section && !section.hidden;
    const registry = await import('atmos-core/core/panel-registry.js');
    const other = registry.listPanelPlugins().find(p => p.id !== 'matrix-chat')?.id;
    registry.activatePanelPlugin(other);
    await new Promise(resolve => setTimeout(resolve, 300));
    const hiddenElsewhere = section?.hidden === true;
    registry.activatePanelPlugin('matrix-chat');
    return { shownWithChat, hiddenElsewhere, other };
  });

  // 3. Sign in from the panel.
  const panel = await waitFor(s.page, 'panel', () => !!document.querySelector('#mx-login-user'));
  await panel.fill('#mx-login-homeserver', homeserver);
  await panel.fill('#mx-login-user', 'tester');
  await panel.fill('#mx-login-pass', 'secret');
  await panel.click('#mx-login-submit');
  r.signedIn = !!(await waitFor(s.page, 'panel', () => !!document.querySelector('.mx-home'), 30000));
  // The widget starts on Home (as the panel does); rooms outside any space
  // are under Spaces → Other rooms.
  r.widgetOpened = await openRoomsWidget(s.page);
  r.widgetStartsOnHome = !!(await waitFor(s.page, 'sidebar', () => document.querySelector('[data-matrix-room-mode="home"]')?.classList.contains('active'), 20000));
  const switcher = await waitFor(s.page, 'sidebar', () => !!document.querySelector('[data-matrix-room-mode="spaces"]'));
  await switcher?.click('[data-matrix-room-mode="spaces"]');
  await waitFor(s.page, 'sidebar', () => !!document.querySelector('.mx-space-group-toggle'), 30000);
  await switcher?.evaluate(() => document.querySelectorAll('.mx-space-group-toggle[aria-expanded="false"]').forEach(toggle => toggle.click())).catch(() => {});
  const rooms = await waitFor(s.page, 'sidebar', () => !!document.querySelector('[data-room-id="!room:test"]')?.offsetParent, 30000);
  r.widgetListsRoom = !!rooms;
  if (!rooms) {
    r.debugWidget = await Promise.all(framesFor(s.page, 'sidebar').map(f => f.evaluate(() => document.body.innerText.slice(0, 300)).catch(e => e.message)));
    r.debugRequests = server.requests.map(q => `${q.method} ${q.path} ${q.status ?? ''}`).slice(0, 60);
    r.debugErrors = s.errors.slice(0, 20);
  }
  await s.page.screenshot({ path: path.join(out, '1-signed-in.png') });

  // 4. Open the room from the widget.
  if (rooms) await rooms.click('[data-room-id="!room:test"]');
  const room = await waitFor(s.page, 'panel', () => document.querySelector('.mx-timeline')?.textContent.includes('Hello from the fake homeserver'), 20000);
  r.roomOpened = !!room;
  r.glass = await until(s.page, () => s.page.evaluate(() => {
    const pieces = [...document.querySelectorAll('.atmos-frame-glass')].map(piece => ({ material: piece.dataset.material, height: piece.offsetHeight, blur: getComputedStyle(piece).backdropFilter }));
    return pieces.length ? pieces : null;
  }));

  // 5. Send a message.
  if (room) {
    await room.fill('#mx-composer-input', 'Sent from the e2e');
    await room.press('#mx-composer-input', 'Enter');
  }
  r.sent = !!(await until(s.page, async () => server.requests.find(q => q.method === 'PUT' && q.path.includes('/send/m.room.message/') && q.body?.body === 'Sent from the e2e')));
  r.sentShown = !!(await waitFor(s.page, 'panel', () => [...document.querySelectorAll('.mx-timeline')].some(el => el.textContent.includes('Sent from the e2e'))));

  // 6. An incoming message pings through the Audio service.
  server.deliver({ type: 'm.room.message', content: { msgtype: 'm.text', body: 'Incoming ping test' } });
  r.incomingShown = !!(await waitFor(s.page, 'panel', () => document.querySelector('.mx-timeline')?.textContent.includes('Incoming ping test')));
  r.ping = await until(s.page, () => s.page.evaluate(async () => {
    const audio = (await import('atmos-core/core/renderer-capabilities.js')).getCapability('media.audio');
    const state = audio?.channel('plugin:matrix-chat').state();
    return state?.source === 'ping' ? { source: state.source, error: state.error } : null;
  }));

  // 7. The message menu: quick reaction row, then Delete asks first.
  const row = room && await room.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-msg-id]')];
    const target = rows.find(el => el.textContent.includes('Incoming ping test'));
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + rect.height / 2 };
  });
  if (row) {
    await room.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, row);
    r.quickRow = await until(s.page, () => s.page.evaluate(() => [...document.querySelectorAll('#ctx-menu .ctx-button, .ctx-menu-surface .ctx-button')].map(b => b.textContent || b.title)));
    await s.page.screenshot({ path: path.join(out, '2-message-menu.png') });
    await s.page.locator('.ctx-button', { hasText: '👍' }).first().click().catch(error => { r.quickRowError = error.message; });
    r.reacted = !!(await until(s.page, async () => server.requests.find(q => q.method === 'PUT' && q.path.includes('/send/m.reaction/') && q.body?.['m.relates_to']?.key === '👍')));
  }
  const ownRow = room && await room.evaluate(() => {
    const target = [...document.querySelectorAll('[data-msg-id]')].find(el => el.textContent.includes('Sent from the e2e'));
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + rect.height / 2 };
  });
  if (ownRow) {
    await room.evaluate(({ x, y }) => {
      document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, ownRow);
    await s.page.waitForTimeout(300);
    await s.page.locator('[data-context-menu-item="delete"]').first().click().catch(error => { r.deleteError = error.message; });
    r.deleteAsks = await until(s.page, () => s.page.evaluate(() => document.querySelector('[data-context-menu-item="cancel"]')?.closest('.ctx-menu-surface, #ctx-menu, div')?.parentElement?.innerText.replace(/\s+/g, ' ').trim() || null));
    await s.page.screenshot({ path: path.join(out, '3-delete-confirm.png') });
    await s.page.locator('[data-context-menu-item="cancel"]').first().click().catch(() => {});
    await s.page.waitForTimeout(500);
    r.notRedacted = !server.requests.some(q => q.path.includes('/redact/'));
  }

  // 8. Restart: signed in again straight away, no second fresh start.
  const logoutsBefore = server.requests.filter(q => q.path.endsWith('/logout')).length;
  await s.app.close();
  s = await launch();
  await activate(s.page, 'matrix-chat');
  await openRoomsWidget(s.page);
  const restartedWidget = await waitFor(s.page, 'sidebar', () => !!document.querySelector('[data-matrix-room-mode="spaces"]'), 30000);
  await restartedWidget?.click('[data-matrix-room-mode="spaces"]').catch(() => {});
  r.afterRestart = {
    home: !!(await waitFor(s.page, 'panel', () => !!document.querySelector('.mx-home'), 30000)),
    widget: !!(await waitFor(s.page, 'sidebar', () => !!document.querySelector('[data-room-id="!room:test"]'), 30000)),
    noSecondSignOut: server.requests.filter(q => q.path.endsWith('/logout')).length === logoutsBefore,
    showUsernames: (await savedState(s.page))?.data?.showUsernames,
  };
  await s.page.screenshot({ path: path.join(out, '4-after-restart.png') });
  r.errors = s.errors.filter(e => !/push rule|pending `\/keys\/query`/.test(e)).slice(0, 30);
  await s.app.close();
  await server.close();
  r.unhandledPaths = [...new Set(server.requests.filter(q => q.status === 404).map(q => q.path))];
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(async error => {
  console.error(error);
  console.log(JSON.stringify(r, null, 2));
  process.exit(1);
});

// Matrix Chat in frames, end to end, against a fake homeserver
// (fake-homeserver.cjs): the one-time fresh start (old devices signed out,
// old key stores deleted, display preferences kept); signing in from the
// Chat panel; the Rooms widget beside Chat only; opening a room from the
// widget; Core-drawn glass; sending, a reaction from the menu's quick row,
// the delete confirmation; an incoming message pinging through the Audio
// service; rev/ commands in Atmos's command bar (typed in the message bar,
// answered by the background frame: go, notifications, invite, leave,
// create-room with its options, rev/go from another panel); and the session
// after a restart.
// Usage: node scripts/e2e/matrix-chat.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, savedFrameState, forgetFrameState, atmosWindow } = require('./isolate.cjs');
const { createHomeserver } = require('./fake-homeserver.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'matrix-chat'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-matrix-');

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
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
// Matrix Chat's atmos.state, as saved (its own file; written shortly after a change).
const savedState = async page => {
  await page.waitForTimeout(400);
  const data = savedFrameState(installRoot, 'plugin', 'matrix-chat');
  return data ? { data } : null;
};
// Open Atmos's sidebar and the Matrix Chat section, as you would.
const openRoomsWidget = page => page.evaluate(async () => {
  (await import('atmos-core/core/sidebar-shell.js')).openSidebar();
  const section = document.getElementById('fin-section-matrix-chat-rooms');
  if (section && !section.classList.contains('open')) section.querySelector('.fin-section-label').click();
  return !!section?.classList.contains('open');
});
const pageDatabases = page => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
// The mouse and keyboard as the user has them: a frame's own focus calls
// (frame.fill) don't reliably move the keyboard into an out-of-process frame.
async function clickIn(page, frame, selector) {
  const where = () => frame.evaluate(sel => {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    return rect && rect.width ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  }, selector).catch(() => null);
  // Where it is once it has stopped moving (a form sliding in, a notice above it appearing).
  let point = await where();
  for (let tries = 0; point && tries < 20; tries += 1) {
    await page.waitForTimeout(100);
    const again = await where();
    if (again && again.x === point.x && again.y === point.y) break;
    point = again;
  }
  const box = await (await frame.frameElement()).boundingBox();
  if (!point || !box) return false;
  await page.mouse.click(box.x + point.x, box.y + point.y);
  await page.waitForTimeout(150);
  return true;
}
async function typeIn(page, frame, selector, text) {
  // Typed again if the keys didn't land in the field (the click missed it).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await frame.evaluate(sel => { document.querySelector(sel).value = ''; }, selector);
    const clicked = await clickIn(page, frame, selector);
    await page.keyboard.type(text, { delay: 15 });
    const value = await frame.evaluate(sel => document.querySelector(sel)?.value, selector).catch(() => null);
    if (value === text) return clicked;
    await page.waitForTimeout(400);
  }
  return false;
}
const until = async (page, fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await page.waitForTimeout(150);
  }
  return null;
};

/** Atmos's command bar as it stands: its field, the rows and options it lists, what it last said. */
const bar = page => page.evaluate(() => {
  const field = document.getElementById('command-bar-field');
  const input = field?.isConnected ? document.getElementById('command-bar-input') : null;
  const list = document.getElementById('command-bar-list');
  const box = element => {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const chipText = chip => [...chip.childNodes].map(node => (node.tagName === 'INPUT' ? node.value
    : node.tagName === 'SELECT' ? node.selectedOptions[0]?.textContent : node.textContent)).join('').replace(/\s+/g, ' ').trim();
  return {
    open: !!input,
    focused: !!input && document.activeElement === input,
    value: input?.value ?? null,
    own: field?.isConnected ? field.classList.contains('is-own') : null,
    field: box(field),
    rows: [...(list?.querySelectorAll('.command-bar-item') || [])].map(item => ({
      title: item.querySelector('.command-bar-item-title')?.firstChild?.textContent.trim() || '',
      sub: item.querySelector('.command-bar-item-sub')?.textContent.trim() || '',
      source: item.querySelector('.command-bar-item-source')?.textContent.trim() || '',
      danger: item.classList.contains('danger'),
    })),
    notes: [...(list?.querySelectorAll('.command-bar-note') || [])].map(note => note.textContent.trim()),
    chips: [...(list?.querySelectorAll('.command-bar-chip') || [])].map(chip => `${chipText(chip)}${chip.classList.contains('on') ? '*' : ''}`),
    status: list?.querySelector('.command-bar-status')?.textContent.trim() || null,
    flash: document.querySelector('.command-bar-flash')?.textContent.trim() || null,
  };
});

async function commands(s, server) {
  const out_ = {};
  const page = s.page;
  const keys = async text => { await page.keyboard.type(text, { delay: 30 }); await page.waitForTimeout(500); };
  const key = async name => { await page.keyboard.press(name); await page.waitForTimeout(400); };
  const barUntil = (test, timeout = 8000) => until(page, async () => { const now = await bar(page); return test(now) ? now : null; }, timeout);
  const clickChip = async label => {
    const point = await page.evaluate(text => {
      const chip = [...document.querySelectorAll('#command-bar-list .command-bar-chip')].find(element => element.textContent.trim() === text);
      const rect = chip?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    }, label);
    if (point) await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(600);
    return !!point;
  };
  const rowsOf = now => now?.rows.map(row => `${row.title}${row.sub ? ` · ${row.sub}` : ''}${row.source ? ` (${row.source})` : ''}${row.danger ? ' !' : ''}`);

  const chat = await waitFor(page, 'panel', () => !!document.querySelector('#mx-composer-input'));
  if (!chat) return { chat: false };
  await clickIn(page, chat, '#mx-composer-input');
  await page.keyboard.type('rev/', { delay: 40 });
  const handed = await barUntil(now => now.open && now.focused);
  const frame = await page.evaluate(() => {
    const element = document.querySelector('iframe.atmos-extension-frame-panel[data-extension="plugin:matrix-chat"]');
    const rect = element?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top } : null;
  });
  const composer = await chat.evaluate(() => {
    const rect = document.querySelector('.mx-composer').getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  out_.handedOver = { bar: handed?.value ?? null, composer: await chat.evaluate(() => document.querySelector('#mx-composer-input').value) };
  out_.overComposer = !!(handed?.field && frame && handed.own === false
    && Math.abs(handed.field.top - (frame.top + composer.top)) <= 2 && Math.abs(handed.field.height - composer.height) <= 2
    && Math.abs(handed.field.left - (frame.left + composer.left)) <= 2);
  if (!out_.overComposer) out_.overComposerDetail = { field: handed?.field, own: handed?.own, frame, composer };
  out_.listed = rowsOf(handed)?.slice(0, 10);
  await page.screenshot({ path: path.join(out, '4-commands.png') });

  // rev/go: your rooms, listed by the background frame.
  await keys('go te');
  out_.go = rowsOf(await barUntil(now => now.rows.some(row => row.title === 'Test Room')));
  // rev/leave lists what it would do, marked; nothing happens until it's chosen.
  await key('Escape');
  await keys('leave');
  await key('Enter');
  out_.leave = rowsOf(await barUntil(now => now.rows.some(row => row.danger)));
  // rev/notifications: Enter gives it a space, its row says what it would do, Enter does it.
  await key('Escape');
  await keys('notif');
  await key('Enter');
  out_.notifications = rowsOf(await barUntil(now => now.rows.some(row => /^Ping sound/.test(row.title))));
  await key('Enter');
  out_.notificationsDone = (await barUntil(now => !now.open && now.flash))?.flash ?? null;
  out_.soundSaved = (await savedState(page))?.data?.notificationSound;

  // rev/invite, from the open room, to the homeserver.
  await key('Alt+Backslash');
  await keys('invite @friend2:test');
  out_.invite = rowsOf(await barUntil(now => now.rows.some(row => row.title === 'Invite @friend2:test')));
  await key('Enter');
  out_.invited = {
    flash: (await barUntil(now => !now.open && now.flash))?.flash ?? null,
    request: !!server.requests.find(q => q.method === 'POST' && decodeURIComponent(q.path).endsWith('/rooms/!room:test/invite') && q.body?.user_id === '@friend2:test'),
  };

  // rev/create-room: its options as chips; public asks for an address.
  await key('Alt+Backslash');
  await keys('create-room Plugin Showcase');
  const create = await barUntil(now => now.chips.length > 0);
  out_.createRow = rowsOf(create);
  out_.createChips = create?.chips;
  out_.publicChip = await clickChip('public');
  const publicNow = await barUntil(now => now.chips.some(chip => chip.startsWith('#')));
  out_.publicChips = publicNow?.chips;
  await page.screenshot({ path: path.join(out, '5-create-room.png') });
  await key('Enter');
  const created = await until(page, async () => server.requests.find(q => q.method === 'POST' && q.path.endsWith('/createRoom')));
  out_.created = created ? {
    name: created.body?.name, preset: created.body?.preset, alias: created.body?.room_alias_name, visibility: created.body?.visibility,
    encrypted: (created.body?.initial_state || []).some(item => item.type === 'm.room.encryption'),
  } : null;
  out_.closedAfterCreate = !(await bar(page)).open;

  // rev/go from another panel: the Chat panel comes back with the room.
  const other = await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().find(panel => panel.id !== 'matrix-chat')?.id);
  await activate(page, other);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.activeElement?.blur?.());
  await key('Alt+Backslash');
  await keys('go test');
  out_.elsewhere = { from: other, rows: rowsOf(await barUntil(now => now.rows.some(row => row.title === 'Test Room'))) };
  await key('Enter');
  out_.elsewhere.backInChat = !!(await until(page, () => page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).getActivePanelPluginId() === 'matrix-chat')));
  out_.elsewhere.roomShown = !!(await waitFor(page, 'panel', () => document.querySelector('.mx-timeline')?.textContent.includes('Hello from the fake homeserver'), 15000));
  return out_;
}

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
  // This setup run's framed Matrix Chat saved its own state already; forget
  // it, so the next start takes what the page left, as on a first start.
  forgetFrameState(installRoot, 'plugin', 'matrix-chat');

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
  await typeIn(s.page, panel, '#mx-login-homeserver', homeserver);
  // Leaving the field, the form asks the homeserver how to sign in, then
  // shows the password fields.
  await s.page.keyboard.press('Tab');
  await s.page.waitForTimeout(800);
  await panel.waitForFunction(() => {
    const password = document.querySelector('[data-part="password"]');
    return password && !password.hidden && document.querySelector('[data-part="checking"]')?.hidden;
  }, null, { timeout: 20000 });
  await typeIn(s.page, panel, '#mx-login-user', 'tester');
  await typeIn(s.page, panel, '#mx-login-pass', 'secret');
  await clickIn(s.page, panel, '#mx-login-submit');
  // Signed in: the panel shows the empty view (no room open yet) and its message bar.
  r.signedIn = !!(await waitFor(s.page, 'panel', () => !!document.querySelector('.mx-empty-view .mx-composer'), 30000));
  // The widget is one list of groups; rooms outside any space are under Other rooms.
  r.widgetOpened = await openRoomsWidget(s.page);
  const groups = await waitFor(s.page, 'sidebar', () => !!document.querySelector('.mx-space-group-toggle'), 30000);
  await groups?.evaluate(() => document.querySelectorAll('.mx-space-group-toggle[aria-expanded="false"]').forEach(toggle => toggle.click())).catch(() => {});
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
    await typeIn(s.page, room, '#mx-composer-input', 'Sent from the e2e');
    await s.page.keyboard.press('Enter');
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

  // 8. rev/ commands: typed in the message bar, rev/ goes to Atmos's command
  //    bar, which opens over the bar; Matrix Chat's background frame answers
  //    (src/ui/command-handlers.js).
  r.commands = await commands(s, server);

  // 9. Restart: signed in again straight away, no second fresh start.
  const logoutsBefore = server.requests.filter(q => q.path.endsWith('/logout')).length;
  await s.app.close();
  s = await launch();
  await activate(s.page, 'matrix-chat');
  await openRoomsWidget(s.page);
  const restartedWidget = await waitFor(s.page, 'sidebar', () => !!document.querySelector('.mx-space-group-toggle'), 30000);
  await restartedWidget?.evaluate(() => document.querySelectorAll('.mx-space-group-toggle[aria-expanded="false"]').forEach(toggle => toggle.click())).catch(() => {});
  r.afterRestart = {
    lastRoom: !!(await waitFor(s.page, 'panel', () => document.querySelector('.mx-timeline')?.textContent.includes('Hello from the fake homeserver'), 30000)),
    widget: !!(await waitFor(s.page, 'sidebar', () => !!document.querySelector('[data-room-id="!room:test"]'), 30000)),
    noSecondSignOut: server.requests.filter(q => q.path.endsWith('/logout')).length === logoutsBefore,
  };
  await s.page.screenshot({ path: path.join(out, '6-after-restart.png') });
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

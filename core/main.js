const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen, protocol, session, Notification, net, webContents, WebContentsView, nativeImage, utilityProcess, powerMonitor, nativeTheme } = require('electron');
const fs   = require('fs');
const path = require('path');

const { createExtensionHost, checkCompatibility, ACTIVATION_TIMEOUT_MS } = require('./js/core/extension-host.cjs');
const { createExtensionPreferences } = require('./js/core/extension-preferences.cjs');
const { createExtensionCatalog } = require('./js/core/extension-catalog.cjs');
const { createExtensionTrust } = require('./js/core/extension-trust.cjs');
const { loadTrustedKeys } = require('./js/core/extension-signing.cjs');
const links = require('./js/core/extension-links.cjs');
const { openStartupSplash } = require('./js/core/startup-splash.cjs');
const { readBootMessages, pickBootMessage } = require('./js/core/boot-messages.cjs');
const { resolveDependencies, dependentsOf, normalizeDependencies, refOf } = require('./js/core/extension-dependencies.cjs');
const { createExtensionManager } = require('./js/core/extension-manager.cjs');
const { createAtmosUpdater, spawnDetached } = require('./js/core/atmos-update.cjs');
const { createSourceFetch } = require('./js/core/source-fetch.cjs');
const { createExtensionStateStore } = require('./js/core/extension-state.cjs');
const { BASELINE_BROWSER, SYSTEM_INVOKES, exportDetails, describeExports, sharingRisk } = require('./js/core/extension-permissions.cjs');
const { createLocationGate } = require('./js/core/location-gate.cjs');
const { createExtensionFetch } = require('./js/core/extension-fetch.cjs');
const frames = require('./js/core/extension-frames.cjs');
const { resolveContainedPath } = require('./js/core/path-security.cjs');
const { createWebHost } = require('./js/core/web-host.cjs');
const { fromAtmosPage, pageOnly } = require('./js/core/ipc-gate.cjs');
const { mimeFor: _mimeFor } = require('./js/core/protocol-files.cjs');
const { createInvokeAuthorizer } = require('./js/core/invoke-authorizer.cjs');
const { APP_ORIGIN: _APP_ORIGIN, isAppUrl: _isAppUrl, originOf: _originOf, mayOpenExternally, guardContents } = require('./js/core/app-navigation.cjs');
const { createFrameAccess, createAtmosExtHandler } = require('./js/core/atmos-ext-protocol.cjs');

let _extensionPreferences = null;
let _startupDisabled = { plugin: new Set(), service: new Set() };
const _windowResizeSessions = new WeakMap();

// A detached Windows launch can outlive the terminal that supplied stdout.
// Do not turn a diagnostic write to that closed pipe into an app crash.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'atmos-resource',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    // atmos-app:// serves the app shell itself (index.html + js/ + css/ +
    // assets/) instead of loading it over file://. This exists purely to
    // give the renderer a STABLE origin. When loaded via file://, Chromium
    // partitions localStorage/IndexedDB by the full path of the loading
    // file — fine for a normal install, but fatal for a portable exe: each
    // launch self-extracts to a new random %TEMP%\<random>\resources\app
    // folder, so the file:// origin (and therefore the storage partition)
    // is different every single run, and everything persist.js writes
    // becomes unreachable the moment that temp folder gets cleaned up.
    // atmos-app://local/... is the same origin every launch regardless of
    // where the exe unpacked itself, so localStorage/IndexedDB now live in
    // one consistent place on disk. `standard: true` is required so
    // relative paths in index.html (script src="js/...", href="css/...")
    // resolve the normal way instead of erroring.
    scheme: 'atmos-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    // atmos-ext://<host>/ serves framed extensions (see
    // js/core/extension-frames.cjs). Each host is its own origin, so its own
    // storage partition, and nothing on it can reach the Atmos page.
    // None of the atmos-* schemes bypass CSP, so a frame's policy also
    // decides which Atmos resources it may load.
    scheme: 'atmos-ext',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// What the atmos-* protocols serve from disk: protocol-files.cjs.

/**
 * The Atmos page's Content-Security-Policy. The page holds the preload
 * bridges and checks every extension's SDK calls, so it runs only Atmos's
 * own files: no inline scripts (only the import map, by its hash), no
 * eval, no plugins. Frames are atmos-ext://; images and media also come
 * from blobs, data URLs and atmos-resource://; the network reaches only
 * what the system services declare (Location's geocoding). Styles may be
 * inline (Core sets element styles throughout). Built once, on first use.
 */
let _appPageCspValue = null;
function _appPageCsp() {
  if (_appPageCspValue) return _appPageCspValue;
  const crypto = require('crypto');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  // The browser hashes the script's text after the HTML parser has turned
  // CR and CRLF into LF, so the file's own line endings must not reach the
  // hash: a checkout with Windows endings would otherwise block the import
  // map, and with it every system service (0.14.0's installer did).
  const importMapText = importMap ? importMap[1].replace(/\r\n?/g, '\n') : '';
  const importMapHash = importMap ? `'sha256-${crypto.createHash('sha256').update(importMapText).digest('base64')}'` : '';
  const hosts = new Set();
  for (const entry of _catalog.list('services').filter(item => item.tier === 'system')) {
    for (const host of entry.manifest?.permissions?.network || []) {
      if (typeof host === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(host)) hosts.add(`https://${host}`);
    }
  }
  _appPageCspValue = [
    "default-src 'self'",
    `script-src 'self' ${importMapHash}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: atmos-ext: atmos-resource:",
    "media-src 'self' data: blob: atmos-resource:",
    "font-src 'self' data: blob:",
    `connect-src 'self' data: blob: atmos-resource: ${[...hosts].join(' ')}`.trim(),
    // Frames are atmos-ext:// only; the main process's navigation guard
    // (will-frame-navigate) refuses anything else. http(s) is listed so
    // that guard, not this policy, blocks a frame navigating itself away:
    // the frame then stays as it was instead of turning into an error page.
    'frame-src atmos-ext: https: http:',
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return _appPageCspValue;
}

/** Serves atmos-app://local/<path> by reading straight out of the app
 *  bundle directory (__dirname) — same files loadFile('index.html') used
 *  to read directly, just fronted by a scheme with a fixed origin instead
 *  of a file:// path that moves every portable-mode launch. See the scheme
 *  registration comment above for why this exists. Registered once, at
 *  app.whenReady() time, same pattern as the other two protocols. */
function _registerAtmosAppProtocol() {
  protocol.handle('atmos-app', async (request) => {
    try {
      const url = new URL(request.url); // atmos-app://local/<path>
      let rel = decodeURIComponent(url.pathname || '/');
      if (rel === '' || rel === '/') rel = '/index.html';
      // Core's hidden storage page (see _withStoragePage): empty; its frames
      // see the storage extensions' frames use in the Atmos window.
      if (rel === '/__atmos/storage.html') {
        return new Response('<!doctype html><title></title><body></body>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      const filePath = resolveContainedPath(__dirname, rel);

      // Guard against escaping the app directory via a crafted '..' path.
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }

      const buf = await fs.promises.readFile(filePath);
      const headers = { 'Content-Type': _mimeFor(filePath) };
      if (rel === '/index.html') headers['Content-Security-Policy'] = _appPageCsp();
      return new Response(buf, { status: 200, headers });
    } catch (e) {
      console.error('[main] atmos-app protocol error:', e.message, request.url);
      return new Response('Not found', { status: 404 });
    }
  });
}


const DEFAULT_WINDOW_BOUNDS = { width: 1280, height: 800 };
const WINDOW_STATE_FILENAME = 'window-state.json';
const WINDOW_APPEARANCE_FILENAME = 'window-appearance.json';
let _windowAppearance = { transparent: false };

function _loadWindowAppearance() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), WINDOW_APPEARANCE_FILENAME), 'utf8'));
    return { transparent: saved?.transparent === true };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[main] unable to restore window appearance:', error.message);
    return { transparent: false };
  }
}

function _saveWindowAppearance() {
  try {
    const target = path.join(app.getPath('userData'), WINDOW_APPEARANCE_FILENAME);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(_windowAppearance, null, 2));
    fs.renameSync(temporary, target);
  } catch (error) {
    console.warn('[main] unable to save window appearance:', error.message);
    throw error;
  }
}

function _loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), WINDOW_STATE_FILENAME), 'utf8'));
    const bounds = state?.bounds;
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return {};

    // A monitor may have been disconnected since the previous session. Only
    // restore an explicit position if some current display still intersects it.
    const intersectsDisplay = Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
      screen.getAllDisplays().some(({ bounds: display }) =>
        bounds.x < display.x + display.width && bounds.x + bounds.width > display.x &&
        bounds.y < display.y + display.height && bounds.y + bounds.height > display.y);

    return {
      bounds: {
        width: Math.max(400, Math.round(bounds.width)),
        height: Math.max(300, Math.round(bounds.height)),
        ...(intersectsDisplay ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : {}),
      },
      isMaximized: state.isMaximized === true,
      isFullScreen: state.isFullScreen === true,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[main] unable to restore window state:', error.message);
    return {};
  }
}

function _saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const statePath = path.join(app.getPath('userData'), WINDOW_STATE_FILENAME);
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    }, null, 2));
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    console.warn('[main] unable to save window state:', error.message);
  }
}

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[main] preload path:', preloadPath);
  console.log('[main] preload exists:', fs.existsSync(preloadPath));

  const windowState = _loadWindowState();
  const transparentWindow = _windowAppearance.transparent === true;

  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    ...windowState.bounds,
    fullscreen: windowState.isFullScreen,
    frame: false,
    transparent: transparentWindow,
    backgroundColor: transparentWindow ? '#00000000' : '#050505',
    resizable: true,
    roundedCorners: true,
    hasShadow: false,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      // The preload needs only Electron's renderer modules (contextBridge,
      // ipcRenderer, webUtils), which a sandboxed preload has.
      sandbox:          true,
      preload:          preloadPath,
      // Atmos Browser's pages are <webview>s Core's web layer makes in this
      // page; will-attach-webview (web-host.cjs) fixes what each one runs
      // with, and refuses any other.
      webviewTag:       true,
    }
  });
  win.__atmosTransparentWindow = transparentWindow;
  _web.setWindow(win);
  // Its first paint is the page's boot splash, the same picture as the
  // startup splash above it: that one can go now.
  win.once('ready-to-show', _closeStartupSplash);
  win.webContents.once('did-fail-load', _closeStartupSplash);
  win.once('closed', _closeStartupSplash);

  if (windowState.isMaximized && !windowState.isFullScreen) win.maximize();

  let saveTimer;
  const scheduleWindowStateSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => _saveWindowState(win), 250);
  };
  win.on('resize', scheduleWindowStateSave);
  win.on('move', scheduleWindowStateSave);
  const syncFullscreenState = () => {
    scheduleWindowStateSave();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('fullscreen-changed', win.isFullScreen());
    }
  };
  const syncMaximizedState = () => {
    scheduleWindowStateSave();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('maximized-changed', win.isMaximized());
    }
  };
  win.on('enter-full-screen', syncFullscreenState);
  win.on('leave-full-screen', syncFullscreenState);
  win.on('maximize', syncMaximizedState);
  win.on('unmaximize', syncMaximizedState);
  win.on('close', () => {
    clearTimeout(saveTimer);
    _saveWindowState(win);
  });
  // Windows is shutting down or signing out: no installer is started on
  // the way out (it could be stopped halfway).
  win.on('session-end', () => { _sessionEnding = true; });

  win.webContents.on('before-input-event', (event, input) => {
    // DevTools only when running from source, or started with --devtools:
    // otherwise, in an installed Atmos, they'd be a console on the page
    // that holds every bridge.
    if (input.key === 'F12' && input.type === 'keyDown' && (!app.isPackaged || process.argv.includes('--devtools'))) {
      win.webContents.isDevToolsOpened()
        ? win.webContents.closeDevTools()
        : win.webContents.openDevTools({ mode: 'detach' });
    }
    // Ctrl+R reloads what has the keyboard: an extension's frame (its
    // panel, widget or settings page) by itself; Atmos Browser's panel
    // reloads its tab (the browser takes the key); Atmos's own page, all of
    // Atmos (as rev/reload does).
    if (input.key === 'r' && input.control && !input.alt && !input.meta && input.type === 'keyDown') {
      const frame = _topFrameOf(win.webContents.focusedFrame, win.webContents.mainFrame);
      if (frame && _isWebExtensionFrame(frame)) return;
      event.preventDefault();
      if (frame && frame.origin?.startsWith('atmos-ext://')) frame.reload();
      else if (!frame) _reloadAtmos(win);
    }
  });

  Menu.setApplicationMenu(null);

  win.webContents.on('preload-error', (_, preloadPath, error) => {
    console.error('[main] preload-error:', preloadPath, error);
  });

  win.webContents.on('console-message', (_, _level, message) => {
    console.log('[renderer]', message);
  });

  win.loadURL(`atmos-app://local/index.html${_bootMessage ? `?boot=${_bootMessage.index}` : ''}`);
}

// ── Who may call ──────────────────────────────────────────────────────────────
// Every channel in this file answers the Atmos page and nothing else
// (ipc-gate.cjs): each registers through _page, never ipcMain directly
// (ipc-gate.test.cjs checks). The window controls below act on the sender's
// window, which for one of Atmos Browser's tabs is the Atmos window too.
const _page = pageOnly(ipcMain, event => _fromAtmosPage(event));

// ── Client certificates ───────────────────────────────────────────────────────
// A site that asks for a TLS client certificate gets none. Electron's
// default is to answer with the first certificate in the store, without a
// word: on a work or eID computer that's your name, employer and a stable
// identifier, to any https site in Atmos Browser (an ordinary or a private
// tab) and to anything else Atmos loads. Nothing in Atmos uses one; a site
// that needs one says it couldn't sign you in.
app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

// ── Window controls ───────────────────────────────────────────────────────────

_page.handle('toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const fullscreen = !win.isFullScreen();
  win.setFullScreen(fullscreen);
  return fullscreen;
});

// package.json sits at the repo root, outside the core/ folder atmos-app://
// serves, so the renderer asks for the version instead of fetching it.
_page.handle('app:version', () => app.getVersion());

_page.handle('is-fullscreen', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
});

_page.handle('is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

_page.handle('task-view:capture-preview', async (event, requestedRect) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
  const contentBounds = win.getContentBounds();
  const values = ['x', 'y', 'width', 'height'].map(key => Number(requestedRect?.[key]));
  if (!values.every(Number.isFinite)) return null;

  const x = Math.max(0, Math.min(contentBounds.width - 1, Math.round(values[0])));
  const y = Math.max(0, Math.min(contentBounds.height - 1, Math.round(values[1])));
  const width = Math.max(1, Math.min(contentBounds.width - x, Math.round(values[2])));
  const height = Math.max(1, Math.min(contentBounds.height - y, Math.round(values[3])));
  try {
    let image = await win.webContents.capturePage({ x, y, width, height });
    const size = image.getSize();
    if (size.width > 720) image = image.resize({ width: 720, quality: 'good' });
    return `data:image/jpeg;base64,${image.toJPEG(76).toString('base64')}`;
  } catch (error) {
    console.warn('[main] task-view preview capture failed:', error.message);
    return null;
  }
});

_page.handle('window-effects:get', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    active: win?.__atmosTransparentWindow === true,
    configured: _windowAppearance.transparent === true,
  };
});

_page.handle('window-effects:set-transparent', (event, enabled) => {
  _windowAppearance = { transparent: enabled === true };
  _saveWindowAppearance();
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    active: win?.__atmosTransparentWindow === true,
    configured: _windowAppearance.transparent,
  };
});

_page.on('win-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

_page.on('win-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});

_page.on('win-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

_page.on('set-window-click-through', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(enabled === true, enabled === true ? { forward: true } : undefined);
});

_page.on('window-resize:start', (event, direction, screenX, screenY) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  if (!/^(n|s|e|w|ne|nw|se|sw)$/.test(direction)) return;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  _windowResizeSessions.set(event.sender, {
    direction,
    screenX,
    screenY,
    bounds: win.getBounds(),
  });
});

_page.on('window-resize:update', (event, screenX, screenY) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const session = _windowResizeSessions.get(event.sender);
  if (!win || win.isDestroyed() || !session || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return;

  const dx = Math.round(screenX - session.screenX);
  const dy = Math.round(screenY - session.screenY);
  const start = session.bounds;
  const next = { ...start };
  if (session.direction.includes('e')) next.width = Math.max(400, start.width + dx);
  if (session.direction.includes('s')) next.height = Math.max(300, start.height + dy);
  if (session.direction.includes('w')) {
    next.width = Math.max(400, start.width - dx);
    next.x = start.x + start.width - next.width;
  }
  if (session.direction.includes('n')) {
    next.height = Math.max(300, start.height - dy);
    next.y = start.y + start.height - next.height;
  }
  win.setBounds(next, false);
});

_page.on('window-resize:end', event => {
  _windowResizeSessions.delete(event.sender);
});

// ── Extension discovery ──────────────────────────────────────────────────
// Bundled extensions ship with Atmos: resources/extensions/{plugins,services}
// in a build, or the repo's plugins/ and services/ when running from source.
// Unpackaged, launching with --extensions-root=<dir> bundles <dir>/plugins
// and <dir>/services instead (development and the end-to-end checks). The
// system services are not bundled extensions: they are part of Core
// (core/system).
//
// Installed extensions live in %APPDATA%/atmos/{plugins,services}. One
// signed with an official key (core/trusted-keys.json) is first-party
// ("official") there too, and the highest official version of an id wins;
// anything else installed is third-party ("community"). See
// extension-catalog.cjs and extension-signing.cjs. The handlers below only
// list what is present; frames load extensions' files over atmos-ext://.
const _installedRoots = {};

function _bundledRoot(kind) {
  // Bundled extensions are official, so a packaged Atmos never takes them from elsewhere.
  const flag = app.isPackaged ? null : process.argv.find(arg => arg.startsWith('--extensions-root='));
  if (flag) return path.join(path.resolve(flag.slice('--extensions-root='.length)), kind);
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extensions', kind)
    : path.join(__dirname, '..', kind);
}

function _installBase() {
  let base;
  if      (process.platform === 'win32')  base = process.env.APPDATA;
  else if (process.platform === 'darwin') base = path.join(process.env.HOME, 'Library', 'Application Support');
  else                                    base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
  return path.join(base, 'atmos');
}

// Services used to be installed in a singular "service" folder. Move it to
// "services" once; if that fails (a file held open, say), keep using the old
// folder for this session rather than starting with no services.
function _migrateLegacyServicesDir(base) {
  const current = path.join(base, 'services');
  const legacy = path.join(base, 'service');
  if (!fs.existsSync(legacy)) return current;
  try {
    const isEmpty = dir => fs.readdirSync(dir).length === 0;
    if (fs.existsSync(current) && isEmpty(current)) fs.rmdirSync(current);
    if (!fs.existsSync(current)) {
      fs.renameSync(legacy, current);
      console.log(`[main] moved installed services: ${legacy} -> ${current}`);
    } else if (isEmpty(legacy)) {
      fs.rmdirSync(legacy);
    } else {
      console.warn(`[main] both ${legacy} and ${current} exist; loading ${current}. Merge or remove the old folder.`);
    }
    return current;
  } catch (error) {
    console.warn(`[main] could not move ${legacy} to ${current}; using the old folder this session:`, error.message);
    return legacy;
  }
}

/** %APPDATA%/atmos/<kind> — where users add their own (third-party) extensions. */
function _installedRoot(kind) {
  if (_installedRoots[kind]) return _installedRoots[kind];
  const base = _installBase();
  const dir = kind === 'services' ? _migrateLegacyServicesDir(base) : path.join(base, kind);
  fs.mkdirSync(dir, { recursive: true });
  _installedRoots[kind] = dir;
  return dir;
}

// Keys whose signatures make an extension official. Unpackaged (development
// and end-to-end runs only), --trusted-keys=<file> or ATMOS_TRUSTED_KEYS adds
// a list of test keys; a packaged Atmos trusts only its own list.
function _trustedKeyFiles() {
  const files = [path.join(__dirname, 'trusted-keys.json')];
  if (!app.isPackaged) {
    const flag = process.argv.find(arg => arg.startsWith('--trusted-keys='));
    const extra = flag ? flag.slice('--trusted-keys='.length) : process.env.ATMOS_TRUSTED_KEYS;
    if (extra) files.push(path.resolve(extra));
  }
  return files;
}
const _trustedKeys = loadTrustedKeys(_trustedKeyFiles());

// The extension manager (extension-manager.cjs): sources, and install /
// update / remove applied at the next start. Unpackaged, --extension-source=
// (or ATMOS_EXTENSION_SOURCE) adds a source for this session.
function _sessionSources() {
  if (app.isPackaged) return [];
  const flag = process.argv.find(arg => arg.startsWith('--extension-source='));
  const value = flag ? flag.slice('--extension-source='.length) : process.env.ATMOS_EXTENSION_SOURCE;
  return value ? [value] : [];
}

// How long a main.cjs activate() may take (extension-host.cjs). Unpackaged,
// --activation-timeout=<ms> changes it, so end-to-end runs needn't wait.
function _activationTimeoutMs() {
  const flag = app.isPackaged ? null : process.argv.find(arg => arg.startsWith('--activation-timeout='));
  const value = flag ? Number(flag.slice('--activation-timeout='.length)) : NaN;
  return Number.isFinite(value) && value > 0 ? value : ACTIVATION_TIMEOUT_MS;
}

// An installer carries Core and the system services built in; every other
// extension is a package. A release build downloads them from the official
// source (core/extension-sources.json, the GitHub releases); a personal
// build also carries its own as signed packages in
// resources/extensions/packages (scripts/after-pack.cjs), "Comes with
// Atmos", which then serve the first run and upgrades offline. Unpackaged,
// --seed-packages=<dir> stands in for those.
function _seedSources() {
  let location = null;
  if (app.isPackaged) location = path.join(process.resourcesPath, 'extensions', 'packages');
  else {
    const flag = process.argv.find(arg => arg.startsWith('--seed-packages='));
    if (flag) location = path.resolve(flag.slice('--seed-packages='.length));
  }
  return location && fs.existsSync(path.join(location, 'index.json')) ? [{ location, name: 'Comes with Atmos' }] : [];
}

const _BUILT_IN_SOURCES_FILE = path.join(__dirname, 'extension-sources.json');

// The extensions Atmos itself ships with (core/built-in-extensions.json):
// Atmos Browser. An installer carries them (scripts/after-pack.cjs), so they
// are there from the first start, never offered in the picker, switched off
// rather than removed, and the built-in panel is the one Atmos opens on. Only
// an official copy counts: a community extension can't take the id.
function _loadBuiltIn() {
  const out = { plugin: new Set(), service: new Set() };
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'built-in-extensions.json'), 'utf8'));
    for (const id of Array.isArray(list.plugins) ? list.plugins : []) if (typeof id === 'string') out.plugin.add(id);
    for (const id of Array.isArray(list.services) ? list.services : []) if (typeof id === 'string') out.service.add(id);
  } catch (error) {
    console.warn('[extensions] could not read built-in-extensions.json:', error.message);
  }
  return out;
}
const _BUILT_IN = _loadBuiltIn();

/** Whether this catalog entry is one of the extensions Atmos ships with (an official copy of it). */
function _isBuiltIn(entry) {
  return !!entry && entry.tier === 'first-party' && _BUILT_IN[entry.kind]?.has(entry.id) === true;
}

/**
 * Where the first-run picker and the upgrade install take packages from:
 * the packages that come with Atmos if there are any, otherwise (installed
 * Atmos) the built-in sources. Running from source has no first run, unless
 * --setup-source=<folder or https://> (tests) says where from.
 */
function _setupSources() {
  const seed = _seedSources();
  if (seed.length) return seed;
  if (!app.isPackaged) {
    const flag = process.argv.find(arg => arg.startsWith('--setup-source='));
    return flag ? [{ location: flag.slice('--setup-source='.length), name: 'Atmos' }] : [];
  }
  try {
    return (JSON.parse(fs.readFileSync(_BUILT_IN_SOURCES_FILE, 'utf8')).sources || [])
      .filter(item => typeof item?.location === 'string').map(item => ({ location: item.location, name: item.name || null }));
  } catch { return []; }
}

/**
 * Whether this user data has been used before (an Atmos that bundled its
 * extensions is being upgraded), as opposed to a first start.
 */
function _usedBefore(userData) {
  return ['Local Storage', 'extension-preferences.json', 'extension-approvals.json', 'window-state.json']
    .some(name => fs.existsSync(path.join(userData, name)));
}

// Downloads from sources (indexes, packages, the Atmos installer): Atmos's
// own schemes bypassed, https kept through every redirect, bounded, and
// stopped if they stall (source-fetch.cjs).
const _sources = createSourceFetch({ net });

// Unpackaged, --github-releases=<folder> serves GitHub repositories' latest
// releases from <folder>/<owner>/<repo>/ (end-to-end tests of community
// sources, without GitHub).
const _GITHUB_RELEASES = (() => {
  const flag = app.isPackaged ? null : process.argv.find(arg => arg.startsWith('--github-releases='));
  return flag ? path.resolve(flag.slice('--github-releases='.length)) : null;
})();

/** A download for a web source, refused past maxBytes. */
function _fetchSourceFile(url, maxBytes) {
  const release = _GITHUB_RELEASES && /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/([^/]+)$/.exec(url);
  if (release) {
    const file = path.join(_GITHUB_RELEASES, release[1], release[2], release[3]);
    if (!file.startsWith(_GITHUB_RELEASES + path.sep)) return Promise.reject(new Error('Not found'));
    return fs.promises.stat(file).then(stat => {
      if (stat.size > maxBytes) throw new Error(`${release[3]} is too large`);
      return fs.promises.readFile(file);
    });
  }
  return _sources.fetchBuffer(url, maxBytes);
}

const _manager = createExtensionManager({
  userData: app.getPath('userData'),
  installedRoot: _installedRoot,
  trustedKeys: _trustedKeys,
  builtInSourceFiles: [_BUILT_IN_SOURCES_FILE],
  extraSources: _sessionSources(),
  seedSources: _seedSources(),
  setupSources: _setupSources(),
  fetchUrl: _fetchSourceFile,
  installed: () => [..._catalog.list('plugins'), ..._catalog.list('services')].map(entry => ({
    ...entry, loadable: _trust?.get(entry)?.loadable !== false, active: _isActive(entry),
  })),
  // Built in (Atmos Browser): never offered in the picker or installed over.
  builtIn: (kind, id) => _BUILT_IN[kind]?.has(id) === true,
  appVersion: app.getVersion(),
});

// ── Atmos updating itself (atmos-update.cjs) ─────────────────────────────

let _sessionEnding = false;     // Windows is shutting down: install nothing on the way out
let _installOnQuit = false;     // "Restart to update": install as Atmos quits, and start it again
let _relaunching = false;       // Atmos restarts itself (app.relaunch): install nothing on the way out
let _started = false;           // the window is up (a second instance quits before it)

/**
 * Unpackaged, --update-test-install=<file> (end-to-end runs) stands in for
 * an installed copy: the installer isn't run, what would have run is
 * written to <file>.
 */
function _updateTestFile() {
  if (app.isPackaged) return null;
  const flag = process.argv.find(arg => arg.startsWith('--update-test-install='));
  return flag ? path.resolve(flag.slice('--update-test-install='.length)) : null;
}

// electron-builder's registry key for Atmos's install (Software\<APP_GUID>,
// in HKCU for this user, HKLM for every user): UUID v5 of the appId
// "com.hashy.atmosphere" in its namespace (atmos-update.test.cjs checks it).
const _INSTALL_GUID = '61a4a7c5-b328-533c-af00-52ce914e709f';

/**
 * Whether the installer would ask Windows' permission: the same test it
 * makes (assistedInstaller.nsh, installer.nsi), an install for every user
 * recorded in HKLM. If the registry can't be read, anything outside local
 * app data counts, so Atmos never surprises you with a prompt on quit.
 */
function _installedForEveryUser(dir) {
  const { spawnSync } = require('child_process');
  // Windows' own reg.exe, by its full path (a bare name is looked for in
  // the working folder first).
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const query = spawnSync(reg, ['query', `HKLM\\Software\\${_INSTALL_GUID}`, '/v', 'InstallLocation', '/reg:64'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
  if (query.status === 0) return true;
  // Not found (or not readable): still counted as for every user outside
  // local app data, where a per-user install goes.
  const local = process.env.LOCALAPPDATA;
  const relative = local ? path.relative(path.resolve(local), path.resolve(dir)) : '..';
  return !relative || relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * How this copy of Atmos is installed, for updating itself: an NSIS
 * install on Windows (its uninstaller beside Atmos.exe), for this user or
 * for every user (asked only when it matters, then remembered). Null when
 * it can't update itself: running from source, the portable build,
 * another platform.
 */
function _updateInstall() {
  if (!app.isPackaged) return _updateTestFile() ? { perMachine: false } : null;
  if (process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) return null;
  const dir = path.dirname(process.execPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  if (!names.some(name => /^Uninstall .+\.exe$/i.test(name))) return null;
  let perMachine = null;
  return { get perMachine() { if (perMachine === null) perMachine = _installedForEveryUser(dir); return perMachine; } };
}

/**
 * Where installers are downloaded: local app data on Windows (not the
 * roaming user data, for a 100 MB file; not "atmos-updater", which is
 * electron-builder's own), user data elsewhere.
 */
function _updateDownloadDir() {
  const base = process.platform === 'win32' && app.isPackaged && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('userData');
  return path.join(base, 'atmos-updates');
}

/** Start the installer on its own, so it outlives Atmos. Throws if it can't start. */
function _spawnInstaller(file, args) {
  const testFile = _updateTestFile();
  if (testFile) {
    fs.writeFileSync(testFile, JSON.stringify({ file, args, at: new Date().toISOString() }));
    return;
  }
  spawnDetached(file, args);
}

const _updater = createAtmosUpdater({
  appVersion: app.getVersion(),
  stateFile: path.join(app.getPath('userData'), 'atmos-update.json'),
  downloadDir: _updateDownloadDir(),
  install: _updateInstall(),
  download: (url, file, options) => _sources.downloadToFile(url, file, options),
  spawnInstaller: _spawnInstaller,
  onChange: () => { if (_started) _broadcastManager(); },
});

/**
 * "Restart to update": the installer must still match (said at once if
 * not); Atmos then quits as usual, its pages closing first, and the
 * installer starts once the windows are gone (will-quit) and starts Atmos
 * again.
 */
function _quitToInstall() {
  _updater.checkReady();
  _installOnQuit = true;
  console.log(`[update] quitting to install Atmos ${_updater.state().version}`);
  setImmediate(() => app.quit());
}

/**
 * An update downloaded two days ago and still not installed (Atmos left
 * open, Windows shut down around it): one notification, which opens
 * Settings → Extensions.
 */
const _nudges = new Set(); // kept referenced until closed, so clicks arrive
function _nudgeAboutUpdate() {
  if (!Notification.isSupported()) return;
  const version = _updater.nudgeDue();
  if (!version) return;
  const notification = new Notification({
    title: `Atmos ${version} is ready to install`,
    body: _updater.state().perMachine
      ? 'Restart Atmos to update it. It brings Chromium\'s latest security fixes to Atmos Browser.'
      : 'It installs when you quit Atmos, or restart it now. It brings Chromium\'s latest security fixes to Atmos Browser.',
  });
  notification.on('click', () => {
    const win = _atmosWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('extensions:show-manager');
  });
  const forget = () => _nudges.delete(notification);
  notification.on('close', forget);
  notification.on('failed', forget);
  _nudges.add(notification);
  notification.show();
}

/**
 * Where "Atmos X is available" sends you: Core's own setting
 * (core/extension-sources.json "download"), never an address from a
 * source's index. Only https.
 */
function _atmosDownloadUrl() {
  try {
    const url = JSON.parse(fs.readFileSync(_BUILT_IN_SOURCES_FILE, 'utf8')).download;
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// The system services (Wallpaper, Audio) are part of Atmos itself:
// core/system/<id>, loaded by Core like the rest of its code.
const _SYSTEM_ROOT = path.join(__dirname, 'system');

// Extensions being written: --dev-extension=<folder> (a plugin) and
// --dev-service=<folder>, each as often as needed. Loaded from where they
// are, as community extensions without asking for approval, and reloaded
// when their files change (_watchDeveloperFolders). Packaged builds accept
// them too: they grant nothing a folder in %APPDATA%\atmos\plugins and an
// approval wouldn't.
function _developerFolders(kind) {
  const flag = kind === 'plugins' ? '--dev-extension=' : '--dev-service=';
  return process.argv.filter(arg => arg.startsWith(flag)).map(arg => path.resolve(arg.slice(flag.length)));
}

const _catalog = createExtensionCatalog({
  coreRoot: kind => (kind === 'services' ? _SYSTEM_ROOT : null),
  bundledRoot: _bundledRoot, installedRoot: _installedRoot, previousRoot: _manager.previousRoot, trustedKeys: _trustedKeys,
  developerFolders: _developerFolders,
});

let _trust = null;

/** Whether an extension is switched off for this session. System extensions never are. */
function _isStartupDisabled(entry) {
  return entry.tier !== 'system' && _startupDisabled[entry.kind].has(entry.id);
}

/** Switched on and trusted, before dependencies are considered. */
function _isUsableAlone(entry) {
  return !_isStartupDisabled(entry) && _trust?.get(entry)?.loadable !== false && !_activationFailures.has(refOf(entry))
    && !_stoppedNow.has(refOf(entry));
}

// Community extensions whose approval was removed this session: stopped at
// once (_stopNow) and not running again until the next start.
const _stoppedNow = new Set();

// main.cjs activations that threw or ran out of time this session
// (extension-host.cjs): ref → reason. They count as not loading, so what
// needs them is skipped too, and Settings says why.
const _activationFailures = new Map();

// Decided once at startup, after trust (see extension-dependencies.cjs):
// an extension whose required dependency can't load doesn't load either.
let _dependencyState = null;
let _dependents = new Map();

function _resolveDependencyState() {
  const all = [..._catalog.list('plugins'), ..._catalog.list('services')];
  _dependencyState = resolveDependencies(all, _isUsableAlone, entry => (_isStartupDisabled(entry)
    ? 'is switched off'
    : _stoppedNow.has(refOf(entry)) ? 'was stopped (its approval was removed)'
    : _activationFailures.has(refOf(entry)) ? 'failed to start'
      : `can't load (${_trust?.get(entry)?.status || 'unknown'})`));
  _dependents = dependentsOf(all);
  for (const entry of all) {
    const state = _dependencyState.get(refOf(entry));
    if (_isUsableAlone(entry) && !state.ok) console.warn(`[extensions] not loading ${entry.kind} '${entry.id}': ${state.problems.join('; ')}`);
  }
}

/** Whether an extension loads this session: switched on, trusted, and its required dependencies load. */
function _isActive(entry) {
  return _isUsableAlone(entry) && _dependencyState?.get(refOf(entry))?.ok !== false;
}

/** Version, publisher and dependency details for Settings. */
function _describePackage(entry) {
  const trust = _trust?.get(entry);
  const state = _dependencyState?.get(refOf(entry));
  const label = ref => {
    const [kind, id] = ref.split(':');
    const target = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
    const declared = target?.manifest?.displayName || target?.manifest?.name;
    // Same fallback as Settings' own labels: "media-metadata" → "Media Metadata".
    return typeof declared === 'string' && declared.trim()
      ? declared.trim()
      : id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };
  return {
    version: entry.version || null,
    publisher: entry.manifest?.publisher || null,
    signature: trust?.signature || entry.signature || null,
    fellBackFrom: trust?.fellBackFrom || null,
    dependencies: normalizeDependencies(entry.manifest).list
      .map(dep => {
        const [kind, id] = dep.ref.split(':');
        const system = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id)?.tier === 'system';
        return { ref: dep.ref, name: label(dep.ref), range: dep.range, optional: dep.optional, system };
      }),
    dependencyProblems: _activationFailures.has(refOf(entry)) ? [_activationFailures.get(refOf(entry))] : state?.problems || [],
    activationFailed: _activationFailures.has(refOf(entry)),
    optionalMissing: (state?.optionalMissing || []).map(label),
    usedBy: (_dependents.get(refOf(entry)) || []).map(item => ({ ref: item.ref, name: label(item.ref), optional: item.optional })),
    removable: entry.source === 'installed' || entry.source === 'previous',
    bundledFallback: entry.fallback?.source === 'bundled',
  };
}

// ── Extension manager (Settings → Extensions, the footer icon) ───────────

/** What the footer icon needs: approvals, updates, changes waiting for a restart, and problems. */
function _managerSummary(status = _manager.status()) {
  const problems = [];
  const approvals = [];
  const switchedOff = { plugin: _extensionPreferences?.disabledIds('plugin') ?? new Set(), service: _extensionPreferences?.disabledIds('service') ?? new Set() };
  for (const entry of [..._catalog.list('plugins'), ..._catalog.list('services')]) {
    if (_isStartupDisabled(entry)) continue;
    const trust = _trust?.get(entry);
    const name = entry.manifest?.displayName || entry.id;
    // Community extensions waiting for the user (switched off since: no).
    if (entry.tier === 'third-party' && ['pending', 'changed'].includes(trust?.status)
      && !trust.approvalChanged && !switchedOff[entry.kind].has(entry.id)) {
      approvals.push({ kind: entry.kind, id: entry.id, name, status: trust.status });
      continue;
    }
    const deps = _dependencyState?.get(refOf(entry));
    if (trust && !trust.loadable && ['tampered', 'blocked', 'incompatible'].includes(trust.status)) problems.push({ kind: entry.kind, id: entry.id, name, reason: trust.reason });
    else if (_activationFailures.has(refOf(entry))) problems.push({ kind: entry.kind, id: entry.id, name, reason: _activationFailures.get(refOf(entry)) });
    else if (trust?.fellBackFrom) problems.push({ kind: entry.kind, id: entry.id, name, reason: `version ${trust.fellBackFrom.version} couldn't load` });
    else if (deps && !deps.ok && trust?.loadable) problems.push({ kind: entry.kind, id: entry.id, name, reason: deps.problems[0] });
    else if (_moveProblems.has(refOf(entry))) problems.push({ kind: entry.kind, id: entry.id, name, reason: _moveProblems.get(refOf(entry)) });
  }
  // A newer Atmos: the updater's offer (it outlasts a check that couldn't
  // reach the source), else what the last check found.
  const update = _updater.state();
  const newer = update.version || status.core?.available || null;
  return {
    updates: status.updates, pending: status.pending.length, problems, approvals, checkedAt: status.checkedAt,
    atmosUpdate: newer ? { version: newer, current: app.getVersion(), download: _atmosDownloadUrl() !== null } : null,
    // Atmos updating itself: the setting, and where a newer version is.
    atmos: update,
    // Whether the last check heard from a source that names Atmos versions
    // (a folder of packages alone doesn't say whether Atmos is current).
    reached: !status.checkedAt || status.core?.seen === true,
  };
}

/**
 * The Atmos window, to send the page what changed. Not every BrowserWindow:
 * a sign-in pop-up a web page opened in Atmos Browser is one too, and what
 * Atmos tells its page (the extensions, their folders, what's waiting) is
 * none of that page's business.
 */
function _atmosWindows() {
  return BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.__atmosStartupSplash
    && !_web.isWebSession(win.webContents.session));
}

// The window on screen while Atmos starts (startup-splash.cjs): open before
// the extension checks, closed once the Atmos window has painted its own
// splash. --no-startup-splash leaves it out.
// Its line is one of the boot splash's own (core/js/boot/splash.js), and
// the page is told which (index.html?boot=N) so it goes on with the same one.
let _startupSplash = null;
let _bootMessage = null;
function _openStartupSplash() {
  if (process.argv.includes('--no-startup-splash')) return;
  _bootMessage = pickBootMessage(readBootMessages(path.join(__dirname, 'js', 'boot', 'splash.js')));
  _startupSplash = openStartupSplash({
    BrowserWindow, screen, state: _loadWindowState(), defaults: DEFAULT_WINDOW_BOUNDS,
    imagePath: path.join(__dirname, 'assets', 'Rev2.png'), icon: path.join(__dirname, 'assets', 'icon.ico'),
    line: _bootMessage?.text,
  });
}
function _closeStartupSplash() {
  _startupSplash?.close();
  _startupSplash = null;
}

function _broadcastManager(status = _manager.status()) {
  const payload = { status, summary: _managerSummary(status) };
  for (const win of _atmosWindows()) win.webContents.send('extensions:manager-changed', payload);
  return payload;
}

/**
 * Upgrading from an Atmos that bundled every extension, without packages of
 * its own: download what it had from the official source, stage it, and
 * ask for a restart (Settings → Extensions opens on "Waiting for a
 * restart"). Offline, nothing is marked done, so the next start tries again.
 */
let _upgradeDownloaded = false;
async function _downloadForUpgrade() {
  try {
    const changes = await _manager.installFromSeed();
    _manager.finishSetup('upgrade');
    console.log(`[extensions] upgrade: downloaded ${changes.map(change => change.id).join(', ') || 'nothing'}; applied at the next restart`);
    _broadcastManager();
    if (changes.length) {
      _upgradeDownloaded = true;
      for (const win of _atmosWindows()) win.webContents.send('extensions:upgrade-downloaded', { changes });
    }
  } catch (error) {
    console.warn(`[extensions] upgrade: can't download extensions yet (${error.message}); trying again next start`);
  }
}

let _lastUpdateCheck = null;
async function _checkForUpdates() {
  try {
    let status = await _manager.checkForUpdates();
    _lastUpdateCheck = Date.now();
    // What Atmos Browser recommends (Now Playing), the first time it does,
    // and Location for an extension that reads the location (it was part
    // of Atmos before 0.21): staged for the next restart, as an update that
    // first recommends one brings it. Not before the first start's choice.
    if (_manager.setupDone()) {
      const staged = await _manager.installBuiltInRecommendations().catch(error => {
        console.warn('[extensions] built-in recommendations:', error.message);
        return [];
      });
      if (staged.length) {
        console.log(`[extensions] staged ${staged.map(change => change.id).join(', ')}: recommended by an extension Atmos comes with, or used by one installed`);
        status = _manager.status();
      }
    }
    // What the sources name (with "Update Atmos automatically", downloaded
    // at once). An offer stands until its own source answers without it,
    // so being offline changes nothing.
    void _updater.consider(status.core?.offer || null, { answered: (status.sources || []).filter(source => source.ok).map(source => source.location) })
      .then(() => _nudgeAboutUpdate(), () => {});
    return _broadcastManager(status);
  } catch (error) {
    console.warn('[extensions] update check failed:', error.message);
    return _broadcastManager();
  }
}

// A sender must be the Atmos page itself: frames never reach these, nor do
// web pages (ipc-gate.cjs).
function _fromAtmosPage(event) {
  return fromAtmosPage(event, { isWebSession: candidate => _web.isWebSession(candidate) });
}
function _managerHandler(name, fn) {
  _page.handle(`extensions:${name}`, async (_event, ...args) => fn(...args));
}

_managerHandler('manager-status', () => ({ status: _manager.status(), summary: _managerSummary() }));
_managerHandler('check-updates', () => _checkForUpdates());
_managerHandler('install', async (kind, id) => {
  const result = await _manager.install(kind, id);
  return { changes: result.changes, ..._broadcastManager(result.status) };
});
_managerHandler('remove', (kind, id, options) => _broadcastManager(_manager.remove(kind, id, { deleteData: options?.deleteData === true })));
_managerHandler('cancel', (kind, id) => _broadcastManager(_manager.cancel(kind, id)));
_managerHandler('add-source', async location => { _manager.addSource(location); return _checkForUpdates(); });
_managerHandler('remove-source', async location => { _manager.removeSource(location); return _checkForUpdates(); });
// A frame of an extension didn't load: if that's an update in its first
// session, the version it replaced runs from the next start (R4).
_managerHandler('frame-failed', (kind, id, reason) => {
  const failed = _manager.startFailed(String(kind), String(id), String(reason || '').slice(0, 300));
  if (failed) console.warn(`[extensions] the update of ${kind}:${id} didn't start (${reason}); the version before it runs from the next start`);
  return failed;
});
_managerHandler('take-data-cleanup', () => _dataCleanup.splice(0).map(({ kind, id }) => ({ kind, id })));
// Atmos updating itself: download when asked (automatic updates off), install
// now, and the setting.
_managerHandler('atmos-update-download', async () => {
  await _updater.download();
  return _broadcastManager();
});
_managerHandler('atmos-update-install', () => {
  _quitToInstall();
  return _broadcastManager();
});
_managerHandler('atmos-update-auto', on => {
  _updater.setAuto(on === true);
  return _broadcastManager();
});
_managerHandler('open-atmos-download', async () => {
  const url = _atmosDownloadUrl();
  if (!url) throw new Error('No download page is set for Atmos');
  await shell.openExternal(url);
  return true;
});
// First run: the plugins that come with Atmos, to choose from.
_managerHandler('setup', async () => {
  // upgradeDownloaded: the page may start after the download finished.
  if (_manager.setupDone()) return { needed: false, packages: [], upgradeDownloaded: _upgradeDownloaded };
  // What comes with Atmos already (Atmos Browser), for the picker to say so.
  const builtIn = _catalog.list('plugins').filter(entry => _isBuiltIn(entry))
    .map(entry => ({ id: entry.id, displayName: entry.manifest?.displayName || entry.id }));
  try {
    return {
      needed: true,
      builtIn,
      packages: (await _manager.seedPackages()).map(item => ({
        kind: item.kind, id: item.id, version: item.version, displayName: item.displayName, description: item.description,
        dependencies: item.named,
      })),
    };
  } catch (error) {
    // Offline, or the source can't be reached: the picker says so and offers to try again.
    return { needed: true, builtIn, packages: [], error: error.message };
  }
});
_managerHandler('finish-setup', async chosen => {
  const wanted = Array.isArray(chosen) ? chosen.filter(item => ['plugin', 'service'].includes(item?.kind) && typeof item?.id === 'string') : [];
  const changes = wanted.length ? await _manager.installFromSeed(wanted) : [];
  _manager.finishSetup(wanted.length ? 'chosen' : 'skipped');
  return { changes, ..._broadcastManager() };
});

// ── Each extension's atmos.state, in a file of its own (extension-state.cjs) ─
const _stateStore = createExtensionStateStore({ dir: path.join(app.getPath('userData'), 'extension-state') });

/** kind:id of a listed extension, or an error. */
function _checkedExtension(kind, id) {
  if (!['plugin', 'service'].includes(kind) || typeof id !== 'string' || !_catalog.find(`${kind}s`, id)) {
    throw new Error(`not an extension: ${kind}:${id}`);
  }
  return { kind, id };
}

_page.handle('extension-state:load-all', () => _stateStore.loadAll());
_page.handle('extension-state:save', (_event, kind, id, data) => {
  _checkedExtension(kind, id);
  _stateStore.save(kind, id, data);
  return true;
});
// The same, synchronously: the page's last writes as it unloads (quitting,
// restarting), when an asynchronous reply would never arrive.
_page.on('extension-state:save-sync', (event, kind, id, data) => {
  try {
    _checkedExtension(kind, id);
    _stateStore.save(kind, id, data);
    event.returnValue = true;
  } catch (error) {
    console.warn(`[extensions] could not save ${kind}:${id}'s state:`, error.message);
    event.returnValue = false;
  }
}, { refused: false });

// Extensions removed with their data: the page forgets their state
// namespaces (it asks once, at boot), and origins of their own lose their
// storage (_clearRemovedStorage, once the schemes are registered). The
// manager lists them until every delete has worked, so a failed one is
// tried again at the next start.
const _dataCleanup = []; // { kind, id, failed, browsing }
function _cleanUpRemovedData() {
  for (const { kind, id } of _manager.dataCleanup()) {
    const job = { kind, id, failed: false };
    _dataCleanup.push(job);
    try { _stateStore.remove(kind, id); } catch (error) { job.failed = true; console.warn(`[extensions] could not delete ${kind}:${id}'s state:`, error.message); }
    // Atmos Browser's: its session (cookies, storage, cache) and site settings.
    job.browsing = _web.forgetExtensionData(`${kind}:${id}`)
      .catch(error => { job.failed = true; console.warn(`[extensions] could not delete ${kind}:${id}'s browsing data:`, error.message); });
  }
}

/**
 * The IndexedDB databases and localStorage of extensions removed with their
 * data, in origins of their own. Chromium keys a frame's storage by the page
 * it's in as well as its own origin, so clearStorageData({ origin }) doesn't
 * reach what frames in the Atmos window stored: it's deleted from frames in
 * Core's hidden storage page instead, as the shared-origin clean-up does.
 * Before the window, so no frame of the same id holds it open.
 */
async function _clearRemovedStorage() {
  for (const job of _dataCleanup) {
    const { kind, id } = job;
    for (const host of [`${kind}-${id}`, `first-party-${kind}-${id}`]) {
      const origin = `${frames.SCHEME}://${host}`;
      try {
        await session.defaultSession.clearStorageData({ origin });
        const deleted = await _withStoragePage(null, frames.storageHostScript({ from: origin, remove: { indexedDB: ['*'], localStorage: ['*'] } }), 60_000, { removeHost: host });
        if (deleted?.length) console.log(`[extensions] deleted ${kind}:${id}'s storage in ${origin}:`, deleted.join(', '));
      } catch (error) {
        job.failed = true;
        console.warn(`[extensions] could not delete ${kind}:${id}'s storage in ${origin}:`, error.message);
      }
    }
    await job.browsing;
    // Installed again: what it keeps from now on is new (even one waiting
    // for approval can be approved and run this session), which a later
    // retry would delete, so this was the last try.
    const entry = _catalog.find(`${kind}s`, id);
    try {
      if (!job.failed || entry) _manager.finishDataCleanup(kind, id);
      else if (_manager.dataCleanupFailed(kind, id)) console.warn(`[extensions] gave up deleting ${kind}:${id}'s data after three tries`);
      else console.warn(`[extensions] ${kind}:${id}'s data will be deleted again at the next start`);
    } catch (error) {
      console.warn(`[extensions] could not record ${kind}:${id}'s data deletion:`, error.message);
    }
  }
}

// ── What extensions share with each other ("exports") ───────────────────
// An extension reaches another's IPC handlers, events, exposed methods and
// resource providers only when it declares it in "permissions.invokes" and
// the other lists them in "exports" for its tier (extension-permissions.cjs).

function _entryOf(targetRef) {
  const [kind, id] = String(targetRef).split(':');
  return kind === 'plugin' || kind === 'service' ? _catalog.find(`${kind}s`, id) : null;
}

// Who may call main.cjs IPC handlers, and what each extension may use of
// another's: invoke-authorizer.cjs.
const _invokes = createInvokeAuthorizer({
  fromAtmosPage: event => _fromAtmosPage(event),
  entryOf: ref => _entryOf(ref),
  isActive: entry => _isActive(entry),
  trustOf: entry => _trust?.get(entry) || null,
});

/** What `entry` may use of the extension `targetRef`: { ipc, events, methods }, or null for itself. */
function _reachOf(entry, targetRef) {
  return _invokes.reachOf(entry, targetRef);
}

/** For each extension a framed one declares: what it may use of it. */
function _reachFor(entry) {
  const out = {};
  for (const target of _trust?.get(entry)?.permissions.invokes || []) {
    if (target === `${entry.kind}:${entry.id}`) continue;
    const reach = _reachOf(entry, target);
    if (reach) out[target] = reach;
  }
  return out;
}

/** Plain-language lines for Settings: what it can use of each extension it declares. */
function _describeSharing(entry) {
  const lines = [];
  for (const target of _trust?.get(entry)?.permissions.invokes || []) {
    if (target === `${entry.kind}:${entry.id}`) continue;
    // Atmos's own calls (atmos.audio, atmos.nowPlaying…): Core in between,
    // nothing the other extension shares. The permissions list says them.
    if (Object.hasOwn(SYSTEM_INVOKES, target)) continue;
    const owner = _entryOf(target);
    const name = owner?.manifest?.displayName || target.split(':')[1];
    if (!owner) { lines.push(`${name}: not installed`); continue; }
    // The Wallpaper and Audio system services are Atmos's own SDK calls, and
    // a library without a main.cjs is only code the extension imports:
    // nothing to share.
    if (owner.tier === 'system' || (owner.manifest?.library === true && !_trust?.get(owner)?.hasMain)) continue;
    const reach = _reachOf(entry, target);
    if (reach.ipc.includes('*')) { lines.push(`${name}: everything (it doesn't list what it shares yet)`); continue; }
    // With what each gives, where the owner says (SDK 1.1 descriptions).
    let details = null;
    try { details = exportDetails(owner.manifest?.exports); } catch { details = null; }
    const said = (kind, item, label) => {
      const description = details?.[kind]?.[item]?.description;
      return description ? `${label} (${description})` : label;
    };
    const parts = [
      ...reach.ipc.map(item => said('ipc', item, item)),
      ...reach.methods.map(item => said('methods', item, item)),
      ...reach.events.map(event => said('events', event, `${event} events`)),
    ];
    lines.push(parts.length
      ? `${name}: ${parts.join(', ')}`
      : `${name} shares nothing with ${entry.tier === 'third-party' ? 'community' : 'other'} extensions`);
  }
  return lines;
}

/** Checked by extension-host.cjs before every main.cjs IPC handler runs (invoke-authorizer.cjs). */
function _authorizeInvoke(event, caller, target) {
  return _invokes.authorize(event, caller, target);
}

/**
 * What it shares with others, for its own card and approval prompt (null:
 * no "exports" block), and a warning when it holds something sensitive and
 * shares anything with every extension.
 */
function _describeOwnExports(entry) {
  const declared = entry.manifest && !entry.manifest.invalid ? entry.manifest.exports : undefined;
  let shares = null;
  try { shares = describeExports(declared); } catch { shares = []; }
  // A community extension without a block shares with official extensions only.
  if (shares === null && entry.tier !== 'system') {
    let offers = !!_trust?.get(entry)?.hasMain;
    try { offers ||= frames.describeContributions(entry, _walkRelativeFiles(entry.path)).some(item => item.surface === 'boot'); } catch { /* no surfaces to speak of */ }
    shares = offers ? ['Official extensions can use everything it offers (it doesn\u2019t list what it shares)'] : [];
  }
  return { shares: shares || [], sharingRisk: sharingRisk(entry.manifest?.permissions, declared) };
}

function _describeTrust(entry) {
  const trust = _trust?.get(entry);
  if (!trust) return {};
  return {
    status: trust.status,
    statusReason: trust.reason,
    permissions: trust.permissions,
    permissionSummary: trust.permissionSummary,
    sharing: _describeSharing(entry),
    ..._describeOwnExports(entry),
    newPermissions: trust.newPermissions || [],
    hasMain: trust.hasMain,
    fingerprint: trust.fingerprint || null,
    approvalChanged: trust.approvalChanged === true,
    // Its approval was removed this session, and it stopped then.
    stoppedNow: _stoppedNow.has(refOf(entry)),
    // A community extension: whether its author signed it (and with which
    // key), and the GitHub repository it was installed from, if any.
    authorSignature: trust.authorSignature || null,
    origin: entry.tier === 'third-party' ? _communityOrigin(entry) : null,
  };
}

/** The repository a community extension came from: { repo, keyId, keyChanged }, or null (added by hand). */
function _communityOrigin(entry) {
  const origin = _manager.communityOrigin(entry.kind, entry.id);
  // Only while what's installed is what came from it (not a copy put over it by hand).
  if (!origin || (origin.version && entry.version !== origin.version)) return null;
  return { repo: origin.repo || null, keyId: origin.keyId || null, keyChanged: origin.keyChanged === true };
}

/** Runtime and frame details for the renderer's frame host. */
function _describeRuntime(entry) {
  const runtime = frames.resolveRuntime(entry);
  const trust = _trust?.get(entry);
  const out = { runtime };
  if (frames.isLibrary(entry)) {
    out.libraryBase = `${frames.frameOrigin(entry)}${frames.extensionPath(entry)}`;
  }
  if (runtime !== 'frame') return out;
  out.frame = {
    origin: frames.frameOrigin(entry),
    base: frames.extensionPath(entry),
    allow: frames.framePermissionsPolicy(trust?.permissions),
    contributions: frames.describeContributions(entry, _walkRelativeFiles(entry.path)),
    // rev/ commands for Atmos's command bar ("contributes.commands").
    commands: frames.describeCommands(entry),
    // atmos-resource:// providers it may load (its audio channel checks these).
    resourceProviders: _resourceProvidersFor(entry),
    // What the extensions it declares share with it (the bridge checks these).
    reach: _reachFor(entry),
  };
  return out;
}

function _describeExtension(entry, files, disabled) {
  return {
    id: entry.id, kind: entry.kind, path: entry.path, files,
    manifest: entry.manifest,
    tier: entry.tier,
    source: entry.source,
    // One of the extensions Atmos ships with: its panel is the default.
    builtIn: _isBuiltIn(entry),
    developerRestart: _developerRestart.has(refOf(entry)),
    developerIgnored: entry.developerIgnored || null,
    enabled: entry.tier === 'system' || !disabled.has(entry.id),
    active: _isActive(entry),
    ..._describeTrust(entry),
    ..._describePackage(entry),
    ..._describeRuntime(entry),
  };
}

_page.handle('plugins:list', async () => {
  const disabled = _extensionPreferences?.disabledIds('plugin') ?? new Set();
  try {
    // Start order ("after", else alphabetical) decides the order the renderer
    // loads entry points in, and so the panel discovery/default order.
    return _catalog.list('plugins').map(entry => _describeExtension(entry,
      fs.readdirSync(entry.path, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name),
      disabled));
  } catch (e) {
    console.error('[main] plugins:list error:', e.message);
    return [];
  }
});

// Renderer code only ever addresses a service's own source files, so skip
// installed dependencies and dot-folders (.git, caches) instead of shipping
// hundreds of irrelevant paths over IPC on every launch.
const _UNLISTED_SERVICE_DIRS = new Set(['node_modules']);

function _walkRelativeFiles(root, dir = root, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !_UNLISTED_SERVICE_DIRS.has(entry.name)) _walkRelativeFiles(root, full, files);
    }
    else if (entry.isFile()) files.push(path.relative(root, full).replace(/\\/g, '/'));
  }
  return files;
}

_page.handle('services:list', async () => {
  const disabled = _extensionPreferences?.disabledIds('service') ?? new Set();
  try {
    return _catalog.list('services').map(entry => _describeExtension(entry, _walkRelativeFiles(entry.path), disabled));
  } catch (e) {
    console.error('[main] services:list error:', e.message);
    return [];
  }
});

_page.handle('extensions:set-enabled', async (_event, kind, id, enabled) => {
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (entry?.tier === 'system' && enabled === false) throw new Error(`'${id}' is a system extension and cannot be disabled`);
  const result = _extensionPreferences.setEnabled(kind, id, enabled);
  _broadcastManager(); // "Keep disabled" ends a wait for approval
  return result;
});

/**
 * A community extension approved while Atmos runs loads at once, with any
 * community extension that was waiting only for it (a plugin that needs a
 * service just approved). They run only in frames, so there is no main.cjs
 * to start: what a start does for them is trust (reassessed here), their
 * dependencies (resolved again), their files served and browser
 * permissions granted (both follow _isActive), and their surfaces, which
 * the page registers from the descriptions this returns. An official
 * extension that could now load too waits for a restart. Returns null,
 * and changes nothing, when the approved one can't load this session
 * (switched off at startup, or a dependency that isn't loading).
 */
function _loadApprovedNow(folder, entry) {
  if (!entry || entry.tier !== 'third-party' || entry.source === 'developer') return null;
  const all = [..._catalog.list('plugins'), ..._catalog.list('services')];
  const before = new Set(all.filter(_isActive).map(refOf));
  // This one, and any approved earlier this session that couldn't load then
  // (it needed this one), as they are now.
  const assessed = new Map([[entry, _trust.assess(folder, entry)]]);
  for (const item of all) {
    const trust = _trust.get(item);
    if (item !== entry && item.tier === 'third-party' && item.source !== 'developer' && trust?.approvalChanged && !trust.loadable) {
      assessed.set(item, _trust.assess(`${item.kind}s`, item));
    }
  }
  const usable = item => (assessed.has(item)
    ? assessed.get(item).loadable && !_isStartupDisabled(item) && !_activationFailures.has(refOf(item))
    : _isUsableAlone(item));
  const fresh = resolveDependencies(all, usable);
  let loading = all.filter(item => !before.has(refOf(item)) && item.tier === 'third-party' && item.source !== 'developer'
    && usable(item) && fresh.get(refOf(item))?.ok);
  // Each needs what it requires to be loading already, or loading with it.
  for (let changed = true; changed;) {
    changed = false;
    const refs = new Set([...before, ...loading.map(refOf)]);
    const next = loading.filter(item => normalizeDependencies(item.manifest).list.every(dep => dep.optional || refs.has(dep.ref)));
    if (next.length !== loading.length) { loading = next; changed = true; }
  }
  if (!loading.includes(entry)) return null;
  for (const item of loading) if (assessed.has(item)) _trust.reassess(`${item.kind}s`, item);
  for (const item of loading) _dependencyState.set(refOf(item), fresh.get(refOf(item)));
  _installBrowserPermissions(_activeEntries());
  console.log(`[extensions] approved ${entry.kind} '${entry.id}'; loading ${loading.map(refOf).join(', ')} now`);
  // Services before plugins, each in start order, as at startup.
  const disabled = { plugin: _extensionPreferences?.disabledIds('plugin') ?? new Set(), service: _extensionPreferences?.disabledIds('service') ?? new Set() };
  const order = [..._catalog.list('services'), ..._catalog.list('plugins')];
  return order.filter(item => loading.includes(item)).map(item => _describeExtension(item,
    item.kind === 'plugin' ? fs.readdirSync(item.path, { withFileTypes: true }).filter(file => file.isFile()).map(file => file.name) : _walkRelativeFiles(item.path),
    disabled[item.kind]));
}

// Third-party approval: the renderer passes the fingerprint it showed the
// user; approval is refused if the files changed since. It loads at once
// when it can (_loadApprovedNow), otherwise at the next start.
_page.handle('extensions:approve', async (_event, kind, id, fingerprint) => {
  const folder = kind === 'plugin' ? 'plugins' : 'services';
  const entry = _catalog.find(folder, id);
  const result = _trust.approve(folder, entry, fingerprint);
  let loaded = null;
  // Stopped this session (its approval removed): it starts again at the next start.
  try { loaded = entry && _stoppedNow.has(refOf(entry)) ? null : _loadApprovedNow(folder, entry); }
  catch (error) { console.warn(`[extensions] ${kind} '${id}' approved; it loads at the next start (${error.message})`); }
  // The page registers their surfaces and starts their background frames.
  if (loaded) {
    for (const win of _atmosWindows()) win.webContents.send('extensions:loaded', loaded);
  }
  _broadcastManager();
  return loaded ? { ...result, restartRequired: false, loaded } : { ...result, loaded: [] };
});

/**
 * A community extension whose approval was just removed stops now, with
 * whatever needed it: it no longer counts as running (every channel to
 * Core, its files and its browser permissions follow _isActive), and the
 * page tears down its frames (extensions:stopped). Returns the refs that
 * stopped. The reverse of _loadApprovedNow; approving it again this
 * session takes a restart.
 */
function _stopNow(entry) {
  const all = [..._catalog.list('plugins'), ..._catalog.list('services')];
  const before = new Set(all.filter(_isActive).map(refOf));
  if (!before.has(refOf(entry))) return [];
  _stoppedNow.add(refOf(entry));
  _resolveDependencyState();
  const stopped = all.filter(item => before.has(refOf(item)) && !_isActive(item)).map(refOf);
  _installBrowserPermissions(_activeEntries());
  console.log(`[extensions] approval removed for ${refOf(entry)}; stopped ${stopped.join(', ')}`);
  return stopped;
}

_page.handle('extensions:revoke', async (_event, kind, id) => {
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (!entry || entry.tier !== 'third-party') throw new Error('Only community extensions have approvals');
  _trust.revoke(entry);
  const stopped = _stopNow(entry);
  if (stopped.length) {
    for (const win of _atmosWindows()) win.webContents.send('extensions:stopped', stopped);
  }
  _broadcastManager();
  return { restartRequired: false, stopped };
});

_page.handle('extensions:restart', () => {
  // Any restart Atmos makes itself (Restart to apply, the window effects'
  // restart, the first start's Install and restart): an Atmos update that
  // would install on quit goes in now instead, and the installer starts
  // Atmos again; the extensions' changes apply then.
  if (_updater.wouldInstallOnQuit()) {
    try {
      _quitToInstall();
      return;
    } catch (error) {
      console.warn('[update] restarting without the update:', error.message);
    }
  }
  // quit() (not exit()) closes windows normally, so the renderer's unload
  // handlers flush pending saves and the window state is written. Nothing
  // installs on the way out: the installer would close the new Atmos.
  _relaunching = true;
  app.relaunch();
  app.quit();
});

// System notifications for framed extensions, which can't use the
// Notification API themselves. The bridge in the page has checked the
// extension declares "notifications"; this checks again against its trust
// record. A click brings Atmos forward and tells the extension's frames.
const _shownNotifications = new Set(); // kept referenced until closed, so clicks arrive
// A link an extension's frame asks Atmos to open (atmos-sdk.js routes link
// clicks and window.open here; community frames can't open windows
// themselves). Official ones open; a community one opens after a click in
// its own frame, and otherwise asks (extension-links.cjs, the A5 fix).
const _linkQuestions = new Set();  // "kind:id" with a question up
const _linksBlocked = new Set();   // "kind:id" blocked until Atmos restarts
// Where the Atmos window last had a mouse button pressed, and how long ago:
// what Now Playing asks before it lets a community extension's start count
// as one you made (extension-frame-host.js _usedJustNow). From Chromium's
// own input, so no frame can make one up.
_page.handle('atmos:last-click', () => {
  const press = _web.atmosPointerDown();
  return press ? { x: press.x, y: press.y, ago: Date.now() - press.at } : null;
});

_page.handle('extensions:open-link', async (event, kind, id, url, info) => {
  if (!_isAppUrl(event.senderFrame?.url) || event.senderFrame !== event.sender.mainFrame) throw new Error('not allowed');
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (!entry || !_isActive(entry)) return false;
  const href = links.externalLink(url);
  if (!href) return false;
  const ref = `${entry.kind}:${entry.id}`;
  const decision = links.linkDecision({
    tier: entry.tier, focused: info?.focused === true, actedAt: _web.atmosActedAt(), now: Date.now(),
    blocked: _linksBlocked.has(ref), asking: _linkQuestions.has(ref),
  });
  if (decision === 'open') { _openExternally(href); return true; }
  if (decision === 'refuse') return false;
  _linkQuestions.add(ref);
  try {
    const name = entry.manifest?.displayName || entry.id;
    const win = BrowserWindow.fromWebContents(event.sender);
    const question = {
      type: 'question', buttons: ['Open', "Don't open"], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Open link?',
      message: `${name} wants to open ${links.describeLink(href)}`,
      detail: `${href.length > 300 ? `${href.slice(0, 300)}…` : href}\n\nThis didn't come from a click in ${name}. Open it only if you expected it.`,
      checkboxLabel: `Block links from ${name} until Atmos restarts`,
    };
    const { response, checkboxChecked } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, question) : await dialog.showMessageBox(question);
    if (response === 0) {
      // Your choice: it comes to the front, in Atmos Browser or the system's.
      if (!_web.openLink(href, { foreground: true })) _openExternally(href);
      return true;
    }
    if (checkboxChecked) _linksBlocked.add(ref);
    return false;
  } finally {
    _linkQuestions.delete(ref);
  }
});

_page.handle('extensions:notify', (event, kind, id, options) => {
  if (!_isAppUrl(event.senderFrame?.url)) throw new Error('not allowed');
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (!entry || !_isActive(entry) || frames.resolveRuntime(entry) !== 'frame'
    || !(_trust.get(entry)?.permissions.browser || []).includes('notifications')) {
    throw new Error(`${kind} '${id}' may not show notifications`);
  }
  if (!Notification.isSupported()) return false;
  const title = String(options?.title ?? '').slice(0, 120);
  if (!title.trim()) throw new Error('a notification needs a title');
  const tag = String(options?.tag ?? '').slice(0, 200);
  const notification = new Notification({
    title,
    body: String(options?.body ?? '').slice(0, 500),
    silent: options?.silent === true,
  });
  const sender = event.sender;
  notification.on('click', () => {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (!sender.isDestroyed()) sender.send('extensions:notification-click', kind, id, tag);
  });
  const forget = () => _shownNotifications.delete(notification);
  notification.on('close', forget);
  notification.on('failed', forget);
  _shownNotifications.add(notification);
  notification.show();
  return true;
});

// atmos.fetch(): a framed extension's HTTP request, made here for it (no
// CORS, no cookies, only its declared hosts, never a local address; see
// extension-fetch.cjs). The page's bridge stamps the caller, as for invoke().
// Unpackaged, --fetch-test=<file> ({ "hosts": { "name": { "address",
// "port" } }, "ca": "<PEM>" }) points names at a local test server.
function _fetchTestOptions() {
  const flag = app.isPackaged ? null : process.argv.find(arg => arg.startsWith('--fetch-test='));
  if (!flag) return {};
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(flag.slice('--fetch-test='.length)), 'utf8'));
    return { testHosts: config.hosts || {}, ca: typeof config.ca === 'string' ? [config.ca] : null };
  } catch (error) {
    console.warn('[extensions] --fetch-test could not be read:', error.message);
    return {};
  }
}
const _extensionFetch = createExtensionFetch({ userAgent: `Atmos/${app.getVersion()}`, ..._fetchTestOptions() });
const _fetchesInFlight = new Map(); // "caller requestId" -> AbortController

_page.handle('extensions:fetch', async (_event, caller, requestId, request) => {
  const entry = typeof caller === 'string' ? _entryOf(caller) : null;
  if (!entry || !_isActive(entry) || frames.resolveRuntime(entry) !== 'frame') {
    return { error: { name: 'AtmosPermissionError', message: `${caller} is not running` } };
  }
  const key = `${caller} ${requestId}`;
  const controller = new AbortController();
  _fetchesInFlight.set(key, controller);
  try {
    return { result: await _extensionFetch.fetch(caller, _trust.get(entry)?.permissions.network || [], request, { signal: controller.signal }) };
  } catch (error) {
    return { error: { name: error?.name || 'TypeError', message: error?.message || String(error) } };
  } finally {
    _fetchesInFlight.delete(key);
  }
});
_page.on('extensions:fetch-abort', (_event, caller, requestId) => {
  _fetchesInFlight.get(`${caller} ${requestId}`)?.abort();
});

_page.handle('extensions:open-root', async (_event, kind) => {
  if (kind === 'plugins') return shell.openPath(_installedRoot('plugins'));
  if (kind === 'services' || kind === 'service') return shell.openPath(_installedRoot('services'));
  return 'Unsupported extension kind';
});

// ── Framed extensions (atmos-ext://) ─────────────────────────────────────────
function _activeEntries() {
  return [..._catalog.list('plugins'), ..._catalog.list('services')].filter(_isActive);
}

function _framedEntries() {
  return _activeEntries().filter(entry => frames.resolveRuntime(entry) === 'frame');
}

// Which frame origins may use a library's modules or a resource provider:
// atmos-ext-protocol.cjs (createFrameAccess).
const _frameAccess = createFrameAccess({
  framedEntries: () => _framedEntries(),
  trustOf: entry => _trust.get(entry),
  findService: id => _catalog.find('services', id),
  isActive: entry => _isActive(entry),
});
function _resourceProvidersFor(entry) { return _frameAccess.resourceProvidersFor(entry); }
function _originMayUseResource(origin, provider) { return _frameAccess.originMayUseResource(origin, provider); }

function _registerAtmosExtProtocol() {
  const handler = createAtmosExtHandler({
    framedEntries: _framedEntries,
    trustOf: entry => _trust.get(entry),
    libraryService: _frameAccess.libraryService,
    libraryOriginsFor: _frameAccess.libraryOriginsFor,
    resourceProvidersFor: _frameAccess.resourceProvidersFor,
    originMayUseLibrary: _frameAccess.originMayUseLibrary,
    moveInProgress: () => _moveInProgress,
    sdkDir: path.join(__dirname, 'js', 'sdk'),
    originMoveScript: path.join(__dirname, 'js', 'core', 'extension-origin-move.js'),
  });
  protocol.handle('atmos-ext', request => handler.handle(request));
}

// ── Developer folders (--dev-extension) ─────────────────────────────────────
// A change to a file reloads the extension's frames; a changed extension.json
// is read again first (permissions, network hosts). New or removed surfaces
// need a restart, which Settings says.
const _developerRestart = new Set(); // refs whose surfaces changed since start
const _DEV_IGNORED = /(^|[\\/])(\.|node_modules([\\/]|$)|tests([\\/]|$))/;

function _watchDeveloperFolders() {
  for (const entry of [..._catalog.list('plugins'), ..._catalog.list('services')]) {
    if (entry.source !== 'developer') continue;
    const kind = `${entry.kind}s`;
    let timer = null;
    let manifestChanged = false;
    const flush = () => {
      timer = null;
      let restart = false;
      if (manifestChanged) {
        manifestChanged = false;
        const before = JSON.stringify(frames.describeContributions(entry, _walkRelativeFiles(entry.path)));
        try {
          const text = fs.readFileSync(path.join(entry.path, 'extension.json'), 'utf8');
          const manifest = JSON.parse(text);
          entry.manifest = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : { invalid: true, error: 'manifest root must be an object' };
        } catch (error) {
          entry.manifest = { invalid: true, error: error.message };
        }
        _trust.reassess(kind, entry);
        restart = JSON.stringify(frames.describeContributions(entry, _walkRelativeFiles(entry.path))) !== before
          || _trust.get(entry)?.loadable === false;
        if (restart) _developerRestart.add(refOf(entry));
        console.log(`[extensions] ${entry.kind} '${entry.id}': extension.json changed${restart ? '; restart Atmos to apply its surfaces' : ''}`);
      }
      const description = _describeExtension(entry, _walkRelativeFiles(entry.path), new Set());
      for (const win of _atmosWindows()) win.webContents.send('extensions:developer-changed', { kind: entry.kind, id: entry.id, restart, extension: description });
    };
    try {
      fs.watch(entry.path, { recursive: true }, (_event, filename) => {
        const name = String(filename || '');
        if (name && _DEV_IGNORED.test(name)) return;
        if (name === 'extension.json') manifestChanged = true;
        clearTimeout(timer);
        timer = setTimeout(flush, 150);
      });
      console.log(`[extensions] developing ${entry.kind} '${entry.id}' from ${entry.path}`);
    } catch (error) {
      console.warn(`[extensions] can't watch ${entry.path} (${error.message}); restart Atmos to see changes`);
    }
  }
}

// ── Web hardening ─────────────────────────────────────────────────────────────
// The Atmos window's page is always atmos-app://local/: it never navigates
// away. Links and window.open() to the web from it and from extension frames
// open in the user's browser (or in Atmos Browser, when the user turned that
// on); everything else is refused. Browser permissions (location,
// notifications, camera...) are granted only to the Atmos page and frame
// origins, and only those some active extension declares in extension.json
// "permissions.browser".
//
// The one exception is Atmos Browser (web-host.cjs, web-layer.js): web pages
// in <webview>s that only Core's web layer in the Atmos page attaches, in
// two sessions of their own (never Atmos's), under the browser's policy
// instead of this one: web-policy.cjs, unit-tested.
// The guard itself (what may navigate where): app-navigation.cjs.

// shell.openExternal goes through Atmos Browser first (see _web.routeShell).
function _openExternally(url) {
  try {
    if (mayOpenExternally(url)) shell.openExternal(url);
    else console.warn('[main] refused to open', url);
  } catch {
    console.warn('[main] refused to open', url);
  }
}

/** An active official extension declaring "web": true ("plugin:<id>"). */
function _isWebExtension(ref) {
  const entry = typeof ref === 'string' ? _entryOf(ref) : null;
  return !!entry && entry.tier !== 'third-party' && _isActive(entry) && _trust?.get(entry)?.permissions.web === true;
}

/** Whether a frame of the Atmos window is one of a web extension's (its panel, say). */
/**
 * The frame directly inside the Atmos page that `frame` is in (an
 * extension's frame, whatever frame of its own has the keyboard), or null
 * when it's the Atmos page itself.
 */
function _topFrameOf(frame, mainFrame) {
  // Frames are compared by their node in the frame tree (Electron may hand
  // out a new WebFrameMain object for the same frame).
  const same = (a, b) => !!a && !!b && a.frameTreeNodeId === b.frameTreeNodeId;
  let current = frame;
  while (current?.parent && !same(current.parent, mainFrame)) current = current.parent;
  return current && !same(current, mainFrame) && same(current.parent, mainFrame) ? current : null;
}

/** Atmos's page again, the browser's pages closing first, as Chrome closes a tab (web-host.cjs closePages). */
function _reloadAtmos(win) {
  void _web.closePages().finally(() => { if (!win.isDestroyed()) win.webContents.reload(); });
}

// Atmos's theme is light or dark everywhere: web pages (prefers-color-scheme),
// extension frames and the system's own dialogs follow it, not Windows'
// setting (appearance.js sends it whenever the theme changes).
_page.on('appearance:color-scheme', (_event, scheme) => {
  if (scheme === 'light' || scheme === 'dark') nativeTheme.themeSource = scheme;
});

_page.on('atmos:reload', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) _reloadAtmos(win);
});

function _isWebExtensionFrame(frame) {
  const origin = frame?.origin;
  if (!origin || !origin.startsWith('atmos-ext://')) return false;
  return _framedEntries().some(entry => frames.frameOrigin(entry) === origin && _isWebExtension(`${entry.kind}:${entry.id}`));
}

const _web = createWebHost({
  app, session, net, BrowserWindow, WebContentsView, nativeImage, webContents, shell, ipcMain, utilityProcess, dialog,
  isAppUrl: _isAppUrl,
  userData: app.getPath('userData'),
  isWebExtension: _isWebExtension,
  // Unpackaged (the end-to-end check): --browser-downloads=<dir> saves
  // downloads there without asking; --browser-filter-lists=<dir> takes the
  // blocker's lists from <dir>/<id>.txt instead of downloading them.
  testOptions: (() => {
    const flag = name => (app.isPackaged ? null : process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)) || null;
    const options = {};
    if (flag('browser-downloads')) options.downloadsDir = path.resolve(flag('browser-downloads'));
    if (flag('browser-filter-lists')) options.filterLists = path.resolve(flag('browser-filter-lists'));
    // --browser-memory-step-mb=<n>: 'memory' events every n MB instead of 2 GB.
    if (Number(flag('browser-memory-step-mb')) > 0) options.memoryStepBytes = Number(flag('browser-memory-step-mb')) * 1024 * 1024;
    return options;
  })(),
});
// Every shell.openExternal in the main process (Core's and official main.cjs)
// gives Atmos Browser the link first, when the user asked for that.
_web.routeShell();

app.on('web-contents-created', (_, contents) => {
  if (contents.getType() === 'devtools') return;
  // A page in Atmos Browser: the browser's policy, not the one below.
  if (_web.isWebSession(contents.session)) { _web.applyPolicy(contents); return; }
  guardContents(contents, {
    openExternally: _openExternally,
    attachWebview: (...args) => _web.attachWebview(...args),
  });
});

// Location stays off until you press Detect (see location-gate.cjs): the
// official Location service's frame, and the Atmos page itself.
let _locationOrigins = new Set([_APP_ORIGIN]);
const _locationGate = createLocationGate({ gated: origin => _locationOrigins.has(origin) });
_page.handle('location:allow-detect', event => {
  // Only the Atmos page itself (not a frame inside it) opens the gate; it
  // does so for the Location service after a click on its Detect button.
  if (event.senderFrame !== event.sender.mainFrame || !_isAppUrl(event.senderFrame?.url)) return false;
  _locationGate.open();
  return true;
});

function _installBrowserPermissions(activeEntries) {
  // The Atmos page gets what page-runtime extensions declare; each frame
  // origin gets what its own extension(s) declare.
  const byOrigin = new Map([[_APP_ORIGIN, new Set(BASELINE_BROWSER)]]);
  _locationOrigins = new Set([_APP_ORIGIN]);
  for (const entry of activeEntries) {
    if (entry.kind === 'service' && entry.id === 'location' && entry.tier !== 'third-party' && frames.resolveRuntime(entry) === 'frame') {
      _locationOrigins.add(frames.frameOrigin(entry));
    }
    const origin = frames.resolveRuntime(entry) === 'frame' ? frames.frameOrigin(entry) : _APP_ORIGIN;
    if (!byOrigin.has(origin)) byOrigin.set(origin, new Set(BASELINE_BROWSER));
    for (const name of _trust.get(entry)?.permissions.browser || []) byOrigin.get(origin).add(name);
  }
  const allowedFor = url => byOrigin.get(_originOf(url)) || null;
  const granted = (permission, url) => allowedFor(url)?.has(permission) === true
    && _locationGate.allows(permission, _originOf(url));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details?.requestingUrl || contents?.getURL?.();
    const ok = granted(permission, url);
    if (!ok) console.warn(`[main] denied browser permission '${permission}' for ${_originOf(url)} (not declared)`);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
    granted(permission, requestingOrigin || contents?.getURL?.())
  ));
  for (const [origin, allowed] of byOrigin) console.log(`[main] browser permissions for ${origin}:`, [...allowed].join(', '));
}

/**
 * First-party extensions that moved to an origin of their own ("isolation":
 * "origin") may have left databases in the shared first-party origin, where
 * every other first-party extension can read them. Delete the ones each
 * declares ("legacyStorage.sharedOriginIndexedDB") once, from a hidden page
 * in that origin; nothing else there is touched. Done jobs are recorded, so
 * this runs again only if an extension's list changes.
 */
// ── Moving an extension's storage into an origin of its own ─────────────────
// An official extension with "isolation": "origin" runs in an origin of its
// own. What it kept in the shared first-party origin before (its manifest's
// "legacyStorage.sharedOrigin") is copied across once, before its frames
// start (extension-origin-move.js), and the shared copies are deleted at a
// later start, once it has run from its own. If the copy fails, it runs
// from the shared origin this session, where its data still is, and the
// move is tried again at the next start. Records: extension-origin-moves.json.
// A copy counts only once its record is saved: one made but not recorded is
// made again at the next start, over whatever the extension saved since.
const _MOVES_FILE = path.join(app.getPath('userData'), 'extension-origin-moves.json');
const _SESSION = new Date().toISOString();
// Unpackaged, --origin-move-timeout=<ms> changes it (the end-to-end check
// makes one move fail this way).
const _MOVE_TIMEOUT_MS = (() => {
  const flag = app.isPackaged ? null : process.argv.find(arg => arg.startsWith('--origin-move-timeout='));
  const value = flag ? Number(flag.slice('--origin-move-timeout='.length)) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 180_000;
})();
let _moveInProgress = null; // { host, removeHost }: the move (or removal) whose pages are served
const _moveProblems = new Map(); // ref → reason, for Settings

const _MOVES_BACKUP = `${_MOVES_FILE}.bak`;

/** A record file's moves; null if there's no such file. Throws if it can't be read. */
function _readMoveRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const saved = JSON.parse(text);
  if (saved?.format !== 1 || !saved.moves || typeof saved.moves !== 'object') throw new Error('not a record of moves');
  return saved.moves;
}

/**
 * The moves made so far: from the record (asked twice: a scanner may hold
 * it a moment), else from its backup (a write cut short), else none. With
 * none, a move is made again: it copies only what the shared origin still
 * holds, which is nothing once a move's shared copies are cleaned, and the
 * record is written anew. (Moving nothing while it can't be read left it
 * unreadable for good, and data stranded with it.)
 */
function _readMoves() {
  for (const file of [_MOVES_FILE, _MOVES_BACKUP]) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const moves = _readMoveRecord(file);
        if (moves) return moves;
        break; // no such file: its backup
      } catch (error) {
        console.warn(`[extensions] couldn't read ${path.basename(file)}:`, error.message);
        if (attempt === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
  return {};
}

/** Written whole and flushed to disk, then renamed into place. */
function _writeRecordFile(file, text) {
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, text);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function _writeMoves(moves) {
  const text = JSON.stringify({ format: 1, moves }, null, 2);
  _writeRecordFile(_MOVES_FILE, text);
  try { _writeRecordFile(_MOVES_BACKUP, text); } catch (error) { console.warn('[extensions] could not back up the record of storage moves:', error.message); }
}

/**
 * Run `script` (frames.storageHostScript) in Core's hidden storage page: an
 * atmos-app page, so its frames see the same storage as extension frames in
 * the Atmos window (Chromium keys a frame's storage by the page it is in).
 */
async function _withStoragePage(allowImportHost, script, timeoutMs, { removeHost = null } = {}) {
  const { WebContentsView } = require('electron');
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  _moveInProgress = { host: allowImportHost, removeHost };
  let timer;
  try {
    await view.webContents.loadURL(`${_APP_ORIGIN}/__atmos/storage.html`);
    const run = view.webContents.executeJavaScript(script);
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`it took longer than ${Math.max(1, Math.round(timeoutMs / 1000))} s`)), timeoutMs); });
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    _moveInProgress = null;
    view.webContents.close();
  }
}

function _moveOne(entry, spec) {
  const from = `${frames.SCHEME}://${frames.FIRST_PARTY_HOST}`;
  return _withStoragePage(frames.frameHost(entry), frames.storageHostScript({ from, to: frames.frameOrigin(entry), spec }), _MOVE_TIMEOUT_MS);
}

async function _moveToOwnOrigins() {
  const moves = _readMoves();
  for (const entry of _framedEntries()) {
    const spec = frames.sharedOriginMove(entry);
    const ref = `${entry.kind}:${entry.id}`;
    if (!spec || moves[ref]?.status === 'copied') continue;
    const started = Date.now();
    let reason;
    try {
      const copied = await _moveOne(entry, spec);
      const record = { status: 'copied', session: _SESSION, at: new Date().toISOString(), spec, copied };
      try {
        // Recorded before anything uses the new origin.
        _writeMoves({ ...moves, [ref]: record });
      } catch (error) {
        throw new Error(`its record couldn't be saved: ${error.message}`);
      }
      moves[ref] = record;
      console.log(`[extensions] moved ${ref}'s storage into ${frames.frameOrigin(entry)} in ${Date.now() - started}ms:`, JSON.stringify(copied));
      continue;
    } catch (error) {
      reason = error?.message || String(error);
    }
    // Run from the shared origin this session, where its data still is.
    entry.originFallback = true;
    moves[ref] = { status: 'failed', at: new Date().toISOString(), error: reason, attempts: (moves[ref]?.attempts || 0) + 1 };
    _moveProblems.set(ref, `Its data couldn't be moved to storage of its own (${reason}); it uses the shared storage this session, and Atmos tries again at the next start`);
    console.error(`[extensions] could not move ${ref}'s storage; using the shared origin this session:`, reason);
    try { _writeMoves(moves); } catch (error) { console.error('[extensions] could not record storage moves:', error.message); }
  }
}

async function _cleanUpSharedOriginStorage() {
  // (Before Atmos 0.12 this ran in a top-level page of the shared origin,
  // which Chromium gives other storage than frames inside the Atmos window,
  // so it deleted nothing; the v2 record makes it run again, as frames.)
  const markerPath = path.join(app.getPath('userData'), 'shared-origin-cleanup-v2.json');
  let done = {};
  try { done = JSON.parse(fs.readFileSync(markerPath, 'utf8')) || {}; } catch { /* first run */ }
  const jobs = _framedEntries()
    .map(entry => ({ key: `${entry.kind}:${entry.id}`, patterns: frames.sharedOriginCleanupPatterns(entry), keys: [] }))
    .filter(job => job.patterns.length && JSON.stringify(done[job.key]) !== JSON.stringify(job.patterns));
  // Storage moved into an extension's own origin at an earlier start (so it
  // has run from there since): its shared copies go.
  const moves = _readMoves();
  for (const [ref, move] of Object.entries(moves)) {
    if (move.status !== 'copied' || move.cleaned || move.session === _SESSION) continue;
    jobs.push({ key: ref, patterns: move.spec?.indexedDB || [], keys: move.spec?.localStorage || [], move: true });
  }
  if (!jobs.length) return;

  const from = `${frames.SCHEME}://${frames.FIRST_PARTY_HOST}`;
  try {
    for (const job of jobs) {
      const deleted = await _withStoragePage(null, frames.storageHostScript({ from, remove: { indexedDB: job.patterns, localStorage: job.keys } }), 60_000);
      console.log(`[main] removed ${job.key}'s old shared-origin storage:`, (deleted || []).join(', ') || 'none');
      if (job.move) moves[job.key] = { ...moves[job.key], cleaned: new Date().toISOString() };
      else done[job.key] = job.patterns;
    }
  } catch (error) {
    console.error('[main] shared-origin storage cleanup failed (will retry next launch):', error);
  }
  try {
    const temporary = `${markerPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(done, null, 2));
    fs.renameSync(temporary, markerPath);
    if (jobs.some(job => job.move)) _writeMoves(moves);
  } catch (error) {
    console.error('[main] could not record the shared-origin cleanup:', error.message);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  const win = _atmosWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

// Windows shows notifications under the app user model id; the installer's
// shortcut carries the same id (package.json "build.appId").
if (process.platform === 'win32') app.setAppUserModelId('com.hashy.atmosphere');

// Cookies are encrypted on disk (package.json "build" "electronFuses";
// `npm start` flips the same fuse on its Electron). One-way: an Electron
// without it can't read them (every sign-in gone) and writes plain ones.
// The profile records that it's encrypted; running from source with an
// Electron that isn't (`npx electron .`, an IDE's launcher) stops instead.
const COOKIES_ENCRYPTED_MARK = 'cookies-encrypted';
async function _cookiesReadable() {
  const mark = path.join(app.getPath('userData'), COOKIES_ENCRYPTED_MARK);
  const remember = () => { try { if (!fs.existsSync(mark)) fs.writeFileSync(mark, 'Cookies here are encrypted (Atmos 0.19.2).\n'); } catch { /* next start */ } };
  if (app.isPackaged) { remember(); return true; }
  let fuses;
  try { fuses = require('@electron/fuses'); } catch { return true; }
  let on = false;
  try { on = (await fuses.getCurrentFuseWire(process.execPath))[fuses.FuseV1Options.EnableCookieEncryption] === 49; } catch { return true; }
  if (on) { remember(); return true; }
  if (!fs.existsSync(mark)) return true;
  dialog.showErrorBox('Atmos', 'This profile’s cookies are encrypted, and the Electron running Atmos here doesn’t encrypt them: your sign-ins would be lost. Start Atmos with `npm start`, which turns encryption on in this Electron.');
  app.exit(1);
  return false;
}

if (hasInstanceLock) app.whenReady().then(async () => {
  if (!(await _cookiesReadable())) return;
  // Whether this profile was used before, read before any window opens: the
  // startup splash's page makes Chromium create "Local Storage" at once,
  // which made every first start look like an upgrade (0.19.4–0.20.1: no
  // picker, everything installed).
  const usedBefore = _usedBefore(app.getPath('userData'));
  // Something on screen at once, while extensions are checked and started.
  _openStartupSplash();
  console.log('[main] userData:', app.getPath('userData'));
  // How the last Atmos update went (atmos-update.cjs).
  const lastUpdate = _updater.startup();
  if (lastUpdate.installed) console.log(`[update] updated to Atmos ${lastUpdate.installed.version} from ${lastUpdate.installed.from}`);
  if (lastUpdate.failed) console.warn(`[update] Atmos ${lastUpdate.failed} didn't install`);
  powerMonitor.on('shutdown', () => { _sessionEnding = true; });
  // Upgrading from an Atmos that bundled every extension: what came with it
  // is installed from the packages that come with this one, at once, so
  // nothing disappears (settings and data are kept by id). A first start
  // shows the picker instead (Settings, first run).
  // With packages of its own (a personal build) that happens here, offline;
  // otherwise they are downloaded once the window is up (below) and applied
  // at the next restart.
  // (A first run that hasn't been chosen yet, say offline, stays a first run.)
  const upgrading = !_manager.setupDone() && !_manager.setupPending() && usedBefore;
  if (!_manager.setupDone() && !upgrading) _manager.beginSetup();
  if (upgrading && _seedSources().length) {
    const changes = await _manager.installFromSeed();
    console.log(`[extensions] upgrade: installing ${changes.map(change => change.id).join(', ') || 'nothing'} from the packages that come with Atmos`);
    _manager.finishSetup('upgrade');
  }
  // Installs, updates and removals chosen last session, before anything is listed.
  for (const change of _manager.applyPending()) {
    console.log(`[extensions] ${change.action === 'install' ? 'installed' : 'removed'} ${change.kind} '${change.id}'${change.version ? ` ${change.version}` : ''}`);
  }
  _catalog.refresh(); // what was listed above (to plan installs) may have changed
  _extensionPreferences = createExtensionPreferences(path.join(app.getPath('userData'), 'extension-preferences.json'));
  _windowAppearance = _loadWindowAppearance();
  _startupDisabled = {
    plugin: _extensionPreferences.disabledIds('plugin'),
    service: _extensionPreferences.disabledIds('service'),
  };
  const userData = app.getPath('userData');
  _trust = createExtensionTrust({
    approvalsFile: path.join(userData, 'extension-approvals.json'),
    hashCacheFile: path.join(userData, 'extension-hash-cache.json'),
    bundledRoot: _bundledRoot,
    trustedKeys: _trustedKeys,
    // "engines.atmos", apiVersion and capabilities, against this Atmos.
    compatibility: manifest => checkCompatibility(manifest, { appVersion: app.getVersion() }),
  });
  const trustStart = Date.now();
  // An update that failed to start last time falls back to the version it replaced.
  _trust.assessAll(_catalog, { refuse: entry => _manager.failedUpdate(entry) });
  _resolveDependencyState();
  _cleanUpRemovedData();
  console.log(`[main] checked extension integrity in ${Date.now() - trustStart}ms`);
  const extensions = createExtensionHost({ app, BrowserWindow, ipcMain, dialog, shell, protocol, authorizeInvoke: _authorizeInvoke, appVersion: app.getVersion() });
  // An extension frame that called a main.cjs went (its handlers' event.callerFrame).
  _page.on('extensions:frame-closed', (event, frame) => extensions.frameClosed(event.sender, String(frame)));
  const activePlugins = _catalog.list('plugins').filter(_isActive);
  // Only official plugins may stand in for a service ("supersedesServices"):
  // a community one could otherwise switch an official service off.
  const supersededServices = extensions.supersededServices(activePlugins.filter(entry => entry.tier !== 'third-party'));
  const activeServices = _catalog.list('services')
    .filter(entry => _isActive(entry) && !supersededServices.has(entry.id));
  // A main.cjs that throws or takes longer than 10 s is failed and startup
  // carries on; whatever needs it is skipped (and not listed as active).
  const activation = {
    timeoutMs: _activationTimeoutMs(),
    skip: (kind, id) => {
      const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
      return entry && !_isActive(entry) ? (_dependencyState?.get(refOf(entry))?.problems[0] || 'not loading') : null;
    },
    onFailed: (kind, id, error) => {
      _activationFailures.set(`${kind}:${id}`, error?.code === 'ATMOS_ACTIVATION_TIMEOUT'
        ? `Didn't start: it took longer than ${Math.round(_activationTimeoutMs() / 1000)} s`
        : `Didn't start: ${error?.message || error}`);
      _resolveDependencyState();
    },
  };
  // main.cjs runs only for official and system extensions. Trust already
  // blocks a community one that has a main.cjs; this doesn't rely on it.
  const mayRunMain = entry => entry.tier !== 'third-party';
  // Updates whose main.cjs starts now for the first time: if Atmos never
  // gets past this (a crash, a main.cjs that hangs it), the next start runs
  // the version before (R4).
  _manager.markStarting([...activeServices, ...activePlugins.filter(_isActive)]
    .filter(entry => mayRunMain(entry) && fs.existsSync(path.join(entry.path, 'main.cjs'))));
  await extensions.activateEntries('service', activeServices.filter(mayRunMain), activation);
  await extensions.activateEntries('plugin', activePlugins.filter(entry => _isActive(entry) && mayRunMain(entry)), activation);
  // Updates applied this start: confirmed once they've started (trust, then
  // their main.cjs); a frame that fails to load later says so (frame-failed).
  _manager.confirmApplied((kind, id) => {
    const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
    const trust = entry ? _trust.get(entry) : null;
    const problem = entry ? (_activationFailures.get(refOf(entry)) || '').replace(/^Didn't start: /, '') || null : null;
    const loadable = trust?.loadable !== false && !problem;
    return entry ? {
      entry, loadable, problem,
      // Switched off, or waiting for what it needs: it hasn't run yet.
      inactive: loadable && !_isActive(entry),
      awaitingApproval: entry.tier === 'third-party' && ['pending', 'changed'].includes(trust?.status),
    } : null;
  });
  extensions.registerResourceProtocol(protocol, { allowOrigin: _originMayUseResource });
  _registerAtmosAppProtocol();
  _registerAtmosExtProtocol();
  // Storage moves decide which origin an extension runs from, so they come
  // before browser permissions (granted per origin) and the window.
  await _moveToOwnOrigins();
  await _clearRemovedStorage();
  _installBrowserPermissions([...activePlugins, ...activeServices]);
  // Atmos Browser's sessions are set up when its first page attaches
  // (web-host.cjs configureSessions), so there are none without it.
  createWindow();
  _started = true;
  _watchDeveloperFolders();
  void _cleanUpSharedOriginStorage();
  // Check the sources soon after start and twice a day. Extensions only
  // download when Install or Update is pressed; a newer Atmos downloads by
  // itself with "Update Atmos automatically" (atmos-update.cjs). Hourly, a
  // reminder for an Atmos update left waiting two days.
  if (upgrading && !_seedSources().length) void _downloadForUpgrade();
  setTimeout(() => void _checkForUpdates(), 5000);
  setInterval(() => {
    if (!_lastUpdateCheck || Date.now() - _lastUpdateCheck > 12 * 60 * 60 * 1000) void _checkForUpdates();
    else _nudgeAboutUpdate();
  }, 60 * 60 * 1000).unref?.();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stopped from outside rather than quit: Ctrl+C in the terminal running
// `npm start`, its window closed (SIGHUP on Windows, which then gives about
// 5 s), or a polite kill. Quit as if the window were closed, so browser
// pages get their last events first: Discord writes its sign-in back as
// its page closes, and a process killed without that comes back signed
// out. A second signal, or no quit within 4 s, stops at once.
let _signalled = false;
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM', 'SIGBREAK']) {
  try {
    process.on(signal, () => {
      if (_signalled) return app.exit(0);
      _signalled = true;
      console.log(`[main] ${signal}: quitting`);
      setTimeout(() => app.exit(0), 4000).unref?.();
      app.quit();
    });
  } catch { /* a signal this platform doesn't have */ }
}

// Like Chrome: a downloaded Atmos update installs as Atmos quits (when
// updating automatically, on a per-user install), or for "Restart to
// update" (and starts Atmos again). will-quit comes once the windows have
// closed, browser pages' last events included (atmos-update.cjs).
app.on('will-quit', () => {
  if (!_started || _sessionEnding) return;
  if (_installOnQuit) {
    try {
      _updater.installNow();
      console.log(`[update] installing Atmos ${_updater.state().version}; it starts again afterwards`);
    } catch (error) {
      console.warn('[update] not installed, starting again as before:', error.message);
      app.relaunch();
    }
    return;
  }
  if (_relaunching) return;
  if (_updater.installOnQuit()) console.log(`[update] installing Atmos ${_updater.state().version} as Atmos quits`);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

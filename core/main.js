const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen, protocol, session, Notification, net, webContents, WebContentsView, nativeImage, utilityProcess } = require('electron');
const fs   = require('fs');
const path = require('path');

const { createExtensionHost, checkCompatibility, ACTIVATION_TIMEOUT_MS } = require('./js/core/extension-host.cjs');
const { createExtensionPreferences } = require('./js/core/extension-preferences.cjs');
const { createExtensionCatalog } = require('./js/core/extension-catalog.cjs');
const { createExtensionTrust } = require('./js/core/extension-trust.cjs');
const { loadTrustedKeys } = require('./js/core/extension-signing.cjs');
const { resolveDependencies, dependentsOf, normalizeDependencies, refOf } = require('./js/core/extension-dependencies.cjs');
const { createExtensionManager } = require('./js/core/extension-manager.cjs');
const { createExtensionStateStore } = require('./js/core/extension-state.cjs');
const { BASELINE_BROWSER, reachOf, reaches, exportDetails, describeExports, sharingRisk } = require('./js/core/extension-permissions.cjs');
const { createLocationGate } = require('./js/core/location-gate.cjs');
const { createExtensionFetch } = require('./js/core/extension-fetch.cjs');
const frames = require('./js/core/extension-frames.cjs');
const { resolveContainedPath } = require('./js/core/path-security.cjs');
const { createWebHost } = require('./js/core/web-host.cjs');

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

// Extension → MIME lookup shared by every atmos-* protocol (the app shell,
// plugins, and services). Chromium silently refuses some assets served as
// application/octet-stream — notably stylesheets injected with
// `new URL('./x.css', import.meta.url)` — so every served type belongs here.
// Text types carry an explicit charset because the protocol handlers return
// raw bytes with no other encoding hint.
const _MIME_BY_EXT = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.cjs':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.avif':  'image/avif',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.mp3':   'audio/mpeg',
  '.wav':   'audio/wav',
  '.ogg':   'audio/ogg',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.wasm':  'application/wasm',
};

function _mimeFor(filename) {
  return _MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/** Reads a regular file for a protocol response, or returns null when the
 *  path is missing or is not a file. */
/**
 * A file's bytes, or null. With `root`, only a file that really is inside
 * it: a symbolic link (or junction) pointing out of an extension's folder
 * would otherwise serve whatever it points at, and links aren't part of
 * the fingerprint a community extension is approved on.
 */
async function _readServableFile(filePath, root = null) {
  try {
    if (root) {
      const [real, realRoot] = await Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(root)]);
      const inside = path.relative(realRoot, real);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
    }
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? await fs.promises.readFile(filePath) : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

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

  win.webContents.on('before-input-event', (event, input) => {
    // DevTools only when running from source, or started with --devtools:
    // otherwise, in an installed Atmos, they'd be a console on the page
    // that holds every bridge.
    if (input.key === 'F12' && input.type === 'keyDown' && (!app.isPackaged || process.argv.includes('--devtools'))) {
      win.webContents.isDevToolsOpened()
        ? win.webContents.closeDevTools()
        : win.webContents.openDevTools({ mode: 'detach' });
    }
    // Ctrl+R reloads Atmos, except in Atmos Browser's panel, where it reloads the tab.
    // The browser's pages close first, as Chrome closes a tab (web-host.cjs closePages).
    if (input.key === 'r' && input.control && input.type === 'keyDown' && !_isWebExtensionFrame(win.webContents.focusedFrame)) {
      event.preventDefault();
      void _web.closePages().finally(() => { if (!win.isDestroyed()) win.webContents.reload(); });
    }
  });

  Menu.setApplicationMenu(null);

  win.webContents.on('preload-error', (_, preloadPath, error) => {
    console.error('[main] preload-error:', preloadPath, error);
  });

  win.webContents.on('console-message', (_, _level, message) => {
    console.log('[renderer]', message);
  });

  win.loadURL('atmos-app://local/index.html');
}

// ── Window controls ───────────────────────────────────────────────────────────

ipcMain.handle('toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const fullscreen = !win.isFullScreen();
  win.setFullScreen(fullscreen);
  return fullscreen;
});

// package.json sits at the repo root, outside the core/ folder atmos-app://
// serves, so the renderer asks for the version instead of fetching it.
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('is-fullscreen', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
});

ipcMain.handle('is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

ipcMain.handle('task-view:capture-preview', async (event, requestedRect) => {
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

ipcMain.handle('window-effects:get', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    active: win?.__atmosTransparentWindow === true,
    configured: _windowAppearance.transparent === true,
  };
});

ipcMain.handle('window-effects:set-transparent', (event, enabled) => {
  _windowAppearance = { transparent: enabled === true };
  _saveWindowAppearance();
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    active: win?.__atmosTransparentWindow === true,
    configured: _windowAppearance.transparent,
  };
});

ipcMain.on('win-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('win-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.on('win-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on('set-window-click-through', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(enabled === true, enabled === true ? { forward: true } : undefined);
});

ipcMain.on('window-resize:start', (event, direction, screenX, screenY) => {
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

ipcMain.on('window-resize:update', (event, screenX, screenY) => {
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

ipcMain.on('window-resize:end', event => {
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

/** A download for a web source, refused past maxBytes. */
async function _fetchSourceFile(url, maxBytes) {
  const response = await net.fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`${new URL(url).pathname.split('/').pop()}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('The file is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('The file is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
  appVersion: app.getVersion(),
});

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

// The system services (Wallpaper, Audio, Location) are part of Atmos itself:
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
  return !_isStartupDisabled(entry) && _trust?.get(entry)?.loadable !== false && !_activationFailures.has(refOf(entry));
}

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
  return {
    updates: status.updates, pending: status.pending.length, problems, approvals, checkedAt: status.checkedAt,
    atmosUpdate: status.core?.available ? { version: status.core.available, current: status.core.current, download: _atmosDownloadUrl() !== null } : null,
  };
}

function _broadcastManager(status = _manager.status()) {
  const payload = { status, summary: _managerSummary(status) };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('extensions:manager-changed', payload);
  }
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
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('extensions:upgrade-downloaded', { changes });
      }
    }
  } catch (error) {
    console.warn(`[extensions] upgrade: can't download extensions yet (${error.message}); trying again next start`);
  }
}

let _lastUpdateCheck = null;
async function _checkForUpdates() {
  try {
    const status = await _manager.checkForUpdates();
    _lastUpdateCheck = Date.now();
    return _broadcastManager(status);
  } catch (error) {
    console.warn('[extensions] update check failed:', error.message);
    return _broadcastManager();
  }
}

// A sender must be the Atmos page itself: frames never reach these.
function _fromAtmosPage(event) {
  return String(event.senderFrame?.url || event.sender.getURL()).startsWith('atmos-app://local/');
}
function _managerHandler(name, fn) {
  ipcMain.handle(`extensions:${name}`, async (event, ...args) => {
    if (!_fromAtmosPage(event)) throw new Error('Not allowed');
    return fn(...args);
  });
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
_managerHandler('take-data-cleanup', () => _dataCleanup.splice(0));
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
  try {
    return {
      needed: true,
      packages: (await _manager.seedPackages()).map(item => ({
        kind: item.kind, id: item.id, version: item.version, displayName: item.displayName, description: item.description,
        dependencies: item.named,
      })),
    };
  } catch (error) {
    // Offline, or the source can't be reached: the picker says so and offers to try again.
    return { needed: true, packages: [], error: error.message };
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

ipcMain.handle('extension-state:load-all', event => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  return _stateStore.loadAll();
});
ipcMain.handle('extension-state:save', (event, kind, id, data) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  _checkedExtension(kind, id);
  _stateStore.save(kind, id, data);
  return true;
});
// The same, synchronously: the page's last writes as it unloads (quitting,
// restarting), when an asynchronous reply would never arrive.
ipcMain.on('extension-state:save-sync', (event, kind, id, data) => {
  try {
    if (!_fromAtmosPage(event)) throw new Error('Not allowed');
    _checkedExtension(kind, id);
    _stateStore.save(kind, id, data);
    event.returnValue = true;
  } catch (error) {
    console.warn(`[extensions] could not save ${kind}:${id}'s state:`, error.message);
    event.returnValue = false;
  }
});

// Extensions removed with their data at this start: the page forgets their
// state namespaces (it asks once, at boot), and origins of their own lose
// their storage (_clearRemovedStorage, once the schemes are registered).
const _dataCleanup = [];
function _cleanUpRemovedData() {
  for (const { kind, id } of _manager.takeDataCleanup()) {
    _dataCleanup.push({ kind, id });
    try { _stateStore.remove(kind, id); } catch (error) { console.warn(`[extensions] could not delete ${kind}:${id}'s state:`, error.message); }
    // Atmos Browser's: its session (cookies, storage, cache) and site settings.
    _web.forgetExtensionData(`${kind}:${id}`).catch(error => console.warn(`[extensions] could not delete ${kind}:${id}'s browsing data:`, error.message));
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
  for (const { kind, id } of _dataCleanup) {
    for (const host of [`${kind}-${id}`, `first-party-${kind}-${id}`]) {
      const origin = `${frames.SCHEME}://${host}`;
      try {
        await session.defaultSession.clearStorageData({ origin });
        const deleted = await _withStoragePage(null, frames.storageHostScript({ from: origin, remove: { indexedDB: ['*'], localStorage: ['*'] } }), 60_000, { removeHost: host });
        if (deleted?.length) console.log(`[extensions] deleted ${kind}:${id}'s storage in ${origin}:`, deleted.join(', '));
      } catch (error) {
        console.warn(`[extensions] could not delete ${kind}:${id}'s storage in ${origin}:`, error.message);
      }
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

/** What `entry` may use of the extension `targetRef`: { ipc, events, methods }, or null for itself. */
function _reachOf(entry, targetRef) {
  const target = _entryOf(targetRef);
  const empty = { ipc: [], events: [], methods: [] };
  if (!target) return empty;
  return reachOf(
    { kind: entry.kind, id: entry.id, tier: entry.tier, invokes: _trust?.get(entry)?.permissions.invokes || [] },
    { kind: target.kind, id: target.id, exports: _trust?.get(target)?.exports },
  ) || null;
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

/**
 * Checked by extension-host.cjs before every main.cjs IPC handler runs. Only
 * the Atmos page (never a frame) can call, and only on behalf of a framed
 * extension (`caller`, stamped by Core's bridge): the page's own code never
 * invokes a main.cjs handler. Returns a refusal, or null.
 */
function _authorizeInvoke(event, caller, { kind, id, name }) {
  if (!_fromAtmosPage(event)) return 'Not allowed';
  if (typeof caller !== 'string') return 'Not allowed';
  const target = `${kind}:${id}`;
  if (caller === target) return null;
  const entry = _entryOf(caller);
  if (!entry || !_isActive(entry)) return `${caller} is not running`;
  if (!(_trust?.get(entry)?.permissions.invokes || []).includes(target)) return `${caller} is not permitted to invoke ${target}`;
  const reach = _reachOf(entry, target);
  if (!reaches(reach.ipc, name)) return `${target} doesn't share its '${name}' handler with ${entry.tier === 'third-party' ? 'community' : 'other'} extensions`;
  return null;
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
  };
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
    developerRestart: _developerRestart.has(refOf(entry)),
    developerIgnored: entry.developerIgnored || null,
    enabled: entry.tier === 'system' || !disabled.has(entry.id),
    active: _isActive(entry),
    ..._describeTrust(entry),
    ..._describePackage(entry),
    ..._describeRuntime(entry),
  };
}

ipcMain.handle('plugins:list', async () => {
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

ipcMain.handle('services:list', async () => {
  const disabled = _extensionPreferences?.disabledIds('service') ?? new Set();
  try {
    return _catalog.list('services').map(entry => _describeExtension(entry, _walkRelativeFiles(entry.path), disabled));
  } catch (e) {
    console.error('[main] services:list error:', e.message);
    return [];
  }
});

ipcMain.handle('extensions:set-enabled', async (event, kind, id, enabled) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
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
ipcMain.handle('extensions:approve', async (event, kind, id, fingerprint) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  const folder = kind === 'plugin' ? 'plugins' : 'services';
  const entry = _catalog.find(folder, id);
  const result = _trust.approve(folder, entry, fingerprint);
  let loaded = null;
  try { loaded = _loadApprovedNow(folder, entry); }
  catch (error) { console.warn(`[extensions] ${kind} '${id}' approved; it loads at the next start (${error.message})`); }
  // The page registers their surfaces and starts their background frames.
  if (loaded) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('extensions:loaded', loaded);
    }
  }
  _broadcastManager();
  return loaded ? { ...result, restartRequired: false, loaded } : { ...result, loaded: [] };
});

ipcMain.handle('extensions:revoke', async (event, kind, id) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (!entry || entry.tier !== 'third-party') throw new Error('Only community extensions have approvals');
  _trust.revoke(entry);
  _broadcastManager();
  return { restartRequired: true };
});

ipcMain.handle('extensions:restart', event => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  // quit() (not exit()) closes windows normally, so the renderer's unload
  // handlers flush pending saves and the window state is written.
  app.relaunch();
  app.quit();
});

// System notifications for framed extensions, which can't use the
// Notification API themselves. The bridge in the page has checked the
// extension declares "notifications"; this checks again against its trust
// record. A click brings Atmos forward and tells the extension's frames.
const _shownNotifications = new Set(); // kept referenced until closed, so clicks arrive
ipcMain.handle('extensions:notify', (event, kind, id, options) => {
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

ipcMain.handle('extensions:fetch', async (event, caller, requestId, request) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
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
ipcMain.on('extensions:fetch-abort', (event, caller, requestId) => {
  if (_fromAtmosPage(event)) _fetchesInFlight.get(`${caller} ${requestId}`)?.abort();
});

ipcMain.handle('extensions:open-root', async (event, kind) => {
  if (!_fromAtmosPage(event)) throw new Error('Not allowed');
  if (kind === 'plugins') return shell.openPath(_installedRoot('plugins'));
  if (kind === 'services' || kind === 'service') return shell.openPath(_installedRoot('services'));
  return 'Unsupported extension kind';
});

// ── Framed extensions (atmos-ext://) ─────────────────────────────────────────
const _SDK_DIR = path.join(__dirname, 'js', 'sdk');
// ui.css: Atmos's Settings rows and controls, for frames that opt in (SDK 1.1).
const _SDK_FILES = { '/__atmos/sdk.js': 'atmos-sdk.js', '/__atmos/frame.js': 'frame.js', '/__atmos/frame.css': 'frame.css', '/__atmos/ui.css': 'ui.css' };

function _originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function _activeEntries() {
  return [..._catalog.list('plugins'), ..._catalog.list('services')].filter(_isActive);
}

function _framedEntries() {
  return _activeEntries().filter(entry => frames.resolveRuntime(entry) === 'frame');
}

/** Active services whose files other extensions' frames may import. */
function _libraryService(id) {
  const entry = _catalog.find('services', id);
  return entry && _isActive(entry) && entry.manifest?.library === true ? entry : null;
}

/** Origins of the libraries a framed extension declared (invokes service:<id>). */
function _libraryOriginsFor(entry) {
  const origins = new Set();
  for (const target of _trust.get(entry)?.permissions.invokes || []) {
    const [kind, id] = target.split(':');
    const library = kind === 'service' ? _libraryService(id) : null;
    if (library) origins.add(frames.frameOrigin(library));
  }
  origins.delete(frames.frameOrigin(entry));
  return [...origins];
}

/**
 * atmos-resource:// providers a framed extension may load: those it
 * registers itself ("resources"). Another extension's are never shared
 * (that went with SDK 1.0).
 */
function _resourceProvidersFor(entry) {
  return [...new Set(_trust.get(entry)?.permissions.resources || [])];
}

/** Whether a frame origin may fetch() a resource provider's responses. */
function _originMayUseResource(origin, provider) {
  return _framedEntries().some(entry => frames.frameOrigin(entry) === origin && _resourceProvidersFor(entry).includes(provider));
}

/** Whether a frame origin belongs to an extension that declared this library. */
function _originMayUseLibrary(origin, library) {
  return _framedEntries().some(entry => frames.frameOrigin(entry) === origin
    && (_trust.get(entry)?.permissions.invokes || []).includes(`service:${library.id}`));
}

function _registerAtmosExtProtocol() {
  protocol.handle('atmos-ext', async request => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      const owners = _framedEntries().filter(entry => frames.frameHost(entry) === host);
      const rel = decodeURIComponent(url.pathname);
      const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

      if (rel === '/__atmos/frame.html') {
        const [kind, id] = (url.searchParams.get('ext') || '').split(':');
        const entry = owners.find(candidate => candidate.kind === kind && candidate.id === id);
        if (!entry) return new Response('Forbidden', { status: 403 });
        const csp = frames.frameCsp({
          permissions: _trust.get(entry)?.permissions,
          inlineScriptHashes: [frames.IMPORT_MAP_HASH],
          libraryOrigins: _libraryOriginsFor(entry),
          resourceProviders: _resourceProvidersFor(entry),
        });
        return new Response(frames.frameDocument(), {
          headers: { ...noStore, 'Content-Type': _MIME_BY_EXT['.html'], 'Content-Security-Policy': csp },
        });
      }
      // Core's pages that copy an extension's storage into its own origin,
      // or delete it, served only to the move or removal running now (see
      // _moveToOwnOrigins, _clearRemovedStorage).
      if (_moveInProgress && (rel === '/__atmos/move.html' || rel === '/__atmos/move.js')) {
        // export: the shared origin, or the origin whose storage is being deleted (it reads and deletes).
        const role = host === frames.FIRST_PARTY_HOST || (_moveInProgress.removeHost && host === _moveInProgress.removeHost) ? 'export'
          : _moveInProgress.host && host === _moveInProgress.host ? 'import' : null;
        if (role && rel === '/__atmos/move.html') {
          return new Response(frames.moveDocument(role), {
            headers: { ...noStore, 'Content-Type': _MIME_BY_EXT['.html'], 'Content-Security-Policy': frames.moveCsp(role) },
          });
        }
        if (role) {
          return new Response(await fs.promises.readFile(path.join(__dirname, 'js', 'core', 'extension-origin-move.js')), {
            headers: { ...noStore, 'Content-Type': _MIME_BY_EXT['.js'] },
          });
        }
      }
      // An empty document in the shared first-party origin, for Core's own
      // one-time storage cleanup (see _cleanUpSharedOriginStorage).
      if (rel === '/__atmos/blank.html' && host === frames.FIRST_PARTY_HOST) {
        return new Response('<!doctype html><title></title>', {
          headers: { ...noStore, 'Content-Type': _MIME_BY_EXT['.html'], 'Content-Security-Policy': "default-src 'none'" },
        });
      }
      if (_SDK_FILES[rel]) {
        if (!owners.length) return new Response('Not found', { status: 404 });
        const filePath = path.join(_SDK_DIR, _SDK_FILES[rel]);
        return new Response(await fs.promises.readFile(filePath), {
          headers: { ...noStore, 'Content-Type': _mimeFor(filePath) },
        });
      }

      const match = rel.match(/^\/(plugins|services)\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
      const file = match ? frames.safeRelative(match[3]) : null;
      if (!file) return new Response('Not found', { status: 404 });
      const kind = match[1] === 'plugins' ? 'plugin' : 'service';
      let entry = owners.find(candidate => candidate.kind === kind && candidate.id === match[2]);
      const headers = { 'X-Content-Type-Options': 'nosniff' };
      if (!entry && kind === 'service') {
        // Another extension's frame importing a library service's modules.
        const library = _libraryService(match[2]);
        if (library && frames.frameHost(library) === host) {
          entry = library;
          const origin = request.headers.get('origin');
          if (origin && _originMayUseLibrary(origin, library)) {
            headers['Access-Control-Allow-Origin'] = origin;
            headers.Vary = 'Origin';
          }
        }
      }
      if (!entry) return new Response('Not found', { status: 404 });
      const filePath = resolveContainedPath(entry.path, file);
      const buf = filePath ? await _readServableFile(filePath, entry.path) : null;
      if (!buf) return new Response('Not found', { status: 404 });
      // A developer folder changes under Atmos: never serve a stale copy.
      if (entry.source === 'developer') headers['Cache-Control'] = 'no-store';
      return new Response(buf, { headers: { ...headers, 'Content-Type': _mimeFor(filePath) } });
    } catch (e) {
      console.error('[main] atmos-ext protocol error:', e.message);
      return new Response('Error', { status: 500 });
    }
  });
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
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('extensions:developer-changed', { kind: entry.kind, id: entry.id, restart, extension: description });
      }
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
const _APP_ORIGIN = 'atmos-app://local';
const _EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// shell.openExternal goes through Atmos Browser first (see _web.routeShell).
function _openExternally(url) {
  try {
    if (_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) shell.openExternal(url);
    else console.warn('[main] refused to open', url);
  } catch {
    console.warn('[main] refused to open', url);
  }
}

function _isAppUrl(url) {
  return typeof url === 'string' && (url === _APP_ORIGIN || url.startsWith(`${_APP_ORIGIN}/`));
}

/** An active official extension declaring "web": true ("plugin:<id>"). */
function _isWebExtension(ref) {
  const entry = typeof ref === 'string' ? _entryOf(ref) : null;
  return !!entry && entry.tier !== 'third-party' && _isActive(entry) && _trust?.get(entry)?.permissions.web === true;
}

/** Whether a frame of the Atmos window is one of a web extension's (its panel, say). */
function _isWebExtensionFrame(frame) {
  const origin = frame?.origin;
  if (!origin || !origin.startsWith('atmos-ext://')) return false;
  return _framedEntries().some(entry => frames.frameOrigin(entry) === origin && _isWebExtension(`${entry.kind}:${entry.id}`));
}

const _web = createWebHost({
  app, session, BrowserWindow, WebContentsView, nativeImage, webContents, shell, ipcMain, utilityProcess, dialog,
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
  contents.setWindowOpenHandler(({ url }) => {
    _openExternally(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (_isAppUrl(url)) return;
    event.preventDefault();
    _openExternally(url);
  });
  // Refused everywhere except the Atmos page's own web layer, and there
  // only in the browser's sessions, starting blank, with fixed preferences.
  contents.on('will-attach-webview', (event, webPreferences, params) => _web.attachWebview(contents, event, webPreferences, params));
  // Frames only ever show extension documents. Core creates them; an
  // extension frame may reload or move within its own origin, never to the
  // web, to another extension's origin, or to Atmos itself.
  contents.on('will-frame-navigate', details => {
    if (details.isMainFrame) return;
    const target = _originOf(details.url);
    const initiator = details.initiator;
    const fromCore = !initiator || initiator === contents.mainFrame;
    const allowed = details.url.startsWith('atmos-ext://')
      && (fromCore || (initiator.origin && initiator.origin === target));
    if (!allowed) {
      details.preventDefault();
      console.warn('[main] blocked frame navigation to', details.url);
    }
  });
});

// Location stays off until you press Detect (see location-gate.cjs).
const _locationGate = createLocationGate({ appOrigin: _APP_ORIGIN });
ipcMain.handle('location:allow-detect', event => {
  // Only the Atmos page itself (not a frame inside it) opens the gate.
  if (event.senderFrame !== event.sender.mainFrame || !_isAppUrl(event.senderFrame?.url)) return false;
  _locationGate.open();
  return true;
});

function _installBrowserPermissions(activeEntries) {
  // The Atmos page gets what page-runtime extensions declare; each frame
  // origin gets what its own extension(s) declare.
  const byOrigin = new Map([[_APP_ORIGIN, new Set(BASELINE_BROWSER)]]);
  for (const entry of activeEntries) {
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

function _readMoves() {
  try {
    const saved = JSON.parse(fs.readFileSync(_MOVES_FILE, 'utf8'));
    return saved?.format === 1 && saved.moves && typeof saved.moves === 'object' ? saved.moves : {};
  } catch { return {}; }
}

function _writeMoves(moves) {
  const temporary = `${_MOVES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ format: 1, moves }, null, 2));
  fs.renameSync(temporary, _MOVES_FILE);
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
  let changed = false;
  for (const entry of _framedEntries()) {
    const spec = frames.sharedOriginMove(entry);
    const ref = `${entry.kind}:${entry.id}`;
    if (!spec || moves[ref]?.status === 'copied') continue;
    const started = Date.now();
    try {
      const copied = await _moveOne(entry, spec);
      moves[ref] = { status: 'copied', session: _SESSION, at: new Date().toISOString(), spec, copied };
      console.log(`[extensions] moved ${ref}'s storage into ${frames.frameOrigin(entry)} in ${Date.now() - started}ms:`, JSON.stringify(copied));
    } catch (error) {
      // Run from the shared origin this session, where its data still is.
      entry.originFallback = true;
      const reason = error?.message || String(error);
      moves[ref] = { status: 'failed', at: new Date().toISOString(), error: reason, attempts: (moves[ref]?.attempts || 0) + 1 };
      _moveProblems.set(ref, `Its data couldn't be moved to storage of its own (${reason}); it uses the shared storage this session, and Atmos tries again at the next start`);
      console.error(`[extensions] could not move ${ref}'s storage; using the shared origin this session:`, reason);
    }
    changed = true;
  }
  if (changed) {
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
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

// Windows shows notifications under the app user model id; the installer's
// shortcut carries the same id (package.json "build.appId").
if (process.platform === 'win32') app.setAppUserModelId('com.hashy.atmosphere');

if (hasInstanceLock) app.whenReady().then(async () => {
  console.log('[main] userData:', app.getPath('userData'));
  // Upgrading from an Atmos that bundled every extension: what came with it
  // is installed from the packages that come with this one, at once, so
  // nothing disappears (settings and data are kept by id). A first start
  // shows the picker instead (Settings, first run).
  // With packages of its own (a personal build) that happens here, offline;
  // otherwise they are downloaded once the window is up (below) and applied
  // at the next restart.
  // (A first run that hasn't been chosen yet, say offline, stays a first run.)
  const upgrading = !_manager.setupDone() && !_manager.setupPending() && _usedBefore(app.getPath('userData'));
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
  _trust.assessAll(_catalog);
  _resolveDependencyState();
  _manager.confirmApplied((kind, id) => {
    const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
    return entry ? { entry, loadable: _trust.get(entry)?.loadable !== false } : null;
  });
  _cleanUpRemovedData();
  console.log(`[main] checked extension integrity in ${Date.now() - trustStart}ms`);
  const extensions = createExtensionHost({ app, BrowserWindow, ipcMain, dialog, shell, protocol, authorizeInvoke: _authorizeInvoke, appVersion: app.getVersion() });
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
  await extensions.activateEntries('service', activeServices.filter(mayRunMain), activation);
  await extensions.activateEntries('plugin', activePlugins.filter(entry => _isActive(entry) && mayRunMain(entry)), activation);
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
  _watchDeveloperFolders();
  void _cleanUpSharedOriginStorage();
  // Check the sources soon after start and twice a day; this only reads
  // their indexes (nothing downloads until Install or Update is pressed).
  if (upgrading && !_seedSources().length) void _downloadForUpgrade();
  setTimeout(() => void _checkForUpdates(), 5000);
  setInterval(() => {
    if (!_lastUpdateCheck || Date.now() - _lastUpdateCheck > 12 * 60 * 60 * 1000) void _checkForUpdates();
  }, 60 * 60 * 1000).unref?.();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

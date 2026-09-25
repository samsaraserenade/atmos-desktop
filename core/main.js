const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen, protocol, session, Notification } = require('electron');
const fs   = require('fs');
const path = require('path');

const { createExtensionHost } = require('./js/core/extension-host.cjs');
const { createExtensionPreferences } = require('./js/core/extension-preferences.cjs');
const { createExtensionCatalog } = require('./js/core/extension-catalog.cjs');
const { createExtensionTrust } = require('./js/core/extension-trust.cjs');
const { BASELINE_BROWSER } = require('./js/core/extension-permissions.cjs');
const { createLocationGate } = require('./js/core/location-gate.cjs');
const frames = require('./js/core/extension-frames.cjs');
const { resolveContainedPath } = require('./js/core/path-security.cjs');

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
    // atmos-plugin:// lets plugin-loader.js import() plugin files that live
    // outside the app's own file:// origin (AppData, not the app bundle).
    // Chromium's ES module loader blocks cross-directory file:// imports
    // outright — this sidesteps that by making plugin files look like
    // same-origin resources. `standard` + `supportFetchAPI` are required
    // for import() to treat responses as loadable modules.
    scheme: 'atmos-plugin',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    // Renderer-facing shared services live outside the application bundle,
    // just like plugins, and therefore need their own module/resource bridge.
    scheme: 'atmos-service',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
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
async function _readServableFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? await fs.promises.readFile(filePath) : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
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

      const filePath = resolveContainedPath(__dirname, rel);

      // Guard against escaping the app directory via a crafted '..' path.
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }

      const buf = await fs.promises.readFile(filePath);
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': _mimeFor(filePath) },
      });
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
      sandbox:          false,
      preload:          preloadPath,
    }
  });
  win.__atmosTransparentWindow = transparentWindow;

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
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.isDevToolsOpened()
        ? win.webContents.closeDevTools()
        : win.webContents.openDevTools({ mode: 'detach' });
    }
    if (input.key === 'r' && input.control && input.type === 'keyDown') {
      event.preventDefault();
      win.webContents.reload();
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
// Launching with --extensions-root=<dir> (or ATMOS_EXTENSIONS_ROOT=<dir>)
// bundles <dir>/plugins and <dir>/services instead. Only bundled extensions
// can be `system` (always on) or `first-party`.
//
// Installed extensions live in %APPDATA%/atmos/{plugins,services}; they are
// always third-party, and a bundled extension with the same id wins. See
// extension-catalog.cjs. The handlers below only list what is present;
// plugin-loader.js and service-loader.js do their own dynamic import().
const _installedRoots = {};

function _bundledRoot(kind) {
  const flag = process.argv.find(arg => arg.startsWith('--extensions-root='));
  const override = flag ? flag.slice('--extensions-root='.length) : process.env.ATMOS_EXTENSIONS_ROOT;
  if (override) return path.join(path.resolve(override), kind);
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

const _catalog = createExtensionCatalog({ bundledRoot: _bundledRoot, installedRoot: _installedRoot });

let _trust = null;

/** Whether an extension is switched off for this session. System extensions never are. */
function _isStartupDisabled(entry) {
  return entry.tier !== 'system' && _startupDisabled[entry.kind].has(entry.id);
}

/** Whether an extension loads this session: switched on, and trusted (see extension-trust.cjs). */
function _isActive(entry) {
  return !_isStartupDisabled(entry) && _trust?.get(entry)?.loadable !== false;
}

function _describeTrust(entry) {
  const trust = _trust?.get(entry);
  if (!trust) return {};
  return {
    status: trust.status,
    statusReason: trust.reason,
    permissions: trust.permissions,
    permissionSummary: trust.permissionSummary,
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
  };
  return out;
}

function _describeExtension(entry, files, disabled) {
  return {
    id: entry.id, path: entry.path, files,
    manifest: entry.manifest,
    tier: entry.tier,
    source: entry.source,
    enabled: entry.tier === 'system' || !disabled.has(entry.id),
    active: _isActive(entry),
    ..._describeTrust(entry),
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

ipcMain.handle('extensions:set-enabled', async (_, kind, id, enabled) => {
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (entry?.tier === 'system' && enabled === false) throw new Error(`'${id}' is a system extension and cannot be disabled`);
  return _extensionPreferences.setEnabled(kind, id, enabled);
});

// Third-party approval: the renderer passes the fingerprint it showed the
// user; approval is refused if the files changed since. Takes effect on restart.
ipcMain.handle('extensions:approve', async (_, kind, id, fingerprint) => {
  const folder = kind === 'plugin' ? 'plugins' : 'services';
  return _trust.approve(folder, _catalog.find(folder, id), fingerprint);
});

ipcMain.handle('extensions:revoke', async (_, kind, id) => {
  const entry = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
  if (!entry || entry.source !== 'installed') throw new Error('Only third-party extensions have approvals');
  _trust.revoke(entry);
  return { restartRequired: true };
});

ipcMain.handle('extensions:restart', () => {
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

ipcMain.handle('extensions:open-root', async (_, kind) => {
  if (kind === 'plugins') return shell.openPath(_installedRoot('plugins'));
  if (kind === 'services' || kind === 'service') return shell.openPath(_installedRoot('services'));
  return 'Unsupported extension kind';
});

/** The folder of an active (discovered, trusted and not disabled) extension
 *  that runs in the Atmos page. Framed extensions are never served to the
 *  page: their code must only ever run inside their own frames. */
function _activeExtensionFolder(kind, id) {
  const entry = id ? _catalog.find(kind, id) : null;
  return entry && _isActive(entry) && frames.resolveRuntime(entry) === 'page' ? entry.path : null;
}

// ── Framed extensions (atmos-ext://) ─────────────────────────────────────────
const _SDK_DIR = path.join(__dirname, 'js', 'sdk');
const _SDK_FILES = { '/__atmos/sdk.js': 'atmos-sdk.js', '/__atmos/frame.js': 'frame.js', '/__atmos/frame.css': 'frame.css' };

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
 * registers itself ("resources"), and those registered by extensions it
 * declares in "invokes".
 */
function _resourceProvidersFor(entry) {
  const providers = new Set(_trust.get(entry)?.permissions.resources || []);
  for (const target of _trust.get(entry)?.permissions.invokes || []) {
    const [kind, id] = target.split(':');
    const owner = _catalog.find(kind === 'plugin' ? 'plugins' : 'services', id);
    if (owner && _isActive(owner)) for (const name of _trust.get(owner)?.permissions.resources || []) providers.add(name);
  }
  return [...providers];
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
      const buf = filePath ? await _readServableFile(filePath) : null;
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(buf, { headers: { ...headers, 'Content-Type': _mimeFor(filePath) } });
    } catch (e) {
      console.error('[main] atmos-ext protocol error:', e.message);
      return new Response('Error', { status: 500 });
    }
  });
}

function _registerAtmosPluginProtocol() {
  protocol.handle('atmos-plugin', async (request) => {
    try {
      const url = new URL(request.url); // atmos-plugin://<pluginId>/<file>
      const pluginId = url.hostname;
      const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));


      // Contain both the plugin id and the file path: neither a crafted
      // host nor a "../" filename may reach outside this plugin's folder.
      const pluginPath = _activeExtensionFolder('plugins', pluginId);
      const filePath = pluginPath && filename ? resolveContainedPath(pluginPath, filename) : null;
      if (!filePath || filePath === pluginPath) {
        console.warn('[main] atmos-plugin protocol — rejected path:', request.url);
        return new Response('Forbidden', { status: 403 });
      }

      const buf = await _readServableFile(filePath);
      if (!buf) {
        console.warn('[main] atmos-plugin protocol — not found:', filePath);
        return new Response('Not found', { status: 404 });
      }
      return new Response(buf, { status: 200, headers: { 'Content-Type': _mimeFor(filePath) } });
    } catch (e) {
      console.error('[main] atmos-plugin protocol error:', e.message);
      return new Response('Error', { status: 500 });
    }
  });
}

/** Serves renderer-side service modules and assets from
 *  %AppData%/atmos/services/<serviceId>. */
function _registerAtmosServiceProtocol() {
  protocol.handle('atmos-service', async (request) => {
    try {
      const url = new URL(request.url);
      const serviceId = url.hostname;
      const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const servicePath = _activeExtensionFolder('services', serviceId);
      const filePath = servicePath && filename ? resolveContainedPath(servicePath, filename) : null;
      const buf = filePath && filePath !== servicePath ? await _readServableFile(filePath) : null;
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(buf, { status: 200, headers: { 'Content-Type': _mimeFor(filePath) } });
    } catch (e) {
      console.error('[main] atmos-service protocol error:', e.message);
      return new Response('Error', { status: 500 });
    }
  });
}

// ── Web hardening ─────────────────────────────────────────────────────────────
// The Atmos window only ever shows atmos-app://local/. Links and window.open()
// to the web open in the user's browser; everything else is refused. No
// <webview>s. Browser permissions (location, notifications, camera...) are
// granted only to the Atmos page, and only those some active extension
// declares in extension.json "permissions.browser".
const _APP_ORIGIN = 'atmos-app://local';
const _EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

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

app.on('web-contents-created', (_, contents) => {
  if (contents.getType() === 'devtools') return;
  contents.setWindowOpenHandler(({ url }) => {
    _openExternally(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (_isAppUrl(url)) return;
    event.preventDefault();
    _openExternally(url);
  });
  contents.on('will-attach-webview', event => event.preventDefault());
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
async function _cleanUpSharedOriginStorage() {
  const markerPath = path.join(app.getPath('userData'), 'shared-origin-cleanup.json');
  let done = {};
  try { done = JSON.parse(fs.readFileSync(markerPath, 'utf8')) || {}; } catch { /* first run */ }
  const jobs = _framedEntries()
    .map(entry => ({ key: `${entry.kind}:${entry.id}`, patterns: frames.sharedOriginCleanupPatterns(entry) }))
    .filter(job => job.patterns.length && JSON.stringify(done[job.key]) !== JSON.stringify(job.patterns));
  if (!jobs.length) return;

  const { WebContentsView } = require('electron');
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await view.webContents.loadURL(`${frames.SCHEME}://${frames.FIRST_PARTY_HOST}/__atmos/blank.html`);
    for (const job of jobs) {
      // An isolated world shares the page's origin (so its storage) but not
      // its script restrictions; the page itself runs no script.
      const deleted = await view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: frames.sharedOriginCleanupScript(job.patterns) }]);
      console.log(`[main] removed ${job.key}'s old shared-origin storage:`, (deleted || []).join(', ') || 'none');
      done[job.key] = job.patterns;
    }
    const temporary = `${markerPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(done, null, 2));
    fs.renameSync(temporary, markerPath);
  } catch (error) {
    console.error('[main] shared-origin storage cleanup failed (will retry next launch):', error);
  } finally {
    view.webContents.close();
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
  });
  const trustStart = Date.now();
  _trust.assessAll(_catalog);
  console.log(`[main] checked extension integrity in ${Date.now() - trustStart}ms`);
  const extensions = createExtensionHost({ app, BrowserWindow, ipcMain, dialog, shell, protocol });
  const activePlugins = _catalog.list('plugins').filter(_isActive);
  const supersededServices = extensions.supersededServices(activePlugins);
  const activeServices = _catalog.list('services')
    .filter(entry => _isActive(entry) && !supersededServices.has(entry.id));
  _installBrowserPermissions([...activePlugins, ...activeServices]);
  await extensions.activateEntries('service', activeServices);
  await extensions.activateEntries('plugin', activePlugins);
  extensions.registerResourceProtocol(protocol, { allowOrigin: _originMayUseResource });
  _registerAtmosPluginProtocol();
  _registerAtmosServiceProtocol();
  _registerAtmosAppProtocol();
  _registerAtmosExtProtocol();
  createWindow();
  void _cleanUpSharedOriginStorage();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

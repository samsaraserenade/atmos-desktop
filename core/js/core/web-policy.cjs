'use strict';
/**
 * Atmos Browser's web policy: what web pages shown in Atmos may do.
 *
 * Pure (no Electron), so every rule here is unit-tested
 * (web-policy.test.cjs). web-host.cjs applies it to the browser's sessions
 * and to every web contents in them; the browser plugin drives pages
 * through atmos.web and can't change any of it.
 *
 *   sessions      web pages live in partitions of their own, never Atmos's
 *                 (the default session, where atmos-app://, atmos-ext:// and
 *                 atmos-resource:// are served; no handler for them exists
 *                 in these partitions)
 *   preferences   sandboxed, context-isolated, web security on, no Node;
 *                 the only preload is Core's web-page-preload.cjs (Chrome's
 *                 window.chrome members, and the ad blocker's styles and
 *                 scriptlets over two channels Core answers only for the
 *                 page's own address): the page's own scripts can't reach it
 *   identity      Chrome's user agent (no Electron or Atmos token), and
 *                 the client hints Chromium sends with a navigation
 *   navigation    pages are http(s) and about:blank; frames inside them may
 *                 also be about:srcdoc, data: and blob:; Atmos's own schemes,
 *                 files and the browser's internals never; other schemes
 *                 (mailto:, magnet:…) only after asking, and a few that run
 *                 programs on Windows never
 *   permissions   denied unless the user allowed that site (the page's,
 *                 whichever of its frames asks); fullscreen (a tab's only),
 *                 pointer lock (a tab's, just after a click or key in it)
 *                 and writing the clipboard need no prompt (as in Chrome)
 *   activation    a pop-up only just after a click or key in the page, one
 *                 each; a download on its own once a page load, more after
 *                 a click (as Chrome's pop-up blocker and download limiter)
 *   downloads     a safe file name, and "Open" only for documents, media
 *                 and archives
 *   site icons    fetched without cookies, and never from a local address
 *                 a page isn't on
 */

// Ordinary tabs: cookies, storage and cache kept on disk (Partitions/atmos-browser).
const PARTITION = 'persist:atmos-browser';
// Private tabs: in memory only, shared by the private tabs open at a time
// and cleared when the last one closes.
const PRIVATE_PARTITION = 'atmos-browser-private';
const PARTITIONS = Object.freeze([PARTITION, PRIVATE_PARTITION]);

/** What every tab's contents run with, whoever asked for what. */
const WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  plugins: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  // FedCM (navigator.credentials.get({ identity })) exists in Electron but
  // has no dialog, so every request fails, and "Sign in with Google" on
  // other sites stops there. Without it, sites use a sign-in pop-up, as in
  // Firefox and Safari.
  disableBlinkFeatures: 'FedCm',
  navigateOnDragDrop: false,
  spellcheck: false,
  // A page's alert() and confirm() are Electron's dialogs over the Atmos
  // window, with no site named (Electron has no hook to add one). From the
  // second, a box stops that page showing more.
  safeDialogs: true,
  safeDialogsMessage: 'Don’t let this page show more dialogs',
  autoplayPolicy: 'document-user-activation-required',
  // A <webview>'s page is see-through by default (Electron): one that sets
  // no background would show Atmos's wallpaper. Opaque, it gets the
  // browser's own background for its colour scheme, as in Chrome.
  transparent: false,
});

/**
 * Chrome's own user agent for this Chromium, with no Electron or Atmos
 * token (sites that sniff for embedded browsers look for those).
 */
function chromeUserAgent(platform = process.platform, chromeVersion = process.versions.chrome) {
  const major = String(chromeVersion || '').split('.')[0] || '0';
  const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * The brands a page reads from navigator.userAgentData, in Chromium's
 * order: "Chromium" and a made-up "GREASE" brand, both chosen from the major
 * version (Chromium's algorithm, components/embedder_support; Electron adds
 * no brand of its own). The browser's e2e checks it against a real page.
 */
function uaBrands(chromeVersion = process.versions.chrome) {
  const seed = Number(String(chromeVersion || '').split('.')[0]) || 0;
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const brands = [];
  brands[seed % 2] = { brand: `Not${chars[seed % chars.length]}A${chars[(seed + 1) % chars.length]}Brand`, version: ['8', '99', '24'][seed % 3] };
  brands[(seed + 1) % 2] = { brand: 'Chromium', version: String(seed) };
  return brands;
}

// Which requests get the client hints below: navigations to https and
// localhost. A page's own requests carry them already (Blink adds them),
// but Electron sends none with a navigation, where Chromium sends these
// three by default, one of the ways an embedded Chromium shows (Google's
// sign-in looks for them).
const CLIENT_HINTS_FILTER = Object.freeze({
  urls: Object.freeze(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']),
  types: Object.freeze(['mainFrame', 'subFrame']),
});

/** Request headers with the user agent client hints Chromium sends by default added, when they're missing. */
function withClientHints(headers = {}, platform = process.platform, chromeVersion = process.versions.chrome) {
  if (Object.keys(headers).some(name => /^sec-ch-ua$/i.test(name))) return headers;
  return {
    ...headers,
    'sec-ch-ua': uaBrands(chromeVersion).map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}"`,
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

// Never loaded, top-level or in a frame: Atmos's own schemes, files, the
// browser's internals and script. (about: and data:/blob: are handled below.)
const REFUSED_SCHEMES = new Set([
  'atmos-app:', 'atmos-ext:', 'atmos-resource:', 'atmos-plugin:', 'atmos-service:',
  'file:', 'filesystem:', 'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'chrome-error:',
  'devtools:', 'javascript:', 'vbscript:', 'view-source:', 'blob:', 'data:', 'about:', 'ws:', 'wss:', 'ftp:',
  'electron:', 'app:', 'jar:', 'res:',
]);

// Other schemes are handed to another program after asking, except these,
// which on Windows run programs, search or open local files, or show help
// content that can run script.
const NEVER_EXTERNAL = new Set([
  'ms-msdt:', 'msdt:', 'search-ms:', 'search:', 'ms-search:', 'ms-officecmd:', 'ms-word:', 'ms-excel:',
  'ms-powerpoint:', 'ms-access:', 'ms-visio:', 'ms-project:', 'ms-publisher:', 'ms-spd:', 'ms-infopath:',
  'ms-settings:', 'ms-appinstaller:', 'ms-cxh:', 'ms-cxh-full:', 'ms-its:', 'mk:', 'its:', 'hcp:', 'ms-help:',
  'shell:', 'mhtml:', 'res:', 'ldap:', 'smb:', 'ms-quick-assist:', 'microsoft-edge:', 'microsoft-edge-holographic:',
]);

function parseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try { return new URL(value); } catch { return null; }
}

/**
 * What to do with a navigation to `url`:
 *   { action: 'allow' }                    load it
 *   { action: 'external', scheme }         ask, then hand it to another program
 *   { action: 'refuse', reason }           never
 * `frame` is 'top' for the page itself, 'sub' for a frame inside it. A
 * frame never gets 'external': only a page the user is on asks.
 */
function navigationPolicy(url, { frame = 'top' } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) return { action: 'refuse', reason: 'not a valid address' };
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'http:' || scheme === 'https:') {
    if (!parsed.hostname) return { action: 'refuse', reason: 'an address without a host' };
    return { action: 'allow' };
  }
  if (scheme === 'about:') {
    const page = parsed.href.toLowerCase();
    if (page === 'about:blank') return { action: 'allow' };
    if (frame === 'sub' && page === 'about:srcdoc') return { action: 'allow' };
    return { action: 'refuse', reason: `${parsed.href} isn't a web page` };
  }
  if (frame === 'sub' && (scheme === 'data:' || scheme === 'blob:')) return { action: 'allow' };
  if (REFUSED_SCHEMES.has(scheme)) return { action: 'refuse', reason: `${scheme} addresses aren't opened in Atmos Browser` };
  // "C:\…" parses with the one-letter scheme "c:": it's a file on a drive.
  if (/^[a-z]:$/.test(scheme)) return { action: 'refuse', reason: 'files on this computer aren\'t opened in Atmos Browser' };
  if (frame !== 'top') return { action: 'refuse', reason: `a frame can't open ${scheme} links` };
  if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme) || NEVER_EXTERNAL.has(scheme)) {
    return { action: 'refuse', reason: `${scheme} links aren't opened` };
  }
  return { action: 'external', scheme: scheme.slice(0, -1) };
}

/** A navigation Core starts itself (the address bar, a restored tab): http(s) or about:blank only. */
function isLoadable(url) {
  return navigationPolicy(url, { frame: 'top' }).action === 'allow';
}

/** The origin a site setting is kept under: http(s) only. */
function siteOf(url) {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  return parsed.origin;
}

/**
 * The page a request is for (its site's shield) and the document making it
 * (the ad blocker's $third-party and $domain): { pageUrl, sourceUrl }, each
 * '' when unknown. From the request: its `type` (Electron's resourceType),
 * `url`, `initiator` (initiatorOrigin: the origin of the document that made
 * it), `referrer`; and from the browser: its `frame` ({ url, topUrl,
 * parentUrl, isTop }, null without one: a service worker's requests) and
 * the tab's `contentsUrl`.
 *
 * The browser takes in a navigation's commit after the new page may already
 * be making requests: a page's first requests can find its frame still at
 * the page before (another site, whose shield and context would apply) or
 * at nothing yet (a new tab). The initiator is never behind, so for a
 * request from the top of the page, it is the page when the two disagree.
 */
function requestContext({ type, url, frame = null, contentsUrl = '', referrer = '', initiator = '' }) {
  if (type === 'mainFrame') return { pageUrl: url, sourceUrl: url };
  const web = value => (siteOf(value) ? value : '');
  const origin = siteOf(initiator);
  const asking = origin ? `${origin}/` : '';
  // A frame loading: in the context of the page around it.
  if (type === 'subFrame') {
    const pageUrl = web(frame?.topUrl) || web(contentsUrl) || asking || web(referrer);
    return { pageUrl, sourceUrl: web(frame?.parentUrl) || pageUrl };
  }
  // The page's own document (or a worker of the site's, with no frame).
  if (!frame || frame.isTop) {
    const known = frame ? frame.url : contentsUrl;
    if (asking && siteOf(known) !== origin) return { pageUrl: asking, sourceUrl: asking };
    const pageUrl = web(known) || web(contentsUrl) || web(referrer);
    return { pageUrl, sourceUrl: pageUrl };
  }
  // A frame's document: the page is the top frame's; the frame asks.
  const pageUrl = web(frame.topUrl) || web(contentsUrl);
  return { pageUrl, sourceUrl: asking || web(frame.url) || pageUrl };
}

// ── Permissions ──────────────────────────────────────────────────────────────

/** What a site may ask the user for; everything else is refused. */
const PROMPTED = Object.freeze(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read']);
/** What needs no prompt, as in Chrome. */
const FREE = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

/**
 * The user-facing permissions a Chromium permission request stands for:
 * [] for a free one, null for one that is always refused.
 * `details.mediaTypes` (a request) or `details.mediaType` (a check) says
 * which of camera and microphone "media" means.
 */
function permissionNames(permission, details = {}) {
  if (FREE.has(permission)) return [];
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes
      : typeof details.mediaType === 'string' && details.mediaType !== 'unknown' ? [details.mediaType] : ['video', 'audio'];
    const names = [];
    if (types.includes('video')) names.push('camera');
    if (types.includes('audio')) names.push('microphone');
    return names.length ? names : null;
  }
  if (permission === 'geolocation' || permission === 'notifications' || permission === 'clipboard-read') return [permission];
  return null;
}

/**
 * The site a permission is asked for and kept under: the page you're on
 * (the tab's top-level origin), whichever of its frames asks, as Chrome
 * does. A frame from another site gets as far as asking only when the page
 * delegated the permission to it (an iframe's allow="camera", which
 * Chromium checks before Atmos is asked), and the question then names the
 * page. Notifications never come from a frame of another origin (Chrome
 * refuses those too). `requestingUrl` is the asking frame's address,
 * `topUrl` the page's. Returns the origin, or null: refused.
 */
function permissionSite(permission, { requestingUrl = '', topUrl = '' } = {}) {
  const top = siteOf(topUrl);
  if (!top) return null;
  const asking = siteOf(requestingUrl);
  if (permission === 'notifications' && asking && asking !== top) return null;
  return top;
}

/**
 * A request: 'allow', 'deny' or 'ask'. `setting(name)` is what the user
 * chose for the site (permissionSite: 'allow', 'block' or undefined).
 * `tab`: whether a tab asks. Only a tab goes fullscreen: Core names the
 * site over it and takes it back with Escape (web-layer.js), which it
 * can't do over a pop-up window.
 * Pointer lock (a game hiding the cursor to steer with the mouse) is a
 * tab's too, and only within USER_ACTIVATION_MS of a click or key in that
 * page (`activated`), as Chrome has it: Chromium leaves that check to the
 * browser, so without it a page could take the mouse as it loads. Escape
 * gives it back (Chromium's own, the page doesn't get the key), and Core
 * says so over the page.
 */
function permissionDecision(permission, details, setting, { origin, tab = true, activated = false } = {}) {
  if (permission === 'fullscreen' && !tab) return 'deny';
  if (permission === 'pointerLock' && !(tab && activated)) return 'deny';
  const names = permissionNames(permission, details);
  if (names === null) return 'deny';
  if (!names.length) return 'allow';
  if (!origin) return 'deny';
  const chosen = names.map(name => setting(name));
  if (chosen.includes('block')) return 'deny';
  if (chosen.every(value => value === 'allow')) return 'allow';
  return 'ask';
}

/** A synchronous check (navigator.permissions, Notification.permission): only what the user allowed. */
function permissionCheck(permission, details, setting, { origin, tab = true } = {}) {
  if ((permission === 'fullscreen' || permission === 'pointerLock') && !tab) return false;
  const names = permissionNames(permission, details);
  if (names === null) return false;
  if (!names.length) return true;
  return !!origin && names.every(name => setting(name) === 'allow');
}

// ── What a page may do because you just used it ────────────────────────────

/** How long a click or key counts (Chrome's transient user activation). */
const USER_ACTIVATION_MS = 5000;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock',
  'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS']);

/**
 * Whether an input event Electron reports for a page is the user using it
 * (HTML's activation-triggering events, as Chromium has them): a mouse
 * button pressed, a tap, or a key pressed that the page gets (not one held
 * down and repeating, not Escape or a modifier alone, not the browser's
 * own shortcut). `input` is a before-input-event Input, a
 * before-mouse-event MouseInputEvent or an input-event InputEvent.
 */
function activatesUser(input) {
  if (!input || typeof input.type !== 'string') return false;
  if (input.type === 'mouseDown' || input.type === 'touchEnd' || input.type === 'gestureTap') return true;
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false;
  const key = String(input.key || '');
  if (input.isAutoRepeat || !key || key === 'Escape' || MODIFIER_KEYS.has(key)) return false;
  return shortcutFor({ ...input, type: 'keyDown' }) === null;
}

/**
 * When each page (or the Atmos window) was last used, and what that use
 * has paid for: a pop-up opens only within USER_ACTIVATION_MS of a click
 * or key in the page that opens it, one per click (Chrome consumes the
 * activation the same way). `now` for the tests.
 */
function createActivations({ now = () => Date.now(), lifespan = USER_ACTIVATION_MS } = {}) {
  const pages = new Map(); // id -> { at, used: Set }
  const fresh = entry => !!entry && now() - entry.at < lifespan;
  return {
    /** The user clicked, tapped or pressed a key in `id`. */
    activate(id) { pages.set(id, { at: now(), used: new Set() }); },
    /** When `id` was last used (0: never). */
    lastAt: id => pages.get(id)?.at || 0,
    /** Whether `id` was used just now, and that use hasn't paid for `what` yet; if so it has now. */
    take(id, what) {
      const entry = pages.get(id);
      if (!fresh(entry) || entry.used.has(what)) return false;
      entry.used.add(what);
      return true;
    },
    forget(id) { pages.delete(id); },
  };
}

// ── "Leave site?" ────────────────────────────────────────────────────────────

/** After you answer Cancel, how long the same page's next "Leave site?" are answered Cancel without asking. */
const LEAVE_QUIET_MS = 30_000;
/** …unless you did something yourself this recently (a click or key in it, Back, the address bar). */
const LEAVE_ACTED_MS = 2_000;

/**
 * Whether to ask "Leave site?" for a page that objects to being left.
 * Electron needs the answer synchronously, so the question holds all of
 * Atmos while it's up; a page can start one navigation after another to
 * bring it back as soon as it's answered. After a Cancel (`refusedAt`) the
 * page stays, without a question, for half a minute (Chrome's "prevent
 * this page from creating additional dialogs"), unless you just acted
 * yourself (`actedAt`, after that Cancel).
 */
function askBeforeLeaving({ refusedAt = 0, actedAt = 0, now = Date.now() } = {}) {
  if (!refusedAt || now - refusedAt >= LEAVE_QUIET_MS) return true;
  return actedAt > refusedAt && now - actedAt < LEAVE_ACTED_MS;
}

// ── Downloads ────────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
const MAX_NAME = 200;

function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot >= name.length - 16 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * A file name that is safe to save anywhere: no folders, no characters
 * Windows refuses, no reserved device names, no leading or trailing dots
 * and spaces, at most 200 characters with its extension kept. Falls back
 * to the last part of the address, then to "download".
 */
function downloadName(suggested, url = '') {
  const clean = value => String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '')
    .split(/[\\/]/).pop()
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  let name = clean(suggested);
  if (!name) {
    const parsed = parseUrl(url);
    let last = '';
    try { last = decodeURIComponent((parsed?.pathname || '').split('/').pop() || ''); } catch { last = ''; }
    name = clean(last);
  }
  if (!name) name = 'download';
  if (WINDOWS_RESERVED.test(name.split('.')[0].trim())) name = `_${name}`;
  if (name.length > MAX_NAME) {
    const [base, extension] = splitExtension(name);
    name = `${base.slice(0, MAX_NAME - extension.length).replace(/[\s.]+$/, '')}${extension}`;
  }
  return name;
}

/** `name`, or "name (1).ext", "name (2).ext"… the first that `exists` says is free. */
function uniqueName(name, exists) {
  if (!exists(name)) return name;
  const [base, extension] = splitExtension(name);
  for (let n = 1; n < 10000; n += 1) {
    const candidate = `${base} (${n})${extension}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${extension}`;
}

// What "Open" hands to the file's default program: documents, images,
// audio, video, text and archives. Everything else gets "Show in folder"
// only: programs and scripts, and the many Windows types that run or
// fetch something when opened (.rdp, .one, .msu, .wsb, .theme, .jnlp,
// .iqy…), web pages and SVG (the default browser runs their script),
// macro-enabled Office files, disk images. A list of what may open, not of
// what may not, so a type nobody thought of stays shut.
const OPENABLE_EXTENSIONS = new Set([
  'pdf', 'txt', 'text', 'log', 'md', 'csv', 'tsv', 'epub',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'odg',
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif',
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'mid', 'midi',
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'ogv', 'mpg', 'mpeg', '3gp',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst',
]);

/** Whether Atmos may open a downloaded file with its default program (OPENABLE_EXTENSIONS). */
function openableDownload(name) {
  const [, extension] = splitExtension(String(name || ''));
  return OPENABLE_EXTENSIONS.has(extension.replace(/^\./, '').toLowerCase());
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * The browser's own shortcuts, taken before a page sees them (Electron's
 * before-input-event): a command name, or null for keys that belong to the
 * page. Atmos's single-key shortcuts are never taken from a page.
 */
function shortcutFor(input) {
  if (!input || input.type !== 'keyDown') return null;
  const ctrl = !!(input.control || input.meta);
  const key = String(input.key || '');
  const lower = key.toLowerCase();
  if (ctrl && !input.alt) {
    if (lower === 'l') return 'focus-address';
    if (lower === 't') return input.shift ? 'reopen-tab' : 'new-tab';
    if (lower === 'n' && input.shift) return 'new-private-tab';
    if (lower === 'w' || key === 'F4') return 'close-tab';
    if (key === 'Tab') return input.shift ? 'previous-tab' : 'next-tab';
    if (key === 'PageDown') return 'next-tab';
    if (key === 'PageUp') return 'previous-tab';
    if (/^[1-8]$/.test(key)) return `tab-${key}`;
    if (key === '9') return 'last-tab';
    if (lower === 'r') return input.shift ? 'hard-reload' : 'reload';
    if (lower === 'f') return 'find';
    if (lower === 'd' && !input.shift) return 'bookmark';
    if (lower === 'h' && !input.shift) return 'history';
    if (lower === 'j' && !input.shift) return 'downloads';
    if (key === '+' || key === '=') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    if (lower === 'p' && !input.shift) return 'print';
  }
  if (!ctrl && !input.alt && key === 'F5') return input.shift ? 'hard-reload' : 'reload';
  if (!ctrl && !input.alt && !input.shift && key === 'F6') return 'focus-address';
  if (input.alt && !ctrl && !input.shift && key === 'ArrowLeft') return 'back';
  if (input.alt && !ctrl && !input.shift && key === 'ArrowRight') return 'forward';
  return null;
}

// ── Site icons ───────────────────────────────────────────────────────────────
//
// A site's icon is untrusted image data. It's decoded in a renderer of its
// own (web-host.cjs: sandboxed, in ICON_PARTITION, which has no network and
// nothing else in it), never in the browser's UI frames, which can do more
// than a page can, nor in the main process. What comes back is ICON_SIZE²
// raw pixels, checked here, which Core encodes as a PNG itself.

const ICON_PARTITION = 'atmos-browser-icons';
const ICON_SIZE = 32;
const ICON_MAX_BYTES = 256 * 1024;

/** An IPv4 address (as the URL parser writes one) in a range that isn't the public internet. */
function localIPv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** An IPv6 address (brackets, a zone and a dotted IPv4 tail allowed) as its eight groups, or null. */
function ipv6Groups(text) {
  let address = String(text || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number);
    if (v4.some(part => part > 255)) return null;
    address = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.every(group => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map(group => parseInt(group, 16)) : null;
}

/**
 * An IPv6 address that isn't the public internet: loopback and unspecified,
 * unique-local, link-local, site-local, multicast, and every way of
 * writing an IPv4 address inside one (compatible, mapped, translated,
 * NAT64's well-known prefix, 6to4), judged as that IPv4 address.
 * Unparseable: local.
 */
function localIPv6(text) {
  const groups = ipv6Groups(text);
  if (!groups) return true;
  const [a, b, c, d, e, f, g, h] = groups;
  const v4 = (high, low) => localIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  const zeros = (...values) => values.every(value => value === 0);
  if (zeros(a, b, c, d, e, f)) return v4(g, h);                       // ::, ::1, ::a.b.c.d
  if (zeros(a, b, c, d, e) && f === 0xffff) return v4(g, h);          // ::ffff:a.b.c.d
  if (zeros(a, b, c, d) && e === 0xffff && f === 0) return v4(g, h);  // ::ffff:0:a.b.c.d
  if (a === 0x64 && b === 0xff9b && zeros(c, d, e, f)) return v4(g, h); // 64:ff9b::a.b.c.d
  if (a === 0x2002) return v4(b, c);                                  // 6to4
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00;
}

/** Whether an IP address (as a resolver reports it, v4 or v6) isn't on the public internet. */
function isLocalAddress(address) {
  const text = String(address || '');
  return /^\d+(?:\.\d+){3}$/.test(text) ? localIPv4(text) : localIPv6(text);
}

/** A host as iconFetchAllowed compares them: lower case, no trailing dot. */
const plainHost = parsed => parsed.hostname.toLowerCase().replace(/\.$/, '');

/**
 * Whether Core may fetch a page's icon from `iconUrl` for the page at
 * `pageUrl`. The fetch is Core's, not the page's: the rules on what a
 * page may reach don't apply to it, so the page mustn't be able to point
 * it at your network. http(s) only, and not a local address (loopback, a
 * private or link-local range, localhost, *.local, a name without a dot)
 * unless the page is on that same host (a local server's own icon, or an
 * intranet site's). A name that only resolves to a local address isn't
 * caught here: web-host.cjs resolves it first (iconLookup). What that
 * leaves: a name that resolves differently by the time it's fetched, and
 * the page's own name doing so (DNS rebinding), for a blind GET without
 * cookies.
 */
function iconFetchAllowed(iconUrl, pageUrl) {
  const icon = parseUrl(iconUrl);
  if (!icon || (icon.protocol !== 'https:' && icon.protocol !== 'http:') || !icon.hostname || icon.username || icon.password) return false;
  const host = plainHost(icon);
  const page = parseUrl(pageUrl);
  if (page && (page.protocol === 'https:' || page.protocol === 'http:') && plainHost(page) === host) return true;
  if (host.startsWith('[')) return !localIPv6(host);
  if (/^\d+(?:\.\d+){3}$/.test(host)) return !localIPv4(host);
  return host.includes('.') && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')
    && !host.endsWith('.internal') && !host.endsWith('.home.arpa') && !host.endsWith('.lan');
}

/** A public name, as iconFetchAllowed reads one: not an IP address, localhost, a .local name or one without a dot. */
function publicName(host) {
  if (!host || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) return false;
  return host.includes('.') && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')
    && !host.endsWith('.internal') && !host.endsWith('.home.arpa') && !host.endsWith('.lan') && !host.endsWith('.test');
}

/**
 * Automatic https (Chrome's HTTPS-Upgrades): the https address to try first
 * for a page at `url`, or null. Only plain http on its usual port to a
 * public name (not an address on your network, which rarely has https, nor
 * a port of its own), without a user name, and not a site already found to
 * have no https (`httpOnly`, its host: web-host.cjs keeps them). The page
 * falls back to http, saying so, when https fails.
 */
function httpsUpgrade(url, httpOnly = new Set()) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'http:' || parsed.port || parsed.username || parsed.password) return null;
  const host = plainHost(parsed);
  if (!publicName(host) || httpOnly.has(host)) return null;
  parsed.protocol = 'https:';
  return parsed.href;
}

/**
 * Whether a failed page tried over https (automatic https) falls back to
 * http: the connection or its security failed (refused, reset, closed, a
 * TLS or certificate error, timed out). Not when the network itself is out
 * (offline, a name that doesn't resolve, the network changed): http would
 * fail as well, and the site would be remembered as having no https.
 */
function httpsFallbackError(code) {
  if (![-105, -106, -109, -137].includes(code) && code <= -100 && code > -300) return true;
  return false;
}

/**
 * Chrome's insecure download blocking: a download a secure page started
 * that comes, or passes on its way, over plain http (not from your own
 * machine). `chain` is the download's addresses, redirects included.
 */
function insecureDownload(chain, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page || page.protocol !== 'https:') return false;
  const links = chain || [];
  return links.some((link, index) => {
    // An http address Atmos itself upgraded (the next hop is the same over https) wasn't fetched over http.
    if (/^http:/i.test(link) && typeof links[index + 1] === 'string' && links[index + 1] === link.replace(/^http:/i, 'https:')) return false;
    const hop = parseUrl(link);
    if (!hop || hop.protocol !== 'http:') return false;
    const host = plainHost(hop);
    return !(host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]');
  });
}

/**
 * The name to resolve before fetching an icon iconFetchAllowed allowed,
 * whose addresses must all be public (isLocalAddress), or null: the page's
 * own host, or an address already judged.
 */
function iconLookup(iconUrl, pageUrl) {
  const icon = parseUrl(iconUrl);
  if (!icon) return null;
  const host = plainHost(icon);
  const page = parseUrl(pageUrl);
  if ((page && plainHost(page) === host) || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  return host;
}

/**
 * The bytes of a `data:image/…` address (base64 or percent-encoded), or null:
 * { type, bytes }, at most `maxBytes`.
 */
function imageDataUrlBytes(url, maxBytes = ICON_MAX_BYTES) {
  if (typeof url !== 'string' || url.length > maxBytes * 1.4 + 200) return null;
  const match = url.match(/^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,]*)*)(;base64)?,(.*)$/is);
  if (!match) return null;
  let bytes;
  try {
    bytes = match[3] ? Buffer.from(match[4], 'base64') : Buffer.from(decodeURIComponent(match[4]), 'utf8');
  } catch { return null; }
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { type: match[1].toLowerCase(), bytes };
}

/**
 * The decoder's answer, ICON_SIZE² pixels as RGBA (unpremultiplied, as a
 * canvas gives them), as premultiplied BGRA for nativeImage.createFromBitmap;
 * null for anything else.
 */
function iconBitmap(rgba, size = ICON_SIZE) {
  if (!Buffer.isBuffer(rgba) || rgba.length !== size * size * 4) return null;
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    out[i] = Math.round((rgba[i + 2] * a) / 255);
    out[i + 1] = Math.round((rgba[i + 1] * a) / 255);
    out[i + 2] = Math.round((rgba[i] * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

const ZOOM_FACTORS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]);

/** The next zoom factor from `current`: 'in', 'out' or 'reset'. */
function nextZoom(current, direction) {
  if (direction === 'reset') return 1;
  const value = Number.isFinite(current) && current > 0 ? current : 1;
  if (direction === 'in') return ZOOM_FACTORS.find(factor => factor > value + 0.001) ?? ZOOM_FACTORS.at(-1);
  if (direction === 'out') return [...ZOOM_FACTORS].reverse().find(factor => factor < value - 0.001) ?? ZOOM_FACTORS[0];
  return value;
}

// ── <webview> attachment ─────────────────────────────────────────────────────

// Attributes a <webview> could use to change what its page runs with.
const CONTROLLED_PARAMS = ['preload', 'nodeintegration', 'nodeintegrationinsubframes', 'plugins', 'disablewebsecurity',
  'webpreferences', 'allowpopups', 'useragent', 'httpreferrer', 'enableblinkfeatures', 'disableblinkfeatures', 'enableremotemodule'];

/**
 * Whether a <webview> may attach, and with what. Only Core's web layer in
 * the Atmos page (the window's own page, atmos-app://local/) makes them:
 * in a browser partition, starting blank (Core navigates it afterwards,
 * through the same checks as the address bar). Whatever the element asked
 * for, the page runs with WEB_PREFERENCES.
 */
function webviewAttachment({ fromAtmosPage, params }) {
  if (!fromAtmosPage) return { ok: false, reason: 'only the Atmos page attaches web pages' };
  const partition = params?.partition;
  if (!PARTITIONS.includes(partition)) return { ok: false, reason: `not a browser partition (${partition || 'default'})` };
  const src = params?.src || 'about:blank';
  if (src !== 'about:blank') return { ok: false, reason: 'a web page starts blank' };
  const cleanParams = { ...params, src: 'about:blank', partition };
  for (const name of CONTROLLED_PARAMS) delete cleanParams[name];
  return { ok: true, webPreferences: { ...WEB_PREFERENCES, partition }, params: cleanParams };
}

module.exports = {
  PARTITION, PRIVATE_PARTITION, PARTITIONS, WEB_PREFERENCES, PROMPTED, ZOOM_FACTORS,
  ICON_PARTITION, ICON_SIZE, ICON_MAX_BYTES, imageDataUrlBytes, iconBitmap, iconFetchAllowed, iconLookup, isLocalAddress,
  chromeUserAgent, uaBrands, CLIENT_HINTS_FILTER, withClientHints, navigationPolicy, isLoadable, siteOf, requestContext,
  permissionNames, permissionSite, permissionDecision, permissionCheck,
  USER_ACTIVATION_MS, activatesUser, createActivations, LEAVE_QUIET_MS, LEAVE_ACTED_MS, askBeforeLeaving,
  downloadName, uniqueName, openableDownload, httpsUpgrade, httpsFallbackError, insecureDownload,
  shortcutFor, nextZoom, webviewAttachment,
};

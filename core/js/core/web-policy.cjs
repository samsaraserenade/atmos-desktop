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
 *   preferences   sandboxed, context-isolated, web security on, no Node and
 *                 no preload: a page can't send IPC
 *   navigation    pages are http(s) and about:blank; frames inside them may
 *                 also be about:srcdoc, data: and blob:; Atmos's own schemes,
 *                 files and the browser's internals never; other schemes
 *                 (mailto:, magnet:…) only after asking, and a few that run
 *                 programs on Windows never
 *   permissions   denied unless the user allowed that site; fullscreen and
 *                 writing the clipboard need no prompt (as in Chrome)
 *   downloads     a safe file name, and no "Open" for a program
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
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
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

// ── Permissions ──────────────────────────────────────────────────────────────

/** What a site may ask the user for; everything else is refused. */
const PROMPTED = Object.freeze(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read']);
/** What needs no prompt, as in Chrome. */
const FREE = new Set(['fullscreen', 'clipboard-sanitized-write']);

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
 * A request: 'allow', 'deny' or 'ask'. `setting(name)` is what the user
 * chose for the requesting site ('allow', 'block' or undefined).
 */
function permissionDecision(permission, details, setting, { origin } = {}) {
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
function permissionCheck(permission, details, setting, { origin } = {}) {
  const names = permissionNames(permission, details);
  if (names === null) return false;
  if (!names.length) return true;
  return !!origin && names.every(name => setting(name) === 'allow');
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

// Opening one of these would run it: Atmos offers "Show in folder" only.
const PROGRAM_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'msp', 'mst', 'bat', 'cmd', 'com', 'scr', 'pif',
  'cpl', 'msc', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'hta', 'jar', 'lnk',
  'url', 'reg', 'dll', 'sys', 'ocx', 'inf', 'ins', 'isp', 'sct', 'shb', 'shs', 'scf', 'gadget', 'application',
  'appref-ms', 'settingcontent-ms', 'library-ms', 'search-ms', 'diagcab', 'xll', 'chm', 'hlp', 'mht', 'mhtml',
  'iso', 'img', 'vhd', 'vhdx', 'app', 'command', 'sh', 'bash', 'zsh', 'run', 'bin', 'deb', 'rpm', 'dmg', 'pkg',
  'apk', 'py', 'pyw', 'pl', 'rb', 'svg',
]);

/** Whether Atmos may open a downloaded file with its default program (not a program or script itself). */
function openableDownload(name) {
  const [, extension] = splitExtension(String(name || ''));
  const ext = extension.replace(/^\./, '').toLowerCase();
  return !!ext && !PROGRAM_EXTENSIONS.has(ext);
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
  ICON_PARTITION, ICON_SIZE, ICON_MAX_BYTES, imageDataUrlBytes, iconBitmap,
  chromeUserAgent, navigationPolicy, isLoadable, siteOf,
  permissionNames, permissionDecision, permissionCheck,
  downloadName, uniqueName, openableDownload,
  shortcutFor, nextZoom, webviewAttachment,
};

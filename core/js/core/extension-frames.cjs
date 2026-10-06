'use strict';
/**
 * Framed extensions: where they run, what their frames may load, and what
 * each frame is told about itself.
 *
 * Runtimes
 *   page    — the system services (core/system): part of Core, their code
 *             runs in the Atmos page. Nothing else does.
 *   library — a first-party library service: its modules run inside the
 *             frames that import them (atmos.library()); it has no frames.
 *   frame   — every other extension: each surface (panel, sidebar widget,
 *             settings, boot) runs in its own sandboxed <iframe> and talks
 *             to Core only through the Atmos SDK bridge. "runtime": "frame"
 *             in a manifest is what every extension gets now, and ignored.
 *
 * Origins
 *   atmos-ext://first-party         shared by framed first-party extensions
 *   atmos-ext://first-party-plugin-<id>
 *                                   a first-party extension with
 *                                   "isolation": "origin" (one that keeps
 *                                   secrets, such as keys, in its storage)
 *   atmos-ext://plugin-<id>         one per third-party plugin
 *   atmos-ext://service-<id>        one per third-party service
 *
 * An origin is a storage partition (localStorage, IndexedDB) and a process:
 * frames of one extension share both, different third-party extensions
 * never do, and none can reach the Atmos page. Each frame document carries
 * a Content-Security-Policy built from the extension's declared network
 * permissions, so undeclared hosts are refused by the browser itself.
 */

const crypto = require('crypto');
const path = require('path');
const { normalizePermissions } = require('./extension-permissions.cjs');

const SCHEME = 'atmos-ext';
const RESOURCE_SCHEME = 'atmos-resource';
const FIRST_PARTY_HOST = 'first-party';
const SURFACES = ['panel', 'sidebar', 'settings', 'boot'];
const CONVENTIONAL_ENTRY = { panel: 'panel.js', sidebar: 'sidebar.js', settings: 'settings.js', boot: 'boot.js' };
// Folders that are never served to a frame, whatever the extension.
const UNSERVED_DIRS = new Set(['data', 'tests', 'backups', '_to_delete', '.git']);
// Permissions Policy features a frame is delegated for its browser permissions.
const FRAME_FEATURES = {
  geolocation: ['geolocation'],
  'clipboard-read': ['clipboard-read'],
  media: ['camera', 'microphone'],
  'display-capture': ['display-capture'],
};
const BASELINE_FEATURES = ['autoplay', 'clipboard-write', 'fullscreen'];

/**
 * A library service ("library": true) is code its consumers import; it has
 * no lifecycle, UI or state of its own, so it contributes no surfaces and
 * no boot frame, whatever files it ships (ATMOS_CORE_INTEGRATION.md,
 * "Services and libraries").
 */
function isLibrary(entry) {
  return entry.kind === 'service' && entry.manifest?.library === true;
}

function resolveRuntime(entry) {
  if (entry.tier === 'system') return 'page';
  if (entry.tier !== 'third-party' && isLibrary(entry)) return 'library';
  return 'frame';
}

/**
 * A first-party extension that keeps secrets in its frames' storage (keys,
 * tokens) asks for an origin of its own with "isolation": "origin", so the
 * other first-party extensions — which share one origin, and so one storage
 * partition and one set of windows — can't read its storage or script its
 * frames.
 */
function isIsolated(entry) {
  return entry.tier === 'first-party' && entry.manifest?.isolation === 'origin';
}

/**
 * An isolated extension whose data couldn't be moved out of the shared
 * origin this start (entry.originFallback, set by main.js) runs from the
 * shared origin once more, where its data still is.
 */
function frameHost(entry) {
  if (entry.tier === 'third-party') return `${entry.kind}-${entry.id}`;
  return isIsolated(entry) && !entry.originFallback ? `${FIRST_PARTY_HOST}-${entry.kind}-${entry.id}` : FIRST_PARTY_HOST;
}

const STORAGE_PATTERN = item => typeof item === 'string' && item.length > 0 && item.length <= 100
  && (!item.includes('*') || (item.indexOf('*') === item.length - 1 && item.length > 4));

/**
 * What an isolated extension kept in the shared first-party origin and takes
 * with it to its own ("legacyStorage.sharedOrigin": { "indexedDB": [...],
 * "localStorage": [...] }, exact names or "prefix*" of at least four
 * characters): Core copies it across once, before the extension's frames
 * start there, and deletes the shared copies at a later start. Null when
 * there is nothing to move.
 */
function sharedOriginMove(entry) {
  if (!isIsolated(entry)) return null;
  const declared = entry.manifest?.legacyStorage?.sharedOrigin;
  if (!declared || typeof declared !== 'object') return null;
  const list = value => (Array.isArray(value) ? [...new Set(value.filter(STORAGE_PATTERN))] : []);
  const move = { indexedDB: list(declared.indexedDB), localStorage: list(declared.localStorage) };
  return move.indexedDB.length || move.localStorage.length ? move : null;
}

/**
 * Run in Core's hidden storage page (atmos-app://local/__atmos/storage.html):
 * opens the shared origin's frame and, for a copy, the extension's own, and
 * has them copy `spec` across (or, with `remove`, delete those patterns from
 * the shared origin). Resolves what the export frame reports.
 */
function storageHostScript({ from, to = null, spec = null, remove = null }) {
  return `(async (from, to, spec, remove) => {
    const load = src => new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const timer = setTimeout(() => reject(new Error('a storage frame did not load')), 20000);
      frame.onload = () => { clearTimeout(timer); resolve(frame); };
      frame.src = src;
      document.body.append(frame);
    });
    const exporter = await load(from + '/__atmos/move.html?role=export');
    const result = new Promise((resolve, reject) => window.addEventListener('message', event => {
      if (event.source !== exporter.contentWindow || !event.data?.atmosMoveResult) return;
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    }));
    if (remove) {
      exporter.contentWindow.postMessage({ atmosMove: 'remove', ...remove }, from);
      return result;
    }
    const importer = await load(to + '/__atmos/move.html?role=import');
    const channel = new MessageChannel();
    importer.contentWindow.postMessage({ atmosMove: 'port' }, to, [channel.port2]);
    exporter.contentWindow.postMessage({ atmosMove: 'export', spec }, from, [channel.port1]);
    return result;
  })(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(spec)}, ${JSON.stringify(remove)})`;
}

/** The Core pages that copy an extension's storage from one origin to another (extension-origin-move.js). */
function moveDocument(role) {
  return '<!doctype html>\n<html><head><meta charset="utf-8"><title></title>'
    + `<script src="/__atmos/move.js" data-role="${role === 'import' ? 'import' : 'export'}"></script>`
    + '</head><body></body></html>\n';
}

function moveCsp(role) {
  return role === 'import'
    ? "default-src 'none'; script-src 'self'"
    : `default-src 'none'; script-src 'self'; frame-src ${SCHEME}:`;
}

/**
 * Database names (or "prefix*" of at least 4 characters) an isolated
 * extension left in the shared first-party origin before it moved out,
 * from "legacyStorage.sharedOriginIndexedDB". Core deletes them once.
 */
function sharedOriginCleanupPatterns(entry) {
  if (!isIsolated(entry)) return [];
  const declared = entry.manifest?.legacyStorage?.sharedOriginIndexedDB;
  return Array.isArray(declared) ? declared.filter(STORAGE_PATTERN) : [];
}

function frameOrigin(entry) {
  return `${SCHEME}://${frameHost(entry)}`;
}

/** URL path of an extension file inside its frame origin. */
function extensionPath(entry, file = '') {
  return `/${entry.kind}s/${entry.id}/${file}`;
}

/** CSP sources for declared network hosts: http(s) and ws(s) for each. */
function networkSources(network) {
  if (network.includes('*')) return ['https:', 'http:', 'wss:', 'ws:'];
  const sources = [];
  for (const host of network) {
    for (const scheme of ['https', 'http', 'wss', 'ws']) sources.push(`${scheme}://${host}`);
  }
  return sources;
}

function sha256Base64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

/** CSP sources for atmos-resource:// providers a frame may load media from. */
function resourceSources(providers) {
  return providers.filter(name => /^[a-z0-9][a-z0-9-]*$/.test(name)).map(name => `${RESOURCE_SCHEME}://${name}`);
}

/**
 * The Content-Security-Policy for one extension's frame documents.
 * `libraryOrigins` are other frame origins whose library modules it may
 * import (declared with "invokes": ["service:<id>"]). `resourceProviders`
 * are atmos-resource:// providers it may load (its own "resources", and
 * those of extensions it declares in "invokes").
 */
function frameCsp({ permissions, inlineScriptHashes = [], libraryOrigins = [], resourceProviders = [] }) {
  const p = normalizePermissions(permissions);
  const net = [...networkSources(p.network), ...resourceSources(resourceProviders)];
  const directives = {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...(p.browser.includes('wasm') ? ["'wasm-unsafe-eval'"] : []), ...libraryOrigins, ...inlineScriptHashes.map(hash => `'sha256-${hash}'`)],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...net],
    'media-src': ["'self'", 'data:', 'blob:', ...net],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...net],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${[...new Set(values)].join(' ')}`).join('; ');
}

/** Value for the <iframe allow="…"> attribute. */
function framePermissionsPolicy(permissions) {
  const p = normalizePermissions(permissions);
  const features = new Set(BASELINE_FEATURES);
  for (const name of p.browser) for (const feature of FRAME_FEATURES[name] || []) features.add(feature);
  return [...features].join('; ');
}

/** Text Core may place in its own UI: no markup characters, bounded length. */
function plainLabel(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
  return text || fallback;
}

function titleCase(id) {
  return id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** A relative, forward-slash path inside the extension, or null. */
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 200) return null;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split('/').some(part => UNSERVED_DIRS.has(part) || part.startsWith('.'))) return null;
  return normalized;
}

/**
 * What a framed extension contributes, from manifest "contributes" or, when
 * absent, the conventional entry files. Every label is plain text and every
 * icon is a file inside the extension, so nothing an extension declares is
 * ever inserted into the Atmos page as markup.
 */
function describeContributions(entry, files) {
  if (isLibrary(entry)) return [];
  const manifest = entry.manifest && !entry.manifest.invalid ? entry.manifest : {};
  const declared = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : null;
  const has = file => files.includes(file);
  const baseLabel = plainLabel(manifest.displayName, titleCase(entry.id));
  const out = [];
  const add = (surface, def, index) => {
    const entryFile = safeRelative(def?.entry ?? CONVENTIONAL_ENTRY[surface]);
    if (!entryFile || !has(entryFile)) return;
    const icon = safeRelative(def?.icon);
    // A first-party extension that moved into frames may keep the id a panel
    // or widget had before ("legacyId"), so saved layouts still find it.
    const legacyId = entry.tier !== 'third-party' && typeof def?.legacyId === 'string'
      && /^[a-z0-9][a-z0-9-]{0,59}$/.test(def.legacyId) ? def.legacyId : null;
    out.push({
      surface,
      // A second sidebar widget needs its own id: <extension>-<its id>.
      id: legacyId ?? (surface === 'sidebar' && index > 0
        ? `${entry.id}-${String(def?.id ?? index).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || index}`
        : entry.id),
      entry: entryFile,
      label: plainLabel(def?.label, baseLabel),
      icon: icon && has(icon) ? icon : null,
      order: Number.isFinite(def?.order) ? def.order : 0,
      default: surface === 'panel' && def?.default === true,
      defaultEnabled: def?.defaultEnabled !== false,
      defaultHeight: Number.isFinite(def?.defaultHeight) ? def.defaultHeight : null,
      // A widget whose height follows its content only ("resizable": false).
      resizable: surface !== 'sidebar' || def?.resizable !== false,
      // The panels a widget shows beside until the person picks otherwise
      // ("showIn": ["audio-player"]). Absent means beside its own extension's
      // panel (filled in below); "showIn": [] means everywhere.
      showIn: surface === 'sidebar' && Array.isArray(def?.showIn)
        ? [...new Set(def.showIn.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(id)))].slice(0, 8)
        : null,
      // Core draws the panel's frosted glass under the frame where the frame
      // says (atmos.surface.setGlass), following the panel's blur and opacity.
      glass: surface === 'panel' && def?.glass === true,
      // A panel that lives in a drawer sliding up from the bottom of the
      // full workspace (Core moves it; see panel-drawer.js). "bar" is the
      // height of the strip that stays visible when the drawer is lowered.
      // First-party: a drawer takes wheel and typing on the whole workspace.
      drawer: surface === 'panel' && def?.drawer && entry.tier !== 'third-party'
        ? {
            bar: Math.round(Math.max(24, Math.min(200, Number(def.drawer?.bar) || 54))),
            // Characters typed on the workspace while it is open go to the frame.
            keys: def.drawer?.keys === true,
          }
        : null,
      // Keys a boot frame hears wherever they are pressed in Atmos (outside
      // text fields): KeyboardEvent.code values such as "Space". First-party.
      keys: surface === 'boot' && entry.tier !== 'third-party' && Array.isArray(def?.keys)
        ? def.keys.filter(code => typeof code === 'string' && /^[A-Za-z0-9]{1,20}$/.test(code)).slice(0, 8)
        : [],
      // Where Settings shows a settings contribution: the browser's (an
      // official extension declaring "web", which only Atmos Browser does)
      // on a page of its own, the rest on the Appearance page.
      category: surface !== 'settings' ? ''
        : (entry.tier !== 'third-party' && manifest.permissions?.web === true ? 'Browser' : 'Appearance'),
    });
  };
  for (const surface of SURFACES) {
    const value = declared ? declared[surface] : (has(CONVENTIONAL_ENTRY[surface]) ? {} : undefined);
    if (value === undefined || value === false) continue;
    const list = Array.isArray(value) && surface === 'sidebar' ? value : [value];
    list.forEach((def, index) => add(surface, def === true ? {} : def, index));
  }
  // A widget that doesn't say where it shows goes beside its own panel, so
  // a plugin's accordions appear with it rather than everywhere. One with
  // no panel of its own (a service's, say) still shows everywhere.
  const ownPanel = out.find(contribution => contribution.surface === 'panel');
  if (ownPanel) {
    for (const contribution of out) {
      if (contribution.surface === 'sidebar' && contribution.showIn === null) contribution.showIn = [ownPanel.id];
    }
  }
  return out;
}

// ── Commands (SDK 1.3) ───────────────────────────────────────────────────────
// rev/ commands an extension adds to Atmos's command bar, declared in
// "contributes.commands" so Atmos can list them while the extension's frames
// are away and show them before a community extension is approved. Core's
// own names can't be taken.
// command-list.js CORE_COMMANDS' names (command-list.test.cjs checks they agree).
const CORE_COMMAND_NAMES = Object.freeze(['sidebar', 'sidebar-side', 'settings', 'extensions', 'switch', 'widget', 'wallpaper', 'reload']);
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,29}$/;
const MAX_COMMANDS = 30;

/** Text for the bar: one line, no markup characters, at most `max` long. */
function commandText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').replace(/[<>&"'`\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

/**
 * An extension's commands as the bar uses them:
 *   [{ name, args, about, takesArgs, suggests }]
 *   name       what follows rev/ (lowercase letters, digits, -; not one of Atmos's)
 *   args       a hint for what it takes ("room or person")
 *   about      a line saying what it does
 *   takesArgs  Enter on the command waits for something typed after it
 *   suggests   the extension lists choices as you type (atmos.commands.handle's suggest)
 *   aliases    other names typed for it (SDK 1.6: rev/pause for rev/play), at most 3,
 *              never Atmos's names nor another of its own commands' names
 */
function describeCommands(entry) {
  if (isLibrary(entry)) return [];
  const manifest = entry.manifest && !entry.manifest.invalid ? entry.manifest : {};
  const declared = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes.commands : null;
  if (!Array.isArray(declared)) return [];
  const seen = new Set();
  const out = [];
  const nameOf = def => (typeof def?.name === 'string' ? def.name.trim().toLowerCase() : '');
  const ownNames = new Set(declared.map(nameOf));
  const aliased = new Set();
  for (const def of declared) {
    if (out.length >= MAX_COMMANDS) break;
    const name = typeof def?.name === 'string' ? def.name.trim().toLowerCase() : '';
    if (!COMMAND_NAME.test(name) || CORE_COMMAND_NAMES.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      args: commandText(def.args, 40),
      about: commandText(def.about, 120),
      takesArgs: def.takesArgs === true,
      suggests: def.suggests === true,
      ...aliasesOf(def),
    });
  }
  return out;

  function aliasesOf(def) {
    const aliases = [];
    for (const raw of Array.isArray(def.aliases) ? def.aliases : []) {
      const alias = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (aliases.length >= 3 || !COMMAND_NAME.test(alias) || CORE_COMMAND_NAMES.includes(alias) || ownNames.has(alias) || aliased.has(alias)) continue;
      aliased.add(alias);
      aliases.push(alias);
    }
    return aliases.length ? { aliases } : {};
  }
}

const IMPORT_MAP = JSON.stringify({ imports: { 'atmos-sdk': '/__atmos/sdk.js' } });
const IMPORT_MAP_HASH = sha256Base64(IMPORT_MAP);

/** The HTML document every frame starts from; the SDK loads the entry. */
function frameDocument() {
  return '<!doctype html>\n<html><head><meta charset="utf-8">'
    + `<script type="importmap">${IMPORT_MAP}</script>`
    + '<link rel="stylesheet" href="/__atmos/frame.css">'
    + '<script type="module" src="/__atmos/frame.js"></script>'
    + '</head><body></body></html>\n';
}

module.exports = {
  SCHEME, FIRST_PARTY_HOST, IMPORT_MAP_HASH,
  isLibrary, resolveRuntime, frameHost, frameOrigin, extensionPath,
  sharedOriginCleanupPatterns, sharedOriginMove, moveDocument, moveCsp, storageHostScript,
  frameCsp, framePermissionsPolicy, describeContributions, describeCommands, CORE_COMMAND_NAMES, frameDocument,
  safeRelative,
};

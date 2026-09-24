'use strict';
/**
 * Framed extensions: where they run, what their frames may load, and what
 * each frame is told about itself.
 *
 * Runtimes
 *   page   — the extension's code runs in the Atmos page itself and uses
 *            Core modules directly. System extensions always; first-party
 *            extensions until they migrate (manifest "runtime": "frame").
 *   frame  — every surface (panel, sidebar widget, settings, boot) runs in
 *            its own sandboxed <iframe> and talks to Core only through the
 *            Atmos SDK bridge. Third-party extensions always.
 *
 * Origins
 *   atmos-ext://first-party         shared by framed first-party extensions
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
  if (entry.tier === 'third-party') return 'frame';
  return entry.manifest?.runtime === 'frame' ? 'frame' : 'page';
}

function frameHost(entry) {
  return entry.tier === 'third-party' ? `${entry.kind}-${entry.id}` : FIRST_PARTY_HOST;
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
      // ("showIn": ["audio-player"]); absent means everywhere.
      showIn: surface === 'sidebar' && Array.isArray(def?.showIn)
        ? [...new Set(def.showIn.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(id)))].slice(0, 8)
        : null,
      // One printable key that opens the panel from anywhere in Atmos
      // (typing in a field excepted), e.g. "#".
      shortcut: surface === 'panel' && typeof def?.shortcut === 'string' && /^[^\s\p{C}]$/u.test(def.shortcut) ? def.shortcut : null,
      // With "shortcutToggles": true the key also closes the panel again
      // (back to the previous one) when it is already showing.
      shortcutToggles: surface === 'panel' && def?.shortcutToggles === true,
      // Core draws the panel's frosted glass under the frame where the frame
      // says (atmos.surface.setGlass), following the panel's blur and opacity.
      glass: surface === 'panel' && def?.glass === true,
      // Files dropped from the desktop arrive with their paths (first-party
      // only for now; see extension-drop-overlay.js).
      fileDrops: (surface === 'panel' || surface === 'sidebar') && def?.fileDrops === true && entry.tier !== 'third-party',
      // A panel that lives in a drawer sliding up from the bottom of the
      // full workspace (Core moves it; see panel-drawer.js). "bar" is the
      // height of the strip that stays visible when the drawer is lowered.
      drawer: surface === 'panel' && def?.drawer
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
      // Settings only shows contributions on its Appearance page.
      category: surface === 'settings' ? 'Appearance' : '',
    });
  };
  for (const surface of SURFACES) {
    const value = declared ? declared[surface] : (has(CONVENTIONAL_ENTRY[surface]) ? {} : undefined);
    if (value === undefined || value === false) continue;
    const list = Array.isArray(value) && surface === 'sidebar' ? value : [value];
    list.forEach((def, index) => add(surface, def === true ? {} : def, index));
  }
  return out;
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
  SCHEME, FIRST_PARTY_HOST, SURFACES, UNSERVED_DIRS, IMPORT_MAP_HASH,
  isLibrary, resolveRuntime, frameHost, frameOrigin, extensionPath,
  frameCsp, framePermissionsPolicy, describeContributions, frameDocument,
  safeRelative, plainLabel, networkSources,
};

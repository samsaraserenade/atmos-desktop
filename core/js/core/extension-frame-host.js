/**
 * Runs every extension (the system services aside, which are part of Core)
 * inside sandboxed iframes and plugs their surfaces
 * into Core's ordinary registries, so layouts, tiles, windows, the sidebar
 * and Settings treat them like any other extension.
 *
 *   panel     registerPanelPlugin → a frame filling the panel surface
 *   sidebar   registerSection     → a frame sized to its content
 *   settings  registerSettingsPanel → a frame in the settings body
 *   boot      registerBootHook    → a hidden frame that lives all session
 *
 * Each frame gets a private MessagePort on connect; its requests go through
 * extension-bridge.js. Frames of one extension share one origin (storage and
 * process); see core/js/core/extension-frames.cjs for origins and CSP.
 */

import { readSavedNamespace, forgetStateNamespaces, scheduleSave } from '../persist.js';
import { emit, on } from './events.js';
import { openMenu, closeOpenMenu, openMenuOwner } from './context-menu.js';
import {
  registerPanelPlugin, activatePanelPlugin, isPanelPluginRegistered, listPanelPlugins, ensureDefaultPanelPlugin, restorePanelWorkspace,
} from './panel-registry.js';
import { registerSection, unregisterSection } from './sidebar-registry.js';
import { registerSettingsPanel } from './settings-registry.js';
import { registerBootHook, runBootHooks } from './boot-registry.js';
import { onAppearanceChange, appearanceState, getAppFont } from './appearance.js';
import { onSemanticColorChange } from './semantic-colors.js';
import { checkExtensionCompatibility } from './capabilities.js';
import { getCapability, onCapabilityChange } from './renderer-capabilities.js';
import { createExtensionBridge } from './extension-bridge.js';
import { createNowPlayingHub, USED_RECENTLY_MS } from './now-playing.js';
import { createLocationHub } from './location-hub.js';
import { forgetEarlierLocation, takeEarlierLocation } from './location-legacy.js';
import { createPanelDrawer } from './panel-drawer.js';
import { panelState } from './panel-state.js';
import { webFor } from './web-layer.js';
import { onEscape } from './shortcuts.js';
import { atmosKeysForFrames } from './keymap.mjs';

// allow-popups: a link a frame opens in a new window (target="_blank") goes
// to Atmos's window-open handler, which never opens a window: it hands
// http(s) and mailto links to the system browser and drops the rest.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';
// A community extension's frames can't open windows themselves: their links
// and window.open reach Atmos through the SDK (links.open), which asks you
// first unless you just clicked in that frame (main.js, extension-links.cjs).
const COMMUNITY_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
const APPEARANCE_VARS = [
  '--ink-rgb', '--surface-rgb', '--app-font-family',
  '--color-positive', '--color-negative', '--color-neutral',
  '--shell-blur', '--shell-opacity', '--default-panel-blur', '--default-panel-opacity',
];
const BOOT_TIMEOUT_MS = 10000;
// The SDK frames get (core/js/sdk/atmos-sdk.js SDK_VERSION; a test keeps them equal).
export const SDK_VERSION = '1.6.0';

const _states = new Map();   // "kind:id" -> { extension, value }: each extension's atmos.state
const _frames = new Map();   // "kind:id" -> Set<frame record>
const _framed = new Map();   // "kind:id" -> the extension, as loadFramedExtensions() got it
const _incompatible = new Set(); // "kind:id" of those made for another Atmos (never run here)
const SERVICE_WAIT_MS = 15000;
const _exposed = new Map();        // "kind:id" -> { methods, call, owner }
const _serviceWaiters = new Map(); // "kind:id" -> [resolve]
// Keys background frames declared ("keys": ["Space"]): theirs anywhere outside a field.
const _globalKeyCodes = new Set();
const _withBootFrame = new Set();  // "kind:id" of framed extensions that have a boot.js
const _stopped = new Set();        // "kind:id" stopped this session: its approval was removed (stopExtensions)
const _sectionOwners = new Map();  // sidebar widget id -> "kind:id" of the extension it's registered for
const _sectionIds = new WeakMap(); // a widget contribution -> the id it has in the sidebar
// Methods exposed by boot frames. Callers that arrive before a boot frame
// has started wait for it (awaitService) instead of failing.
const _services = {
  get: target => _exposed.get(target),
  has: target => _exposed.has(target),
  set(target, value) {
    _exposed.set(target, value);
    for (const resolve of _serviceWaiters.get(target) || []) resolve(value);
    _serviceWaiters.delete(target);
  },
  delete: target => _exposed.delete(target),
};

function _awaitService(target) {
  if (_exposed.has(target)) return Promise.resolve(_exposed.get(target));
  if (!_withBootFrame.has(target)) return Promise.resolve(null);
  return new Promise(resolve => {
    if (!_serviceWaiters.has(target)) _serviceWaiters.set(target, []);
    _serviceWaiters.get(target).push(resolve);
    setTimeout(() => resolve(_exposed.get(target) || null), SERVICE_WAIT_MS);
  });
}
let _libraryBases = new Map(); // service id -> URL base
let _hiddenHost = null;

const key = extension => `${extension.kind}:${extension.id}`;

const _isTyping = target => !!target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
// Core's own markup for a ticked menu row (frames send plain data only).
const MENU_TICK = '<span class="ctx-ico" style="color:var(--color-positive, #34d399)" aria-hidden="true">✓</span>';

// Menu icons arrive from frames as SVG text; only plain shapes survive.
const ICON_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ICON_ATTRS = new Set([
  'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'opacity',
  'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'transform', 'aria-hidden', 'xmlns',
]);
const _iconCache = new Map();

/** A frame's menu icon as safe SVG markup ('' when it isn't a plain SVG). */
function sanitizeMenuIcon(markup) {
  if (typeof markup !== 'string' || !markup.trim().startsWith('<svg') || markup.length > 4000) return '';
  if (_iconCache.has(markup)) return _iconCache.get(markup);
  let out = '';
  try {
    const source = /\sxmlns=/.test(markup) ? markup : markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    if (root?.localName === 'svg' && !doc.getElementsByTagName('parsererror').length) {
      const clean = node => {
        for (const child of [...node.children]) {
          if (ICON_TAGS.has(child.localName)) clean(child);
          else child.remove();
        }
        for (const attr of [...node.attributes]) {
          if (!ICON_ATTRS.has(attr.name) || /url\s*\(|javascript:|expression\s*\(/i.test(attr.value)) node.removeAttribute(attr.name);
        }
      };
      clean(root);
      root.setAttribute('class', 'ctx-ico');
      out = new XMLSerializer().serializeToString(root);
    }
  } catch { out = ''; }
  if (_iconCache.size > 200) _iconCache.clear();
  _iconCache.set(markup, out);
  return out;
}

/**
 * A frame's cleaned menu item as a Core menu row. Choosing a plain row calls
 * choose(); a control (toggle, range, number, text, select, colours) calls
 * change(value) on every change (a text field on Enter). A ticked row gets a tick icon, or in a
 * sidebar header menu a "✓ " before its label, like the header's own items.
 */
function toCoreMenuItem(item, { choose, change, tickInLabel = false }) {
  const icon = sanitizeMenuIcon(item.icon);
  switch (item.type) {
    case 'separator':
    case 'heading':
      return item;
    case 'meta':
      return { ...item, icon };
    case 'buttons':
      return {
        ...item,
        buttons: (item.buttons || []).map(button => ({
          ...button, icon: sanitizeMenuIcon(button.icon), run: () => choose(button.id),
        })),
      };
    case 'range':
      return {
        ...item, icon, run: change,
        format: value => (value === 0 && item.zeroLabel ? item.zeroLabel : `${value}${item.suffix || ''}`),
      };
    case 'toggle':
    case 'number':
    case 'text':
    case 'select':
    case 'colors':
      return { ...item, icon, run: change };
    default: {
      const { checked, ...row } = item;
      if (tickInLabel) return { ...row, icon, label: `${checked ? '✓ ' : ''}${row.label}`, run: choose };
      return { ...row, icon: checked ? MENU_TICK : icon, run: choose };
    }
  }
}

function _appearance() {
  const style = getComputedStyle(document.documentElement);
  const vars = {};
  for (const name of APPEARANCE_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  const font = _activeImportedFont();
  return {
    theme: document.documentElement.dataset.appTheme || null,
    colorScheme: document.documentElement.style.colorScheme || 'dark',
    vars,
    // A font imported in Appearance is only in this page's document.fonts;
    // frames fetch it once by id (appearance.fontData) and register it.
    font: font ? { id: font.id, family: font.label } : null,
  };
}

function _activeImportedFont() {
  const id = getAppFont();
  return (appearanceState.customFonts || []).find(font => font.id === id) || null;
}

/** The active imported app font's data URL, for a frame registering it. */
function _appFontData(id) {
  const font = _activeImportedFont();
  return font && font.id === id ? font.dataUrl : null;
}

// What each extension plays, passed to the Now Playing service (atmos.nowPlaying).
const _nowPlaying = createNowPlayingHub({
  send: (owner, control) => _broadcast(owner, 'nowPlaying.control', control),
  clickedJustNow: ref => _clickedJustNow(ref),
});

function _broadcast(extensionKey, topic, payload, except = null) {
  for (const record of _frames.get(extensionKey) || []) {
    if (record.bridge && record.bridge !== except) record.bridge.post({ topic, payload });
  }
}

function _broadcastAll(topic, payload) {
  for (const extensionKey of _frames.keys()) _broadcast(extensionKey, topic, payload);
}

let _appearanceQueued = false;
function _queueAppearanceBroadcast() {
  if (_appearanceQueued) return;
  _appearanceQueued = true;
  requestAnimationFrame(() => {
    _appearanceQueued = false;
    _broadcastAll('appearance', _appearance());
  });
}
onAppearanceChange(_queueAppearanceBroadcast);
// A developer folder changed (--dev-extension): take its new permissions
// and reload its frames. Surfaces added or removed need a restart
// (Settings says so).
let _reloads = 0;
window.atmosCore?.onDeveloperChange?.(({ kind, id, restart, extension: fresh }) => {
  const extensionKey = `${kind}:${id}`;
  const current = _framed.get(extensionKey);
  if (current && fresh?.frame) {
    current.manifest = fresh.manifest;
    current.permissions = fresh.permissions;
    current.frame = { ...current.frame, allow: fresh.frame.allow, reach: fresh.frame.reach, resourceProviders: fresh.frame.resourceProviders, commands: fresh.frame.commands || [] };
  }
  if (restart) console.warn(`[extensions] ${extensionKey}'s surfaces changed: restart Atmos to apply them`);
  _reloads += 1;
  for (const record of _frames.get(extensionKey) || []) {
    const url = new URL(record.iframe.src);
    url.searchParams.set('reload', String(_reloads));
    if (current?.frame?.allow) record.iframe.setAttribute('allow', current.frame.allow);
    record.iframe.src = url.href;
  }
});

// Community extensions approved while Atmos runs (main.js _loadApprovedNow):
// start them now rather than at the next start.
window.atmosCore?.onExtensionsLoaded?.(list => {
  import('./extension-list.js').then(module => module.forgetInstalledLists()).catch(() => {});
  loadApprovedExtensions(Array.isArray(list) ? list : [])
    .then(count => console.log(`[extension-frames] ${count} approved extension${count === 1 ? '' : 's'} loaded`))
    .catch(error => console.error('[extension-frames] approved extensions failed to load:', error));
});

// Community extensions whose approval was just removed (main.js _stopNow).
window.atmosCore?.onExtensionsStopped?.(refs => {
  import('./extension-list.js').then(module => module.forgetInstalledLists()).catch(() => {});
  const count = stopExtensions(Array.isArray(refs) ? refs : []);
  console.log(`[extension-frames] ${count} extension${count === 1 ? '' : 's'} stopped`);
});

// A click on a notification a frame showed goes to every frame of its extension.
window.atmosCore?.onExtensionNotificationClick?.((kind, id, tag) => {
  _broadcast(`${kind}:${id}`, 'notificationClick', { tag });
});
onSemanticColorChange(_queueAppearanceBroadcast);

// A pointer press inside a frame never reaches this document, so Core's
// menus would stay open; close them when focus moves into a frame. A menu
// that frame itself just opened stays: the first right-click into a frame
// moves focus there too, sometimes only after its menu has opened.
window.addEventListener('blur', () => {
  const focused = document.activeElement;
  if (focused?.tagName === 'IFRAME' && openMenuOwner() !== focused) closeOpenMenu();
});

// ── atmos.state: one file per extension (core/js/core/extension-state.cjs) ──
// The page keeps the working copy of each extension's state; changes are
// written to its own file shortly after they happen, and at once as the page
// unloads. Nothing is shared between extensions, so one can't overwrite
// another's settings.
const STATE_WRITE_DELAY_MS = 250;
const _stateApi = window.atmosCore?.extensionState ?? null;
let _savedStates = {};
const _stateReady = (async () => {
  try { _savedStates = (await _stateApi?.loadAll?.()) || {}; }
  catch (error) { console.warn('[extensions] saved extension state could not be read:', error.message); }
})();
const _stateTimers = new Map(); // "kind:id" -> timer

function _stateFor(extension) {
  const k = key(extension);
  if (!_states.has(k)) {
    let value;
    if (Object.hasOwn(_savedStates, k)) {
      value = _savedStates[k];
      // Its own file is in use, so the copy the Atmos page's saved blob had
      // (before Atmos 0.12) can go.
      forgetStateNamespaces([extension.id, `${extension.kind}-${extension.id}`]);
    } else {
      // First use since 0.12: take what the Atmos page saved for it (the
      // same namespace id, or kind-qualified after a clash), and write its
      // file. The blob's copy stays until a later start. Not the Location
      // service's: the `location` namespace is the location Atmos kept
      // itself before 0.21, which the service takes over by asking
      // (location-legacy.js), and clears.
      value = k === LOCATION_SERVICE ? {}
        : readSavedNamespace(extension.id) ?? readSavedNamespace(`${extension.kind}-${extension.id}`) ?? {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
      _states.set(k, { extension, value });
      _writeState(k, 0);
      return _states.get(k);
    }
    _states.set(k, { extension, value });
  }
  return _states.get(k);
}

// A change stays unsaved until its write succeeds: a failed one is tried
// again, after 5 s and then less often (one that's always refused, at most
// every 5 minutes), and at the latest as the page goes; never forgotten.
const STATE_RETRY_MS = 5000;
const STATE_RETRY_MAX_MS = 5 * 60_000;
const _stateUnsaved = new Set();
const _stateFailures = new Map(); // "kind:id" -> writes failed in a row
const _retryDelay = k => Math.min(STATE_RETRY_MS * 2 ** (_stateFailures.get(k) || 0), STATE_RETRY_MAX_MS);
function _stateFailed(k) {
  const delay = _retryDelay(k);
  _stateFailures.set(k, (_stateFailures.get(k) || 0) + 1);
  if (!_stateTimers.has(k)) _writeState(k, delay);
}

function _writeState(k, delay = STATE_WRITE_DELAY_MS) {
  _stateUnsaved.add(k);
  clearTimeout(_stateTimers.get(k));
  _stateTimers.set(k, setTimeout(() => {
    _stateTimers.delete(k);
    const record = _states.get(k);
    if (!record || !_stateApi) return;
    _stateApi.save(record.extension.kind, record.extension.id, record.value).then(() => {
      _stateFailures.delete(k);
      // A change made meanwhile has a write of its own on the way.
      if (!_stateTimers.has(k)) _stateUnsaved.delete(k);
    }, error => {
      console.warn(`[extensions] ${k}'s state could not be saved; trying again in ${Math.round(_retryDelay(k) / 1000)} s:`, error.message);
      _stateFailed(k);
    });
  }, delay));
}

/** Write an extension's state now, if a change is unsaved; resolves once it's on disk. */
async function _saveStateNow(k) {
  if (!_stateUnsaved.has(k)) return;
  clearTimeout(_stateTimers.get(k));
  _stateTimers.delete(k);
  const record = _states.get(k);
  if (!record || !_stateApi) return;
  try {
    await _stateApi.save(record.extension.kind, record.extension.id, record.value);
    _stateFailures.delete(k);
    if (!_stateTimers.has(k)) _stateUnsaved.delete(k);
  } catch (error) {
    _stateFailed(k);
    throw error;
  }
}

/** Write what is still unsaved, synchronously (the page is going away). */
function _flushStates() {
  for (const timer of _stateTimers.values()) clearTimeout(timer);
  _stateTimers.clear();
  for (const k of [..._stateUnsaved]) {
    const record = _states.get(k);
    if (record && _stateApi && _stateApi.saveSync(record.extension.kind, record.extension.id, record.value) !== false) _stateUnsaved.delete(k);
  }
}
window.addEventListener('pagehide', _flushStates);
window.addEventListener('beforeunload', _flushStates);

function _replaceState(extension, value, from) {
  const record = _stateFor(extension);
  record.value = structuredClone(value);
  _writeState(key(extension));
  _broadcast(key(extension), 'state', structuredClone(record.value), from);
}

const _deps = {
  state: {
    async get(extension) {
      await _stateReady;
      return structuredClone(_stateFor(extension).value);
    },
    async set(extension, value, from) {
      await _stateReady;
      _replaceState(extension, value, from);
    },
    // Merged here, in one step, so two frames' updates can't undo each other.
    async update(extension, patch, from, check = value => value) {
      await _stateReady;
      _replaceState(extension, check({ ..._stateFor(extension).value, ...patch }), from);
    },
  },
  events: { emit, on },
  appearance: _appearance,
  appFontData: _appFontData,
  // `owner` is the calling extension ("plugin:<id>"): the image it sets is
  // recorded as its own, so Atmos keeps what it replaced and only it (or
  // the user, in Settings) can put that back.
  wallpaper: {
    async set(file, owner) {
      const wallpaper = await _whenCapability('visual.wallpaper', 'Wallpaper');
      if (!wallpaper?.setWallpaperFor) throw new Error('the Wallpaper service is not running');
      const named = file instanceof File ? file : new File([file], 'wallpaper', { type: file.type });
      await wallpaper.setWallpaperFor(owner, _displayName(owner), named);
    },
    async restore(owner) {
      const wallpaper = await _whenCapability('visual.wallpaper', 'Wallpaper');
      return wallpaper.restorePrevious(owner);
    },
    get: owner => _wallpaperSummary(owner),
    /** Calls fn with the summary now and whenever the image or mode changes. */
    subscribe(fn, owner) {
      const wallpaper = getCapability('visual.wallpaper');
      if (!wallpaper?.subscribe) return () => {};
      let last = '';
      let alive = true;
      const off = wallpaper.subscribe(state => {
        const signature = `${state.mode}|${state.opacity}|${state.image}|${state.setBy === owner && !!state.previous}`;
        if (signature === last) return;
        last = signature;
        _wallpaperSummary(owner).then(summary => { if (alive && signature === last) fn(summary); });
      });
      return () => { alive = false; off?.(); };
    },
  },
  // Stamped with the calling extension, which the main process checks
  // again, and its frame ({ caller, frame }); then that the frame went.
  invokeMain: (stamp, kind, id, channel, ...args) => window.atmosCore.invokeExtensionAs(stamp, kind, id, channel, ...args),
  frameClosed: frame => window.atmosCore.frameClosed?.(frame),
  // A frame whose entry file didn't load: an update that can't start falls back (R4).
  frameLoadFailed: (extension, type, message) => {
    const reason = `its ${type === 'boot' ? 'background' : type} frame failed to load${message ? ` (${message})` : ''}`;
    window.atmosCore?.extensionManager?.frameFailed?.(extension.kind, extension.id, reason)?.catch?.(() => {});
  },
  onMain: (kind, id, channel, fn) => window.atmos.extensionOn(kind, id, channel, fn),
  services: _services,
  awaitService: _awaitService,
  libraryBase: id => _libraryBases.get(id) || null,
  closeMenus: () => closeOpenMenu(),
  // atmos.fetch(): made by the main process for the frame (the bridge has
  // checked the host; the main process checks everything again).
  fetch: (caller, requestId, request) => window.atmosCore.extensionFetch(caller, requestId, request),
  fetchAbort: (caller, requestId) => window.atmosCore.abortExtensionFetch?.(caller, requestId),
  // atmos.location: what the Location service (services/location) last
  // published; the bridge checks who may read it, and that only the
  // official service publishes.
  location: {
    get: () => _location.get(),
    /** Calls fn with the location whenever it changes. Returns the unsubscribe. */
    subscribe: fn => _location.subscribe(fn),
    publish: value => _location.publish(value),
    /** The location Atmos kept before 0.21 (location-legacy.js). */
    takeEarlier: () => takeEarlierLocation(),
    /**
     * The service has saved it: Atmos's copy goes, once the service's state
     * is on disk (a crash in between would otherwise lose both).
     */
    async forgetEarlier() {
      await _saveStateNow(LOCATION_SERVICE);
      forgetEarlierLocation();
    },
    /**
     * Its Detect button was pressed: the service's frame may use the
     * browser's location for a moment (location-gate.cjs). Only after a
     * real click in its frame, which the main process saw land there.
     */
    async allowDetect() {
      if (!(await _clickedJustNow(LOCATION_SERVICE))) throw new Error('Detect works from a click on its button');
      return (await window.atmosCore?.allowLocationDetect?.()) === true;
    },
  },
  readLegacyIndexedDB: _readLegacyIndexedDB,
  deleteLegacyIndexedDB: _deleteLegacyIndexedDB,
  readLegacyState: namespace => readSavedNamespace(namespace),
  readLegacyLocalStorage(keys) {
    const out = {};
    for (const name of keys) {
      try {
        if (name.endsWith('*')) {
          const prefix = name.slice(0, -1);
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) out[key] = localStorage.getItem(key);
          }
        } else {
          out[name] = localStorage.getItem(name);
        }
      } catch { if (!name.endsWith('*')) out[name] = null; }
    }
    return out;
  },
};

// The Location service, official (services/location): what it publishes
// goes to readers through here. Without it running, a read is null at once.
const LOCATION_SERVICE = 'service:location';
const _location = createLocationHub({
  running: () => _framed.get(LOCATION_SERVICE)?.tier !== undefined && _framed.get(LOCATION_SERVICE).tier !== 'third-party'
    && !_stopped.has(LOCATION_SERVICE) && !_incompatible.has(LOCATION_SERVICE),
});

/**
 * What a frame may know about the wallpaper: its mode and a small copy of
 * the image (the page's own blob: URL means nothing inside a frame).
 */
async function _wallpaperSummary(owner = null) {
  const wallpaper = getCapability('visual.wallpaper');
  if (!wallpaper) return null;
  const state = wallpaper.getState();
  return {
    mode: state.mode,
    opacity: state.opacity,
    thumbnail: await wallpaper.getThumbnail?.(320) ?? null,
    // This extension set the image showing, and Atmos kept the one before.
    canRestore: owner !== null && state.setBy === owner && !!state.previous,
  };
}

/**
 * Whose a command is, as the command bar says: the name cleaned of
 * characters that don't show (a blank name is its id in words), and a
 * community extension marked as one, so none passes for Atmos or another.
 */
function _commandLabel(ref) {
  const clean = _displayName(ref).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const id = String(ref).split(':')[1] || String(ref);
  const name = clean || id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return _framed.get(ref)?.tier === 'third-party' ? `${name} · community` : name;
}

/**
 * Whether you just clicked in this extension: the Atmos window's last
 * mouse-button press, as Chromium reported it to the main process (a frame
 * can't make one up, as it can take the focus), was on one of its frames a
 * moment ago. What a community extension starts in Now Playing counts as
 * started only then (or after you used its controls there).
 */
async function _clickedJustNow(ref) {
  const press = await window.atmosCore?.lastClick?.().catch(() => null);
  if (!press || !(press.ago >= 0 && press.ago < USED_RECENTLY_MS)) return false;
  const hit = document.elementFromPoint(press.x, press.y);
  return hit instanceof HTMLIFrameElement && [...(_frames.get(ref) || [])].some(record => record.iframe === hit);
}

/** What Settings calls an extension ("plugin:<id>"): its displayName, else its id in words. */
function _displayName(ref) {
  const extension = _framed.get(ref);
  const declared = extension?.manifest?.displayName;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  const id = String(ref).split(':')[1] || String(ref);
  return id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * A system service's capability, waiting for it to start if need be. Frames
 * are created before Core runs its boot hooks (which start Audio and
 * Wallpaper), so a frame's first call can arrive a moment early; it waits
 * rather than failing. Rejects after `timeout` ms with "the X service is
 * not running".
 */
function _whenCapability(name, label, timeout = 10000) {
  const now = getCapability(name);
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error(`the ${label} service is not running`)); }, timeout);
    off = onCapabilityChange(name, value => {
      if (!value) return;
      clearTimeout(timer);
      queueMicrotask(() => off());
      resolve(value);
    }, { immediate: false });
  });
}

// Audio channels whose changes are already being sent to the owner's frames.
const _audioWatched = new Set();

async function _audioChannel(extension) {
  return (await _whenCapability('media.audio', 'Audio')).channel(key(extension));
}

/** Every record of every store in one of the Atmos page's own databases. */
/** Whether a record key matches one of `patterns` (exact, or "prefix*"). */
function _keyMatches(key, patterns) {
  if (typeof key !== 'string') return false;
  return patterns.some(pattern => pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern);
}

/** Every record (or, with `keys`, the matching records) of every store in one of the Atmos page's own databases. */
async function _readLegacyIndexedDB(name, keys = null) {
  const known = await indexedDB.databases?.() ?? [];
  if (!known.some(db => db.name === name)) return null; // never opened: don't create it
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const stores = {};
    for (const storeName of db.objectStoreNames) {
      stores[storeName] = await new Promise((resolve, reject) => {
        const records = [];
        const cursor = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) { resolve(records); return; }
          if (!keys || _keyMatches(current.key, keys)) records.push([current.key, current.value]);
          current.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    }
    return { version: db.version, stores };
  } finally {
    db.close();
  }
}

/** Delete the Atmos page's own databases whose names match `patterns` (exact or "prefix*"). Resolves the names deleted. */
async function _deleteLegacyIndexedDB(patterns) {
  const known = await indexedDB.databases?.() ?? [];
  const names = known.map(db => db.name).filter(name => _keyMatches(name, patterns));
  for (const name of names) {
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
  return names;
}

function _dispatchKey(init) {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: String(init?.key ?? ''), code: String(init?.code ?? ''),
    ctrlKey: !!init?.ctrlKey, shiftKey: !!init?.shiftKey, altKey: !!init?.altKey, metaKey: !!init?.metaKey,
    bubbles: true, cancelable: true,
  }));
}

/**
 * Create one frame for a surface of an extension inside `container`.
 * Returns { element, ready, menuItems, dispose }.
 */
function _createFrame(extension, surface, container, { presentation = null, hidden = false, drawer = null } = {}) {
  const { origin, base, allow } = extension.frame;
  const iframe = document.createElement('iframe');
  iframe.className = `atmos-extension-frame atmos-extension-frame-${surface.type}`;
  iframe.setAttribute('sandbox', extension.tier === 'third-party' ? COMMUNITY_SANDBOX : SANDBOX);
  iframe.setAttribute('allow', allow);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = `${surface.label || extension.id}`;
  iframe.dataset.extension = key(extension);
  if (hidden) iframe.setAttribute('aria-hidden', 'true');
  iframe.src = `${origin}/__atmos/frame.html?ext=${encodeURIComponent(key(extension))}&surface=${surface.type}`;

  const record = {
    iframe, bridge: null, port: null, presentation, menuItems: [], drawer,
    // For the command bar (command-bar.js): what kind of surface it is and
    // where, the commands it handles and its panel's bottom bar.
    type: surface.type, container, extensionKey: key(extension),
    commands: new Map(), // name -> { suggests }
    bar: null,           // { x, y, width, height } in the frame's pixels
  };
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  const deps = {
    ..._deps,
    // atmos.panel.show(): not while this frame runs a command "here" (Alt+Enter).
    showPanel: target => _showPanel(target, record),
    // Only a frame the user is interacting with may drive Atmos's UI.
    dispatchKey(init) {
      if (document.activeElement === iframe) _dispatchKey(init);
    },
    // Not only while it has the keyboard: the switcher took it at Alt+`.
    altUp() { window.dispatchEvent(new Event('atmos:alt-up')); },
    openMenu(x, y, items, onChange) {
      if (surface.type === 'boot') return Promise.reject(new Error('background frames cannot open menus'));
      const rect = iframe.getBoundingClientRect();
      return new Promise(resolve => {
        // The menu closes before a row's run() is called, so a dismissal is
        // only settled after any click has had its chance to be recorded.
        // Resolves with the plain row chosen, the last control change, or null.
        let chosen = null;
        openMenu(rect.left + x, rect.top + y, items.map(item => toCoreMenuItem(item, {
          choose: (id = item.id) => { chosen = id; },
          change: value => {
            chosen = { id: item.id, value };
            onChange?.(chosen);
          },
        })), { owner: iframe, onClose: () => setTimeout(() => resolve(chosen)) });
      });
    },
    closeOwnMenu() {
      if (openMenuOwner() === iframe) closeOpenMenu();
    },
    audio: {
      channel: () => _audioChannel(extension),
      async watch() {
        const k = key(extension);
        if (_audioWatched.has(k)) return;
        _audioWatched.add(k);
        try {
          (await _audioChannel(extension)).subscribe(value => _broadcast(k, 'audio', value));
        } catch (error) {
          _audioWatched.delete(k);
          throw error;
        }
      },
    },
    // atmos.nowPlaying: this extension's sessions (the bridge checks who may).
    nowPlaying: {
      set: (sessionId, session) => _nowPlaying.set({ id: key(extension), name: _displayName(key(extension)), community: extension.tier === 'third-party' }, sessionId, session),
      clear: sessionId => _nowPlaying.clear(key(extension), sessionId),
      watch: fn => _nowPlaying.watch(fn),
      control: (id, action, value) => _nowPlaying.control(id, action, value),
    },
    setSurfaceMenu(items) { record.menuItems = items; },
    // rev/ commands this frame runs, and its panel's bottom bar (the
    // bridge has checked the names against the manifest).
    commands: {
      handle(name, meta) {
        record.commands.set(name, { suggests: meta?.suggests === true });
        // The bar may have said "Open X…" before this frame got here: it asks again.
        window.dispatchEvent(new CustomEvent('atmos:command-bar-refresh', { detail: { extension: key(extension) } }));
      },
      unhandle(name) { record.commands.delete(name); },
      setBar(rect) {
        record.bar = rect;
        window.dispatchEvent(new CustomEvent('atmos:command-bar-moved'));
      },
      open(text, options, follow = false) {
        if (follow) {
          // Keys typed in this frame's field before the bar had the keyboard
          // (atmos.commands.field): the bar takes them only if it opened from
          // here a moment ago (command-bar.js).
          const detail = { text, from: iframe, accepted: false };
          window.dispatchEvent(new CustomEvent('atmos:command-bar-follow', { detail }));
          if (!detail.accepted) throw new Error('the command bar isn\u2019t taking text from this frame now');
          return;
        }
        // Typing in this frame, not a frame working on its own: it has the
        // keyboard, and the user just did something (Chromium passes a
        // frame's user activation up to this page).
        if (document.activeElement !== iframe) throw new Error('only the frame you\u2019re typing in can open the command bar');
        if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('the command bar opens as you type, not on its own');
        window.dispatchEvent(new CustomEvent('atmos:command-bar-open', { detail: { text, options, from: iframe, extension: key(extension) } }));
      },
      refresh() { window.dispatchEvent(new CustomEvent('atmos:command-bar-refresh', { detail: { extension: key(extension) } })); },
    },
    notify(options) {
      if (!window.atmosCore?.showExtensionNotification) return Promise.resolve(false);
      return window.atmosCore.showExtensionNotification(extension.kind, extension.id, options);
    },
    // A link it asks Atmos to open. Whether this frame has the focus (where
    // your last click or key went) is what lets a community one open
    // without asking; main.js checks the timing.
    openLink(url) {
      if (!window.atmosCore?.openExtensionLink) return Promise.resolve(false);
      return window.atmosCore.openExtensionLink(extension.kind, extension.id, url, { focused: document.activeElement === iframe });
    },
    // A panel in a drawer (full workspace) or shown pinned open (tile, window).
    drawer: drawer ? {
      command: (name, value) => drawer.command(name, value),
      wheel: (deltaY, deltaMode) => drawer.wheel(deltaY, deltaMode),
    } : null,
    resize(height) {
      if (surface.type === 'sidebar' || surface.type === 'settings') iframe.style.height = `${height}px`;
    },
    // A panel declaring "glass": the frame says where its surfaces are and
    // Core draws the frosted material there, under the frame (a frame's own
    // backdrop-filter can't reach the wallpaper behind it).
    setGlass(regions) {
      if (!glassLayer) throw new Error('only panels declaring "glass" have Core-drawn glass');
      _paintGlass(glassLayer, regions);
    },
    // Web pages (Atmos Browser), for an official extension declaring "web"
    // (the bridge checks both again): see web-layer.js.
    web: extension.tier !== 'third-party' && extension.permissions?.web === true ? webFor(extension, iframe, surface.type) : null,
  };

  let glassLayer = null;
  if (surface.type === 'panel' && surface.glass) {
    glassLayer = document.createElement('div');
    glassLayer.className = 'atmos-frame-glass-layer';
    glassLayer.setAttribute('aria-hidden', 'true');
    container.classList.add('atmos-frame-glass-host');
    container.appendChild(glassLayer);
  }

  function onMessage(event) {
    if (event.source !== iframe.contentWindow || event.origin !== origin || event.data?.type !== 'atmos:frame-ready') return;
    // A (re)loaded document gets a fresh port; the previous one is dropped,
    // with the commands it handled and the bar it declared.
    record.bridge?.dispose();
    record.port?.close();
    record.commands.clear();
    record.bar = null;
    const channel = new MessageChannel();
    record.port = channel.port1;
    record.bridge = createExtensionBridge({
      extension,
      surface: { type: surface.type, drawer: !!surface.drawer, glass: surface.type === 'panel' && !!surface.glass },
      post: message => channel.port1.postMessage(message),
      deps,
    });
    channel.port1.onmessage = messageEvent => record.bridge.receive(messageEvent.data);
    iframe.contentWindow.postMessage({
      type: 'atmos:connect',
      init: {
        sdkVersion: SDK_VERSION,
        extension: { id: extension.id, kind: extension.kind, tier: extension.tier, version: extension.version || null },
        surface: {
          type: surface.type, id: surface.id, presentation: record.presentation,
          glass: surface.type === 'panel' && !!surface.glass,
          drawer: surface.drawer ? { bar: surface.drawer.bar, ...(drawer ? drawer.state() : _pinnedDrawerState(surface)) } : null,
        },
        entry: `${base}${surface.entry}`,
        appearance: _appearance(),
        // Atmos's own keys (keymap.mjs), which the SDK takes before the
        // extension's code sees them, even while typing; and the keys an
        // extension's background frame declared ("keys": ["Space"]), which
        // it hands over outside fields and buttons unless the frame took
        // the key itself (never both).
        atmosKeys: atmosKeysForFrames(),
        globalKeys: [..._globalKeyCodes],
      },
    }, origin, [channel.port2]);
    resolveReady(true);
  }
  window.addEventListener('message', onMessage);

  // A panel's own blur and opacity (Settings → Appearance → Individual
  // Panels) are set on Core's panel element; pass them on to the frame.
  let stopPanelVars = null;
  if (surface.type === 'panel') {
    const sendPanelVars = () => {
      const style = getComputedStyle(container);
      const vars = {};
      for (const name of ['--panel-blur', '--panel-opacity']) {
        const value = style.getPropertyValue(name).trim();
        if (value) vars[name] = value;
      }
      if (Object.keys(vars).length) record.bridge?.post({ topic: 'appearance', payload: { vars } });
    };
    ready.then(() => requestAnimationFrame(sendPanelVars));
    stopPanelVars = onAppearanceChange(() => requestAnimationFrame(sendPanelVars));
  }

  // A widget's section opening, closing or changing width: ask the frame to
  // measure again, since a frame Chromium treated as hidden may have
  // missed its own size changes.
  let containerWatch = null;
  if (surface.type === 'sidebar' || surface.type === 'settings') {
    containerWatch = new ResizeObserver(() => record.bridge?.post({ topic: 'measure' }));
    containerWatch.observe(container);
  }

  if (!_frames.has(key(extension))) _frames.set(key(extension), new Set());
  _frames.get(key(extension)).add(record);
  container.appendChild(iframe);

  function dispose() {
    containerWatch?.disconnect();
    stopPanelVars?.();
    window.removeEventListener('message', onMessage);
    record.bridge?.dispose();
    record.port?.close();
    _frames.get(key(extension))?.delete(record);
    // Its last frame gone (stopped, turned off): what it played goes too.
    if (!_frames.get(key(extension))?.size) {
      _nowPlaying.forget(key(extension));
      // The Location service gone (its last frame): nothing to read until it's back.
      if (key(extension) === LOCATION_SERVICE) _location.forget();
    }
    iframe.remove();
    if (glassLayer) {
      glassLayer.remove();
      container.classList.remove('atmos-frame-glass-host');
    }
  }
  // Its extension stopped (stopExtensions): the frame goes, and a panel or
  // settings page says why where it was.
  record.stop = () => {
    dispose();
    if (surface.type === 'panel' || surface.type === 'settings') _stoppedNote(extension, container);
  };

  return {
    element: iframe,
    ready,
    /** Tell the frame about its drawer (state changes, visible browser height). */
    post: message => record.bridge?.post(message),
    /** The widget header's menu, as the frame last set it; choosing runs the frame's item. */
    menuItems: () => record.menuItems.map(item => toCoreMenuItem(item, {
      choose: (id = item.id) => record.bridge?.post({ topic: 'surfaceMenu', payload: id }),
      change: value => record.bridge?.post({ topic: 'surfaceMenu', payload: { id: item.id, value } }),
      tickInLabel: true,
    })),
    dispose,
  };
}

/** Where a stopped extension's panel or settings page was. */
function _stoppedNote(extension, container) {
  if (!container || container.querySelector(':scope > .atmos-extension-stopped')) return;
  const note = document.createElement('div');
  note.className = 'atmos-extension-stopped';
  const name = document.createElement('strong');
  name.textContent = extension.manifest?.displayName || extension.id;
  note.append(name, document.createTextNode(' stopped: you removed its approval. It\u2019s gone at the next start, unless you approve it again.'));
  container.appendChild(note);
}

/** Draw a framed panel's glass regions (already checked by the bridge). */
function _paintGlass(layer, regions) {
  const pieces = regions.map(region => {
    const piece = document.createElement('div');
    piece.className = 'atmos-frame-glass';
    piece.dataset.material = region.material;
    piece.style.cssText = `left:${region.x}px;top:${region.y}px;width:${region.width}px;height:${region.height}px;border-radius:${region.radius}px`;
    return piece;
  });
  layer.replaceChildren(...pieces);
}

/** What a drawer panel's frame hears when it is shown in a tile or window. */
function _pinnedDrawerState(surface) {
  return { open: true, expanded: true, placement: 0, barPlacement: _savedDrawer(surface.id).bar, locked: true };
}

function _savedDrawer(panelId) {
  const saved = panelState.drawers?.[panelId];
  return { placement: Number.isFinite(saved?.placement) ? saved.placement : 1, bar: saved?.bar === 'bottom' ? 'bottom' : 'top' };
}

function _saveDrawer(panelId, patch) {
  if (!panelState.drawers || typeof panelState.drawers !== 'object') panelState.drawers = {};
  panelState.drawers[panelId] = { ..._savedDrawer(panelId), ...patch };
  scheduleSave();
}

const PENDING_CLOSE_MS = 2000;

/**
 * A drawer panel on the full workspace: Core's pass-through surface, the
 * drawer that moves (panel-drawer.js) and the extension's frame inside it.
 * Wheel anywhere on the workspace moves it (the frame forwards wheel from
 * outside its own scrolling areas), and Escape twice closes it. Returns the
 * cleanup function.
 */
function _mountDrawer(extension, surface, surfaceEl) {
  const { bar } = surface.drawer;
  const host = document.createElement('div');
  host.className = 'atmos-drawer-surface';
  host.style.setProperty('--atmos-drawer-bar-h', `${bar}px`);
  // Dock mode reveals the drawer with clip-path, which stops anything inside
  // it from blurring the wallpaper; this sits outside the clip and blurs
  // behind the docked bar instead.
  const dockBlur = document.createElement('div');
  dockBlur.className = 'atmos-drawer-dock-blur';
  const drawerEl = document.createElement('div');
  drawerEl.className = 'atmos-drawer';
  const barGlass = document.createElement('div');
  barGlass.className = 'atmos-drawer-glass atmos-drawer-glass-bar';
  const bodyGlass = document.createElement('div');
  bodyGlass.className = 'atmos-drawer-glass atmos-drawer-glass-body';
  drawerEl.append(barGlass, bodyGlass);
  const pending = document.createElement('div');
  pending.className = 'atmos-drawer-pending';
  pending.dataset.hint = 'Press Esc again to close';
  host.append(dockBlur, drawerEl);
  surfaceEl.replaceChildren(host);

  const saved = _savedDrawer(surface.id);
  let frame = null;
  let visibleNow = 0;
  const post = message => frame?.post(message);
  const syncChrome = state => {
    host.classList.toggle('dock-open', state.open && state.barPlacement === 'bottom');
  };
  const physics = createPanelDrawer({ surface: host, drawer: drawerEl }, {
    barHeight: bar,
    placement: saved.placement,
    barPlacement: saved.bar,
    onState(state) { syncChrome(state); post({ topic: 'drawer', payload: state }); },
    onVisible(visible) { visibleNow = visible; post({ topic: 'drawerVisible', payload: visible }); },
    onSettle(placement) { if (Number.isFinite(placement)) _saveDrawer(surface.id, { placement }); },
  });
  syncChrome(physics.state());

  let pendingTimer = null;
  const setPending = on => {
    clearTimeout(pendingTimer);
    drawerEl.classList.toggle('pending-close', on);
    if (on) pendingTimer = setTimeout(() => drawerEl.classList.remove('pending-close'), PENDING_CLOSE_MS);
  };
  const commands = {
    open: () => { setPending(false); physics.open(); },
    close: () => { setPending(false); physics.close(); },
    expand: () => physics.expand(),
    collapse: () => physics.collapse(),
    placement(value) {
      if (!Number.isFinite(value)) throw new TypeError('setPlacement(placement) needs a number from 0 (open) to 2 (hidden)');
      physics.setPlacement(value);
      _saveDrawer(surface.id, { placement: physics.getPlacement() });
    },
    bar(value) {
      physics.setBarPlacement(value);
      _saveDrawer(surface.id, { bar: value });
      syncChrome(physics.state());
    },
  };
  const drawer = {
    state: () => ({ ...physics.state(), visible: visibleNow }),
    command(name, value) {
      if (!Object.hasOwn(commands, name)) throw new TypeError(`unknown drawer command '${name}'`);
      commands[name](value);
      return physics.state();
    },
    wheel: (deltaY, deltaMode) => physics.wheel(Number(deltaY), Number(deltaMode) || 0),
  };
  frame = _createFrame(extension, { ...surface, type: 'panel' }, drawerEl, { presentation: 'full', drawer });
  drawerEl.appendChild(pending);

  // Wheel on the workspace itself (the page, outside every frame).
  const onWheel = event => {
    if (event.ctrlKey) return;
    if (event.target?.closest?.('#settings-drawer, .ctx-menu-surface, .panel-host-controls, #command-bar-field, #command-bar-list')) return;
    physics.wheel(event.deltaY, event.deltaMode);
  };
  // Escape arms, a second Escape within two seconds closes (the bottom
  // layer of shortcuts.js's Escape stack: a menu, Settings or the switcher
  // over it closes first). With "keys": true, characters typed on the
  // workspace while the drawer is open go to the frame (Audio Player's
  // type-to-search), which takes focus.
  const stopEscape = onEscape({
    priority: 10,
    isOpen: () => physics.isOpen,
    close: () => {
      if (drawerEl.classList.contains('pending-close')) commands.close();
      else setPending(true);
    },
  });
  const onKeydown = event => {
    if (event.defaultPrevented || !physics.isOpen) return;
    if (!surface.drawer.keys || event.isTrusted === false) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || !event.key.trim()) return;
    if (_isTyping(event.target)) return;
    if (document.activeElement?.tagName === 'IFRAME') return;
    if (event.target?.closest?.('#command-bar-field, #command-bar-list, #sidebar-footer.is-commanding, #task-view, #task-view-keys')) return;
    event.preventDefault();
    frame.element.focus();
    post({ topic: 'drawerKey', payload: { key: event.key } });
  };
  const observer = new ResizeObserver(() => physics.resized());
  observer.observe(host);
  document.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('keydown', onKeydown, true);

  return () => {
    document.removeEventListener('wheel', onWheel);
    document.removeEventListener('keydown', onKeydown, true);
    stopEscape();
    observer.disconnect();
    clearTimeout(pendingTimer);
    physics.dispose();
    frame.dispose();
  };
}

/** Icons are files in the extension, drawn as a mask in the current text
 *  colour so they follow the theme like Core's own icons. */
function _iconHtml(extension, icon) {
  if (!icon) return undefined;
  const src = `${extension.frame.origin}${extension.frame.base}${icon.split('/').map(encodeURIComponent).join('/')}`;
  const safe = src.replace(/['"()\\\s]/g, character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `<span class="atmos-extension-icon" aria-hidden="true" style="--atmos-extension-icon:url('${safe}')"></span>`;
}

function _registerContribution(extension, surface) {
  const icon = _iconHtml(extension, surface.icon);
  if (surface.surface === 'panel') {
    registerPanelPlugin(surface.id, {
      label: surface.label,
      icon,
      default: surface.default,
      // Atmos Browser, which Atmos ships with: the panel Atmos opens on.
      builtIn: extension.builtIn === true,
      // A drawer covers only part of the workspace; clicks and scrolls
      // elsewhere reach the wallpaper underneath. Its glass follows the
      // panel's own blur and opacity (Glass in Settings → Appearance).
      passThrough: !!surface.drawer,
      // A panel with Core-drawn glass ("glass": true) follows them too.
      panelAppearance: !!surface.drawer || !!surface.glass,
      mount(surfaceEl, context) {
        if (_stopped.has(key(extension))) { _stoppedNote(extension, surfaceEl); return; }
        const presentation = context?.presentation ?? null;
        if (surface.drawer && presentation === 'full') {
          context?.onCleanup?.(_mountDrawer(extension, surface, surfaceEl));
          return;
        }
        const frame = _createFrame(extension, { ...surface, type: 'panel' }, surfaceEl, { presentation });
        context?.onCleanup?.(frame.dispose);
      },
    });
  } else if (surface.surface === 'sidebar') {
    const mounted = new Map();
    // Two extensions with the same widget id (Now Playing keeps Audio
    // Player's old one, which an Audio Player older than 1.2 still uses):
    // the second gets an id of its own rather than being dropped.
    const holder = _sectionOwners.get(surface.id);
    const sectionId = holder && holder !== key(extension) ? `${extension.id}-${surface.id}` : surface.id;
    _sectionOwners.set(sectionId, key(extension));
    _sectionIds.set(surface, sectionId);
    registerSection(sectionId, {
      label: surface.label,
      // Which extension it comes from, for Settings → Sidebar's groups.
      owner: extension.manifest?.displayName || extension.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
      icon: icon || '',
      order: surface.order,
      defaultEnabled: surface.defaultEnabled,
      ...(surface.defaultHeight ? { defaultHeight: surface.defaultHeight } : {}),
      ...(surface.resizable === false ? { resizable: false } : {}),
      ...(Array.isArray(surface.showIn) && surface.showIn.length ? { showIn: surface.showIn } : {}),
      contextMenuItems: () => [...mounted.values()].at(-1)?.menuItems() ?? [],
      mount(bodyEl) {
        if (_stopped.has(key(extension))) return;
        mounted.set(bodyEl, _createFrame(extension, { ...surface, type: 'sidebar' }, bodyEl));
      },
      unmount(bodyEl) {
        mounted.get(bodyEl)?.dispose();
        mounted.delete(bodyEl);
      },
    });
  } else if (surface.surface === 'settings') {
    registerSettingsPanel(surface.id, {
      label: surface.label,
      icon,
      category: surface.category || undefined,
      order: surface.order,
      mount(bodyEl, context) {
        if (_stopped.has(key(extension))) { _stoppedNote(extension, bodyEl); return; }
        const frame = _createFrame(extension, { ...surface, type: 'settings' }, bodyEl);
        context?.onCleanup?.(frame.dispose);
      },
    });
  } else if (surface.surface === 'boot') {
    _withBootFrame.add(key(extension));
    for (const code of surface.keys || []) _globalKeyCodes.add(code);
    registerBootHook(`${extension.kind}:${extension.id}`, {
      order: surface.order,
      async run() {
        if (_stopped.has(key(extension))) return;
        if (!_hiddenHost) {
          _hiddenHost = document.createElement('div');
          _hiddenHost.id = 'atmos-extension-boot-frames';
          _hiddenHost.hidden = true;
          document.body.appendChild(_hiddenHost);
        }
        // Lives for the whole session: background work and services' exposed methods.
        const frame = _createFrame(extension, { ...surface, type: 'boot' }, _hiddenHost, { hidden: true });
        // Keys it declared ("keys": ["Space"]) pressed anywhere in Atmos
        // outside a text field (frames pass on keys that aren't typing).
        if (surface.keys?.length) {
          const codes = new Set(surface.keys);
          document.addEventListener('keydown', event => {
            if (!codes.has(event.code) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            if (_isTyping(event.target)) return;
            event.preventDefault();
            frame.post({ topic: 'key', payload: { code: event.code } });
          });
        }
        const timeout = new Promise(resolve => setTimeout(() => resolve(false), BOOT_TIMEOUT_MS));
        if (!await Promise.race([frame.ready, timeout])) {
          console.warn(`[extension-frames] ${extension.kind} '${extension.id}' boot frame did not connect within ${BOOT_TIMEOUT_MS / 1000}s`);
        }
      },
    });
  }
}

/**
 * Register every surface of every active framed extension. Call after
 * persistence has loaded and before panels are restored and boot hooks run.
 */
export function loadFramedExtensions({ plugins = [], services = [] } = {}) {
  // Only libraries that load this session can be imported: one switched off,
  // missing a dependency or failed is absent, so optional consumers can tell.
  _libraryBases = new Map();
  return _registerFramed({ plugins, services });
}

/**
 * Community extensions the user approved while Atmos runs (the main
 * process's _loadApprovedNow() decided which, and made their files
 * servable): register their surfaces as startup would, then start their
 * background frames. Resolves how many were loaded.
 */
export async function loadApprovedExtensions(list = []) {
  const plugins = list.filter(item => item.kind === 'plugin' && !_framed.has(key(item)));
  const services = list.filter(item => item.kind === 'service' && !_framed.has(key(item)));
  const hadPanels = listPanelPlugins().length > 0;
  const count = _registerFramed({ plugins, services });
  // The first panel there is: out of the empty state onto it, as startup
  // does when there are panels (core/app.js).
  if (!hadPanels && listPanelPlugins().length) {
    document.getElementById('media-fullscreen')?.classList.remove('panel-host-empty');
    ensureDefaultPanelPlugin();
    restorePanelWorkspace();
    (await import('./task-view.js')).initTaskView();
  }
  await runBootHooks(); // only the new ones: the rest have run
  return count;
}

function _registerFramed({ plugins = [], services = [] }) {
  for (const service of services) {
    if (service.libraryBase && service.active !== false && service.enabled !== false) _libraryBases.set(service.id, service.libraryBase);
  }
  const framed = [
    ...services.map(service => ({ ...service, kind: 'service' })),
    ...plugins.map(plugin => ({ ...plugin, kind: 'plugin' })),
  ].filter(extension => extension.runtime === 'frame'
    && extension.active !== false && extension.enabled !== false && extension.frame);
  const register = (extension, surface) => {
    try { _registerContribution(extension, surface); }
    catch (error) { console.error(`[extension-frames] ${extension.kind} '${extension.id}' ${surface.surface} failed to register:`, error); }
  };
  const communityWidgets = [];
  for (const extension of framed) {
    _framed.set(key(extension), extension);
    const compatibility = checkExtensionCompatibility(extension.manifest || {}, `${extension.kind} '${extension.id}'`);
    if (!compatibility.compatible) {
      _incompatible.add(key(extension));
      console.warn(`[extension-frames] '${extension.id}' skipped: ${compatibility.reasons.join('; ')}`);
      continue;
    }
    _incompatible.delete(key(extension));
    for (const surface of extension.frame.contributions) {
      // A community extension's widgets after every official one's: on an
      // id both want, the official one keeps it (and its saved place).
      if (surface.surface === 'sidebar' && extension.tier === 'third-party') { communityWidgets.push([extension, surface]); continue; }
      register(extension, surface);
    }
  }
  for (const [extension, surface] of communityWidgets) register(extension, surface);
  return framed.length;
}

/**
 * Community extensions whose approval was just removed (the main process's
 * _stopNow decided which, and stopped serving their files): every frame of
 * theirs goes now (panel, widgets, settings page, background frame), their
 * widgets leave the sidebar, what they play stops, what they offered other
 * extensions is withdrawn, and a panel or settings page left showing says
 * they stopped.
 * Resolves how many stopped.
 */
export function stopExtensions(refs = []) {
  let count = 0;
  for (const ref of refs) {
    const extension = _framed.get(ref);
    if (!extension || _stopped.has(ref)) continue;
    _stopped.add(ref);
    count += 1;
    for (const record of [...(_frames.get(ref) || [])]) record.stop?.();
    _exposed.delete(ref);
    // What it plays on its audio channel stops too: nothing of it is left
    // to control it, and its Now Playing went with its last frame.
    const audio = getCapability('media.audio');
    if (audio?.listChannels().some(item => item.owner === ref)) audio.channel(ref).stop();
    for (const surface of extension.frame?.contributions || []) {
      if (surface.surface !== 'sidebar') continue;
      const sectionId = _sectionIds.get(surface) ?? surface.id;
      unregisterSection(sectionId);
      if (_sectionOwners.get(sectionId) === ref) _sectionOwners.delete(sectionId);
    }
  }
  return count;
}

// ── The command bar's view of extensions (command-bar.js) ──────────────────

/**
 * Whether a frame is on screen: in the page, not in a hidden widget
 * section, with a size; a widget only while the sidebar is open.
 */
function _showing(record) {
  if (!record.iframe.isConnected || record.iframe.closest('[hidden]')) return false;
  if (record.type === 'sidebar' && !record.iframe.closest('#settings-drawer.open')) return false;
  const rect = record.iframe.getBoundingClientRect();
  // Some of it on screen: a drawer slid away (Music's) is still laid out, below the window.
  return rect.width > 0 && rect.height > 0 && rect.top < innerHeight - 1 && rect.bottom > 1 && rect.left < innerWidth - 1 && rect.right > 1;
}

function _panelRecords() {
  return [..._frames.values()].flatMap(records => [...records]).filter(record => record.type === 'panel' && _showing(record));
}

/**
 * The panel the command bar is for: the one the keyboard was in, the one a
 * focused web page sits over, else the main panel's.
 */
function _targetPanel(focused) {
  const panels = _panelRecords();
  if (focused) {
    const own = panels.find(record => record.iframe === focused);
    if (own) return own;
    if (focused.tagName === 'WEBVIEW') {
      const box = focused.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const under = panels.find(record => {
        const rect = record.iframe.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (under) return under;
    }
  }
  return panels.find(record => record.iframe.closest('#panel-primary')) || panels[0] || null;
}

const _rectOf = element => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/**
 * The command bar closed and gave `iframe` the keyboard back: its frame puts
 * it where it was (the field rev/ was typed in), which a frame's own focus
 * doesn't do by itself.
 */
export function giveKeyboardBack(iframe) {
  for (const records of _frames.values()) {
    for (const record of records) {
      if (record.iframe === iframe) { record.bridge?.post({ topic: 'keyboardBack' }); return; }
    }
  }
}

/**
 * Where the command bar opens: over the bar of the panel it's for, when
 * that panel declared one and it's on screen (`bar`), else along the
 * bottom of that panel (`area`); with no panel at all, the workspace.
 * Coordinates are the window's. `extension` is the panel's extension.
 */
export function commandBarTarget(focused = null) {
  const record = _targetPanel(focused);
  if (!record) {
    const host = document.getElementById('media-fullscreen');
    return { extension: null, bar: null, area: host ? _rectOf(host) : { left: 0, top: 0, width: innerWidth, height: innerHeight } };
  }
  const frame = record.iframe.getBoundingClientRect();
  let bar = null;
  if (record.bar) {
    // Within the panel's own frame: a frame says where its bar is, not where Atmos's field goes elsewhere.
    const x = Math.min(Math.max(0, record.bar.x), frame.width);
    const y = Math.min(Math.max(0, record.bar.y), Math.max(0, frame.height - record.bar.height));
    const candidate = { left: frame.left + x, top: frame.top + y, width: Math.min(record.bar.width, frame.width - x), height: Math.min(record.bar.height, frame.height) };
    const onScreen = candidate.top >= 0 && candidate.top + candidate.height <= innerHeight + 1 && candidate.left >= -1 && candidate.width > 40;
    if (onScreen) bar = candidate;
  }
  const area = record.container?.isConnected ? _rectOf(record.container) : { left: frame.left, top: frame.top, width: frame.width, height: frame.height };
  return { extension: record.extensionKey, bar, area };
}

/**
 * The rev/ commands extensions declare, with how much of each is showing:
 *   [{ extension: "plugin:<id>", label, rank, commands: [{ name, args, about, takesArgs, suggests }] }]
 * rank: 0 the panel the bar is for, 1 another panel showing, 2 a widget
 * showing, 4 nothing showing (Atmos's own commands sit at 3).
 */
export function extensionCommandSources(focused = null) {
  const target = _targetPanel(focused);
  const out = [];
  for (const [ref, extension] of _framed) {
    const commands = extension.frame?.commands || [];
    if (!commands.length || _stopped.has(ref) || _incompatible.has(ref)) continue;
    const records = [..._frames.get(ref) || []].filter(_showing);
    let rank = 4;
    if (target?.extensionKey === ref) rank = 0;
    else if (records.some(record => record.type === 'panel')) rank = 1;
    else if (records.some(record => record.type === 'sidebar')) rank = 2;
    out.push({ extension: ref, label: _commandLabel(ref), rank, commands: commands.map(command => ({ ...command })) });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Frames whose atmos.panel.show() does nothing while they run a command
// "here" (Alt+Enter in the command bar): frame record -> how many such runs.
// Only that frame's: a widget of the same extension clicked meanwhile still
// opens its panel.
const _panelHolds = new Map();
// A frame that didn't answer in time may still be at it: held this much longer.
const HOLD_AFTER_TIMEOUT_MS = 15_000;

/** Show an extension's panel (atmos.panel.show()); false if it has none. Not while `record` runs a command "here". */
function _showPanel(extension, record = null) {
  const panel = extension?.frame?.contributions?.find(item => item.surface === 'panel');
  if (!panel || !isPanelPluginRegistered(panel.id)) return false;
  if (!(record && _panelHolds.get(record))) activatePanelPlugin(panel.id);
  return true;
}

/** Show an extension's panel for the command bar (Shift+Enter, once the command is done and the bar closed). */
export function showExtensionPanel(ref) {
  const extension = _framed.get(ref);
  return extension ? _showPanel(extension) : false;
}

/** Whether an extension has a panel to go to (the command bar offers Shift+Enter for its commands). */
export function extensionHasPanel(ref) {
  return !!_framed.get(ref)?.frame?.contributions?.some(item => item.surface === 'panel');
}

/** The frame that runs or lists an extension's command: a panel or widget showing, else its background frame, else any. */
function _commandFrame(ref, name) {
  const records = [..._frames.get(ref) || []].filter(record => record.bridge && record.commands.has(name));
  const order = record => (_showing(record) ? (record.type === 'panel' ? 0 : record.type === 'sidebar' ? 1 : 2) : record.type === 'boot' ? 2 : 3);
  return records.sort((a, b) => order(a) - order(b))[0] || null;
}

/**
 * Run one of an extension's commands as the command bar's key said. With
 * `go` false (Alt+Enter), the frame running it can't show its panel while
 * it runs; true (Shift+Enter) the bar shows the panel itself once it's done
 * (showExtensionPanel). The command hears `go` either way; left out, a
 * plain Enter.
 */
export async function runExtensionCommand(ref, name, input, { go } = {}) {
  const record = go === false ? _commandFrame(ref, name) : null;
  if (record) _panelHolds.set(record, (_panelHolds.get(record) || 0) + 1);
  let late = false;
  try {
    return await requestExtensionCommand(ref, name, 'run', go === undefined ? input : { ...input, go });
  } catch (error) {
    late = error?.name === 'TimeoutError';
    throw error;
  } finally {
    if (record) {
      const release = () => {
        const left = (_panelHolds.get(record) || 1) - 1;
        if (left) _panelHolds.set(record, left); else _panelHolds.delete(record);
      };
      if (late) setTimeout(release, HOLD_AFTER_TIMEOUT_MS); else release();
    }
  }
}

/**
 * Ask the extension to run one of its commands, or what to list for it
 * ('run' | 'suggest'). The frame that handles it: a panel or widget
 * showing, else its background frame, else any. Rejects when none does
 * (the extension isn't running, or handles it only in a surface that's away).
 */
export function requestExtensionCommand(ref, name, action, input, { timeout = action === 'suggest' ? 2000 : 15000 } = {}) {
  const record = _commandFrame(ref, name);
  if (!record) {
    const what = _commandLabel(ref);
    return Promise.reject(new Error(_framed.has(ref) && !_stopped.has(ref) && !_incompatible.has(ref) ? `Open ${what} to use rev/${name}.` : `${what} isn't running.`));
  }
  if (action === 'suggest' && !record.commands.get(name)?.suggests) return Promise.resolve(null);
  return record.bridge.requestCommand(action, name, input, timeout);
}

/** For tests and diagnostics: the frames currently open, by extension. */
export function listExtensionFrames() {
  return [..._frames].map(([extensionKey, records]) => ({ extension: extensionKey, frames: records.size }));
}

/**
 * Runs framed extensions (third-party, and first-party with
 * "runtime": "frame") inside sandboxed iframes and plugs their surfaces
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

import { readSavedNamespace, registerStateNamespace, scheduleSave } from '../persist.js';
import { emit, on } from './events.js';
import { openMenu, closeOpenMenu, openMenuOwner } from './context-menu.js';
import {
  registerPanelPlugin, activatePanelPlugin, isPanelPluginRegistered,
  getActivePanelPluginId, getPreviousPanelPluginId, activatePreviousPanelPlugin, activateDefaultPanelPlugin,
} from './panel-registry.js';
import { registerSection } from './sidebar-registry.js';
import { registerSettingsPanel } from './settings-registry.js';
import { registerBootHook } from './boot-registry.js';
import { onAppearanceChange, appearanceState, getAppFont } from './appearance.js';
import { onSemanticColorChange } from './semantic-colors.js';
import { checkExtensionCompatibility } from './capabilities.js';
import { getCapability } from './renderer-capabilities.js';
import { createExtensionBridge } from './extension-bridge.js';
import { armFileDrop, disarmFileDrop } from './extension-drop-overlay.js';
import { createPanelDrawer } from './panel-drawer.js';
import { panelState } from './panel-state.js';

// allow-popups: a link a frame opens in a new window (target="_blank") goes
// to Atmos's window-open handler, which never opens a window: it hands
// http(s) and mailto links to the system browser and drops the rest.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';
const APPEARANCE_VARS = [
  '--ink-rgb', '--surface-rgb', '--app-font-family',
  '--color-positive', '--color-negative', '--color-neutral',
  '--shell-blur', '--shell-opacity', '--default-panel-blur', '--default-panel-opacity',
];
const BOOT_TIMEOUT_MS = 10000;

const _states = new Map();   // "kind:id" -> state namespace object
const _frames = new Map();   // "kind:id" -> Set<frame record>
const SERVICE_WAIT_MS = 15000;
const _exposed = new Map();        // "kind:id" -> { methods, call, owner }
const _serviceWaiters = new Map(); // "kind:id" -> [resolve]
const _withBootFrame = new Set();  // "kind:id" of framed extensions that have a boot.js
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
// Keys that open a framed panel ("shortcut"); typing them never goes to a drawer.
const _panelShortcuts = new Set();

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
export function sanitizeMenuIcon(markup) {
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
 * choose(); a control (toggle, range, number, select, colours) calls
 * change(value) on every change. A ticked row gets a tick icon, or in a
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

function _stateFor(extension) {
  const k = key(extension);
  if (!_states.has(k)) {
    // Same namespace id an in-page extension would use, so state survives a
    // move between runtimes; a clash between a plugin and a service with
    // the same id falls back to a kind-qualified name.
    let namespace;
    try { namespace = registerStateNamespace(extension.id, { defaults: {} }); }
    catch { namespace = registerStateNamespace(`${extension.kind}-${extension.id}`, { defaults: {} }); }
    _states.set(k, namespace);
  }
  return _states.get(k);
}

const _deps = {
  state: {
    get: extension => structuredClone({ ..._stateFor(extension) }),
    set(extension, value, from) {
      const namespace = _stateFor(extension);
      for (const name of Object.keys(namespace)) delete namespace[name];
      Object.assign(namespace, value);
      scheduleSave();
      _broadcast(key(extension), 'state', structuredClone(value), from);
    },
  },
  events: { emit, on },
  appearance: _appearance,
  appFontData: _appFontData,
  wallpaper: {
    async set(file) {
      const wallpaper = getCapability('visual.wallpaper');
      if (!wallpaper?.setWallpaper) throw new Error('the Wallpaper service is not running');
      const named = file instanceof File ? file : new File([file], 'wallpaper', { type: file.type });
      await wallpaper.setWallpaper(named);
    },
    get: _wallpaperSummary,
    /** Calls fn with the summary now and whenever the image or mode changes. */
    subscribe(fn) {
      const wallpaper = getCapability('visual.wallpaper');
      if (!wallpaper?.subscribe) return () => {};
      let last = '';
      let alive = true;
      const off = wallpaper.subscribe(state => {
        const signature = `${state.mode}|${state.opacity}|${state.image}`;
        if (signature === last) return;
        last = signature;
        _wallpaperSummary().then(summary => { if (alive && signature === last) fn(summary); });
      });
      return () => { alive = false; off?.(); };
    },
  },
  invokeMain: (kind, id, channel, ...args) => window.atmos.extensionInvoke(kind, id, channel, ...args),
  onMain: (kind, id, channel, fn) => window.atmos.extensionOn(kind, id, channel, fn),
  services: _services,
  awaitService: _awaitService,
  libraryBase: id => _libraryBases.get(id) || null,
  closeMenus: () => closeOpenMenu(),
  showPanel(extension) {
    const panel = extension.frame.contributions.find(item => item.surface === 'panel');
    if (!panel || !isPanelPluginRegistered(panel.id)) return false;
    activatePanelPlugin(panel.id);
    return true;
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

/**
 * What a frame may know about the wallpaper: its mode and a small copy of
 * the image (the page's own blob: URL means nothing inside a frame).
 */
async function _wallpaperSummary() {
  const wallpaper = getCapability('visual.wallpaper');
  if (!wallpaper) return null;
  const state = wallpaper.getState();
  return {
    mode: state.mode,
    opacity: state.opacity,
    thumbnail: await wallpaper.getThumbnail?.(320) ?? null,
  };
}

// Audio channels whose changes are already being sent to the owner's frames.
const _audioWatched = new Set();

function _audioChannel(extension) {
  const audio = getCapability('media.audio');
  if (!audio) throw new Error('the Audio service is not running');
  return audio.channel(key(extension));
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
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('allow', allow);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = `${surface.label || extension.id}`;
  iframe.dataset.extension = key(extension);
  if (hidden) iframe.setAttribute('aria-hidden', 'true');
  iframe.src = `${origin}/__atmos/frame.html?ext=${encodeURIComponent(key(extension))}&surface=${surface.type}`;

  const record = { iframe, bridge: null, port: null, presentation, menuItems: [], drawer };
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  const deps = {
    ..._deps,
    // Only a frame the user is interacting with may drive Atmos's UI.
    dispatchKey(init) {
      if (document.activeElement === iframe) _dispatchKey(init);
    },
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
      watch() {
        const k = key(extension);
        if (_audioWatched.has(k)) return;
        _audioChannel(extension).subscribe(value => _broadcast(k, 'audio', value));
        _audioWatched.add(k);
      },
    },
    setSurfaceMenu(items) { record.menuItems = items; },
    notify(options) {
      if (!window.atmosCore?.showExtensionNotification) return Promise.resolve(false);
      return window.atmosCore.showExtensionNotification(extension.kind, extension.id, options);
    },
    armFileDrop() {
      if (!surface.fileDrops) return;
      armFileDrop(iframe, (topic, payload) => record.bridge?.post({ topic, payload }));
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
    // A (re)loaded document gets a fresh port; the previous one is dropped.
    record.bridge?.dispose();
    record.port?.close();
    const channel = new MessageChannel();
    record.port = channel.port1;
    record.bridge = createExtensionBridge({
      extension,
      surface: { type: surface.type, fileDrops: surface.fileDrops === true, drawer: !!surface.drawer, glass: surface.type === 'panel' && !!surface.glass },
      post: message => channel.port1.postMessage(message),
      deps,
    });
    channel.port1.onmessage = messageEvent => record.bridge.receive(messageEvent.data);
    iframe.contentWindow.postMessage({
      type: 'atmos:connect',
      init: {
        sdkVersion: 3,
        extension: { id: extension.id, kind: extension.kind, tier: extension.tier },
        surface: {
          type: surface.type, id: surface.id, presentation: record.presentation, fileDrops: surface.fileDrops === true,
          glass: surface.type === 'panel' && !!surface.glass,
          drawer: surface.drawer ? { bar: surface.drawer.bar, ...(drawer ? drawer.state() : _pinnedDrawerState(surface)) } : null,
        },
        entry: `${base}${surface.entry}`,
        appearance: _appearance(),
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
    dispose() {
      disarmFileDrop(iframe);
      containerWatch?.disconnect();
      stopPanelVars?.();
      window.removeEventListener('message', onMessage);
      record.bridge?.dispose();
      record.port?.close();
      _frames.get(key(extension))?.delete(record);
      iframe.remove();
      if (glassLayer) {
        glassLayer.remove();
        container.classList.remove('atmos-frame-glass-host');
      }
    },
  };
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
    if (event.target?.closest?.('#settings-drawer, .ctx-menu-surface, .panel-host-controls')) return;
    physics.wheel(event.deltaY, event.deltaMode);
  };
  // Escape arms, a second Escape within two seconds closes. With
  // "keys": true, characters typed on the workspace while the drawer is open
  // go to the frame (Audio Player's type-to-search), which takes focus.
  const onKeydown = event => {
    if (event.defaultPrevented || !physics.isOpen) return;
    // An Escape that closes an Atmos menu is only that. (Listening in the
    // capture phase sees the menu before its own Escape handler closes it.)
    if (document.querySelector('body > .ctx-menu-surface:not(#ctx-menu), #ctx-menu.visible')) return;
    if (event.key === 'Escape') {
      if (drawerEl.classList.contains('pending-close')) commands.close();
      else setPending(true);
      return;
    }
    if (!surface.drawer.keys || event.isTrusted === false) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || !event.key.trim()) return;
    if (_panelShortcuts.has(event.key) || _isTyping(event.target)) return;
    if (document.activeElement?.tagName === 'IFRAME') return;
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
      // A drawer covers only part of the workspace; clicks and scrolls
      // elsewhere reach the wallpaper underneath. Its glass follows the
      // panel's own blur and opacity (Glass in Settings → Appearance).
      passThrough: !!surface.drawer,
      // A panel with Core-drawn glass ("glass": true) follows them too.
      panelAppearance: !!surface.drawer || !!surface.glass,
      mount(surfaceEl, context) {
        const presentation = context?.presentation ?? null;
        if (surface.drawer && presentation === 'full') {
          context?.onCleanup?.(_mountDrawer(extension, surface, surfaceEl));
          return;
        }
        const frame = _createFrame(extension, { ...surface, type: 'panel' }, surfaceEl, { presentation });
        context?.onCleanup?.(frame.dispose);
      },
    });
    if (surface.shortcut) {
      _panelShortcuts.add(surface.shortcut);
      // Keys typed inside a frame never reach this document, so a frame
      // can't have typed it into a field of its own.
      document.addEventListener('keydown', event => {
        if (event.key !== surface.shortcut || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
        const target = event.target;
        if (target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
        if (!isPanelPluginRegistered(surface.id)) return;
        if (surface.shortcutToggles && getActivePanelPluginId() === surface.id) {
          if (getPreviousPanelPluginId()) activatePreviousPanelPlugin();
          else activateDefaultPanelPlugin();
        } else {
          activatePanelPlugin(surface.id);
        }
      });
    }
  } else if (surface.surface === 'sidebar') {
    const mounted = new Map();
    registerSection(surface.id, {
      label: surface.label,
      icon: icon || '',
      order: surface.order,
      defaultEnabled: surface.defaultEnabled,
      ...(surface.defaultHeight ? { defaultHeight: surface.defaultHeight } : {}),
      ...(surface.resizable === false ? { resizable: false } : {}),
      ...(Array.isArray(surface.showIn) && surface.showIn.length ? { showIn: surface.showIn } : {}),
      contextMenuItems: () => [...mounted.values()].at(-1)?.menuItems() ?? [],
      mount(bodyEl) {
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
        const frame = _createFrame(extension, { ...surface, type: 'settings' }, bodyEl);
        context?.onCleanup?.(frame.dispose);
      },
    });
  } else if (surface.surface === 'boot') {
    _withBootFrame.add(key(extension));
    registerBootHook(`${extension.kind}:${extension.id}`, {
      order: surface.order,
      async run() {
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
  _libraryBases = new Map(services.filter(service => service.libraryBase).map(service => [service.id, service.libraryBase]));
  const framed = [
    ...services.map(service => ({ ...service, kind: 'service' })),
    ...plugins.map(plugin => ({ ...plugin, kind: 'plugin' })),
  ].filter(extension => extension.runtime === 'frame'
    && extension.active !== false && extension.enabled !== false && extension.frame);
  for (const extension of framed) {
    const compatibility = checkExtensionCompatibility(extension.manifest || {}, `${extension.kind} '${extension.id}'`);
    if (!compatibility.compatible) {
      console.warn(`[extension-frames] '${extension.id}' skipped: ${compatibility.reasons.join('; ')}`);
      continue;
    }
    for (const surface of extension.frame.contributions) {
      try { _registerContribution(extension, surface); }
      catch (error) { console.error(`[extension-frames] ${extension.kind} '${extension.id}' ${surface.surface} failed to register:`, error); }
    }
  }
  return framed.length;
}

/** For tests and diagnostics: the frames currently open, by extension. */
export function listExtensionFrames() {
  return [..._frames].map(([extensionKey, records]) => ({ extension: extensionKey, frames: records.size }));
}

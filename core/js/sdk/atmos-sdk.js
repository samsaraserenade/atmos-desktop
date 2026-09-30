/**
 * Atmos SDK 1.2 — the only way a framed extension talks to Atmos.
 *
 *   import atmos from 'atmos-sdk';
 *
 *   document.body.textContent = `Hello from ${atmos.extension.id}`;
 *   const saved = await atmos.state.get();
 *   await atmos.state.update({ visits: (saved.visits ?? 0) + 1 });
 *
 * Every call goes through a message port to Atmos Core, which checks it
 * against the permissions in the extension's extension.json. The frame has
 * no other route to Atmos: it cannot see the Atmos page, other extensions'
 * frames or Electron. See ATMOS_CORE_INTEGRATION.md, section 4, and the
 * typings beside this file (atmos-sdk.d.ts).
 *
 * What SDK 1.x promises (semver: a later 1.x only adds):
 *
 *   stable        extension, surface (type, id, presentation, setMenu,
 *                 setGlass, trackGlass), state, events, appearance,
 *                 contextMenu, clipboard, panel, invoke, listen, call,
 *                 expose, library, wallpaper, audio, fetch, location,
 *                 lifecycle, ready, SDK_VERSION
 *   experimental  notifications (not yet seen working on Windows)
 *   first-party   drawer, surface.onKey, background(), legacy.*, web — for
 *                 official extensions; Atmos refuses them to community
 *                 ones, and they may change in a minor version
 *
 * The SDK itself is MIT-licensed (LICENSE beside this file).
 */

export const SDK_VERSION = '1.2.0';

let port = null;
let nextId = 1;
let init = null;
const queue = [];
const pending = new Map();
const topics = new Map();       // topic -> Set<fn>
let exposed = null;             // methods offered by a service's boot frame
let menuActions = new Map();    // the open context menu's item id -> run()
const headerActions = new Map(); // sidebar header menu item id -> run()

let resolveReady;
/** Resolves once the frame is connected to Atmos. Entry files run after it. */
export const ready = new Promise(resolve => { resolveReady = resolve; });

function send(message) {
  if (port) port.postMessage(message);
  else queue.push(message);
}

/** A request Atmos answers. */
function ask(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, args });
  });
}

/** A message Atmos doesn't answer. */
function notify(method, ...args) {
  send({ method, args });
}

function subscribe(topic, fn) {
  if (typeof fn !== 'function') throw new TypeError('atmos: listener must be a function');
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic).add(fn);
  return () => topics.get(topic)?.delete(fn);
}

function publish(topic, payload) {
  for (const fn of [...(topics.get(topic) || [])]) {
    try { fn(payload); } catch (error) { console.error(`[atmos-sdk] ${topic} listener failed:`, error); }
  }
}

function toError(error) {
  const name = error?.name;
  const message = error?.message || 'Atmos request failed';
  if (name === 'AbortError' || name === 'TimeoutError') return new DOMException(message, name);
  const out = name === 'TypeError' ? new TypeError(message) : name === 'RangeError' ? new RangeError(message) : new Error(message);
  if (name) out.name = name;
  return out;
}

async function answerCall(message) {
  try {
    const method = exposed && Object.hasOwn(exposed, message.method) ? exposed[message.method] : null;
    if (typeof method !== 'function') throw new Error(`'${message.method}' is not exposed`);
    send({ callReply: message.call, result: await method(...(message.args || [])) });
  } catch (error) {
    send({ callReply: message.call, error: { name: error?.name, message: error?.message } });
  }
}

function onMessage(event) {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.reply !== undefined) {
    const call = pending.get(message.reply);
    pending.delete(message.reply);
    if (!call) return;
    if (message.error) call.reject(toError(message.error));
    else call.resolve(message.result);
  } else if (message.call !== undefined) {
    answerCall(message);
  } else if (message.topic) {
    if (message.topic === 'appearance') applyAppearance(message.payload);
    if (message.topic === 'measure') { measureSize?.(); return; }
    if (message.topic === 'drawerVisible') { setDrawerVisible(message.payload); return; }
    if (message.topic === 'drawer') drawerState = Object.freeze({ ...drawerState, ...message.payload });
    if (message.topic === 'surfaceMenu') {
      const { id, value, isSelect } = menuChoice(message.payload);
      try { isSelect ? headerActions.get(id)?.(value) : headerActions.get(id)?.(); } catch (error) { console.error('[atmos-sdk] header menu action failed:', error); }
    }
    if (message.topic === 'menu') {
      // A plain row once; a control (toggle, range…) on every change while
      // the menu stays open. The actions are dropped when the menu closes.
      const { id, value, isSelect } = menuChoice(message.payload);
      const run = menuActions.get(id);
      try { isSelect ? run?.(value) : run?.(); } catch (error) { console.error('[atmos-sdk] menu action failed:', error); }
    }
    publish(message.topic, message.payload);
  }
}

/** A menu choice: an item's id, or { id, value } from a select row. */
function menuChoice(payload) {
  return payload && typeof payload === 'object'
    ? { id: payload.id, value: payload.value, isSelect: true }
    : { id: payload, isSelect: false };
}

/** What an Atmos menu item may carry across to Core: plain data only. */
function plainMenuItem(item, index, actions) {
  const id = item.id ?? `item-${index}`;
  if (typeof item.run === 'function') actions.set(id, item.run);
  const plain = { id, label: item.label, type: item.type };
  if (typeof item.icon === 'string') plain.icon = item.icon;
  if (typeof item.checked === 'boolean') plain.checked = item.checked;
  if (typeof item.closeOnChange === 'boolean') plain.closeOnChange = item.closeOnChange;
  if (item.hold === true) plain.hold = true;
  if (item.tone === 'danger') plain.tone = 'danger';
  if (item.type === 'select') {
    plain.value = item.value;
    plain.options = (item.options || []).map(option => ({ value: option.value, label: option.label }));
  }
  if (item.type === 'range' || item.type === 'number') {
    for (const name of ['min', 'max', 'step', 'value', 'suffix', 'zeroLabel']) {
      if (item[name] !== undefined) plain[name] = item[name];
    }
  }
  if (item.type === 'text') {
    plain.value = String(item.value ?? '');
    if (typeof item.placeholder === 'string') plain.placeholder = item.placeholder;
    if (Number.isFinite(item.maxLength)) plain.maxLength = item.maxLength;
  }
  if (item.type === 'colors') plain.values = [...(item.values || [])];
  if (item.type === 'buttons') {
    plain.buttons = (item.buttons || []).map((button, buttonIndex) => {
      const buttonId = button.id ?? `${id}-${buttonIndex}`;
      if (typeof button.run === 'function') actions.set(buttonId, button.run);
      const out = { id: buttonId, label: button.label };
      if (typeof button.icon === 'string') out.icon = button.icon;
      if (typeof button.title === 'string') out.title = button.title;
      return out;
    });
  }
  return plain;
}

function applyAppearance(appearance) {
  if (!appearance) return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(appearance.vars || {})) {
    if (/^--[a-z0-9-]+$/.test(name)) root.style.setProperty(name, String(value));
  }
  if (appearance.theme) root.dataset.appTheme = appearance.theme;
  if (appearance.colorScheme) root.style.colorScheme = appearance.colorScheme;
  if ('font' in appearance) loadAppFont(appearance.font);
}

// A font the user imported in Appearance: --app-font-family names it, but
// this document has to register the font itself.
let appFontId = null;
let appFontFace = null;
function loadAppFont(font) {
  const id = font?.id ?? null;
  if (id === appFontId) return;
  appFontId = id;
  if (appFontFace) { document.fonts.delete(appFontFace); appFontFace = null; }
  if (!id || typeof font.family !== 'string') return;
  ask('appearance.fontData', id).then(dataUrl => {
    if (appFontId !== id || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return;
    const face = new FontFace(font.family, `url(${dataUrl})`);
    appFontFace = face;
    document.fonts.add(face);
    return face.load();
  }).catch(error => console.warn('[atmos-sdk] could not load the app font:', error.message));
}

let measureSize = null; // Core asks again when the frame's container changes

/** Whether the body has something visible in it (for the 0 px warning). */
function hasVisibleContent() {
  for (const element of document.body.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

function watchSize(type) {
  let last = -1;
  let queued = false;
  let warned = false;
  let warnTimer = null;
  const report = () => {
    queued = false;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== last) { last = height; notify('surface.resize', height); }
    // A frame measured at 0 px with something in it is invisible (all of
    // it positioned out of the flow, say). Say so once, after it settles.
    clearTimeout(warnTimer);
    if (height === 0 && !warned) {
      warnTimer = setTimeout(() => {
        if (warned || Math.ceil(document.body.getBoundingClientRect().height) !== 0 || !hasVisibleContent()) return;
        warned = true;
        console.warn(`[atmos-sdk] This ${type === 'settings' ? 'settings page' : 'widget'} measures 0 px tall, so Atmos shows nothing of it. `
          + 'Its height is the height of <body>\'s content; content that is position: absolute or fixed, or floated, doesn\'t count. '
          + 'See ATMOS_CORE_INTEGRATION.md § 2, "Files and surfaces".');
      }, 1000);
    }
  };
  // Chromium stops rendering a frame it considers hidden (a collapsed
  // sidebar section, the closed sidebar), and ResizeObserver waits for
  // rendering. DOM changes, loads and Core's requests still arrive, and
  // measuring forces layout, so those keep the height current meanwhile.
  const soon = () => { if (!queued) { queued = true; queueMicrotask(report); } };
  new ResizeObserver(report).observe(document.body);
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  document.addEventListener('load', soon, true);
  document.fonts?.addEventListener?.('loadingdone', soon);
  measureSize = report;
  report();
}

function forwardKeys() {
  // Keys pressed inside a frame never reach Atmos's own shortcuts; pass on
  // the ones that aren't typing. Listening on window runs after the
  // extension's own document listeners, so a key it handled
  // (preventDefault) stays its own.
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const typing = event.target?.closest?.('input, textarea, select, [contenteditable]');
    const control = event.target?.closest?.('button, a[href], [role="button"], summary');
    const shortcut = event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key);
    // Space outside fields and buttons can be a global key (Audio Player's play/pause).
    const space = event.code === 'Space' && !typing && !control;
    // Atmos's single-key shortcuts (Tab for the sidebar, panel shortcuts
    // such as "]"), outside fields and buttons, where Tab moves focus.
    const atmosKey = !typing && !control && (init?.shortcutKeys || []).includes(event.key);
    if (atmosKey) event.preventDefault();
    if (!(shortcut || space || atmosKey || (event.key === 'Escape' && !typing))) return;
    notify('ui.key', {
      key: event.key, code: event.code,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    });
  });
  // Atmos closes its menus when the pointer is used elsewhere.
  document.addEventListener('pointerdown', () => notify('ui.pointerdown'), true);
}

// ── Drawer panels ────────────────────────────────────────────────────────────
let drawerState = null;

function setDrawerVisible(px) {
  if (Number.isFinite(px)) document.documentElement.style.setProperty('--atmos-drawer-visible-h', `${Math.max(0, px)}px`);
}

function armDrawer() {
  // Wheel and swipes outside the frame's own scrolling areas move the
  // drawer, as they do on the workspace around it.
  const scrolls = target => target?.closest?.('[data-atmos-drawer-scroll]');
  document.addEventListener('wheel', event => {
    if (event.ctrlKey || drawerState?.locked || scrolls(event.target)) return;
    notify('drawer.wheel', event.deltaY, event.deltaMode);
  }, { passive: true });
  let touchY = null;
  document.addEventListener('touchstart', event => {
    touchY = scrolls(event.target) ? null : event.touches[0]?.clientY ?? null;
  }, { passive: true });
  document.addEventListener('touchend', event => {
    if (touchY === null || drawerState?.locked) return;
    const dy = touchY - (event.changedTouches[0]?.clientY ?? touchY);
    touchY = null;
    if (dy > 20) drawer.expand();
    else if (dy < -20) drawer.collapse();
  }, { passive: true });
}

/** Internal: called by /__atmos/frame.js before the entry file loads. */
export function __connect() {
  return new Promise(resolve => {
    window.addEventListener('message', function connect(event) {
      if (event.source !== window.parent || event.data?.type !== 'atmos:connect' || !event.ports?.[0]) return;
      window.removeEventListener('message', connect);
      port = event.ports[0];
      port.onmessage = onMessage;
      init = event.data.init;
      Object.assign(extension, init.extension);
      Object.freeze(extension);
      Object.assign(surface, init.surface);
      document.documentElement.dataset.atmosSurface = surface.type;
      applyAppearance(init.appearance);
      for (const message of queue.splice(0)) port.postMessage(message);
      if (surface.type === 'boot') {
        // Lets this extension's own views find this frame (see background()).
        Object.defineProperty(window, '__atmosBackground', { value: `${extension.kind}:${extension.id}` });
      }
      if (surface.type === 'sidebar' || surface.type === 'settings') watchSize(surface.type);
      forwardKeys();
      if (surface.drawer) {
        drawerState = Object.freeze({ ...surface.drawer });
        if (!drawerState.locked) { armDrawer(); setDrawerVisible(drawerState.visible); }
      }
      resolveReady(init);
      resolve(init);
    });
    // Tell Core this frame is listening; it replies with a private port.
    window.parent.postMessage({ type: 'atmos:frame-ready' }, '*');
  });
}

// ── Stable ───────────────────────────────────────────────────────────────────

/** Which extension this frame belongs to: { id, kind, tier, version }. */
export const extension = {};

/**
 * This frame's surface: { type: 'panel'|'sidebar'|'settings'|'boot', id,
 * presentation: 'full'|'tile'|'window'|null, glass, drawer }. A layout
 * change recreates the frame, so `presentation` is fixed for its lifetime.
 */
export const surface = {
  /**
   * Sidebar widgets: the items Atmos adds to this widget's header menu
   * (right-click on its title); same item shapes as contextMenu.open().
   * Call again whenever they change (a `checked` flag, say).
   */
  setMenu(items) {
    headerActions.clear();
    return ask('surface.setMenu', (items || []).map((item, index) => plainMenuItem(item, index, headerActions)));
  },
  /**
   * Panels declaring "glass": true — Core draws the frosted material under
   * the frame (a frame's own backdrop-filter can't blur the wallpaper).
   * regions: [{ x, y, width, height, material: 'panel'|'shell', radius }]
   * in this frame's pixels. Leave those areas transparent in the frame.
   */
  setGlass: regions => ask('surface.setGlass', regions),
  /**
   * The same, kept up to date for you: every element with a
   * data-atmos-glass="panel|shell" attribute (optionally
   * data-atmos-glass-inset="top right bottom left", in px, and its CSS
   * border-radius) becomes a region, re-measured whenever the page's
   * layout changes. Returns a function that stops tracking.
   */
  trackGlass() {
    let queued = false;
    let last = '';
    const measure = () => {
      queued = false;
      const regions = [];
      for (const element of document.querySelectorAll('[data-atmos-glass]')) {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || !element.isConnected) continue;
        const [top = 0, right = 0, bottom = 0, left = 0] = (element.dataset.atmosGlassInset || '')
          .split(/\s+/).filter(Boolean).map(Number).map(value => (Number.isFinite(value) ? value : 0));
        regions.push({
          x: rect.left + left, y: rect.top + top,
          width: rect.width - left - right, height: rect.height - top - bottom,
          material: element.dataset.atmosGlass === 'shell' ? 'shell' : 'panel',
          radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
        });
      }
      const next = JSON.stringify(regions);
      if (next === last) return;
      last = next;
      ask('surface.setGlass', regions).catch(error => console.warn('[atmos] setGlass:', error.message));
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(queue);
    const observed = new Set();
    const watch = () => {
      for (const element of document.querySelectorAll('[data-atmos-glass]')) {
        if (!observed.has(element)) { observed.add(element); resize.observe(element); }
      }
      for (const element of observed) if (!element.isConnected) { observed.delete(element); resize.unobserve(element); }
    };
    const mutations = new MutationObserver(() => { watch(); queue(); });
    mutations.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['data-atmos-glass', 'data-atmos-glass-inset', 'class', 'hidden'],
    });
    window.addEventListener('resize', queue);
    document.addEventListener('scroll', queue, true);
    watch();
    queue();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', queue);
      document.removeEventListener('scroll', queue, true);
      ask('surface.setGlass', []).catch(() => {});
    };
  },
  /**
   * First-party. Boot frames: a key declared on the boot contribution
   * ("keys": ["Space"]) was pressed: fn({ code }).
   */
  onKey: fn => subscribe('key', fn),
};

/**
 * Persisted state for this extension, shared by all of its frames and saved
 * in a file of its own. Keep it small (under 1 MB); use IndexedDB in the
 * frame for larger data.
 */
export const state = Object.freeze({
  get: () => ask('state.get'),
  set: value => ask('state.set', value),
  update: patch => ask('state.update', patch),
  onChange: fn => subscribe('state', fn),
});

/**
 * Events. Plain names are this extension's own (`<id>:<name>` for others);
 * listening to another extension's events requires declaring it in
 * "invokes", and it sharing them ("exports.events"). Emitting is only
 * possible in the extension's own namespace.
 */
export const events = Object.freeze({
  emit: (name, payload) => ask('events.emit', name, payload),
  on(name, fn) {
    const unsubscribe = subscribe(`event:${name}`, fn);
    const subscribed = ask('events.subscribe', name);
    subscribed.catch(error => { unsubscribe(); console.error(`[atmos-sdk] cannot listen to '${name}':`, error.message); });
    return () => { unsubscribe(); notify('events.unsubscribe', name); };
  },
});

/** Current theme: { theme, colorScheme, vars, font }. Frames are themed automatically. */
export const appearance = Object.freeze({
  get: () => ask('appearance.get'),
  onChange: fn => subscribe('appearance', fn),
});

/**
 * Show an Atmos context menu at frame coordinates. Items are
 *   { id, label, run?, checked?, hold?, tone?, icon? }   a row
 *   { id, label, type: 'select', value, options: [{ value, label }], run(value) }
 *   { type: 'toggle' | 'range' | 'number' | 'text' | 'colors', …, run(value) }
 *   { type: 'buttons', buttons: [{ id, label, icon?, title?, run }] }
 *   { type: 'separator' | 'heading' | 'meta', label? }
 * Resolves with the chosen id ({ id, value } for a control), or null when
 * dismissed.
 */
export const contextMenu = Object.freeze({
  async open(x, y, items) {
    // Each menu has its own actions: a menu closing later must not drop
    // the actions of one opened since.
    const actions = new Map();
    menuActions = actions;
    try {
      return await ask('contextMenu.open', x, y, (items || []).map((item, index) => plainMenuItem(item, index, actions)));
    } finally {
      actions.clear();
    }
  },
  /** Close the menu this frame has open, if any (when what it points at scrolls away, say). */
  close: () => ask('contextMenu.close'),
});

/**
 * The clipboard. A frame that has focus can use navigator.clipboard itself;
 * an action chosen from an Atmos menu (contextMenu.open, setMenu) runs
 * while the Atmos page has focus, so copy through here instead.
 */
export const clipboard = Object.freeze({
  writeText: text => ask('clipboard.write', { text: String(text) }),
  /** A PNG Blob, optionally with plain text beside it. */
  writeImage: (png, text) => ask('clipboard.write', text == null ? { image: png } : { image: png, text: String(text) }),
});

/** This extension's panel. */
export const panel = Object.freeze({
  show: () => ask('panel.show'),
});

/** Call another extension's main-process IPC handler: invoke('service:x', 'channel', ...args). */
export function invoke(target, channel, ...args) {
  return ask('invoke', target, channel, ...args);
}

/**
 * Listen to events a main.cjs sends with context.send(target, channel, ...):
 * listen('plugin:<own id>', 'channel', (...args) => {}). Another extension's
 * events need it in "permissions.invokes". Returns an unsubscribe function.
 */
export function listen(target, channel, fn) {
  if (typeof fn !== 'function') throw new TypeError('atmos.listen: listener must be a function');
  const key = `${target} ${channel}`;
  const deliver = args => fn(...(Array.isArray(args) ? args : []));
  const unsubscribe = subscribe(`main:${key}`, deliver);
  ask('main.subscribe', target, channel).catch(error => {
    unsubscribe();
    console.error(`[atmos-sdk] cannot listen to ${target} '${channel}':`, error.message);
  });
  return () => {
    unsubscribe();
    if (!topics.get(`main:${key}`)?.size) notify('main.unsubscribe', target, channel);
  };
}

/** Call a method a service exposes from its boot frame: call('service:x', 'method', ...args). */
export function call(target, method, ...args) {
  return ask('call', target, method, ...args);
}

/**
 * From boot.js: offer methods to call(). The extension's own panel and
 * widgets can always call them ('plugin:<own id>'); other extensions need
 * the target in "permissions.invokes", and the method in "exports.methods".
 */
export function expose(methods) {
  if (!methods || typeof methods !== 'object') throw new TypeError('atmos.expose: methods must be an object');
  exposed = methods;
  return ask('services.expose', Object.keys(methods).filter(name => typeof methods[name] === 'function'));
}

/** URL of a library service's module, for import(): await import(await library('service:plotting', 'index.js')). */
export function library(target, file) {
  return ask('library.url', target, file);
}

/**
 * The background layer's Wallpaper service. Needs "invokes": ["service:wallpaper"].
 *   set(file)      an image File/Blob becomes Atmos's wallpaper; Atmos keeps
 *                  the one it replaced, and Settings says whose it is
 *   restore()      put back the one this extension's image replaced;
 *                  resolves false when the image showing isn't its own
 *   get()          { mode, opacity, thumbnail, canRestore }: thumbnail is a
 *                  small JPEG data URL of the current image (null when there
 *                  is none); canRestore, whether restore() would do anything
 *   onChange(fn)   the same, whenever the image or mode changes
 */
export const wallpaper = Object.freeze({
  set: file => ask('wallpaper.set', file),
  restore: () => ask('wallpaper.restore'),
  get: () => ask('wallpaper.get'),
  onChange(fn) {
    const unsubscribe = subscribe('wallpaper', fn);
    ask('wallpaper.subscribe').catch(error => { unsubscribe(); console.error('[atmos-sdk] cannot follow the wallpaper:', error.message); });
    return unsubscribe;
  },
});

/**
 * The background layer's Audio service: this extension's own playback
 * channel, living in Atmos for the whole session (it keeps playing whatever
 * frames come and go). Needs "invokes": ["service:audio"].
 *
 *   load(source, { id, position, play, loop })  source: a Blob/File, or an
 *        atmos-resource:// URL from a provider the extension registers;
 *        id: your own label for it (a track key), reported back as `id`;
 *        loop: start over at the end, without a gap and without 'ended'
 *   play() pause() seek(seconds) setVolume(0–1) stop()
 *   state()       { type, id, source, loop, playing, currentTime, duration,
 *                 volume, ended, error } (source: the same label as id, its
 *                 name before SDK 1.1)
 *   onChange(fn)  the same on every change, in every frame of the extension
 *                 (type: source, loaded, play, pause, time, ended, volume, error)
 */
export const audio = Object.freeze({
  load: (source, options) => ask('audio.load', source, options),
  play: () => ask('audio.play'),
  pause: () => ask('audio.pause'),
  seek: seconds => ask('audio.seek', seconds),
  setVolume: value => ask('audio.volume', value),
  stop: () => ask('audio.stop'),
  state: () => ask('audio.state'),
  onChange(fn) {
    const unsubscribe = subscribe('audio', fn);
    ask('audio.subscribe').catch(error => { unsubscribe(); console.error('[atmos-sdk] cannot follow audio:', error.message); });
    return unsubscribe;
  },
});

// ── atmos.fetch() ────────────────────────────────────────────────────────────
let nextFetch = 1;

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** The main process's answer as a Response, like fetch()'s own. */
function toResponse({ url, status, statusText, headers, body, redirected }) {
  const noBody = status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
  const clean = new Headers();
  for (const [name, value] of headers || []) {
    try { clean.append(name, value); } catch { /* not a header Response allows */ }
  }
  let response;
  try {
    response = new Response(noBody ? null : body, { status, statusText, headers: clean });
  } catch {
    response = new Response(noBody ? null : body, { status: status >= 200 && status <= 599 ? status : 502, headers: clean });
  }
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected === true } });
  return response;
}

/**
 * fetch(), made by Atmos for the frame: for APIs the frame can't read
 * itself because they send no CORS headers. Same arguments and result as
 * fetch(). Only https://, only hosts in "permissions.network", never a
 * private or local address; no cookies; 30 s, 5 MB up and 10 MB down per
 * request. Rejects with a TypeError for network failures (like fetch()),
 * an AtmosPermissionError for an undeclared host, and an AbortError when
 * `signal` aborts it.
 */
async function atmosFetch(input, init = undefined) {
  // Request does what fetch() does with its arguments: resolves the URL,
  // checks the method, and turns the body into bytes with a content type.
  const request = new Request(input, init);
  const signal = request.signal;
  if (signal.aborted) throw abortReason(signal);
  const body = request.body === null ? null : await request.arrayBuffer();
  const id = nextFetch++;
  let stop = null;
  const aborted = new Promise((_, reject) => {
    stop = () => { notify('fetch.abort', id); reject(abortReason(signal)); };
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const result = await Promise.race([
      ask('fetch', { id, url: request.url, method: request.method, headers: [...request.headers], body, redirect: request.redirect }),
      aborted,
    ]);
    return toResponse(result);
  } finally {
    signal.removeEventListener('abort', stop);
    aborted.catch(() => {});
  }
}
export { atmosFetch as fetch };

// ── atmos.location ───────────────────────────────────────────────────────────
/**
 * The user's location as set in Atmos (Settings → Appearance → Location),
 * read-only. Needs "invokes": ["service:location"].
 *   get()          { lat, lon, label, mode } or null when none is set
 *   onChange(fn)   the same (or null) whenever the user changes it
 */
const locationApi = Object.freeze({
  get: () => ask('location.get'),
  onChange(fn) {
    const unsubscribe = subscribe('location', fn);
    ask('location.subscribe').catch(error => { unsubscribe(); console.error('[atmos-sdk] cannot follow the location:', error.message); });
    return unsubscribe;
  },
});
export { locationApi as location };

// ── atmos.lifecycle ──────────────────────────────────────────────────────────
// A frame lives exactly as long as its surface: Core removes it when the
// panel is switched away, the widget hidden, the layout changed. Anything it
// hands to something that outlives it (a listener on another frame's
// object, a timer in a shared worker, an open request) is cleaned up here.
const lifecycleController = new AbortController();
const lifecycleCleanups = new Set();
const lifecycleTimers = new Set();
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    if (lifecycleController.signal.aborted) return;
    lifecycleController.abort(new DOMException('The frame is going away.', 'AbortError'));
    for (const handle of lifecycleTimers) { clearTimeout(handle); clearInterval(handle); }
    lifecycleTimers.clear();
    for (const fn of [...lifecycleCleanups].reverse()) {
      try { fn(); } catch (error) { console.error('[atmos-sdk] cleanup failed:', error); }
    }
    lifecycleCleanups.clear();
  });
}

function onCleanup(fn) {
  if (typeof fn !== 'function') throw new TypeError('atmos.lifecycle.onCleanup: expected a function');
  if (lifecycleController.signal.aborted) { fn(); return () => {}; }
  const entry = () => fn();
  lifecycleCleanups.add(entry);
  return () => lifecycleCleanups.delete(entry);
}

/**
 * The frame's lifetime.
 *   signal                       aborts as the frame goes (pass it to
 *                                fetch(), addEventListener, your own work)
 *   onCleanup(fn)                run fn as the frame goes (last added runs
 *                                first); returns a function that cancels it
 *   listen(target, type, fn, options)
 *                                addEventListener, removed as the frame
 *                                goes; returns a function that removes it
 *   setTimeout / setInterval     cleared as the frame goes
 */
export const lifecycle = Object.freeze({
  signal: lifecycleController.signal,
  onCleanup,
  listen(target, type, fn, options = {}) {
    if (!target?.addEventListener) throw new TypeError('atmos.lifecycle.listen: target is not an EventTarget');
    const base = typeof options === 'boolean' ? { capture: options } : { ...options };
    const signal = base.signal ? AbortSignal.any([base.signal, lifecycleController.signal]) : lifecycleController.signal;
    target.addEventListener(type, fn, { ...base, signal });
    // Another realm's target (a background frame's object) may outlive this
    // frame's signal, so remove it explicitly too.
    const remove = onCleanup(() => target.removeEventListener(type, fn, base));
    return () => { remove(); target.removeEventListener(type, fn, base); };
  },
  setTimeout(fn, delay, ...args) {
    const handle = setTimeout((...values) => { lifecycleTimers.delete(handle); fn(...values); }, delay, ...args);
    lifecycleTimers.add(handle);
    return handle;
  },
  setInterval(fn, delay, ...args) {
    const handle = setInterval(fn, delay, ...args);
    lifecycleTimers.add(handle);
    return handle;
  },
});

// ── Experimental ─────────────────────────────────────────────────────────────

/**
 * System notifications (the Notification API doesn't work in frames).
 * Needs "notifications" in "permissions.browser". Experimental: not yet
 * seen working on Windows.
 *   show({ title, body?, tag?, silent? })  resolves true once shown, false
 *                                          where the system has none
 *   onClick(({ tag }) => ...)              the user clicked one of this
 *                                          extension's notifications; Atmos
 *                                          comes to the front first. Every
 *                                          frame of the extension hears it.
 */
export const notifications = Object.freeze({
  show: options => ask('notifications.show', options),
  onClick: fn => subscribe('notificationClick', fn),
});

// ── First-party ──────────────────────────────────────────────────────────────
// For official extensions. Atmos refuses them to community ones (a drawer and
// boot keys aren't given to them; background() and legacy.* are refused),
// and they may change in a minor version.

/**
 * A panel declared with "drawer": { "bar": 54 } lives in a drawer that
 * slides up from the bottom of the full workspace; Atmos moves it. The frame
 * lays out the bar (bar px high) at the top of its document, or at the
 * bottom when the bar is docked, and the browser in the rest. While the
 * drawer moves, --atmos-drawer-visible-h on :root is the visible height
 * of the browser.
 *
 * Wheel and swipes in the frame move the drawer, except over elements marked
 * data-atmos-drawer-scroll (which scroll themselves). Escape twice closes it.
 * With "keys": true, characters typed on the workspace while the drawer is
 * open arrive through onKey(fn({ key })) and the frame takes focus.
 * In a tile or floating window the drawer is pinned open (state.locked) and
 * the commands do nothing.
 *
 *   state        { open, expanded, placement, barPlacement, locked, bar }
 *                (pinned open, --atmos-drawer-visible-h is unset: use
 *                 var(--atmos-drawer-visible-h, calc(100vh - <bar>px)))
 *   onChange(fn) open/expanded/bar placement changes
 */
export const drawer = Object.freeze({
  get state() { return drawerState; },
  onChange: fn => subscribe('drawer', () => fn(drawerState)),
  onKey: fn => subscribe('drawerKey', fn),
  open: () => ask('drawer.command', 'open'),
  close: () => ask('drawer.command', 'close'),
  /** Raise fully open. */
  expand: () => ask('drawer.command', 'expand'),
  /** Back down to just the bar. */
  collapse: () => ask('drawer.command', 'collapse'),
  /** 'top' (bar leads the drawer) or 'bottom' (bar docked, browser revealed upward). */
  setBarPlacement: placement => ask('drawer.command', 'bar', placement),
  /** 0 = fully open, 1 = bar only, 2 = hidden. Atmos remembers it; for carrying over an old position. */
  setPlacement: placement => ask('drawer.command', 'placement', placement),
});

/**
 * One-off migration for first-party extensions that moved into a frame:
 * read a database they stored in the Atmos page, listed in the manifest's
 * "legacyStorage": { "indexedDB": [...] }. Resolves with
 * { version, stores: { name: [[key, value], ...] } } or null.
 */
export const legacy = Object.freeze({
  readIndexedDB: name => ask('legacy.readIndexedDB', name),
  /** A state namespace listed in "legacyStorage": { "state": [...] }. Resolves its saved data or null. */
  readState: namespace => ask('legacy.readState', namespace),
  /** Keys listed in "legacyStorage": { "localStorage": [...] } ("prefix*" entries return every matching key). Resolves { key: value|null }. */
  readLocalStorage: keys => ask('legacy.readLocalStorage', keys),
  /** Delete the page databases listed in "legacyStorage": { "deleteIndexedDB": [...] } ("prefix*" allowed). Resolves the names deleted. */
  deleteIndexedDB: () => ask('legacy.deleteIndexedDB'),
});

/**
 * First-party extensions only: the `window` of this extension's own boot
 * frame, so a panel or widget can use live objects the boot frame holds
 * (a network client, say) instead of copying them through call(). An
 * extension's frames share one origin, so this is a same-origin window in
 * the same process. Anything read from it belongs to that realm, where
 * `instanceof` checks against this frame's classes fail.
 * Resolves once the boot frame is up (waiting up to `timeout` ms), or
 * rejects.
 */
function findBackground() {
  const key = `${extension.kind}:${extension.id}`;
  let frames;
  try { frames = window.parent.frames; } catch { return null; }
  for (let index = 0; index < frames.length; index++) {
    try {
      const candidate = frames[index];
      if (candidate !== window && candidate.__atmosBackground === key) return candidate;
    } catch { /* another origin */ }
  }
  return null;
}

export async function background({ timeout = 15000 } = {}) {
  await ready;
  if (extension.tier === 'third-party') throw new Error('background() is for first-party extensions');
  if (surface.type === 'boot') return window;
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = findBackground();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('This extension\'s background frame is not running');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * First-party (SDK 1.2): web pages, for an official extension declaring
 * "web": true in its permissions (Atmos Browser). Core shows each open tab's
 * page in the extension's panel, where the panel says (setSurface), in the
 * browser's own session and under Core's policy: navigation, pop-ups,
 * permissions and downloads are Core's to decide. A tab id is the
 * extension's own name for a tab (1–64 letters, digits, - or _).
 *
 *   open(tabId, { url, private })   a page for the tab (loads url)
 *   close(tabId)                    its page goes (the tab is the extension's to keep)
 *   show(tabId | null)              which tab's page the panel shows
 *   navigate/back/forward/reload/stop/zoom/find/stopFind/print/mute/edit/download/copyImage/focus/state
 *   shield(tabId, on)               the site's shield: block its ads and trackers, or not
 *   blocked(tabId)                  what was blocked on the tab's page
 *   setSurface({ x, y, width, height, over })   the panel: where the page goes, in
 *                                   this frame's pixels; `over` are rectangles the
 *                                   frame draws over the page (the page shows through
 *                                   the rest). null: nowhere
 *   onEvent(fn)                     what the pages do: { type, tabId, … }
 *   downloads, permissions, external, adblock, options, setOptions, clearData
 */
const webAsk = (tabId, name, ...args) => ask('web.do', tabId, name, ...args);
export const web = Object.freeze({
  open: (tabId, options = {}) => ask('web.open', tabId, options),
  close: tabId => ask('web.close', tabId),
  show: tabId => ask('web.show', tabId ?? null),
  list: () => ask('web.list'),
  navigate: (tabId, url) => webAsk(tabId, 'navigate', url),
  back: tabId => webAsk(tabId, 'back'),
  forward: tabId => webAsk(tabId, 'forward'),
  reload: (tabId, options = {}) => webAsk(tabId, 'reload', { hard: options.hard === true }),
  stop: tabId => webAsk(tabId, 'stop'),
  /** 'in', 'out' or 'reset'; kept per site. Resolves the new factor. */
  zoom: (tabId, direction) => webAsk(tabId, 'zoom', direction),
  /** Resolves a request id; results arrive as { type: 'find' } events. '' stops. */
  find: (tabId, text, options = {}) => webAsk(tabId, 'find', text, { forward: options.forward !== false, findNext: options.findNext === true }),
  stopFind: tabId => webAsk(tabId, 'stopFind'),
  print: tabId => webAsk(tabId, 'print'),
  mute: (tabId, muted) => webAsk(tabId, 'mute', muted === true),
  /** 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'. */
  edit: (tabId, action) => webAsk(tabId, 'edit', action),
  /** Saves what `url` points at, through the browser's downloads. */
  download: (tabId, url) => webAsk(tabId, 'download', url),
  /** Copies the image at x, y in the page (a context-menu event's point). */
  copyImage: (tabId, x, y) => webAsk(tabId, 'copyImage', x, y),
  focus: tabId => webAsk(tabId, 'focus'),
  state: tabId => webAsk(tabId, 'state'),
  /** The site's shield: true blocks its ads and trackers (the default), false allows them. Kept per site. */
  shield: (tabId, on) => webAsk(tabId, 'shield', on !== false),
  /** { count, hosts: [{ host, count }] }: what was blocked on the tab's page. */
  blocked: tabId => webAsk(tabId, 'blocked'),
  setSurface: rect => ask('web.setSurface', rect),
  onEvent(fn) {
    const off = subscribe('web', fn);
    ask('web.subscribe').catch(error => console.warn('[atmos] web.onEvent:', error.message));
    return off;
  },
  downloads: Object.freeze({
    list: () => ask('web.downloads'),
    open: id => ask('web.download', id, 'open'),
    show: id => ask('web.download', id, 'show'),
    cancel: id => ask('web.download', id, 'cancel'),
    pause: id => ask('web.download', id, 'pause'),
    resume: id => ask('web.download', id, 'resume'),
    remove: id => ask('web.download', id, 'remove'),
  }),
  permissions: Object.freeze({
    /** The user's answer to a { type: 'permission-request' } event. */
    respond: (requestId, { allow = false, remember = true } = {}) => ask('web.permissionRespond', requestId, { allow, remember }),
    list: () => ask('web.siteSettings'),
    /** 'allow', 'block', or null to forget. */
    set: (origin, name, value) => ask('web.siteSetting', origin, name, value),
  }),
  external: Object.freeze({
    /** The user's answer to an { type: 'external-request' } event (a mailto: link, say). */
    respond: (requestId, allow) => ask('web.externalRespond', requestId, allow === true),
  }),
  /** The ad and tracker blocker: { enabled, state, error, updatedAt, rules, total, lists }. */
  adblock: Object.freeze({
    status: () => ask('web.adblock'),
    /** Check every list now; resolves the status after. */
    update: () => ask('web.adblockUpdate'),
  }),
  /** { openLinks, askWhereToSave, blockAds } */
  options: () => ask('web.options'),
  setOptions: patch => ask('web.setOptions', patch),
  /** { cookies, cache, siteSettings }: the ordinary session's (private tabs keep nothing). */
  clearData: what => ask('web.clearData', what),
});

const atmos = Object.freeze({
  SDK_VERSION, ready, extension, surface, state, events, appearance, contextMenu, clipboard, panel,
  invoke, listen, call, expose, library, wallpaper, audio, fetch: atmosFetch, location: locationApi, lifecycle,
  notifications,
  drawer, legacy, background, web,
});
export default atmos;

/**
 * Atmos SDK — the only way a framed extension talks to Atmos.
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
 * frames or Electron. See ATMOS_CORE_INTEGRATION.md, "Atmos SDK".
 */

export const SDK_VERSION = 3;

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

function request(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, args });
  });
}

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
  const out = new Error(error?.message || 'Atmos request failed');
  if (error?.name) out.name = error.name;
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
  if (item.type === 'select') {
    plain.value = item.value;
    plain.options = (item.options || []).map(option => ({ value: option.value, label: option.label }));
  }
  if (item.type === 'range' || item.type === 'number') {
    for (const name of ['min', 'max', 'step', 'value', 'suffix', 'zeroLabel']) {
      if (item[name] !== undefined) plain[name] = item[name];
    }
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
  request('appearance.fontData', id).then(dataUrl => {
    if (appFontId !== id || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return;
    const face = new FontFace(font.family, `url(${dataUrl})`);
    appFontFace = face;
    document.fonts.add(face);
    return face.load();
  }).catch(error => console.warn('[atmos-sdk] could not load the app font:', error.message));
}

let measureSize = null; // Core asks again when the frame's container changes

function watchSize() {
  let last = -1;
  let queued = false;
  const report = () => {
    queued = false;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== last) { last = height; notify('surface.resize', height); }
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
    if (!(shortcut || space || (event.key === 'Escape' && !typing))) return;
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

function armFileDrops() {
  // A file drag entering the frame: Atmos covers the frame and takes the
  // drop, since only it can see the files' paths (see surface.onFileDrop).
  document.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    notify('drop.arm');
  }, true);
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
      Object.assign(surface, init.surface);
      document.documentElement.dataset.atmosSurface = surface.type;
      applyAppearance(init.appearance);
      for (const message of queue.splice(0)) port.postMessage(message);
      if (surface.type === 'boot') {
        // Lets this extension's own views find this frame (see background()).
        Object.defineProperty(window, '__atmosBackground', { value: `${extension.kind}:${extension.id}` });
      }
      if (surface.type === 'sidebar' || surface.type === 'settings') watchSize();
      forwardKeys();
      if (surface.fileDrops) armFileDrops();
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

/** Which extension this frame belongs to: { id, kind, tier }. */
export const extension = {};

/**
 * This frame's surface: { type: 'panel'|'sidebar'|'settings'|'boot', presentation, fileDrops }.
 * A layout change recreates the frame, so `presentation` is fixed for its
 * lifetime.
 *
 * With "fileDrops": true on the surface in the manifest, files dragged from
 * the desktop are received by Atmos on the frame's behalf:
 *   onFileDrag(({ state }) => ...)   state 'over' while a file drag is over
 *                                    the frame, 'leave' when it ends
 *   onFileDrop(drop => ...)          { paths, files, types, data, x, y }:
 *                                    paths[i] is files[i]'s path on disk
 *                                    ('' for files that have none, e.g. an
 *                                    image dragged from a web page); data
 *                                    holds text/uri-list, text/plain and
 *                                    text/html when present.
 */
export const surface = {
  onFileDrag: fn => subscribe('fileDrag', fn),
  /** Boot frames: a key declared on the boot contribution ("keys": ["Space"]) was pressed: fn({ code }). */
  onKey: fn => subscribe('key', fn),
  onFileDrop: fn => subscribe('fileDrop', fn),
  /**
   * Sidebar widgets: the items Atmos adds to this widget's header menu
   * (right-click on its title); same item shapes as contextMenu.open().
   * Call again whenever they change (a `checked` flag, say).
   */
  /**
   * Panels declaring "glass": true — Core draws the frosted material under
   * the frame (a frame's own backdrop-filter can't blur the wallpaper).
   * regions: [{ x, y, width, height, material: 'panel'|'shell', radius }]
   * in this frame's pixels. Leave those areas transparent in the frame.
   */
  setGlass: regions => request('surface.setGlass', regions),
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
      request('surface.setGlass', regions).catch(error => console.warn('[atmos] setGlass:', error.message));
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
      request('surface.setGlass', []).catch(() => {});
    };
  },
  setMenu(items) {
    headerActions.clear();
    return request('surface.setMenu', (items || []).map((item, index) => plainMenuItem(item, index, headerActions)));
  },
};

/**
 * Persisted state for this extension, shared by all of its frames and saved
 * with Atmos's settings. Keep it small (under 1 MB); use IndexedDB in the
 * frame for larger data.
 */
export const state = {
  get: () => request('state.get'),
  set: value => request('state.set', value),
  update: patch => request('state.update', patch),
  onChange: fn => subscribe('state', fn),
};

/**
 * Events. Plain names are this extension's own (`<id>:<name>` for others);
 * listening to another extension's events requires declaring it in
 * "invokes". Emitting is only possible in the extension's own namespace.
 */
export const events = {
  emit: (name, payload) => request('events.emit', name, payload),
  on(name, fn) {
    const unsubscribe = subscribe(`event:${name}`, fn);
    const subscribed = request('events.subscribe', name);
    subscribed.catch(error => { unsubscribe(); console.error(`[atmos-sdk] cannot listen to '${name}':`, error.message); });
    return () => { unsubscribe(); notify('events.unsubscribe', name); };
  },
};

/** Current theme: { theme, colorScheme, vars }. Frames are themed automatically. */
export const appearance = {
  get: () => request('appearance.get'),
  onChange: fn => subscribe('appearance', fn),
};

/**
 * Show an Atmos context menu at frame coordinates. Items are
 *   { id, label, run?, checked? }             a row; `checked` shows a tick
 *   { id, label, type: 'select', value, options: [{ value, label }], run(value) }
 *   { type: 'separator' | 'heading' | 'meta', label? }
 * Resolves with the chosen id ({ id, value } for a select), or null when
 * dismissed.
 */
export const contextMenu = {
  async open(x, y, items) {
    // Each menu has its own actions: a menu closing later must not drop
    // the actions of one opened since.
    const actions = new Map();
    menuActions = actions;
    try {
      return await request('contextMenu.open', x, y, (items || []).map((item, index) => plainMenuItem(item, index, actions)));
    } finally {
      actions.clear();
    }
  },
  /** Close the menu this frame has open, if any (when what it points at scrolls away, say). */
  close: () => request('contextMenu.close'),
};

/** Call another extension's main-process IPC handler: invoke('service:x', 'channel', ...args). */
export function invoke(target, channel, ...args) {
  return request('invoke', target, channel, ...args);
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
  request('main.subscribe', target, channel).catch(error => {
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
  return request('call', target, method, ...args);
}

/**
 * From boot.js: offer methods to call(). The extension's own panel and
 * widgets can always call them ('plugin:<own id>'); other extensions need
 * the target in "permissions.invokes".
 */
export function expose(methods) {
  if (!methods || typeof methods !== 'object') throw new TypeError('atmos.expose: methods must be an object');
  exposed = methods;
  return request('services.expose', Object.keys(methods).filter(name => typeof methods[name] === 'function'));
}

/** URL of a library service's module, for import(): await import(await library('service:plotting', 'index.js')). */
export function library(target, file) {
  return request('library.url', target, file);
}

/**
 * System notifications (the Notification API doesn't work in frames).
 * Needs "notifications" in "permissions.browser".
 *   show({ title, body?, tag?, silent? })  resolves true once shown, false
 *                                          where the system has none
 *   onClick(({ tag }) => ...)              the user clicked one of this
 *                                          extension's notifications; Atmos
 *                                          comes to the front first. Every
 *                                          frame of the extension hears it.
 */
export const notifications = {
  show: options => request('notifications.show', options),
  onClick: fn => subscribe('notificationClick', fn),
};

/**
 * The background layer's Wallpaper service. Needs "invokes": ["service:wallpaper"].
 *   set(file)      an image File/Blob becomes Atmos's wallpaper
 *   get()          { mode, opacity, thumbnail }: thumbnail is a small JPEG
 *                  data URL of the current image (null when there is none)
 *   onChange(fn)   the same, whenever the image or mode changes
 */
export const wallpaper = {
  set: file => request('wallpaper.set', file),
  get: () => request('wallpaper.get'),
  onChange(fn) {
    const unsubscribe = subscribe('wallpaper', fn);
    request('wallpaper.subscribe').catch(error => { unsubscribe(); console.error('[atmos-sdk] cannot follow the wallpaper:', error.message); });
    return unsubscribe;
  },
};

/**
 * The background layer's Audio service: this extension's own playback
 * channel, living in Atmos for the whole session (it keeps playing whatever
 * frames come and go). Needs "invokes": ["service:audio"].
 *
 *   load(source, { id, position, play })  source: a Blob/File, or an
 *        atmos-resource:// URL from a provider the extension registers or
 *        invokes; id: your own label for it (a track key), reported back
 *   play() pause() seek(seconds) setVolume(0–1) stop()
 *   state()       { type, source, playing, currentTime, duration, volume, ended, error }
 *   onChange(fn)  the same on every change, in every frame of the extension
 *                 (type: source, loaded, play, pause, time, ended, volume, error)
 */
export const audio = {
  load: (source, options) => request('audio.load', source, options),
  play: () => request('audio.play'),
  pause: () => request('audio.pause'),
  seek: seconds => request('audio.seek', seconds),
  setVolume: value => request('audio.volume', value),
  stop: () => request('audio.stop'),
  state: () => request('audio.state'),
  onChange(fn) {
    const unsubscribe = subscribe('audio', fn);
    request('audio.subscribe').catch(error => { unsubscribe(); console.error('[atmos-sdk] cannot follow audio:', error.message); });
    return unsubscribe;
  },
};

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
export const drawer = {
  get state() { return drawerState; },
  onChange: fn => subscribe('drawer', () => fn(drawerState)),
  onKey: fn => subscribe('drawerKey', fn),
  open: () => request('drawer.command', 'open'),
  close: () => request('drawer.command', 'close'),
  /** Raise fully open. */
  expand: () => request('drawer.command', 'expand'),
  /** Back down to just the bar. */
  collapse: () => request('drawer.command', 'collapse'),
  /** 'top' (bar leads the drawer) or 'bottom' (bar docked, browser revealed upward). */
  setBarPlacement: placement => request('drawer.command', 'bar', placement),
  /** 0 = fully open, 1 = bar only, 2 = hidden. Atmos remembers it; for carrying over an old position. */
  setPlacement: placement => request('drawer.command', 'placement', placement),
};

/**
 * The clipboard. A frame that has focus can use navigator.clipboard itself;
 * an action chosen from an Atmos menu (contextMenu.open, setMenu) runs
 * while the Atmos page has focus, so copy through here instead.
 */
export const clipboard = {
  writeText: text => request('clipboard.write', { text: String(text) }),
  /** A PNG Blob, optionally with plain text beside it. */
  writeImage: (png, text) => request('clipboard.write', text == null ? { image: png } : { image: png, text: String(text) }),
};

/** This extension's panel. */
export const panel = {
  show: () => request('panel.show'),
};

/**
 * One-off migration for first-party extensions that moved into a frame:
 * read a database they stored in the Atmos page, listed in the manifest's
 * "legacyStorage": { "indexedDB": [...] }. Resolves with
 * { version, stores: { name: [[key, value], ...] } } or null.
 */
export const legacy = {
  readIndexedDB: name => request('legacy.readIndexedDB', name),
  /** A state namespace listed in "legacyStorage": { "state": [...] }. Resolves its saved data or null. */
  readState: namespace => request('legacy.readState', namespace),
  /** Keys listed in "legacyStorage": { "localStorage": [...] } ("prefix*" entries return every matching key). Resolves { key: value|null }. */
  readLocalStorage: keys => request('legacy.readLocalStorage', keys),
  /** Delete the page databases listed in "legacyStorage": { "deleteIndexedDB": [...] } ("prefix*" allowed). Resolves the names deleted. */
  deleteIndexedDB: () => request('legacy.deleteIndexedDB'),
};

/**
 * First-party extensions only: the `window` of this extension's own boot
 * frame, so a panel or widget can use live objects the boot frame holds
 * (a network client, say) instead of copying them through call(). Frames
 * of first-party extensions share one origin, so this is a same-origin
 * window in the same process. Anything read from it belongs to that realm,
 * where `instanceof` checks against this frame's classes fail.
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

const atmos = Object.freeze({
  SDK_VERSION, ready, extension, surface, state, events, appearance, contextMenu,
  invoke, listen, call, expose, library, notifications, wallpaper, audio, drawer, panel, legacy, background, clipboard,
});
export default atmos;

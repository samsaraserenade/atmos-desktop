/**
 * The Core side of the Atmos SDK: one bridge per extension frame.
 *
 * A frame's only route to Atmos is the MessagePort Core hands it when it
 * starts (see extension-frame-host.js). Core, not the frame, decides which
 * extension a port belongs to, so a frame cannot claim to be someone else.
 * Every request is checked here against that extension's declared
 * permissions before anything happens.
 *
 * Kept free of DOM and registry imports so it can be tested on its own:
 * everything it touches arrives through `deps`.
 */

const MAX_STATE_BYTES = 1024 * 1024;
const MENU_TYPES = new Set([undefined, 'separator', 'heading', 'meta', 'select', 'toggle', 'range', 'number', 'colors', 'buttons']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export class BridgeError extends Error {
  constructor(message, name = 'AtmosPermissionError') {
    super(message);
    this.name = name;
  }
}

function plainObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError(`${what} must be an object`, 'TypeError');
  return value;
}

function checkSize(value) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new BridgeError('state must be JSON-serialisable', 'TypeError'); }
  if (json.length > MAX_STATE_BYTES) throw new BridgeError('state is larger than 1 MB; keep large data in IndexedDB', 'RangeError');
  return JSON.parse(json);
}

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * Menu items a frame may put in an Atmos menu: plain data, known types only.
 * Core draws every control; an icon is an SVG string Core sanitises before
 * drawing (see extension-frame-host.js).
 */
function cleanMenuItems(items) {
  return items.slice(0, 50).filter(item => MENU_TYPES.has(item?.type)).map(item => {
    const clean = {
      id: String(item.id ?? '').slice(0, 80),
      label: String(item.label ?? '').slice(0, 120),
      type: item.type,
    };
    if (typeof item.icon === 'string' && item.icon.length <= 4000) clean.icon = item.icon;
    if (typeof item.closeOnChange === 'boolean') clean.closeOnChange = item.closeOnChange;
    // A plain row may show a tick; Core draws it.
    if ((item.type === undefined || item.type === 'toggle') && typeof item.checked === 'boolean') clean.checked = item.checked;
    if (item.type === 'select') {
      clean.value = String(item.value ?? '').slice(0, 120);
      clean.options = (Array.isArray(item.options) ? item.options : []).slice(0, 50).map(option => ({
        value: String(option?.value ?? '').slice(0, 120),
        label: String(option?.label ?? option?.value ?? '').slice(0, 120),
      }));
    }
    if (item.type === 'range' || item.type === 'number') {
      clean.min = finiteOr(item.min, 0);
      clean.max = finiteOr(item.max, 100);
      clean.step = finiteOr(item.step, 1);
      clean.value = finiteOr(item.value, clean.min);
      if (typeof item.suffix === 'string') clean.suffix = item.suffix.slice(0, 8);
      if (item.type === 'range' && typeof item.zeroLabel === 'string') clean.zeroLabel = item.zeroLabel.slice(0, 20);
    }
    if (item.type === 'buttons') {
      clean.buttons = (Array.isArray(item.buttons) ? item.buttons : []).slice(0, 12).map(button => {
        const plain = {
          id: String(button?.id ?? '').slice(0, 80),
          label: String(button?.label ?? '').slice(0, 40),
        };
        if (typeof button?.title === 'string') plain.title = button.title.slice(0, 120);
        if (typeof button?.icon === 'string' && button.icon.length <= 4000) plain.icon = button.icon;
        return plain;
      });
    }
    if (item.type === 'colors') {
      clean.values = (Array.isArray(item.values) ? item.values : []).slice(0, 6).map(value => (HEX_COLOR.test(value) ? value : '#ffffff'));
    }
    return clean;
  });
}

/** Wallpaper and audio calls go to system services, declared like any other. */
const WALLPAPER = 'service:wallpaper';
const AUDIO = 'service:audio';

function parseTarget(target) {
  const match = typeof target === 'string' && target.match(/^(plugin|service):([a-z0-9][a-z0-9-]*)$/);
  if (!match) throw new BridgeError(`'${target}' is not an extension (use "plugin:<id>" or "service:<id>")`, 'TypeError');
  return { kind: match[1], id: match[2] };
}

/**
 * @param {object} options
 * @param {{id, kind, tier, permissions}} options.extension
 * @param {{type, contribution}} options.surface
 * @param {(message: object) => void} options.post   sends to the frame
 * @param {object} options.deps  Core services (see extension-frame-host.js)
 */
export function createExtensionBridge({ extension, surface, post, deps }) {
  const self = `${extension.kind}:${extension.id}`;
  const invokes = new Set(extension.permissions?.invokes || []);
  const subscriptions = new Map(); // event name -> unsubscribe
  const mainListeners = new Map();  // "target channel" -> unsubscribe
  const outgoingCalls = new Map(); // call id -> { resolve, reject }
  let nextCall = 1;
  let disposed = false;
  let wallpaperWatch = null;

  /** What a frame may ask its audio channel to load. */
  const audioSource = source => {
    if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
    let url = null;
    try { url = typeof source === 'string' ? new URL(source) : null; } catch { url = null; }
    const providers = extension.frame?.resourceProviders || [];
    if (url?.protocol === 'atmos-resource:' && providers.includes(url.hostname)) return url.href;
    throw new BridgeError('audio.load(source) takes a Blob, or an atmos-resource:// URL from a provider the extension registers or invokes', 'TypeError');
  };

  const may = target => target === self || invokes.has(target);
  const requireTarget = (target, what) => {
    const parsed = parseTarget(target);
    if (!may(target)) {
      throw new BridgeError(`${self} is not permitted to ${what} ${target}; declare it in extension.json "permissions.invokes"`);
    }
    return parsed;
  };
  const fullEventName = name => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9:._-]*$/i.test(name)) throw new BridgeError('event names use letters, numbers and - _ . :', 'TypeError');
    const colon = name.indexOf(':');
    if (colon === -1) return `${extension.id}:${name}`;
    const owner = name.slice(0, colon);
    if (owner !== extension.id && !may(`plugin:${owner}`) && !may(`service:${owner}`)) {
      throw new BridgeError(`${self} is not permitted to listen to '${owner}' events; declare it in "permissions.invokes"`);
    }
    return name;
  };

  const handlers = {
    'state.get': () => deps.state.get(extension),
    'state.set': value => deps.state.set(extension, checkSize(plainObject(value, 'state')), bridge),
    'state.update': patch => {
      const next = { ...deps.state.get(extension), ...plainObject(patch, 'state patch') };
      return deps.state.set(extension, checkSize(next), bridge);
    },

    'events.emit': (name, payload) => {
      if (typeof name !== 'string' || name.includes(':')) throw new BridgeError('extensions emit only their own events (no "<id>:" prefix)', 'TypeError');
      deps.events.emit(fullEventName(name), payload);
    },
    'events.subscribe': name => {
      if (subscriptions.has(name)) return;
      const unsubscribe = deps.events.on(fullEventName(name), payload => post({ topic: `event:${name}`, payload }));
      subscriptions.set(name, unsubscribe);
    },
    'events.unsubscribe': name => {
      subscriptions.get(name)?.();
      subscriptions.delete(name);
    },

    'appearance.get': () => deps.appearance(),
    'appearance.fontData': id => deps.appFontData?.(String(id)) ?? null,

    // Items for the Atmos menu on a sidebar widget's header (right-click).
    // Replaces the previous set; the frame hears the chosen id.
    'surface.setMenu': items => {
      if (surface.type !== 'sidebar') throw new BridgeError('only sidebar widgets have a header menu', 'Error');
      if (!Array.isArray(items)) throw new BridgeError('setMenu(items)', 'TypeError');
      deps.setSurfaceMenu?.(cleanMenuItems(items));
    },
    // Where Core should draw glass under a panel that declares "glass":
    // [{ x, y, width, height, material: 'panel'|'shell', radius }], in the
    // frame's own pixels. [] clears it.
    'surface.setGlass': regions => {
      if (surface.type !== 'panel' || !surface.glass) throw new BridgeError('only panels declaring "glass" have Core-drawn glass', 'Error');
      if (!Array.isArray(regions)) throw new BridgeError('setGlass(regions)', 'TypeError');
      const clean = regions.slice(0, 24).map(region => ({
        x: Math.round(finiteOr(region?.x, 0)),
        y: Math.round(finiteOr(region?.y, 0)),
        width: Math.max(0, Math.round(finiteOr(region?.width, 0))),
        height: Math.max(0, Math.round(finiteOr(region?.height, 0))),
        material: region?.material === 'shell' ? 'shell' : 'panel',
        radius: Math.max(0, Math.min(40, Math.round(finiteOr(region?.radius, 0)))),
      })).filter(region => region.width > 0 && region.height > 0);
      deps.setGlass(clean);
    },
    // The background layer's Wallpaper service lives in the page; talking
    // to it is declared like any other extension ("invokes": ["service:wallpaper"]).
    'wallpaper.set': file => {
      requireTarget(WALLPAPER, 'set the wallpaper through');
      if (!(typeof Blob !== 'undefined' && file instanceof Blob) || !/^image\//.test(file.type || '')) {
        throw new BridgeError('wallpaper.set(file) needs an image File or Blob', 'TypeError');
      }
      return deps.wallpaper.set(file);
    },
    'wallpaper.get': () => {
      requireTarget(WALLPAPER, 'read the wallpaper of');
      return deps.wallpaper.get();
    },
    'wallpaper.subscribe': () => {
      requireTarget(WALLPAPER, 'follow the wallpaper of');
      if (!wallpaperWatch) wallpaperWatch = deps.wallpaper.subscribe(value => post({ topic: 'wallpaper', payload: value }));
    },

    // The background layer's Audio service: this extension's own channel
    // ("invokes": ["service:audio"]). Every frame of the extension hears it.
    'audio.load': (source, options) => {
      requireTarget(AUDIO, 'play audio through');
      const { id = null, position = 0, play = false } = options && typeof options === 'object' ? options : {};
      return deps.audio.channel().load(audioSource(source), {
        id: id == null ? null : String(id).slice(0, 500),
        position: Math.max(0, Number(position) || 0),
        play: play === true,
      });
    },
    'audio.play': () => { requireTarget(AUDIO, 'play audio through'); return deps.audio.channel().play(); },
    'audio.pause': () => { requireTarget(AUDIO, 'play audio through'); deps.audio.channel().pause(); },
    'audio.seek': seconds => {
      requireTarget(AUDIO, 'play audio through');
      if (!Number.isFinite(seconds)) throw new BridgeError('audio.seek(seconds)', 'TypeError');
      deps.audio.channel().seek(seconds);
    },
    'audio.volume': value => {
      requireTarget(AUDIO, 'play audio through');
      if (!Number.isFinite(value)) throw new BridgeError('audio.setVolume(0–1)', 'TypeError');
      deps.audio.channel().setVolume(value);
    },
    'audio.stop': () => { requireTarget(AUDIO, 'play audio through'); deps.audio.channel().stop(); },
    'audio.state': () => { requireTarget(AUDIO, 'play audio through'); return deps.audio.channel().state(); },
    'audio.subscribe': () => {
      requireTarget(AUDIO, 'play audio through');
      deps.audio.watch();
    },

    'contextMenu.open': (x, y, items) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Array.isArray(items)) throw new BridgeError('contextMenu.open(x, y, items)', 'TypeError');
      const clean = cleanMenuItems(items);
      // Controls (toggles, ranges, selects…) report each change as it
      // happens; a plain row is reported once, when chosen.
      return deps.openMenu(x, y, clean, change => post({ topic: 'menu', payload: change })).then(choice => {
        if (typeof choice === 'string') post({ topic: 'menu', payload: choice });
        return choice;
      });
    },

    // Close a menu this frame opened (one it didn't open stays).
    'contextMenu.close': () => { deps.closeOwnMenu?.(); },

    // Events a main.cjs sends with context.send(): the extension's own, or
    // those of an extension it declares in "invokes".
    'main.subscribe': (target, channel) => {
      const { kind, id } = requireTarget(target, 'listen to');
      if (typeof channel !== 'string' || !/^[a-z0-9][a-z0-9:._-]*$/i.test(channel)) throw new BridgeError('listen(target, channel, fn)', 'TypeError');
      const key = `${target} ${channel}`;
      if (mainListeners.has(key)) return;
      if (!deps.onMain) throw new BridgeError('main-process events are unavailable', 'Error');
      mainListeners.set(key, deps.onMain(kind, id, channel, (...args) => post({ topic: `main:${key}`, payload: args })));
    },
    'main.unsubscribe': (target, channel) => {
      const key = `${target} ${channel}`;
      mainListeners.get(key)?.();
      mainListeners.delete(key);
    },

    'invoke': (target, channel, ...args) => {
      const { kind, id } = requireTarget(target, 'invoke');
      if (typeof channel !== 'string') throw new BridgeError('invoke(target, channel, ...args)', 'TypeError');
      return deps.invokeMain(kind, id, channel, ...args);
    },

    'call': async (target, method, ...args) => {
      requireTarget(target, 'call');
      if (typeof method !== 'string') throw new BridgeError('call(target, method, ...args)', 'TypeError');
      // A background frame may still be starting; wait for it rather than fail.
      const service = deps.services.get(target) || await deps.awaitService?.(target);
      if (!service) throw new BridgeError(`${target} is not running or exposes nothing`, 'Error');
      if (!service.methods.includes(method)) throw new BridgeError(`${target} does not expose '${method}'`, 'Error');
      return service.call(method, args);
    },

    'services.expose': methods => {
      if (surface.type !== 'boot') throw new BridgeError('only boot.js can expose methods', 'Error');
      if (!Array.isArray(methods) || !methods.every(name => typeof name === 'string')) throw new BridgeError('expose(methods)', 'TypeError');
      deps.services.set(self, { methods: [...methods], call: callFrame, owner: bridge });
    },

    'library.url': (target, file) => {
      const { kind, id } = requireTarget(target, 'import');
      const base = kind === 'service' ? deps.libraryBase(id) : null;
      if (!base) throw new BridgeError(`${target} is not a library service`, 'Error');
      if (typeof file !== 'string' || !/^[\w./-]+$/.test(file) || file.split('/').includes('..')) {
        throw new BridgeError('library file must be a relative path', 'TypeError');
      }
      return `${base}${file}`;
    },

    // The clipboard, written by the Atmos page. A frame can write it itself
    // only while it has focus; after a choice in an Atmos menu (which runs
    // in the page) focus is on the page, so a menu's "Copy" comes here.
    // Text, a PNG image, or both.
    'clipboard.write': data => {
      const { text, image } = plainObject(data, 'clipboard data');
      if (text != null && (typeof text !== 'string' || text.length > 1_000_000)) throw new BridgeError('clipboard text must be a string', 'TypeError');
      if (image != null && !(typeof Blob !== 'undefined' && image instanceof Blob && image.type === 'image/png')) {
        throw new BridgeError('clipboard image must be a PNG Blob', 'TypeError');
      }
      if (text == null && image == null) throw new BridgeError('clipboard.write({ text?, image? }) needs one of them', 'TypeError');
      const write = deps.clipboardWrite ?? (async ({ text: plain, image: png }) => {
        if (!png) return navigator.clipboard.writeText(plain);
        const parts = { 'image/png': png };
        if (plain != null) parts['text/plain'] = new Blob([plain], { type: 'text/plain' });
        return navigator.clipboard.write([new ClipboardItem(parts)]);
      });
      return write({ text: text ?? null, image: image ?? null });
    },

    // System notifications. Chromium refuses the Notification API inside
    // frames, so Core shows them for the frame. Needs "notifications" in
    // "permissions.browser"; Atmos's main process checks it again.
    'notifications.show': options => {
      if (!(extension.permissions?.browser || []).includes('notifications')) {
        throw new BridgeError(`${self} may not show notifications; declare "notifications" in extension.json "permissions.browser"`);
      }
      const { title, body, tag, silent } = plainObject(options, 'notification');
      if (typeof title !== 'string' || !title.trim()) throw new BridgeError('notifications.show({ title, body? }) needs a title', 'TypeError');
      if (!deps.notify) throw new BridgeError('notifications are unavailable', 'Error');
      return deps.notify({
        title: title.slice(0, 120),
        body: typeof body === 'string' ? body.slice(0, 500) : '',
        tag: typeof tag === 'string' ? tag.slice(0, 200) : '',
        silent: silent === true,
      });
    },

    // A panel that lives in a drawer ("drawer" on the panel contribution).
    // In a tile or floating window it is pinned open and commands do nothing.
    'drawer.command': (name, value) => {
      if (!surface.drawer) throw new BridgeError(`${self} ${surface.type} is not a drawer ("drawer" on the panel contribution)`, 'Error');
      if (typeof name !== 'string') throw new BridgeError('drawer command', 'TypeError');
      return deps.drawer ? deps.drawer.command(name, value) : null;
    },

    'panel.show': () => {
      if (!deps.showPanel?.(extension)) throw new BridgeError(`${self} has no panel`, 'Error');
    },

    // One-off copy of data a first-party extension stored in the Atmos page
    // before it moved into a frame. Only databases its manifest lists.
    // An entry is a database name (all of it), or { name, keys } for only
    // the records whose (string) keys match: exact, or "prefix*".
    'legacy.readIndexedDB': name => {
      const declared = extension.manifest?.legacyStorage?.indexedDB;
      const entry = Array.isArray(declared)
        ? declared.find(item => item === name || (item && typeof item === 'object' && item.name === name))
        : null;
      if (extension.tier === 'third-party' || !entry || typeof name !== 'string') {
        throw new BridgeError(`${self} may only read legacy databases listed in "legacyStorage.indexedDB"`);
      }
      const keys = typeof entry === 'object' ? (Array.isArray(entry.keys) ? entry.keys.filter(key => typeof key === 'string' && key && key !== '*') : []) : null;
      return deps.readLegacyIndexedDB(name, keys);
    },

    // Delete databases a first-party extension left in the Atmos page when
    // it moved into a frame and starts afresh there, listed in
    // "legacyStorage.deleteIndexedDB" (a name, or "prefix*" of at least 4
    // characters). Resolves the names deleted.
    'legacy.deleteIndexedDB': () => {
      const declared = extension.manifest?.legacyStorage?.deleteIndexedDB;
      const patterns = Array.isArray(declared)
        ? declared.filter(item => typeof item === 'string' && (!item.includes('*') || (item.indexOf('*') === item.length - 1 && item.length > 4)))
        : [];
      if (extension.tier === 'third-party' || !patterns.length) {
        throw new BridgeError(`${self} may only delete legacy databases listed in "legacyStorage.deleteIndexedDB"`);
      }
      return deps.deleteLegacyIndexedDB(patterns);
    },

    // A state namespace the extension (or its old in-page ids) kept in the
    // Atmos page, listed in "legacyStorage.state". Resolves its saved data or null.
    'legacy.readState': namespace => {
      const declared = extension.manifest?.legacyStorage?.state;
      if (extension.tier === 'third-party' || !Array.isArray(declared) || !declared.includes(namespace)) {
        throw new BridgeError(`${self} may only read legacy state namespaces listed in "legacyStorage.state"`);
      }
      return deps.readLegacyState(namespace);
    },

    // Same, for localStorage keys listed in "legacyStorage.localStorage".
    // A declared entry ending in "*" is a prefix; asking for it returns
    // every key that starts with it. Resolves { key: value } (null for a
    // key that was never stored).
    'legacy.readLocalStorage': keys => {
      const declared = extension.manifest?.legacyStorage?.localStorage;
      const wanted = Array.isArray(keys) ? keys : [keys];
      const allowed = key => typeof key === 'string' && declared.includes(key) && (!key.includes('*') || (key.endsWith('*') && key.indexOf('*') === key.length - 1 && key.length > 4));
      if (extension.tier === 'third-party' || !Array.isArray(declared) || !wanted.every(allowed)) {
        throw new BridgeError(`${self} may only read legacy localStorage keys listed in "legacyStorage.localStorage"`);
      }
      return deps.readLegacyLocalStorage(wanted);
    },

    // Notifications (no reply expected).
    'surface.resize': height => deps.resize?.(Math.max(0, Math.min(4000, Number(height) || 0))),
    'ui.key': init => deps.dispatchKey?.(init),
    'ui.pointerdown': () => deps.closeMenus?.(),
    'drawer.wheel': (deltaY, deltaMode) => {
      if (surface.drawer && Number.isFinite(deltaY)) deps.drawer?.wheel(deltaY, deltaMode);
    },
    'drop.arm': () => {
      if (!surface.fileDrops) throw new BridgeError(`${self} ${surface.type} does not accept file drops ("fileDrops": true)`);
      deps.armFileDrop?.();
    },
  };

  function callFrame(method, args) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new BridgeError('service stopped', 'Error')); return; }
      const call = nextCall++;
      outgoingCalls.set(call, { resolve, reject });
      post({ call, method, args });
    });
  }

  async function receive(message) {
    if (disposed || !message || typeof message !== 'object') return;
    if (message.callReply !== undefined) {
      const pending = outgoingCalls.get(message.callReply);
      outgoingCalls.delete(message.callReply);
      if (!pending) return;
      if (message.error) pending.reject(new BridgeError(message.error.message, message.error.name || 'Error'));
      else pending.resolve(message.result);
      return;
    }
    const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : null;
    const args = Array.isArray(message.args) ? message.args : [];
    const reply = message.id;
    try {
      if (!handler) throw new BridgeError(`unknown request '${message.method}'`, 'Error');
      const result = await handler(...args);
      if (reply !== undefined) post({ reply, result });
    } catch (error) {
      if (reply !== undefined) post({ reply, error: { name: error?.name || 'Error', message: error?.message || String(error) } });
      else console.warn(`[extension-bridge] ${self} ${message.method} failed:`, error?.message);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    for (const unsubscribe of mainListeners.values()) unsubscribe?.();
    mainListeners.clear();
    wallpaperWatch?.();
    wallpaperWatch = null;
    for (const pending of outgoingCalls.values()) pending.reject(new BridgeError('service stopped', 'Error'));
    outgoingCalls.clear();
    if (deps.services.get(self)?.owner === bridge) deps.services.delete(self);
  }

  const bridge = { extension, surface, receive, post, dispose };
  return bridge;
}

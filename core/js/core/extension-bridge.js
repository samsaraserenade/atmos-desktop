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

import { cleanOptionValues } from './command-list.js';

const MAX_STATE_BYTES = 1024 * 1024;
const MENU_TYPES = new Set([undefined, 'separator', 'heading', 'meta', 'select', 'toggle', 'range', 'number', 'text', 'colors', 'buttons']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

class BridgeError extends Error {
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
    // A plain row may ask for a press and hold, and be drawn as destructive.
    if (item.type === undefined && item.hold === true) clean.hold = true;
    if (item.type === undefined && item.tone === 'danger') clean.tone = 'danger';
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
    if (item.type === 'text') {
      clean.value = String(item.value ?? '').slice(0, 500);
      if (typeof item.placeholder === 'string') clean.placeholder = item.placeholder.slice(0, 80);
      if (Number.isFinite(item.maxLength)) clean.maxLength = Math.max(1, Math.min(500, Math.round(item.maxLength)));
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

/** Wallpaper and audio calls go to system services, location reads through Core to the Location service; declared like any other. */
const WALLPAPER = 'service:wallpaper';
const AUDIO = 'service:audio';
const LOCATION = 'service:location';
// What an extension plays goes to this official service (atmos.nowPlaying).
const NOW_PLAYING = 'service:now-playing';

/**
 * Whether `host` is covered by a normalised "permissions.network" list
 * (the main process's hostAllowed() in extension-permissions.cjs, which
 * decides; this only fails early with a clearer message).
 */
function hostAllowed(host, network) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  return !!name && (network || []).some(entry => entry === '*' || entry === name || (entry.startsWith('*.') && name.endsWith(entry.slice(1))));
}
const FETCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_FETCH_BODY = 5 * 1024 * 1024;
// In flight from one frame at once (the main process runs 6 per extension
// and queues 24 more); beyond this a frame is refused before its request
// is copied any further.
const MAX_FETCHES_PER_FRAME = 32;
let _bridgeSerial = 0;
// With the serial, names a frame to the main process (R17): unique across
// reloads of the page.
const _pageSession = Math.random().toString(36).slice(2, 8);

// Web pages (atmos.web): what a frame may ask Core to do to one of its tabs.
const WEB_COMMANDS = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'zoom', 'find', 'stopFind', 'print', 'mute', 'edit', 'download', 'copyImage', 'focus', 'state', 'shield', 'blocked', 'media']);
const WEB_MEDIA_ACTIONS = new Set(['toggle', 'next', 'previous', 'seek']);
const MAX_WEB_URL = 8192;
const MAX_DOWNLOAD_URL = 2_000_000; // "Save image as…" on a data: image
const WEB_TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;
function tabIdOf(value) {
  if (typeof value !== 'string' || !WEB_TAB_ID.test(value)) throw new BridgeError('a tab id is 1–64 letters, digits, - or _', 'TypeError');
  return value;
}

/** Where a panel's bottom bar is, in the frame's pixels (atmos.commands.bar). */
function cleanBarRect(rect) {
  if (rect === null) return null;
  plainObject(rect, 'bar rect');
  const box = {
    x: Math.round(finiteOr(rect.x, 0)), y: Math.round(finiteOr(rect.y, 0)),
    width: Math.max(0, Math.min(10000, Math.round(finiteOr(rect.width, 0)))),
    height: Math.max(0, Math.min(200, Math.round(finiteOr(rect.height, 0)))),
  };
  return box.width > 0 && box.height > 0 ? box : null;
}

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
  const commandRequests = new Map(); // command request id -> { resolve, reject, timer }
  let nextCommand = 1;
  const fetches = new Set();       // this frame's atmos.fetch() requests in flight
  const serial = ++_bridgeSerial;  // request ids are per frame; this makes them per page
  const frameId = `${_pageSession}-${serial}`;
  let calledMain = false;          // told the main process of this frame (invoke)
  let nextCall = 1;
  let disposed = false;
  const waitingCalls = new Set(); // calls waiting for their service to start: cancelled if the frame goes
  let wallpaperWatch = null;
  let locationWatch = null;
  let webWatch = null;
  let nowPlayingWatch = null;

  /** Every session and its controls: the official Now Playing service only. */
  const requireNowPlayingService = () => {
    if (self !== NOW_PLAYING || extension.tier === 'third-party') {
      throw new BridgeError(`only Atmos's Now Playing service sees what extensions play`);
    }
    if (!deps.nowPlaying) throw new BridgeError('Now Playing is unavailable here', 'Error');
  };
  // The Location service itself (official): it says where you are.
  const requireLocationService = () => {
    if (self !== LOCATION || extension.tier === 'third-party') {
      throw new BridgeError(`only Atmos's Location service sets the location`);
    }
  };

  /** Web pages: an official extension that declares "web": true, and Core's web layer to show them. */
  const requireWeb = () => {
    if (extension.tier === 'third-party' || extension.permissions?.web !== true) {
      throw new BridgeError(`${self} may not show web pages; that takes "web": true in its permissions, for official extensions`);
    }
    if (!deps.web) throw new BridgeError('web pages are unavailable here', 'Error');
    return deps.web;
  };

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
  // What another extension shares with this one (its "exports", filtered
  // by this extension's tier in the main process): { ipc, events, methods,
  // resources }. Everything of its own is open to it.
  const reach = extension.frame?.reach || {};
  // ["*"]: everything (an official target that doesn't list its exports yet).
  const shares = (target, kind, name) => {
    const list = reach[target]?.[kind] || [];
    return target === self || list.includes('*') || list.includes(name);
  };
  const whom = extension.tier === 'third-party' ? 'community extensions' : 'other extensions';
  const NOUNS = { ipc: 'handler', events: 'events', methods: 'method' };
  const requireShared = (target, kind, name) => {
    if (!shares(target, kind, name)) {
      throw new BridgeError(`${target} doesn't share its '${name}' ${NOUNS[kind]} with ${whom} ("exports.${kind}" in its extension.json)`);
    }
  };
  const fullEventName = name => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9:._-]*$/i.test(name)) throw new BridgeError('event names use letters, numbers and - _ . :', 'TypeError');
    const colon = name.indexOf(':');
    if (colon === -1) return `${extension.id}:${name}`;
    const owner = name.slice(0, colon);
    if (owner === extension.id) return name;
    const declared = [`plugin:${owner}`, `service:${owner}`].filter(may);
    if (!declared.length) {
      throw new BridgeError(`${self} is not permitted to listen to '${owner}' events; declare it in "permissions.invokes"`);
    }
    const event = name.slice(colon + 1);
    if (!declared.some(target => shares(target, 'events', event))) requireShared(declared[0], 'events', event);
    return name;
  };

  const handlers = {
    'state.get': () => deps.state.get(extension),
    'state.set': value => deps.state.set(extension, checkSize(plainObject(value, 'state')), bridge),
    'state.update': async patch => {
      plainObject(patch, 'state patch');
      if (deps.state.update) return deps.state.update(extension, patch, bridge, checkSize);
      const next = { ...(await deps.state.get(extension)), ...patch };
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
      return deps.wallpaper.set(file, self);
    },
    // Put back what this extension's wallpaper replaced; false when the
    // wallpaper showing isn't its own (the user or another extension changed it).
    'wallpaper.restore': () => {
      requireTarget(WALLPAPER, 'restore the wallpaper through');
      return deps.wallpaper.restore(self);
    },
    'wallpaper.get': () => {
      requireTarget(WALLPAPER, 'read the wallpaper of');
      return deps.wallpaper.get(self);
    },
    'wallpaper.subscribe': () => {
      requireTarget(WALLPAPER, 'follow the wallpaper of');
      if (!wallpaperWatch) wallpaperWatch = deps.wallpaper.subscribe(value => post({ topic: 'wallpaper', payload: value }), self);
    },

    // The background layer's Audio service: this extension's own channel
    // ("invokes": ["service:audio"]). Every frame of the extension hears it.
    // audioChannel() waits for the Audio service if it hasn't started yet,
    // and refuses if this frame went meanwhile.
    'audio.load': async (source, options) => {
      requireTarget(AUDIO, 'play audio through');
      const { id = null, position = 0, play = false, loop = false } = options && typeof options === 'object' ? options : {};
      return (await audioChannel()).load(audioSource(source), {
        id: id == null ? null : String(id).slice(0, 500),
        position: Math.max(0, Number(position) || 0),
        play: play === true,
        loop: loop === true,
      });
    },
    'audio.play': async () => { requireTarget(AUDIO, 'play audio through'); return (await audioChannel()).play(); },
    'audio.pause': async () => { requireTarget(AUDIO, 'play audio through'); (await audioChannel()).pause(); },
    'audio.seek': async seconds => {
      requireTarget(AUDIO, 'play audio through');
      if (!Number.isFinite(seconds)) throw new BridgeError('audio.seek(seconds)', 'TypeError');
      (await audioChannel()).seek(seconds);
    },
    'audio.volume': async value => {
      requireTarget(AUDIO, 'play audio through');
      if (!Number.isFinite(value)) throw new BridgeError('audio.setVolume(0–1)', 'TypeError');
      (await audioChannel()).setVolume(value);
    },
    'audio.stop': async () => { requireTarget(AUDIO, 'play audio through'); (await audioChannel()).stop(); },
    'audio.state': async () => { requireTarget(AUDIO, 'play audio through'); return (await audioChannel()).state(); },
    'audio.subscribe': async () => {
      requireTarget(AUDIO, 'play audio through');
      await deps.audio.watch();
    },

    // The Location service, read-only ("invokes": ["service:location"]):
    // { lat, lon, label, mode }, or null when the user hasn't set one (or
    // the service isn't installed).
    'location.get': () => {
      requireTarget(LOCATION, 'read the location from');
      return deps.location.get();
    },
    // The official Location service (services/location) itself: what it
    // keeps, published for readers; the location Atmos kept before it; and
    // its Detect button, which lets its frame use the browser's location
    // for a moment.
    'location.publish': value => {
      requireLocationService();
      deps.location.publish(value ?? null);
    },
    'location.takeEarlier': () => {
      requireLocationService();
      return deps.location.takeEarlier();
    },
    'location.forgetEarlier': async () => {
      requireLocationService();
      await deps.location.forgetEarlier();
    },
    'location.allowDetect': async () => {
      requireLocationService();
      try { return await deps.location.allowDetect(); }
      catch (error) { throw new BridgeError(error.message, 'Error'); }
    },
    'location.subscribe': () => {
      requireTarget(LOCATION, 'follow the location from');
      if (!locationWatch) locationWatch = deps.location.subscribe(value => post({ topic: 'location', payload: value }));
    },

    // atmos.nowPlaying (SDK 1.4): what this extension plays, for the Now
    // Playing service ("invokes": ["service:now-playing"]). Core checks the
    // session and stamps it with this extension (now-playing.js); controls
    // come back to this extension's frames as topic 'nowPlaying.control'.
    'nowPlaying.set': async (session, key) => {
      requireTarget(NOW_PLAYING, 'show what it plays in');
      try { await deps.nowPlaying.set(key ?? 'main', session); }
      catch (error) { throw new BridgeError(error.message, error.name === 'RangeError' ? 'RangeError' : 'TypeError'); }
    },
    'nowPlaying.clear': async key => {
      requireTarget(NOW_PLAYING, 'show what it plays in');
      if (key != null && typeof key !== 'string') throw new BridgeError('atmos.nowPlaying.clear(key?)', 'TypeError');
      await deps.nowPlaying.clear(key ?? null);
    },
    // The Now Playing service itself, official: every session, and the
    // controls it sends to one (only those its extension takes).
    'nowPlaying.sessions': () => {
      requireNowPlayingService();
      // Asked again (another listener in the frame): the list again, at once.
      nowPlayingWatch?.();
      nowPlayingWatch = deps.nowPlaying.watch(list => post({ topic: 'nowPlaying.sessions', payload: list }));
    },
    'nowPlaying.control': (id, action, value) => {
      requireNowPlayingService();
      try { deps.nowPlaying.control(id, action, value ?? null); }
      catch (error) { throw new BridgeError(error.message, error.name === 'TypeError' ? 'TypeError' : 'Error'); }
    },

    // atmos.fetch(): an HTTP request the main process makes for the frame,
    // to a declared host (see extension-fetch.cjs, which checks it all
    // again). The SDK has turned the frame's arguments into a plain request.
    'fetch': async request => {
      const { id, url, method, headers, body, redirect } = plainObject(request, 'fetch request');
      if (!Number.isInteger(id) || id < 1) throw new BridgeError('fetch request id', 'TypeError');
      let parsed;
      try { parsed = new URL(url); } catch { throw new BridgeError(`'${String(url).slice(0, 200)}' is not a URL`, 'TypeError'); }
      if (parsed.protocol !== 'https:') throw new BridgeError(`atmos.fetch() only reaches https:// addresses (${parsed.protocol}//${parsed.host})`, 'TypeError');
      if (!hostAllowed(parsed.hostname.replace(/^\[|\]$/g, ''), extension.permissions?.network)) {
        throw new BridgeError(`${self} may not connect to ${parsed.hostname}; declare it in extension.json "permissions.network"`);
      }
      if (typeof method !== 'string' || !FETCH_METHODS.has(method)) throw new BridgeError(`atmos.fetch() doesn't send ${method} requests`, 'TypeError');
      if (!Array.isArray(headers) || !headers.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string'))) {
        throw new BridgeError('fetch headers must be [name, value] pairs', 'TypeError');
      }
      if (body != null && !(body instanceof ArrayBuffer)) throw new BridgeError('a fetch body arrives as an ArrayBuffer', 'TypeError');
      if (body && body.byteLength > MAX_FETCH_BODY) throw new BridgeError('a request body is at most 5 MB', 'TypeError');
      if (!deps.fetch) throw new BridgeError('atmos.fetch() is unavailable', 'Error');
      if (fetches.size >= MAX_FETCHES_PER_FRAME) {
        throw new BridgeError(`too many atmos.fetch() requests at once (at most ${MAX_FETCHES_PER_FRAME} from one frame)`, 'TypeError');
      }
      const requestId = `${serial}:${id}`;
      fetches.add(requestId);
      try {
        const answer = await deps.fetch(self, requestId, {
          url: parsed.href, method, headers, body: body ? new Uint8Array(body) : null,
          redirect: ['follow', 'error', 'manual'].includes(redirect) ? redirect : 'follow',
        });
        if (answer?.error) throw new BridgeError(answer.error.message, answer.error.name || 'TypeError');
        const { body: bytes, ...rest } = answer.result;
        return { ...rest, body: bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null };
      } finally {
        fetches.delete(requestId);
      }
    },
    'fetch.abort': id => {
      const requestId = `${serial}:${id}`;
      if (fetches.has(requestId)) deps.fetchAbort?.(self, requestId);
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
      requireShared(target, 'events', channel);
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
      requireShared(target, 'ipc', channel);
      // Stamped with this extension, so the main process can check it too,
      // and this frame, which it hears about again when the frame goes:
      // every call comes through the page, so the page is all it sees.
      calledMain = true;
      return deps.invokeMain({ caller: self, frame: frameId }, kind, id, channel, ...args);
    },

    'call': async (target, method, ...args) => {
      requireTarget(target, 'call');
      if (typeof method !== 'string') throw new BridgeError('call(target, method, ...args)', 'TypeError');
      requireShared(target, 'methods', method);
      // A background frame may still be starting; wait for it rather than
      // fail, unless this frame goes meanwhile: then the call is never made.
      let service = deps.services.get(target);
      if (!service && deps.awaitService) {
        service = await new Promise((resolve, reject) => {
          const cancel = () => reject(new BridgeError(`${self}'s frame went away`, 'Error'));
          waitingCalls.add(cancel);
          deps.awaitService(target).then(resolve, reject).finally(() => waitingCalls.delete(cancel));
        });
      }
      if (disposed) throw new BridgeError(`${self}'s frame went away`, 'Error');
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

    // A link to open (the SDK sends link clicks and window.open here):
    // http(s) or mailto only. Official extensions' open; a community one's
    // opens after a click in its frame and otherwise asks (main.js).
    'links.open': url => {
      if (typeof url !== 'string' || !url || url.length > MAX_WEB_URL) throw new BridgeError('links.open(url): url must be text', 'TypeError');
      if (!/^(https?:|mailto:)/i.test(url)) throw new BridgeError('links.open(url): only http(s) and mailto links open', 'TypeError');
      if (!deps.openLink) return false;
      return deps.openLink(url);
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

    'frame.loadFailed': message => {
      deps.frameLoadFailed?.(extension, surface.type, typeof message === 'string' ? message.slice(0, 200) : '');
    },

    'panel.show': () => {
      if (!deps.showPanel?.(extension)) throw new BridgeError(`${self} has no panel`, 'Error');
    },

    // Web pages (Atmos Browser): official extensions declaring "web": true.
    // Core's web layer and the main process decide what a page may do; these
    // only check who asks and the shape of what they send.
    'web.open': (tabId, options) => {
      const { url, private: isPrivate } = options && typeof options === 'object' ? options : {};
      if (url !== undefined && (typeof url !== 'string' || url.length > MAX_WEB_URL)) throw new BridgeError('web.open(tabId, { url }): url must be text', 'TypeError');
      return requireWeb().open(tabIdOf(tabId), { url: url || 'about:blank', private: isPrivate === true });
    },
    'web.close': (tabId, options) => requireWeb().close(tabIdOf(tabId), { sleep: options?.sleep === true }),
    'web.show': tabId => requireWeb().show(tabId === null ? null : tabIdOf(tabId)),
    'web.do': (tabId, name, ...args) => {
      const web = requireWeb();
      if (!WEB_COMMANDS.has(name)) throw new BridgeError(`unknown web command '${String(name).slice(0, 40)}'`, 'TypeError');
      if (name === 'navigate' || name === 'download') {
        if (typeof args[0] !== 'string' || args[0].length > (name === 'download' ? MAX_DOWNLOAD_URL : MAX_WEB_URL)) throw new BridgeError(`web.${name}(tabId, url): url must be text`, 'TypeError');
      }
      if (name === 'find' && args[0] != null && typeof args[0] !== 'string') throw new BridgeError('web.find(tabId, text)', 'TypeError');
      if (name === 'copyImage' && !(Number.isFinite(args[0]) && Number.isFinite(args[1]))) throw new BridgeError('web.copyImage(tabId, x, y)', 'TypeError');
      if (name === 'shield' && typeof args[0] !== 'boolean') throw new BridgeError('web.shield(tabId, on): on is true or false', 'TypeError');
      if (name === 'media') {
        if (!WEB_MEDIA_ACTIONS.has(args[0])) throw new BridgeError('web.media(tabId, action): toggle, next, previous or seek', 'TypeError');
        if (args[0] === 'seek' && !(Number.isFinite(args[1]) && args[1] >= 0)) throw new BridgeError('web.media(tabId, \'seek\', seconds)', 'TypeError');
      }
      return web.do(tabIdOf(tabId), name, ...args.slice(0, 2));
    },
    'web.list': () => requireWeb().list(),
    'web.setSurface': rect => {
      const web = requireWeb();
      if (surface.type !== 'panel') throw new BridgeError('only a panel shows web pages', 'Error');
      if (rect === null) return web.clearSurface();
      const clean = box => ({
        x: Math.round(finiteOr(box?.x, 0)), y: Math.round(finiteOr(box?.y, 0)),
        width: Math.max(0, Math.round(finiteOr(box?.width, 0))), height: Math.max(0, Math.round(finiteOr(box?.height, 0))),
      });
      return web.setSurface({
        ...clean(rect),
        over: (Array.isArray(rect?.over) ? rect.over : []).slice(0, 8).map(clean).filter(box => box.width > 0 && box.height > 0),
      });
    },
    'web.subscribe': () => {
      const web = requireWeb();
      if (!webWatch) webWatch = web.subscribe(payload => post({ topic: 'web', payload }));
    },
    'web.downloads': () => requireWeb().downloads(),
    'web.download': (id, action) => {
      if (typeof id !== 'string' || !['open', 'show', 'cancel', 'remove', 'pause', 'resume'].includes(action)) throw new BridgeError('web.downloads.<action>(id)', 'TypeError');
      return requireWeb().download(id, action);
    },
    'web.permissionRespond': (id, answer) => {
      if (typeof id !== 'string') throw new BridgeError('web.permissions.respond(requestId, { allow, remember })', 'TypeError');
      return requireWeb().respondPermission(id, { allow: answer?.allow === true, remember: answer?.remember !== false });
    },
    'web.externalRespond': (id, allow) => {
      if (typeof id !== 'string') throw new BridgeError('web.external.respond(requestId, allow)', 'TypeError');
      return requireWeb().respondExternal(id, allow === true);
    },
    'web.siteSettings': () => requireWeb().siteSettings(),
    'web.siteSetting': (origin, name, value) => {
      if (typeof origin !== 'string' || typeof name !== 'string' || ![null, 'allow', 'block'].includes(value)) {
        throw new BridgeError('web.permissions.set(origin, name, "allow" | "block" | null)', 'TypeError');
      }
      return requireWeb().setSiteSetting(origin, name, value);
    },
    'web.options': () => requireWeb().options(),
    // The ad and tracker blocker: its lists and totals, and updating them now.
    'web.adblock': () => requireWeb().adblock(),
    'web.adblockUpdate': () => requireWeb().adblockUpdate(),
    'web.setOptions': patch => requireWeb().setOptions(plainObject(patch, 'web options')),
    'web.clearData': what => {
      const { cookies, cache, siteSettings } = plainObject(what, 'what to clear');
      return requireWeb().clearData({ cookies: cookies === true, cache: cache === true, siteSettings: siteSettings === true });
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

    // rev/ commands (SDK 1.3): only those the extension declares in
    // "contributes.commands"; Core asks the frame to run them (requestCommand).
    'commands.handle': (name, meta) => {
      if (typeof name !== 'string' || !(extension.frame?.commands || []).some(command => command.name === name)) {
        throw new BridgeError(`rev/${String(name).slice(0, 40)} isn't a command ${self} declares ("contributes.commands" in its extension.json)`, 'TypeError');
      }
      deps.commands?.handle(name, { suggests: meta?.suggests === true });
    },
    'commands.unhandle': name => { if (typeof name === 'string') deps.commands?.unhandle(name); },
    // Where the panel's bottom bar is, so the command bar opens over it.
    'commands.bar': rect => {
      if (surface.type !== 'panel') throw new BridgeError('only a panel has a bar for the command bar', 'Error');
      deps.commands?.setBar(cleanBarRect(rect));
    },
    // rev/ typed into a field of the frame: Atmos's bar takes over, with the
    // text so far. Only from the frame the user is typing in; `follow`, keys
    // typed there before the bar had the keyboard (atmos.commands.field).
    'commands.open': (text, options, follow) => {
      if (typeof text !== 'string') throw new BridgeError('commands.open(text)', 'TypeError');
      if (!deps.commands?.open) throw new BridgeError('the command bar is unavailable here', 'Error');
      if (options != null) plainObject(options, 'options');
      return deps.commands.open(text.slice(0, 200), cleanOptionValues(options), follow === true);
    },
    'commands.refresh': () => deps.commands?.refresh(),

    // Notifications (no reply expected).
    'surface.resize': height => deps.resize?.(Math.max(0, Math.min(4000, Number(height) || 0))),
    'ui.key': init => deps.dispatchKey?.(init),
    'ui.pointerdown': () => deps.closeMenus?.(),
    'drawer.wheel': (deltaY, deltaMode) => {
      if (surface.drawer && Number.isFinite(deltaY)) deps.drawer?.wheel(deltaY, deltaMode);
    },
  };

  /**
   * Ask the frame to run one of its commands, or what to list for it
   * (action 'run' or 'suggest'). Rejects if it doesn't answer in time.
   */
  function requestCommand(action, name, input, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new BridgeError(`${self}'s frame went away`, 'Error')); return; }
      const id = nextCommand++;
      const timer = setTimeout(() => {
        commandRequests.delete(id);
        reject(new BridgeError(`${self} didn't answer`, 'TimeoutError'));
      }, timeout);
      commandRequests.set(id, { resolve, reject, timer });
      post({ command: id, action, name, input });
    });
  }

  /** This extension's audio channel, once Audio has started; refused if this frame went meanwhile. */
  async function audioChannel() {
    const channel = await deps.audio.channel();
    if (disposed) throw new BridgeError(`${self}'s frame went away`, 'Error');
    return channel;
  }

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
    if (message.commandReply !== undefined) {
      const pending = commandRequests.get(message.commandReply);
      commandRequests.delete(message.commandReply);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new BridgeError(String(message.error.message || 'The command failed').slice(0, 300), 'Error'));
      else pending.resolve(message.result);
      return;
    }
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
    locationWatch?.();
    locationWatch = null;
    webWatch?.();
    webWatch = null;
    nowPlayingWatch?.();
    nowPlayingWatch = null;
    // A panel that goes takes its page with it (the tab stays open).
    if (surface.type === 'panel' && deps.web) { try { deps.web.clearSurface(); } catch { /* not a web panel */ } }
    for (const requestId of fetches) deps.fetchAbort?.(self, requestId);
    fetches.clear();
    for (const pending of outgoingCalls.values()) pending.reject(new BridgeError('service stopped', 'Error'));
    outgoingCalls.clear();
    for (const cancel of waitingCalls) cancel();
    waitingCalls.clear();
    for (const pending of commandRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(`${self}'s frame went away`, 'Error'));
    }
    commandRequests.clear();
    if (deps.services.get(self)?.owner === bridge) deps.services.delete(self);
    if (calledMain) deps.frameClosed?.(frameId);
  }

  const bridge = { extension, surface, receive, post, dispose, requestCommand };
  return bridge;
}

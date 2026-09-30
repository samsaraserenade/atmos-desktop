/**
 * A stand-in for the Atmos SDK, for testing an extension's code in Node
 * without Atmos. It has the SDK's shape (the same calls, the same
 * refusals for undeclared hosts and targets), keeps everything in memory,
 * and lets the test see and steer what happens through `atmos.fake`.
 *
 *   // tests/stars.test.js — run with:
 *   //   node --import ./.atmos-sdk/testing/register.mjs --test tests/
 *   import { test } from 'node:test';
 *   import assert from 'node:assert/strict';
 *   import { installFakeAtmos } from '../.atmos-sdk/testing/fake-atmos.mjs';
 *
 *   test('shows the count', async () => {
 *     const atmos = installFakeAtmos({
 *       permissions: { network: ['api.github.com'] },
 *       fetch: { 'https://api.github.com/repos/o/r': { json: { stargazers_count: 42 } } },
 *     });
 *     const { loadStars } = await import('../src/stars.js'); // imports 'atmos-sdk'
 *     assert.equal(await loadStars(), 42);
 *     assert.equal(atmos.fake.requests.length, 1);
 *   });
 *
 * installFakeAtmos() makes the fake what `import atmos from 'atmos-sdk'`
 * gives (through register.mjs); createFakeAtmos() only makes one.
 *
 * MIT licence, like the SDK.
 */

const clone = value => (value === undefined ? undefined : structuredClone(value));

class AtmosPermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AtmosPermissionError';
  }
}

function hostAllowed(host, network) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  return !!name && (network || []).some(entry => entry === '*' || entry === name || (entry.startsWith('*.') && name.endsWith(entry.slice(1))));
}

/** A route's answer as a Response: a Response, or { status, headers, json | text | body }. */
function toResponse(answer) {
  if (answer instanceof Response) return answer;
  const { status = 200, statusText = '', headers = {}, json, text, body } = answer || {};
  if (json !== undefined) return new Response(JSON.stringify(json), { status, statusText, headers: { 'content-type': 'application/json', ...headers } });
  return new Response(text ?? body ?? null, { status, statusText, headers });
}

/**
 * @param {object} [options]
 * @param {{ id?: string, kind?: string, tier?: string, version?: string }} [options.extension]
 * @param {{ type?: string, id?: string, presentation?: string|null }} [options.surface]
 * @param {object} [options.permissions]    as in extension.json: network, invokes, browser
 * @param {object} [options.state]          the saved state to start from
 * @param {object|Function} [options.fetch] URL → answer, or (request) => answer
 * @param {object|null} [options.location]  { lat, lon, label, mode } or null
 * @param {object|null} [options.wallpaper] { mode, opacity, thumbnail } to start from (a data URL thumbnail, say)
 * @param {object} [options.appearance]
 */
export function createFakeAtmos(options = {}) {
  const extension = Object.freeze({ id: 'example', kind: 'plugin', tier: 'third-party', version: '0.0.0', ...options.extension });
  const self = `${extension.kind}:${extension.id}`;
  const permissions = { network: [], invokes: [], browser: [], ...options.permissions };
  const declared = target => target === self || (permissions.invokes || []).includes(target);
  const refuse = message => Promise.reject(new AtmosPermissionError(message));
  const listeners = new Map(); // topic -> Set<fn>
  const on = (topic, fn) => {
    if (typeof fn !== 'function') throw new TypeError('atmos: listener must be a function');
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => listeners.get(topic)?.delete(fn);
  };
  const deliver = (topic, payload) => { for (const fn of [...(listeners.get(topic) || [])]) fn(clone(payload)); };

  let saved = clone(options.state) || {};
  let location = options.location === undefined ? null : clone(options.location);
  // What a system service call needs declared, refused as Atmos refuses it.
  const needs = (target, what) => (declared(target) ? null
    : new AtmosPermissionError(`${self} is not permitted to ${what} ${target}; declare it in extension.json "permissions.invokes"`));
  // A subscription Atmos refuses doesn't throw: the SDK logs it.
  const follow = (topic, target, what, label, fn) => {
    const off = on(topic, fn);
    const refused = needs(target, what);
    if (refused) { off(); console.error(`[atmos-sdk] cannot follow ${label}:`, refused.message); }
    return off;
  };

  // The audio channel, as the Audio service reports it (core/system/audio/engine.js).
  let audioState = Object.freeze({ type: 'source', id: null, source: null, loop: false, playing: false, currentTime: 0, duration: 0, volume: 1, ended: false, error: null });
  const setAudio = (patch, type) => {
    audioState = Object.freeze({ ...audioState, ...clone(patch), type });
    deliver('audio', audioState);
    return audioState;
  };
  // The wallpaper as a frame sees it; `mine` is whether this extension set it.
  let wallpaperNow = options.wallpaper === null ? null : { mode: 'wallpaper', opacity: 100, thumbnail: null, ...clone(options.wallpaper || {}) };
  let wallpaperMine = false;
  let wallpaperBefore = null;
  const wallpaperSummary = () => (wallpaperNow ? { ...wallpaperNow, canRestore: wallpaperMine } : null);
  let exposed = {};
  const handlers = new Map(); // "target channel" -> fn
  const menuChoices = [];
  const cleanups = new Set();
  const timers = new Set();
  const controller = new AbortController();

  const fake = {
    /** The saved state now. */
    get state() { return clone(saved); },
    /** Events emitted: [{ name, payload }]. */
    emitted: [],
    /** atmos.fetch() requests made: Request objects. */
    requests: [],
    /** Menus opened: [{ x, y, items }]. */
    menus: [],
    /** Notifications shown. */
    notifications: [],
    /** What the clipboard was given. */
    clipboard: [],
    /** Times atmos.panel.show() was called. */
    panelShown: 0,
    /** The last image atmos.wallpaper.set() was given (null after restore()). */
    wallpaper: null,
    /** Change the wallpaper as the user would in Settings (onChange listeners hear it; restore() then does nothing). */
    setWallpaper(next) {
      wallpaperNow = next ? { mode: 'wallpaper', opacity: 100, thumbnail: null, ...clone(next) } : null;
      wallpaperMine = false;
      deliver('wallpaper', wallpaperSummary());
    },
    /** The audio channel: what load() was given, and playback steered from the test. */
    audio: {
      /** Each load(): { source, id, position, play, loop }. */
      loads: [],
      /** The channel's state now, as state() gives it. */
      get state() { return audioState; },
      /** Change the state as playback would, and tell onChange listeners (type: 'time', 'loaded', …). */
      update(patch, type = 'time') { return setAudio(patch, type); },
      /** The source reaches its end: with loop it starts over ('time'), otherwise it stops ('ended'). */
      end() {
        return audioState.loop
          ? setAudio({ currentTime: 0 }, 'time')
          : setAudio({ playing: false, ended: true, currentTime: audioState.duration }, 'ended');
      },
    },
    /** Change the state as another frame would (onChange listeners hear it). */
    setState(next) { saved = clone(next); deliver('state', saved); },
    /** Deliver an event, as another frame (or extension) emitting it would. */
    emit(name, payload) { deliver(`event:${name}`, payload); },
    /** Change the location as the user would in Settings. */
    setLocation(next) { location = clone(next); deliver('location', location); },
    /** Deliver a main-process event (listen()). */
    send(target, channel, ...args) { for (const fn of [...(listeners.get(`main:${target} ${channel}`) || [])]) fn(...clone(args)); },
    /** What the next contextMenu.open() resolves with (an id, { id, value }, or null). */
    chooseFromMenu(choice) { menuChoices.push(choice); },
    /** A handler for invoke(target, channel, ...args). */
    handle(target, channel, fn) { handlers.set(`${target} ${channel}`, fn); },
    /** Methods of another extension's boot frame, for call(). */
    exposeFor(target, methods) { handlers.set(`call:${target}`, methods); },
    /** The methods this extension's boot.js exposed. */
    get exposed() { return exposed; },
    /** The frame goes away: lifecycle cleanups run and its signal aborts. */
    unload() {
      if (controller.signal.aborted) return;
      controller.abort(new DOMException('The frame is going away.', 'AbortError'));
      for (const handle of timers) { clearTimeout(handle); clearInterval(handle); }
      timers.clear();
      for (const fn of [...cleanups].reverse()) fn();
      cleanups.clear();
    },
  };

  const onCleanup = fn => {
    if (controller.signal.aborted) { fn(); return () => {}; }
    const entry = () => fn();
    cleanups.add(entry);
    return () => cleanups.delete(entry);
  };

  async function fakeFetch(input, init) {
    const request = new Request(input, init);
    if (request.signal.aborted) throw request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new TypeError(`atmos.fetch() only reaches https:// addresses (${url.protocol}//${url.host})`);
    if (!hostAllowed(url.hostname, permissions.network)) throw new AtmosPermissionError(`${self} may not connect to ${url.hostname}; declare it in extension.json "permissions.network"`);
    fake.requests.push(request.clone());
    const routes = options.fetch;
    const answer = typeof routes === 'function' ? await routes(request) : routes?.[request.url] ?? routes?.[`${request.method} ${request.url}`];
    if (answer === undefined) throw new TypeError(`no fake response for ${request.method} ${request.url}`);
    if (answer instanceof Error) throw answer;
    return toResponse(answer);
  }

  const atmos = {
    SDK_VERSION: '1.1.0',
    ready: Promise.resolve({ extension }),
    extension,
    surface: {
      type: 'panel', id: extension.id, presentation: 'full', glass: false, drawer: null, ...options.surface,
      setMenu: async items => { fake.headerMenu = items; },
      setGlass: async regions => { fake.glass = regions; },
      trackGlass: () => () => {},
      onKey: fn => on('key', fn),
    },
    state: {
      get: async () => clone(saved),
      set: async value => { saved = clone(value); },
      update: async patch => { saved = { ...saved, ...clone(patch) }; },
      onChange: fn => on('state', fn),
    },
    events: {
      emit: async (name, payload) => {
        if (typeof name !== 'string' || name.includes(':')) throw new TypeError('extensions emit only their own events (no "<id>:" prefix)');
        fake.emitted.push({ name, payload: clone(payload) });
        deliver(`event:${name}`, payload);
      },
      on: (name, fn) => on(`event:${name}`, fn),
    },
    appearance: {
      get: async () => clone({ theme: null, colorScheme: 'dark', vars: {}, font: null, ...options.appearance }),
      onChange: fn => on('appearance', fn),
    },
    contextMenu: {
      async open(x, y, items) {
        fake.menus.push({ x, y, items });
        const choice = menuChoices.length ? menuChoices.shift() : null;
        const id = choice && typeof choice === 'object' ? choice.id : choice;
        const item = (items || []).find(candidate => candidate.id === id);
        if (item?.run) choice && typeof choice === 'object' ? item.run(choice.value) : item.run();
        return choice;
      },
      close: async () => {},
    },
    clipboard: {
      writeText: async text => { fake.clipboard.push({ text: String(text) }); },
      writeImage: async (png, text) => { fake.clipboard.push({ image: png, text }); },
    },
    panel: { show: async () => { fake.panelShown += 1; } },
    invoke: async (target, channel, ...args) => {
      if (!declared(target)) return refuse(`${self} is not permitted to invoke ${target}; declare it in extension.json "permissions.invokes"`);
      const fn = handlers.get(`${target} ${channel}`);
      if (!fn) throw new Error(`no fake handler for ${target} '${channel}' (atmos.fake.handle())`);
      return clone(await fn(...clone(args)));
    },
    listen: (target, channel, fn) => on(`main:${target} ${channel}`, (...args) => fn(...args)),
    call: async (target, method, ...args) => {
      if (!declared(target)) return refuse(`${self} is not permitted to call ${target}; declare it in extension.json "permissions.invokes"`);
      const methods = target === self ? exposed : handlers.get(`call:${target}`);
      if (typeof methods?.[method] !== 'function') throw new Error(`${target} does not expose '${method}'`);
      return clone(await methods[method](...clone(args)));
    },
    expose: async methods => { exposed = methods; },
    library: async (target, file) => {
      if (!declared(target)) return refuse(`${self} is not permitted to import ${target}; declare it in extension.json "permissions.invokes"`);
      return `atmos-library://${target.split(':')[1]}/${file}`;
    },
    wallpaper: {
      async set(file) {
        const refused = needs('service:wallpaper', 'set the wallpaper through');
        if (refused) throw refused;
        if (!(file instanceof Blob) || !/^image\//.test(file.type || '')) throw new TypeError('wallpaper.set(file) needs an image File or Blob');
        if (!wallpaperMine) wallpaperBefore = wallpaperNow;
        fake.wallpaper = file;
        wallpaperNow = { mode: wallpaperNow?.mode ?? 'wallpaper', opacity: wallpaperNow?.opacity ?? 100, thumbnail: null };
        wallpaperMine = true;
        deliver('wallpaper', wallpaperSummary());
      },
      async restore() {
        const refused = needs('service:wallpaper', 'restore the wallpaper through');
        if (refused) throw refused;
        if (!wallpaperMine) return false;
        wallpaperNow = wallpaperBefore;
        wallpaperMine = false;
        fake.wallpaper = null;
        deliver('wallpaper', wallpaperSummary());
        return true;
      },
      async get() {
        const refused = needs('service:wallpaper', 'read the wallpaper of');
        if (refused) throw refused;
        return clone(wallpaperSummary());
      },
      onChange: fn => follow('wallpaper', 'service:wallpaper', 'follow the wallpaper of', 'the wallpaper', fn),
    },
    audio: (() => {
      const check = () => { const refused = needs('service:audio', 'play audio through'); if (refused) throw refused; };
      return {
        async load(source, loadOptions) {
          check();
          if (!(source instanceof Blob) && !(typeof source === 'string' && source.startsWith('atmos-resource://'))) {
            throw new TypeError('audio.load(source) takes a Blob, or an atmos-resource:// URL from a provider the extension registers or invokes');
          }
          const { id = null, position = 0, play = false, loop = false } = loadOptions && typeof loadOptions === 'object' ? loadOptions : {};
          const label = id == null ? null : String(id).slice(0, 500);
          fake.audio.loads.push({ source, id: label, position: Math.max(0, Number(position) || 0), play: play === true, loop: loop === true });
          const loaded = setAudio({ id: label, source: label, loop: loop === true, playing: false, currentTime: 0, duration: 0, ended: false, error: null }, 'source');
          if (play === true) setAudio({ playing: true }, 'play');
          return loaded;
        },
        async play() { check(); if (audioState.source === null && !fake.audio.loads.length) return false; setAudio({ playing: true, ended: false }, 'play'); return true; },
        async pause() { check(); setAudio({ playing: false }, 'pause'); },
        async seek(seconds) {
          check();
          if (!Number.isFinite(seconds)) throw new TypeError('audio.seek(seconds)');
          const target = Math.max(0, seconds);
          setAudio({ currentTime: audioState.duration ? Math.min(target, audioState.duration) : target }, 'time');
        },
        async setVolume(value) {
          check();
          if (!Number.isFinite(value)) throw new TypeError('audio.setVolume(0–1)');
          setAudio({ volume: Math.max(0, Math.min(1, value)) }, 'volume');
        },
        async stop() { check(); setAudio({ id: null, source: null, loop: false, playing: false, currentTime: 0, duration: 0, ended: false, error: null }, 'source'); },
        async state() { check(); return { ...audioState, type: 'state' }; },
        onChange: fn => follow('audio', 'service:audio', 'play audio through', 'audio', fn),
      };
    })(),
    fetch: fakeFetch,
    location: {
      get: async () => (declared('service:location') ? clone(location) : refuse(`${self} is not permitted to read the location from service:location; declare it in extension.json "permissions.invokes"`)),
      onChange: fn => follow('location', 'service:location', 'follow the location from', 'the location', fn),
    },
    lifecycle: {
      signal: controller.signal,
      onCleanup,
      listen(target, type, fn, listenerOptions = {}) {
        const base = typeof listenerOptions === 'boolean' ? { capture: listenerOptions } : { ...listenerOptions };
        target.addEventListener(type, fn, base);
        const remove = onCleanup(() => target.removeEventListener(type, fn, base));
        return () => { remove(); target.removeEventListener(type, fn, base); };
      },
      setTimeout(fn, delay, ...args) {
        const handle = setTimeout((...values) => { timers.delete(handle); fn(...values); }, delay, ...args);
        timers.add(handle);
        return handle;
      },
      setInterval(fn, delay, ...args) {
        const handle = setInterval(fn, delay, ...args);
        timers.add(handle);
        return handle;
      },
    },
    notifications: {
      show: async notification => {
        if (!(permissions.browser || []).includes('notifications')) return refuse(`${self} may not show notifications; declare "notifications" in extension.json "permissions.browser"`);
        fake.notifications.push(clone(notification));
        return true;
      },
      onClick: fn => on('notificationClick', fn),
    },
    drawer: { state: null, onChange: fn => on('drawer', fn), onKey: fn => on('drawerKey', fn), open: async () => {}, close: async () => {}, expand: async () => {}, collapse: async () => {}, setBarPlacement: async () => {}, setPlacement: async () => {} },
    legacy: { readIndexedDB: async () => null, readState: async () => null, readLocalStorage: async () => ({}), deleteIndexedDB: async () => [] },
    background: async () => { throw new Error('background() is for first-party extensions'); },
    fake,
  };
  return atmos;
}

/** Make a fake the one `import atmos from 'atmos-sdk'` gives (see register.mjs), and return it. */
export function installFakeAtmos(options) {
  const atmos = createFakeAtmos(options);
  globalThis.__atmosFake = atmos;
  return atmos;
}

export { AtmosPermissionError };

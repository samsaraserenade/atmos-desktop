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

import { normalizeSession, readArtwork, sessionKey } from '../now-playing-checks.mjs';

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
 * @param {object} [options.permissions]    as in extension.json: network, invokes, browser (and web, first-party)
 * @param {object} [options.state]          the saved state to start from
 * @param {object|Function} [options.fetch] URL → answer, or (request) => answer
 * @param {object|null} [options.location]  { lat, lon, label, mode } or null
 * @param {object|null} [options.wallpaper] { mode, opacity, thumbnail } to start from (a data URL thumbnail, say)
 * @param {object} [options.appearance]
 * @param {Array<{ name: string }>} [options.commands]  as in extension.json "contributes.commands" (SDK 1.3)
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
  // Now Playing (SDK 1.4): this extension's sessions by key, checked as Atmos
  // checks them (../now-playing-checks.mjs, which Atmos itself uses).
  const nowPlayingSessions = new Map();
  let nowPlayingChain = Promise.resolve(); // set and clear apply in the order asked, as in Atmos
  const inOrder = job => { const run = nowPlayingChain.then(job); nowPlayingChain = run.catch(() => {}); return run; };
  const isNowPlayingService = () => extension.kind === 'service' && extension.id === 'now-playing' && extension.tier !== 'third-party';
  const isLocationService = () => extension.kind === 'service' && extension.id === 'location' && extension.tier !== 'third-party';
  const notLocationService = () => new AtmosPermissionError("only Atmos's Location service sets the location");

  // The wallpaper as a frame sees it; `mine` is whether this extension set it.
  let wallpaperNow = options.wallpaper === null ? null : { mode: 'wallpaper', opacity: 100, thumbnail: null, ...clone(options.wallpaper || {}) };
  let wallpaperMine = false;
  let wallpaperBefore = null;
  const wallpaperSummary = () => (wallpaperNow ? { ...wallpaperNow, canRestore: wallpaperMine } : null);
  let exposed = {};
  const handlers = new Map(); // "target channel" -> fn
  const menuChoices = [];
  // rev/ commands (SDK 1.3): those declared, and the handlers registered for them.
  const declaredCommands = new Set((options.commands || []).map(command => String(command?.name || '').toLowerCase()).filter(Boolean));
  const commandHandlers = new Map(); // name -> { run, suggest }
  const cleanups = new Set();
  const timers = new Set();
  const controller = new AbortController();

  // Web pages (first-party, SDK 1.2): refused as Atmos refuses them; for an
  // official extension declaring "web": true, recorded in fake.web.
  const webPages = new Map(); // tabId -> { url, title, private, zoom, muted, back: [], forward: [], blocked }
  const webRecord = { calls: [], surface: null, shown: null, options: { openLinks: false, askWhereToSave: true, blockAds: true }, adsAllowed: [] };
  const webAllowed = () => extension.tier !== 'third-party' && permissions.web === true;
  const webRefusal = () => refuse(`${self} may not show web pages; that takes "web": true in its permissions, for official extensions`);
  const siteOfUrl = url => { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : ''; } catch { return ''; } };
  const shieldOf = page => {
    const origin = siteOfUrl(page.url);
    if (!origin) return 'none';
    if (webRecord.options.blockAds === false) return 'disabled';
    return webRecord.adsAllowed.includes(origin) ? 'off' : 'on';
  };
  const webState = (tabId, page) => ({
    tabId, private: page.private, url: page.url, title: page.title, loading: false, canGoBack: page.back.length > 0,
    canGoForward: page.forward.length > 0, audible: false, muted: page.muted, zoom: page.zoom, secure: page.url.startsWith('https:'),
    blocked: page.blocked || 0, shield: shieldOf(page),
  });
  function fakeWeb() {
    const guard = (name, run) => (...args) => {
      if (!webAllowed()) return webRefusal();
      webRecord.calls.push({ name, args: clone(args) });
      return Promise.resolve().then(() => run(...args));
    };
    const page = tabId => { if (!webPages.has(tabId)) throw new Error(`no tab ${tabId}`); return webPages.get(tabId); };
    const go = (tabId, url, type = 'navigated') => {
      const current = page(tabId);
      current.url = url;
      current.title = url;
      current.blocked = 0;
      deliver('web', { type, tabId, url, title: current.title, inPage: false });
      deliver('web', { type: 'state', tabId, ...webState(tabId, current) });
    };
    return {
      open: guard('open', (tabId, { url = 'about:blank', private: isPrivate = false } = {}) => {
        if (webPages.has(tabId)) throw new Error(`tab ${tabId} is already open`);
        webPages.set(tabId, { url: 'about:blank', title: '', private: isPrivate === true, zoom: 1, muted: false, back: [], forward: [] });
        if (url !== 'about:blank') go(tabId, url);
        return webState(tabId, page(tabId));
      }),
      close: guard('close', async (tabId, { sleep = false } = {}) => {
        // Put to sleep, a page that objects to being left stays (Atmos asks it without a dialog).
        if (sleep === true) {
          const held = webPages.get(tabId)?.held;
          if (held) await held;
          if (webPages.get(tabId)?.unsaved) return false;
        }
        const had = webPages.delete(tabId);
        if (webRecord.shown === tabId) webRecord.shown = null;
        return had;
      }),
      show: guard('show', tabId => { if (tabId !== null) page(tabId); webRecord.shown = tabId ?? null; return true; }),
      list: guard('list', () => [...webPages].map(([tabId, value]) => webState(tabId, value))),
      navigate: guard('navigate', (tabId, url) => {
        const current = page(tabId);
        if (!/^https?:\/\//i.test(url) && url !== 'about:blank') throw new Error(`${url} isn't opened in Atmos Browser`);
        current.back.push(current.url);
        current.forward = [];
        go(tabId, url);
        return 'loading';
      }),
      back: guard('back', tabId => { const current = page(tabId); if (current.back.length) { current.forward.push(current.url); go(tabId, current.back.pop()); } }),
      forward: guard('forward', tabId => { const current = page(tabId); if (current.forward.length) { current.back.push(current.url); go(tabId, current.forward.pop()); } }),
      reload: guard('reload', tabId => { page(tabId); }),
      stop: guard('stop', tabId => { page(tabId); }),
      zoom: guard('zoom', (tabId, direction) => {
        const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
        const current = page(tabId);
        const at = steps.indexOf(current.zoom);
        current.zoom = direction === 'reset' ? 1 : steps[Math.max(0, Math.min(steps.length - 1, at + (direction === 'in' ? 1 : -1)))];
        return current.zoom;
      }),
      find: guard('find', (tabId, text) => { page(tabId); return text ? webRecord.calls.length : null; }),
      stopFind: guard('stopFind', tabId => { page(tabId); }),
      print: guard('print', tabId => { page(tabId); return true; }),
      mute: guard('mute', (tabId, muted) => { page(tabId).muted = muted === true; return muted === true; }),
      edit: guard('edit', tabId => { page(tabId); }),
      download: guard('download', tabId => { page(tabId); }),
      copyImage: guard('copyImage', tabId => { page(tabId); }),
      focus: guard('focus', tabId => { page(tabId); }),
      media: guard('media', (tabId, action, value) => {
        page(tabId);
        if (!['toggle', 'next', 'previous', 'seek'].includes(action)) throw new TypeError('web.media(tabId, action): toggle, next, previous or seek');
        if (action === 'seek' && !(Number.isFinite(value) && value >= 0)) throw new TypeError("web.media(tabId, 'seek', seconds)");
      }),
      state: guard('state', tabId => webState(tabId, page(tabId))),
      shield: guard('shield', (tabId, on) => {
        const current = page(tabId);
        const origin = siteOfUrl(current.url);
        if (!origin) throw new Error('This isn’t a web page');
        webRecord.adsAllowed = webRecord.adsAllowed.filter(item => item !== origin);
        if (on === false) webRecord.adsAllowed.push(origin);
        deliver('web', { type: 'state', tabId, ...webState(tabId, current) });
        return shieldOf(current);
      }),
      blocked: guard('blocked', tabId => ({ count: page(tabId).blocked || 0, hosts: [] })),
      setSurface: guard('setSurface', rect => { webRecord.surface = clone(rect); }),
      onEvent(fn) {
        const off = on('web', fn);
        if (!webAllowed()) { off(); console.error('[atmos-sdk] cannot follow web pages:', `${self} may not show web pages`); }
        return off;
      },
      downloads: Object.fromEntries(['list', 'open', 'show', 'cancel', 'pause', 'resume', 'remove']
        .map(name => [name, guard(`downloads.${name}`, () => (name === 'list' ? [] : true))])),
      permissions: {
        respond: guard('permissions.respond', () => true),
        list: guard('permissions.list', () => []),
        set: guard('permissions.set', () => []),
      },
      external: { respond: guard('external.respond', () => true) },
      adblock: {
        status: guard('adblock.status', () => ({
          enabled: webRecord.options.blockAds !== false, state: 'ready', error: null, updatedAt: 0, rules: 0, total: 0, lists: [],
        })),
        update: guard('adblock.update', () => ({
          enabled: webRecord.options.blockAds !== false, state: 'ready', error: null, updatedAt: 0, rules: 0, total: 0, lists: [],
        })),
      },
      options: guard('options', () => ({ ...webRecord.options })),
      setOptions: guard('setOptions', patch => { Object.assign(webRecord.options, clone(patch)); return { ...webRecord.options }; }),
      clearData: guard('clearData', () => true),
    };
  }

  const fake = {
    /** The saved state now. */
    get state() { return clone(saved); },
    /** Web pages (first-party): { pages, surface, shown, calls, options, adsAllowed }. */
    get web() { return { ...clone(webRecord), pages: Object.fromEntries([...webPages].map(([tabId, value]) => [tabId, webState(tabId, value)])) }; },
    /** What Atmos would tell the extension's frames about its pages (atmos.web.onEvent listeners hear it). */
    webEvent(event) { deliver('web', event); },
    /** Putting a tab's page to sleep takes until the returned function is called (its page unloading). */
    webHoldSleep(tabId) {
      const current = webPages.get(tabId);
      if (!current) throw new Error(`no tab ${tabId}`);
      let release;
      current.held = new Promise(resolve => { release = resolve; }).then(() => { current.held = null; });
      return release;
    },
    /** A tab's page objects to being left (its beforeunload: unsaved changes), or no longer does. */
    webUnsaved(tabId, unsaved) {
      const current = webPages.get(tabId);
      if (!current) throw new Error(`no tab ${tabId}`);
      current.unsaved = unsaved === true;
    },
    /** `count` ads and trackers blocked on a tab's page, as Atmos would report it. */
    webBlocked(tabId, count) {
      const current = webPages.get(tabId);
      if (!current) throw new Error(`no tab ${tabId}`);
      current.blocked = count;
      deliver('web', { type: 'state', tabId, ...webState(tabId, current) });
    },
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
    /** rev/ commands (SDK 1.3): the element atmos.commands.bar() was given (null after stop()). */
    commandBar: null,
    /** Each atmos.commands.open(), and each rev/ typed into an atmos.commands.field(): { text, options }. */
    commandBarOpened: [],
    /** Times atmos.commands.refresh() was called. */
    commandRefreshes: 0,
    /** The commands handled now, by name. */
    get commandsHandled() { return [...commandHandlers.keys()]; },
    /** Run a handled command as the bar would: input { args, value, options }. Resolves what it returned. */
    async runCommand(name, input = {}) {
      const handler = commandHandlers.get(name);
      if (!handler) throw new Error(`rev/${name} isn't handled (atmos.commands.handle())`);
      return clone(await handler.run({ args: '', value: null, options: {}, ...clone(input) }));
    },
    /** What a handled command lists for input { args, options }, as the bar would ask. */
    async suggestCommand(name, input = {}) {
      const handler = commandHandlers.get(name);
      if (typeof handler?.suggest !== 'function') throw new Error(`rev/${name} lists nothing (atmos.commands.handle(name, run, { suggest }))`);
      return clone(await handler.suggest({ args: '', options: {}, ...clone(input) }));
    },
    /** Now Playing (SDK 1.4): this extension's sessions as Atmos holds them, by key. */
    get nowPlaying() { return Object.fromEntries([...nowPlayingSessions].map(([key, session]) => [key, clone(session)])); },
    /** Use the widget on one of this extension's sessions: onControl hears { key, action, value }. */
    controlNowPlaying(key = 'main', action = 'toggle', value = null) {
      const session = nowPlayingSessions.get(key);
      if (!session) throw new Error(`no Now Playing session '${key}'`);
      if (!session.actions.includes(action)) throw new TypeError(`this session doesn't take “${action}” (its actions: ${session.actions.join(', ') || 'none'})`);
      // As Atmos sends it: seek in seconds within the length, volume 0–100.
      let amount = null;
      if (action === 'seek') {
        if (!Number.isFinite(value) || value < 0) throw new TypeError('seek to a number of seconds, 0 or more');
        amount = session.duration == null ? value : Math.min(value, session.duration);
      } else if (action === 'volume') {
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError('volume is 0–100');
        amount = value;
      }
      deliver('nowPlaying.control', { key, action, value: amount });
    },
    /** As the Now Playing service: what atmos.nowPlaying.sessions() listeners hear. */
    showNowPlaying(sessions) { deliver('nowPlaying.sessions', sessions); },
    /** As the Now Playing service: the controls it sent ({ id, action, value }). */
    nowPlayingControls: [],
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
    /** A key a background frame declared ("keys": ["Space"]), pressed in Atmos: surface.onKey hears { code }. */
    pressKey(code) { deliver('key', { code }); },
    /** Deliver an event, as another frame (or extension) emitting it would. */
    emit(name, payload) { deliver(`event:${name}`, payload); },
    /** Change the location as the user would in Settings. */
    setLocation(next) { location = clone(next); deliver('location', location); },
    /** As the Location service: what it published, in order. */
    locationPublished: [],
    /** The location Atmos kept before 0.21, for the Location service to take (once). */
    earlierLocation: options.earlierLocation === undefined ? null : clone(options.earlierLocation),
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
    SDK_VERSION: '1.6.0',
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
    commands: {
      handle(name, run, { suggest } = {}) {
        if (typeof name !== 'string' || !name) throw new TypeError('atmos.commands.handle(name, run): name is a command declared in extension.json');
        if (typeof run !== 'function') throw new TypeError('atmos.commands.handle(name, run): run must be a function');
        if (suggest !== undefined && typeof suggest !== 'function') throw new TypeError('atmos.commands.handle(name, run, { suggest }): suggest must be a function');
        if (!declaredCommands.has(name)) {
          // Atmos refuses it after the call: the SDK logs why.
          console.error(`[atmos-sdk] cannot handle rev/${name}:`, `rev/${name} isn't a command ${self} declares ("contributes.commands" in its extension.json)`);
          return () => {};
        }
        const handler = { run, suggest };
        commandHandlers.set(name, handler);
        return () => { if (commandHandlers.get(name) === handler) commandHandlers.delete(name); };
      },
      bar(element) {
        if (!element?.getBoundingClientRect) throw new TypeError('atmos.commands.bar(element): an element of this frame');
        fake.commandBar = element;
        return () => { if (fake.commandBar === element) fake.commandBar = null; };
      },
      field(element, { options: preset } = {}) {
        if (!element || typeof element.addEventListener !== 'function' || !('value' in element)) throw new TypeError('atmos.commands.field(input): a text field of this frame');
        // rev/ typed into it opens the bar (fake.commandBarOpened), and the field empties.
        const onInput = () => {
          const value = String(element.value ?? '');
          if (!/^\s*rev\//i.test(value)) return;
          element.value = '';
          fake.commandBarOpened.push({ text: value.trimStart(), options: clone(preset ?? null) });
        };
        element.addEventListener('input', onInput);
        return () => element.removeEventListener('input', onInput);
      },
      open: async (text = '', openOptions = undefined) => { fake.commandBarOpened.push({ text: String(text ?? ''), options: clone(openOptions ?? null) }); },
      refresh: () => { fake.commandRefreshes += 1; },
    },
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
    nowPlaying: {
      async set(session, key = 'main') {
        const refused = needs('service:now-playing', 'show what it plays in');
        if (refused) throw refused;
        const id = sessionKey(key ?? 'main');
        const checked = normalizeSession(session);
        return inOrder(async () => {
          const art = await readArtwork(session.artwork);
          if (!nowPlayingSessions.has(id) && nowPlayingSessions.size >= 16) throw new RangeError('an extension shows 16 sessions in Now Playing at most');
          const others = [...nowPlayingSessions].filter(([other]) => other !== id).reduce((sum, [, item]) => sum + (item.artwork?.size ?? 0), 0);
          if (art && others + art.bytes > 4 * 1024 * 1024) throw new RangeError('an extension’s Now Playing artwork is 4 MB at most, all together');
          nowPlayingSessions.set(id, { ...checked, artwork: art?.blob ?? null });
        });
      },
      async clear(key = null) {
        const refused = needs('service:now-playing', 'show what it plays in');
        if (refused) throw refused;
        if (key != null && typeof key !== 'string') throw new TypeError('atmos.nowPlaying.clear(key?)');
        return inOrder(() => {
          if (key == null) nowPlayingSessions.clear();
          else nowPlayingSessions.delete(key);
        });
      },
      onControl: fn => {
        if (typeof fn !== 'function') throw new TypeError('atmos.nowPlaying.onControl(fn)');
        return on('nowPlaying.control', fn);
      },
      sessions(fn) {
        if (typeof fn !== 'function') throw new TypeError('atmos.nowPlaying.sessions(fn)');
        const off = on('nowPlaying.sessions', fn);
        if (!isNowPlayingService()) { off(); console.error('[atmos-sdk] cannot follow Now Playing:', 'only Atmos\'s Now Playing service sees what extensions play'); }
        return off;
      },
      async control(id, action, value = null) {
        if (!isNowPlayingService()) throw new AtmosPermissionError('only Atmos\'s Now Playing service sees what extensions play');
        fake.nowPlayingControls.push({ id, action, value });
      },
    },
    fetch: fakeFetch,
    location: {
      get: async () => (declared('service:location') ? clone(location) : refuse(`${self} is not permitted to read the location from service:location; declare it in extension.json "permissions.invokes"`)),
      onChange: fn => follow('location', 'service:location', 'follow the location from', 'the location', fn),
      // The Location service's own: what it publishes reaches readers (fake.location).
      async publish(next) {
        if (!isLocationService()) throw notLocationService();
        location = next == null ? null : clone(next);
        fake.locationPublished.push(clone(location));
        deliver('location', location);
      },
      // What Atmos kept before 0.21 (fake.earlierLocation): it stays until forgotten.
      async takeEarlier() {
        if (!isLocationService()) throw notLocationService();
        return clone(fake.earlierLocation);
      },
      async forgetEarlier() {
        if (!isLocationService()) throw notLocationService();
        fake.earlierLocation = null;
      },
      async allowDetect() {
        if (!isLocationService()) throw notLocationService();
        return true;
      },
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
    web: fakeWeb(),
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

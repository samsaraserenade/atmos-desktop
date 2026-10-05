'use strict';
/**
 * Atmos Browser's one script in web pages (web-host.cjs gives it to every
 * tab and pop-up; the attach check refuses any other preload). It runs in
 * its own, isolated world: the page's scripts can't reach it or anything it
 * holds. It runs sandboxed, with only Electron's renderer modules.
 *
 * 1. Chrome's pages have `window.chrome.loadTimes`, `.csi` and `.app`;
 *    Electron's have an empty `window.chrome`. Google's sign-in reads a
 *    Chrome user agent with an empty `chrome` as a browser embedded in an app
 *    and refuses to sign in ("This browser or app may not be secure"). So,
 *    before the page's own scripts run, this gives the page's world those
 *    three members as Chrome has them (the same keys, attributes and values;
 *    checked against Chromium 141). They only report on the page itself.
 *
 * 2. The ad blocker (web-adblock.cjs): it asks Core, synchronously as the
 *    page starts, for the styles that hide this page's ad slots and the
 *    lists' scriptlets for it, and runs those before the page's own scripts
 *    (in the page's world, or in a world of their own for the ones uBlock
 *    Origin runs in its content script's); then, as the page grows, it sends
 *    the class names, ids and links it finds and inserts the styles that
 *    come back. Two channels,
 *    `atmos-web:page-filters` and `atmos-web:page-tokens`: Core answers only
 *    for this page's own address (it reads it from the frame), only for
 *    Atmos Browser's pages, and within a budget per page. Nothing else goes
 *    to Core, and nothing is exposed to the page.
 *
 * 3. Atmos's thin scrollbar instead of Windows' (PAGE_SCROLLBAR_CSS).
 *
 * 4. What plays, for Now Playing (watchMedia): the Media Session metadata
 *    the page set and its media elements' state, sent to Core
 *    (`atmos-web:page-media`, which Core checks and bounds), and the
 *    widget's controls back (`atmos-web:media-control`): play/pause, next,
 *    previous and seek, through the page's own Media Session handlers where
 *    it has them, as Chrome's media controls do, else on the media element.
 *    To call those handlers, setActionHandler is wrapped in the page's world
 *    before its scripts (installMediaSessionRelay); it reaches them through
 *    an event named by a random token. Muted media isn't reported.
 */
function installChromeMembers() {
  const chrome = window.chrome;
  if (!chrome || typeof chrome !== 'object' || 'app' in chrome || 'loadTimes' in chrome || 'csi' in chrome) return;
  const define = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  const navigation = () => performance.getEntriesByType('navigation')[0] || {};
  const origin = performance.timeOrigin;
  const at = ms => (ms > 0 ? Math.floor(origin + ms) / 1000 : 0);
  // As in Chrome: anonymous functions, with a prototype.
  const [loadTimes, csi] = [
    function () {
      const entry = navigation();
      const paint = performance.getEntriesByType('paint').find(item => item.name === 'first-paint');
      const protocol = entry.nextHopProtocol || '';
      const negotiated = location.protocol === 'https:' && !!protocol;
      return {
        requestTime: Math.floor(origin) / 1000,
        startLoadTime: Math.floor(origin) / 1000,
        commitLoadTime: at(entry.responseStart),
        finishDocumentLoadTime: at(entry.domContentLoadedEventEnd),
        finishLoadTime: at(entry.loadEventEnd),
        firstPaintTime: at(paint ? paint.startTime : 0),
        firstPaintAfterLoadTime: 0,
        navigationType: { reload: 'Reload', back_forward: 'BackForward' }[entry.type] || 'Other',
        wasFetchedViaSpdy: /^h[23]/.test(protocol),
        wasNpnNegotiated: negotiated,
        npnNegotiatedProtocol: negotiated ? protocol : 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: protocol || 'unknown',
      };
    },
    function () {
      const entry = navigation();
      return {
        startE: Math.floor(origin),
        onloadT: entry.domContentLoadedEventEnd > 0 ? Math.floor(origin + entry.domContentLoadedEventEnd) : 0,
        pageT: Math.round(performance.now() * 1000) / 1000,
        tran: { reload: 16, back_forward: 6 }[entry.type] ?? 15,
      };
    },
  ];
  define(chrome, 'loadTimes', loadTimes);
  define(chrome, 'csi', csi);
  // chrome.app on a page that isn't an installed app. Methods, so no
  // prototype and no declared parameters, as Chrome's.
  const invocationError = name => new TypeError(`Error in invocation of app.${name}(): `);
  const methods = {
    getDetails() { if (arguments.length) throw invocationError('getDetails'); return null; },
    getIsInstalled() { if (arguments.length) throw invocationError('getIsInstalled'); return false; },
    installState() {
      const callback = arguments[0];
      if (typeof callback === 'function') setTimeout(() => callback('not_installed'), 0);
    },
    runningState() { if (arguments.length) throw invocationError('runningState'); return 'cannot_run'; },
  };
  const app = {};
  define(app, 'isInstalled', false);
  for (const name of ['getDetails', 'getIsInstalled', 'installState', 'runningState']) define(app, name, methods[name]);
  define(app, 'InstallState', { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' });
  define(app, 'RunningState', { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' });
  define(chrome, 'app', app);
  // Chrome's window.chrome can't be redefined; Electron's can.
  const own = Object.getOwnPropertyDescriptor(window, 'chrome');
  if (own && own.configurable && 'value' in own) {
    Object.defineProperty(window, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: false });
  }
}

const FIRST_BATCH_MS = 50;
const BATCH_MS = 250;
const MAX_SEEN = 20000;      // of each kind, per page
const MAX_PER_BATCH = { classes: 1000, ids: 1000, hrefs: 300 };
// The longest of each that Core looks at (web-adblock.cjs, cleanTokens):
// longer ones are dropped here, before they're kept or sent. A page could
// otherwise send class names of any length, copied into the main process
// a batch at a time only to be thrown away there.
const MAX_LENGTH = { classes: 256, ids: 256, hrefs: 1024 };
const MAX_BATCH_CHARS = 128 * 1024; // all of one batch

/**
 * The class names, ids and links of `root` and what's under it, new ones
 * only, into `pending` (sets); `seen` remembers them for the page.
 */
function collectTokens(root, seen, pending) {
  if (!root || root.nodeType !== 1) return;
  const add = (kind, value) => {
    if (!value || typeof value !== 'string' || value.length > MAX_LENGTH[kind] || seen[kind].has(value) || seen[kind].size >= MAX_SEEN) return;
    seen[kind].add(value);
    pending[kind].add(value);
  };
  const visit = element => {
    if (element.id) add('ids', element.id);
    const list = element.classList;
    if (list) for (let i = 0; i < list.length; i += 1) add('classes', list[i]);
    if (element.localName === 'a' && typeof element.href === 'string' && /^https?:/i.test(element.href)) add('hrefs', element.href);
  };
  visit(root);
  if (root.querySelectorAll) for (const element of root.querySelectorAll('[id],[class],a[href]')) visit(element);
}

/** Watch the page's DOM and ask for the styles its new class names, ids and links call for. */
function watchTokens({ ipcRenderer, webFrame, doc = document, Observer = MutationObserver, timers = globalThis }) {
  const seen = { classes: new Set(), ids: new Set(), hrefs: new Set() };
  let pending = { classes: new Set(), ids: new Set(), hrefs: new Set() };
  let timer = null;
  let batches = 0;
  const flush = () => {
    timer = null;
    const batch = {};
    let size = 0;
    let chars = 0;
    for (const kind of ['classes', 'ids', 'hrefs']) {
      batch[kind] = [];
      for (const value of pending[kind]) {
        if (batch[kind].length >= MAX_PER_BATCH[kind] || chars + value.length > MAX_BATCH_CHARS) break;
        batch[kind].push(value);
        chars += value.length;
      }
      for (const value of batch[kind]) pending[kind].delete(value);
      size += batch[kind].length;
    }
    if (!size) return;
    batches += 1;
    ipcRenderer.invoke('atmos-web:page-tokens', batch).then(reply => {
      if (reply && typeof reply.styles === 'string' && reply.styles) webFrame.insertCSS(reply.styles, { cssOrigin: 'user' });
    }).catch(() => {});
    if (pending.classes.size || pending.ids.size || pending.hrefs.size) schedule();
  };
  function schedule() {
    if (!timer) timer = timers.setTimeout(flush, batches ? BATCH_MS : FIRST_BATCH_MS);
  }
  const take = root => { collectTokens(root, seen, pending); schedule(); };
  new Observer(records => {
    for (const record of records) {
      if (record.type === 'attributes') take(record.target);
      else for (const node of record.addedNodes) take(node);
    }
  }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'href'] });
  // And everything there is once the document is parsed.
  const whole = () => take(doc.documentElement);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', whole, { once: true });
  else whole();
}

/** Ask for the blocker's styles and scriptlets for this page, and apply them. */
// The world the blocker's "isolated" scriptlets run in (uBlock Origin runs
// them in its content script's): the page's DOM, out of reach of the page's
// scripts. Its own policy, so the page's Trusted Types rules (YouTube's) don't
// stop it rewriting an inline script, as they don't stop an extension's
// content script. Not Electron's own world (999), where this preload runs.
const SCRIPTLET_WORLD = 1024;
const SCRIPTLET_WORLD_CSP = "script-src 'self'; object-src 'none'";

function applyFilters({ ipcRenderer, webFrame }, where = globalThis.location) {
  let start = null;
  try { start = ipcRenderer.sendSync('atmos-web:page-filters'); } catch { return; }
  if (!start || typeof start !== 'object') return;
  if (typeof start.styles === 'string' && start.styles) {
    try { webFrame.insertCSS(start.styles, { cssOrigin: 'user' }); } catch { /* no document to style */ }
  }
  // Now, before the page's own scripts: in the page's world, then in the
  // scriptlets' own.
  for (const script of Array.isArray(start.scripts) ? start.scripts : []) {
    if (typeof script !== 'string' || !script) continue;
    try { void webFrame.executeJavaScript(script).catch(() => {}); } catch { /* a scriptlet that fails fails alone */ }
  }
  const isolated = (Array.isArray(start.isolated) ? start.isolated : []).filter(script => typeof script === 'string' && script);
  if (isolated.length) {
    try {
      webFrame.setIsolatedWorldInfo(SCRIPTLET_WORLD, { securityOrigin: where.origin, csp: SCRIPTLET_WORLD_CSP, name: 'Atmos Browser: ad blocker' });
      void webFrame.executeJavaScriptInIsolatedWorld(SCRIPTLET_WORLD, isolated.map(code => ({ code }))).catch(() => {});
    } catch { /* the page goes on without them */ }
  }
  if (start.watch === true) watchTokens({ ipcRenderer, webFrame });
}

/**
 * Atmos's scrollbar in web pages: the sidebar's (frame.css), 3 px with no
 * track or arrows, in a grey that shows on light and dark pages alike (a
 * page's background isn't Atmos's theme). The bar is 8 px wide so it's easy
 * to grab, and the thumb draws 3 px of it, 6 px under the pointer. A user
 * stylesheet, as an extension's would be: a page that styles its own
 * scrollbars keeps them (its rules win over these, and `scrollbar-width` or
 * `scrollbar-color` brings back Chromium's standard bar). The page's own
 * frame only: embedded frames of other sites keep theirs.
 */
const PAGE_SCROLLBAR_CSS = [
  '::-webkit-scrollbar { width: 8px; height: 8px; background: transparent; }',
  '::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }',
  '::-webkit-scrollbar-button { display: none; width: 0; height: 0; }',
  '::-webkit-scrollbar-thumb { background-color: rgba(128, 128, 128, .5); background-clip: padding-box; border: 2.5px solid transparent; border-radius: 4px; min-height: 24px; min-width: 24px; }',
  '::-webkit-scrollbar-thumb:hover, ::-webkit-scrollbar-thumb:active { background-color: rgba(128, 128, 128, .75); border-width: 1px; }',
].join('\n');

function applyScrollbar({ webFrame }) {
  try { webFrame.insertCSS(PAGE_SCROLLBAR_CSS, { cssOrigin: 'user' }); } catch { /* no document to style */ }
}

// ── What plays (Now Playing) ────────────────────────────────────────────────

const PAGE_MEDIA = 'atmos-web:page-media';
const MEDIA_CONTROL = 'atmos-web:media-control';
const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'durationchange', 'loadedmetadata', 'seeked', 'volumechange'];
const REPORT_EVERY_MS = 250;   // a report at most this often
const CHECK_EVERY_MS = 2000;   // and a look at the metadata this often, once something played

/**
 * In the page's world, before its scripts: setActionHandler still does what
 * it does, and the handlers the page sets are kept so Atmos can call them,
 * as Chrome's media controls do. `token` names the two events: `<token>`
 * (Atmos asks for an action, its detail a JSON string) and
 * `<token>:actions` (which actions the page handles, sent to Atmos). The
 * page can't name them without the token, and could only ever call its own
 * handlers anyway.
 */
function installMediaSessionRelay(token) {
  if (typeof MediaSession !== 'function' || !navigator.mediaSession || typeof token !== 'string') return;
  const proto = MediaSession.prototype;
  const original = proto.setActionHandler;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'setActionHandler');
  if (typeof original !== 'function' || !descriptor) return;
  const session = navigator.mediaSession;
  const handlers = new Map();
  // Kept now: the page's scripts may replace these later.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const Custom = CustomEvent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const apply = Reflect.apply;
  const doc = document;
  const announce = () => {
    const names = [];
    handlers.forEach((_handler, name) => names.push(name));
    try { dispatch.call(doc, new Custom(`${token}:actions`, { detail: stringify(names) })); } catch { /* no document */ }
  };
  // A Proxy of Chromium's own function: the same name, length and
  // "[native code]" to a page that looks.
  const wrapped = new Proxy(original, {
    apply(target, self, args) {
      const result = apply(target, self, args);
      if (self === session) {
        const [action, handler] = args;
        if (typeof handler === 'function') handlers.set(String(action), handler);
        else handlers.delete(String(action));
        announce();
      }
      return result;
    },
  });
  Object.defineProperty(proto, 'setActionHandler', { ...descriptor, value: wrapped });
  listen.call(doc, token, event => {
    let request = null;
    try { request = parse(event.detail); } catch { return; }
    const handler = request && handlers.get(request.action);
    if (typeof handler !== 'function') return;
    const details = { action: request.action };
    if (typeof request.seekTime === 'number' && request.seekTime >= 0) details.seekTime = request.seekTime;
    try { apply(handler, session, [details]); } catch { /* the page's own error */ }
  });
}

/**
 * Watch what plays in the page and report it; take the widget's controls.
 * `nav`, `doc`, `timers`: the page's, unless a test gives its own.
 */
function watchMedia({ ipcRenderer, contextBridge, doc = document, nav = navigator, timers = globalThis, token = null }) {
  const name = token || `atmos-media-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
    try { contextBridge.executeInMainWorld({ func: installMediaSessionRelay, args: [name] }); } catch { /* the elements alone, then */ }
  }
  let handled = [];         // the actions the page handles itself
  let current = null;       // the media element that played last
  const pausedHere = new Set();
  let started = false;      // something played or the page set handlers: reports begin
  let sent = null;          // the last report sent, as JSON
  let sentAt = -Infinity;
  let lastPosition = null;  // the position it gave
  let timer = null;
  let check = null;

  const audible = element => !element.muted && element.volume > 0;
  const elements = () => {
    const list = [...doc.querySelectorAll('video, audio')];
    if (current && !list.includes(current)) list.push(current);
    return list;
  };
  const playingElements = () => elements().filter(element => !element.paused && !element.ended && audible(element));
  const sessionState = () => { try { return nav.mediaSession?.playbackState || 'none'; } catch { return 'none'; } };

  function snapshot() {
    let metadata = null;
    try { metadata = nav.mediaSession?.metadata || null; } catch { metadata = null; }
    const playingNow = playingElements();
    const element = playingNow.includes(current) ? current : playingNow[0] || (current && audible(current) ? current : null);
    const state = sessionState();
    const playing = state === 'playing' || (state !== 'paused' && playingNow.length > 0);
    if (!metadata && !element && !handled.length) return null;
    const duration = element && Number.isFinite(element.duration) ? element.duration : null;
    const actions = [];
    if (element || handled.includes('play') || handled.includes('pause')) actions.push('toggle');
    if (handled.includes('nexttrack')) actions.push('next');
    if (handled.includes('previoustrack')) actions.push('previous');
    if (handled.includes('seekto') || duration) actions.push('seek');
    let artwork = [];
    try { artwork = [...(metadata?.artwork || [])].slice(0, 10).map(item => ({ src: String(item.src || ''), sizes: String(item.sizes || '') })); } catch { artwork = []; }
    return {
      title: metadata ? String(metadata.title || '') : '',
      artist: metadata ? String(metadata.artist || '') : '',
      album: metadata ? String(metadata.album || '') : '',
      artwork, playing, actions,
      position: element ? element.currentTime : null,
      duration,
    };
  }

  function send() {
    timer = null;
    const report = snapshot();
    // Unchanged but for the position moving on as it plays: Core moves it on itself.
    const key = JSON.stringify(report && { ...report, position: null });
    const moved = report && sent === key && report.position != null && lastPosition != null
      && Math.abs(report.position - (lastPosition + (report.playing ? (Date.now() - sentAt) / 1000 : 0))) > 2;
    if (key === sent && !moved) return;
    sent = key;
    sentAt = Date.now();
    lastPosition = report?.position ?? null;
    try { ipcRenderer.send(PAGE_MEDIA, report); } catch { /* the page is going */ }
  }
  function schedule() {
    if (!started || timer) return;
    timer = timers.setTimeout(send, Math.max(0, sentAt + REPORT_EVERY_MS - Date.now()));
  }
  function start() {
    if (started) return;
    started = true;
    check = timers.setInterval(() => { if (!doc.hidden || playingElements().length) schedule(); }, CHECK_EVERY_MS);
  }

  for (const type of MEDIA_EVENTS) {
    doc.addEventListener(type, event => {
      const element = event.target;
      if (!element || (element.localName !== 'video' && element.localName !== 'audio')) return;
      if ((type === 'play' || type === 'playing') && audible(element)) { current = element; pausedHere.delete(element); }
      if (type === 'volumechange' && audible(element) && !element.paused) current = element;
      if (audible(element) || element === current) start();
      schedule();
    }, true);
  }
  doc.addEventListener(`${name}:actions`, event => {
    try { handled = JSON.parse(event.detail).filter(item => typeof item === 'string').slice(0, 20); } catch { return; }
    start();
    schedule();
  });

  const trigger = (action, extra = {}) => {
    try { doc.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify({ action, ...extra }) })); } catch { /* no document */ }
  };
  ipcRenderer.on(MEDIA_CONTROL, (_event, control) => {
    const action = control?.action;
    if (action === 'toggle') {
      const playingNow = playingElements();
      if (sessionState() === 'playing' || playingNow.length) {
        if (handled.includes('pause')) trigger('pause');
        else for (const element of playingNow) { element.pause(); pausedHere.add(element); }
      } else if (handled.includes('play')) {
        trigger('play');
      } else {
        const again = [...pausedHere].filter(element => element.isConnected || element === current);
        pausedHere.clear();
        for (const element of again.length ? again : [current]) element?.play?.()?.catch?.(() => {});
      }
    } else if (action === 'next') trigger('nexttrack');
    else if (action === 'previous') trigger('previoustrack');
    else if (action === 'seek' && typeof control.value === 'number' && control.value >= 0) {
      if (handled.includes('seekto')) trigger('seekto', { seekTime: control.value });
      else if (current) current.currentTime = control.value;
    }
    schedule();
  });
  return { report: snapshot, stop: () => { timers.clearInterval?.(check); timers.clearTimeout?.(timer); } };
}

// In a page (required by Node for the tests, `electron` is only a path and
// nothing runs): Chrome's members in the page's world, synchronously,
// before its scripts; then the blocker's styles and scriptlets.
const electron = require('electron');
if (electron && typeof electron === 'object') {
  const { contextBridge } = electron;
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
    try { contextBridge.executeInMainWorld({ func: installChromeMembers }); } catch { /* a page without a world to add to */ }
  }
  if (electron.webFrame) applyScrollbar(electron);
  if (electron.ipcRenderer && electron.webFrame) {
    try { applyFilters(electron); } catch { /* the page goes on without them */ }
  }
  if (electron.ipcRenderer && typeof document === 'object') {
    try { watchMedia(electron); } catch { /* the page goes on without it */ }
  }
}

if (typeof module === 'object' && module) module.exports = { installChromeMembers, collectTokens, watchTokens, applyFilters, applyScrollbar, PAGE_SCROLLBAR_CSS, SCRIPTLET_WORLD, SCRIPTLET_WORLD_CSP, MAX_LENGTH, MAX_BATCH_CHARS, installMediaSessionRelay, watchMedia, PAGE_MEDIA, MEDIA_CONTROL };

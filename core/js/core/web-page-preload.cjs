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
 *    lists' scriptlets for it, and runs those in the page's world before its
 *    own scripts; then, as the page grows, it sends the class names, ids and
 *    links it finds and inserts the styles that come back. Two channels,
 *    `atmos-web:page-filters` and `atmos-web:page-tokens`: Core answers only
 *    for this page's own address (it reads it from the frame), only for
 *    Atmos Browser's pages, and within a budget per page. Nothing else goes
 *    to Core, and nothing is exposed to the page.
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

/**
 * The class names, ids and links of `root` and what's under it, new ones
 * only, into `pending` (sets); `seen` remembers them for the page.
 */
function collectTokens(root, seen, pending) {
  if (!root || root.nodeType !== 1) return;
  const add = (kind, value) => {
    if (!value || typeof value !== 'string' || seen[kind].has(value) || seen[kind].size >= MAX_SEEN) return;
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
    for (const kind of ['classes', 'ids', 'hrefs']) {
      batch[kind] = [...pending[kind]].slice(0, MAX_PER_BATCH[kind]);
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
function applyFilters({ ipcRenderer, webFrame }) {
  let start = null;
  try { start = ipcRenderer.sendSync('atmos-web:page-filters'); } catch { return; }
  if (!start || typeof start !== 'object') return;
  if (typeof start.styles === 'string' && start.styles) {
    try { webFrame.insertCSS(start.styles, { cssOrigin: 'user' }); } catch { /* no document to style */ }
  }
  // In the page's world, now: before the page's own scripts.
  for (const script of Array.isArray(start.scripts) ? start.scripts : []) {
    if (typeof script !== 'string' || !script) continue;
    try { void webFrame.executeJavaScript(script).catch(() => {}); } catch { /* a scriptlet that fails fails alone */ }
  }
  if (start.watch === true) watchTokens({ ipcRenderer, webFrame });
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
  if (electron.ipcRenderer && electron.webFrame) {
    try { applyFilters(electron); } catch { /* the page goes on without them */ }
  }
}

if (typeof module === 'object' && module) module.exports = { installChromeMembers, collectTokens, watchTokens };

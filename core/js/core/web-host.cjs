'use strict';
/**
 * Atmos Browser, main-process side: the web pages Core shows for an official
 * extension with "web": true in its permissions, under Core's policy
 * (web-policy.cjs) whatever the extension asks.
 *
 *   this file       the browser's two sessions (web-policy.cjs PARTITIONS) and
 *                   their handlers (permissions, downloads, certificates); the
 *                   policy on every web contents in them (navigation, pop-ups,
 *                   keys); the <webview> attach check for the Atmos page;
 *                   commands on a tab's contents; downloads; site settings
 *                   (web-settings.cjs); pop-up windows; favicons; links the
 *                   rest of Atmos opens, when the user asked for them here;
 *                   the ad and tracker blocker (web-adblock.cjs) on requests,
 *                   and the page channel its preload uses
 *   web-layer.js    in the Atmos page: one <webview> per open tab, placed
 *                   where the extension's panel says; relays between the
 *                   extension's frames (atmos.web) and here
 *
 * Every tab is a <webview> guest of the Atmos window. A page's contents are
 * addressed here by their webContents id; the page knows which tab that is.
 */
const path = require('path');
const fs = require('fs');
const policy = require('./web-policy.cjs');
const { createWebSettings } = require('./web-settings.cjs');

// Every tab and pop-up gets this preload, and no other: it gives
// window.chrome Chrome's members (Google's sign-in refuses a Chrome without
// them), asks for the ad blocker's styles and scriptlets for its own page,
// and says what plays in it (Now Playing), over the channels below. It
// holds nothing else.
const PAGE_PRELOAD = path.join(__dirname, 'web-page-preload.cjs');
const PAGE_FILTERS = 'atmos-web:page-filters';   // sync: as a page starts
const PAGE_TOKENS = 'atmos-web:page-tokens';     // the DOM's class names, ids, links
const PAGE_MEDIA = 'atmos-web:page-media';       // what plays in it
const MEDIA_CONTROL = 'atmos-web:media-control'; // Core to the page: play/pause, next, previous, seek
const TOKEN_MESSAGES = 400;                      // per page load
const MEDIA_MESSAGES_PER_SECOND = 8;             // a page's reports of what plays
const ARTWORK_FETCHES = 4;                       // artwork downloads at once, all tabs (one per tab)
const ARTWORK_DECODES = 4;                       // and waiting to be drawn
const USER_STARTED_MS = 5000;                    // a page that starts playing this soon after you acted in it: you started it
// Filter lists download in a session of their own (in memory, nothing in it).
const LISTS_PARTITION = 'atmos-browser-lists';
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const STORAGE_FLUSH_MS = 30_000;                 // pages' storage and cookies to disk
const CLOSE_PAGE_MS = 3000;                      // a page's last events, before it's closed regardless
const PRIVATE_END_MS = 10_000;                   // clearing the private session, before new private pages go on regardless
const HTTPS_FALLBACK_MS = 3000;                  // an upgraded page with no answer by then loads over http (Chrome's)
const MEMORY_CHECK_MS = 30_000;                  // how often each tab's process is measured
const MEMORY_STEP_BYTES = 2 * 1024 ** 3;         // a 'memory' event at 2 GB, 4 GB, 6 GB…
const PERMISSION_WAIT_MS = 10 * 60 * 1000;
const EXTERNAL_WAIT_MS = 2 * 60 * 1000;
const ICON_DECODE_MS = 5000;
const ICON_DECODER_IDLE_MS = 60 * 1000;
const MAX_DOWNLOADS = 100;
const EXPECTED_DOWNLOAD_MS = 60 * 1000;          // a download Core asked a page for, before it starts
// Where Core runs its own script in a page (leaving fullscreen): a world of
// its own, so the page's scripts can't replace what it calls. Not Electron's
// (999) nor the ad blocker's scriptlets' (1024, web-page-preload.cjs).
const CORE_WORLD = 1025;

// Run in the icon decoder's page (see decodeIcon): the image drawn into a
// square canvas, fitted and centred (or, for artwork, filling it, cut to
// the middle), and its pixels back as base64 RGBA.
const DECODE_ICON = `(async (b64, type, size, cover) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const w = image.naturalWidth || size, h = image.naturalHeight || size;
    const scale = cover ? Math.max(size / w, size / h) : Math.min(size / w, size / h);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
    const data = context.getImageData(0, 0, size, size).data;
    let text = '';
    for (let i = 0; i < data.length; i += 1) text += String.fromCharCode(data[i]);
    return btoa(text);
  } finally {
    URL.revokeObjectURL(url);
  }
})`;
const EDIT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);

function createWebHost({ app, session, net, BrowserWindow, WebContentsView, nativeImage, webContents, shell, ipcMain, utilityProcess, dialog, isAppUrl, userData, isWebExtension = () => false, testOptions = {} }) {
  const settings = createWebSettings({ dir: path.join(userData, 'browser') });
  const openExternal = shell.openExternal.bind(shell); // the system's, before Core routes it (routeShell)
  const ownerFile = path.join(userData, 'browser', 'owner.json');
  let atmosWindow = null;
  let linkListener = null; // the extension ("plugin:<id>") listening for links, while its frames run
  let nextId = 1;
  // Every contents in the browser's sessions: the tabs (<webview> guests of
  // the Atmos window) and the pop-up windows they opened.
  const live = new Map();            // webContents id -> { private, tab }
  const permissionRequests = new Map(); // request id -> { guestId, origin, names, private, callback, timer }
  const externalRequests = new Map();   // request id -> { guestId, url, timer }
  const downloads = new Map();       // download id -> { item, record }
  // Automatic https: hosts found to have none (each session its own, this
  // run only), and each tab's page being tried over https.
  const httpOnly = { ordinary: new Set(), private: new Set() };
  const upgrades = new Map();        // webContents id -> { host, httpUrl, redirects, timer, downgrade }
  // Addresses a secure page opened in a new tab (open-tab), until when: a
  // download that tab starts before it has a page of its own was the
  // secure page's (insecure download blocking judges by who started it).
  const secureOpeners = new Map();    // address -> until when
  const memoryLevels = new Map();    // tab's webContents id -> the last 'memory' step it was told about
  const faviconCache = new Map();    // "private|url" -> data URL
  const artworkCache = new Map();    // "private|url" -> data URL (a JPEG Core drew)
  const mediaOf = new Map();         // webContents id -> { report, artworkSrc, artwork, rate: { at, count } }
  const blockedByTab = new Map();    // webContents id -> { count, hosts: Map(host -> n), timer }
  const tokenBudget = new Map();     // webContents id -> page-token messages left for this page
  const navigations = new Map();     // webContents id -> its page navigations started (the token budget's)
  const budgetFor = new Map();       // webContents id -> the navigation its token budget was armed for
  const closing = new Set();         // webContents ids Atmos is closing (closePage)
  const sleeping = new Map();        // webContents id -> settle(closed): a page asked to let go (sleepPage)
  const SLEEP_PAGE_MS = 10_000;      // …and how long it may take to answer
  // What a page may do because the user just used it (web-policy.cjs):
  // pop-ups, and links Atmos opens here coming to the front ('atmos', the
  // Atmos window's own input).
  const activations = policy.createActivations();
  const downloadReady = new Set();   // webContents ids that may start one download on their own
  const expectedDownloads = new Map(); // "id\nurl" -> until when: downloads Core asked for (a menu's Save)
  const leaveRefusedAt = new Map();  // webContents id -> when "Leave site?" was last answered Cancel
  const coreActedAt = new Map();     // webContents id -> when the user last moved it from the browser (address bar, Back…)
  let quitting = false;              // Atmos is quitting: its windows close next
  let privateEnding = null;          // the last private session being cleared (endPrivateSession)
  const endsPrivate = new Set();     // webContents ids whose closing ended private browsing (closePage)
  app.on('before-quit', () => { quitting = true; });
  let adblock = null;                // web-adblock.cjs, made with the sessions

  // The browser's two sessions, made and set up the first time a page
  // attaches (configureSessions), never before: an Atmos without a web
  // extension doesn't get a browser partition's databases on disk.
  let webSessions = null; // { ordinary, private }
  const isWebSession = candidate => !!candidate && !!webSessions && (candidate === webSessions.ordinary || candidate === webSessions.private);
  const isPrivateSession = candidate => !!candidate && !!webSessions && candidate === webSessions.private;

  function send(guestId, type, payload = {}) {
    if (!atmosWindow || atmosWindow.isDestroyed() || atmosWindow.webContents.isDestroyed()) return;
    atmosWindow.webContents.send('web:event', guestId, type, payload);
  }

  // ── What a tab's contents are doing ───────────────────────────────────────
  function state(contents) {
    const history = contents.navigationHistory;
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      audible: contents.isCurrentlyAudible(),
      muted: contents.isAudioMuted(),
      zoom: Math.round(contents.getZoomFactor() * 100) / 100,
      secure: /^https:/i.test(contents.getURL()),
      blocked: blockedByTab.get(contents.id)?.count || 0,
      shield: shieldOf(contents),
    };
  }
  const sendState = contents => { if (!contents.isDestroyed()) send(contents.id, 'state', state(contents)); };

  function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

  /** A page's own zoom per site (Chromium shares it between tabs of a site; this keeps it across starts). */
  function applyZoom(contents) {
    const host = hostOf(contents.getURL());
    if (!host) return;
    const factor = settings.zoom(host, { private: isPrivateSession(contents.session) });
    if (Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor);
  }
  function zoom(contents, direction) {
    const factor = policy.nextZoom(contents.getZoomFactor(), direction);
    contents.setZoomFactor(factor);
    settings.setZoom(hostOf(contents.getURL()), factor, { private: isPrivateSession(contents.session) });
    sendState(contents);
    return factor;
  }

  // ── Site icons ────────────────────────────────────────────────────────────
  // An icon is the site's own image data, so it's decoded in a renderer of
  // its own: sandboxed, in a session with no network and nothing else in it
  // (policy.ICON_PARTITION), not in the browser's UI frames (which can do
  // more than a page can) nor here. What comes back is 32×32 pixels, which
  // Core encodes as a PNG itself; that's all the extension ever gets. A
  // decoder bug in an icon reaches nothing more than that throwaway page.
  let iconDecoder = null; // { view, ready, idle }
  let iconQueue = Promise.resolve();
  let iconsWaiting = 0;

  function closeIconDecoder() {
    const decoder = iconDecoder;
    iconDecoder = null;
    if (!decoder) return;
    clearTimeout(decoder.idle);
    try { if (!decoder.view.webContents.isDestroyed()) decoder.view.webContents.close(); } catch { /* gone */ }
  }

  function iconDecoderPage() {
    if (iconDecoder && !iconDecoder.view.webContents.isDestroyed()) return iconDecoder;
    const ses = session.fromPartition(policy.ICON_PARTITION);
    if (!ses.__atmosIconSession) {
      ses.__atmosIconSession = true;
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(blob|data):/i.test(details.url) && details.url !== 'about:blank' }));
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: policy.ICON_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webgl: false, plugins: false, spellcheck: false, backgroundThrottling: false,
      },
    });
    const decoder = { view, ready: view.webContents.loadURL('about:blank'), idle: null };
    view.webContents.on('render-process-gone', () => { if (iconDecoder === decoder) iconDecoder = null; });
    iconDecoder = decoder;
    return decoder;
  }

  /**
   * `bytes` of an image (`type` image/…): a data URL made by Core from its
   * pixels, or null. An icon: 32×32, fitted, a PNG; `artwork`: filling
   * ARTWORK_SIZE², a JPEG.
   */
  async function decodeIcon(bytes, type, { artwork = false } = {}) {
    const size = artwork ? policy.ARTWORK_SIZE : policy.ICON_SIZE;
    const decoder = iconDecoderPage();
    clearTimeout(decoder.idle);
    let timer;
    try {
      await decoder.ready;
      const script = `${DECODE_ICON}(${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(type)}, ${size}, ${artwork})`;
      const answer = await Promise.race([
        decoder.view.webContents.executeJavaScript(script),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the icon took too long')), ICON_DECODE_MS); }),
      ]);
      const bitmap = policy.iconBitmap(typeof answer === 'string' ? Buffer.from(answer, 'base64') : null, size);
      if (!bitmap) return null;
      const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
      const encoded = artwork ? image.toJPEG(85) : image.toPNG();
      return encoded.length ? `data:image/${artwork ? 'jpeg' : 'png'};base64,${encoded.toString('base64')}` : null;
    } catch {
      // Stuck or broken: a new page next time.
      closeIconDecoder();
      return null;
    } finally {
      clearTimeout(timer);
      if (iconDecoder === decoder) decoder.idle = setTimeout(closeIconDecoder, ICON_DECODER_IDLE_MS);
    }
  }

  /** At most `max` bytes of a response's body, or null if there are more. */
  async function readCapped(response, max) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /**
   * One request for an icon, without cookies: { image: { type, bytes } },
   * { redirect: url } (not followed: the caller checks it first), or null.
   * At most `maxBytes`, an image type.
   */
  function requestIcon(ses, url, maxBytes = policy.ICON_MAX_BYTES, signal = null) {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(null); return; }
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let request;
      try {
        request = net.request({ url, session: ses, credentials: 'omit', useSessionCookies: false, redirect: 'manual' });
      } catch { finish(null); return; }
      const stop = () => { try { request.abort(); } catch { /* done already */ } finish(null); };
      timer = setTimeout(stop, 8000);
      signal?.addEventListener('abort', stop, { once: true });
      // Not followed here (the request then ends): the caller checks where it goes first.
      request.on('redirect', (_status, _method, next) => finish({ redirect: String(next) }));
      request.on('response', response => {
        const header = response.headers['content-type'];
        const type = String(Array.isArray(header) ? header[0] : header || '').split(';')[0].trim().toLowerCase();
        if (response.statusCode < 200 || response.statusCode > 299 || !/^image\/[a-z0-9.+-]+$/.test(type)) { stop(); return; }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { stop(); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(size ? { image: { type, bytes: Buffer.concat(chunks) } } : null));
        response.on('error', () => finish(null));
      });
      request.on('error', () => finish(null));
      request.on('abort', () => finish(null));
      request.end();
    });
  }

  /**
   * A site icon's bytes, fetched by Core: { type, bytes } or null. The
   * request is Core's, not the page's (the page's CSP and the rules on what
   * a page may reach don't apply to it), so it carries no cookies, and it
   * goes only where iconFetchAllowed says: each address, redirects
   * included, checked before it's asked, and a name that isn't the page's
   * own host resolved first, every address it has public (iconLookup),
   * unless the request goes through a proxy, which resolves it instead (and
   * where a lookup here may not work at all). Five redirects at most.
   */
  async function fetchIcon(ses, url, pageUrl, maxBytes = policy.ICON_MAX_BYTES, signal = null) {
    let target = url;
    for (let hop = 0; hop <= 5; hop += 1) {
      if (signal?.aborted) return null;
      if (!policy.iconFetchAllowed(target, pageUrl)) return null;
      const name = policy.iconLookup(target, pageUrl);
      let direct = true;
      if (name) {
        try { direct = /^\s*DIRECT\s*$/i.test(await ses.resolveProxy(target)); } catch { direct = true; }
      }
      if (name && direct) {
        let endpoints = [];
        try { ({ endpoints } = await ses.resolveHost(name)); } catch { return null; }
        if (!endpoints?.length || endpoints.some(endpoint => policy.isLocalAddress(endpoint.address))) return null;
      }
      const answer = await requestIcon(ses, target, maxBytes, signal);
      if (!answer?.redirect) return answer?.image || null;
      target = answer.redirect;
    }
    return null;
  }

  async function sendFavicon(contents, favicons) {
    const url = (favicons || []).find(candidate => /^(https?:|data:image\/)/i.test(candidate));
    if (!url) return;
    const key = `${isPrivateSession(contents.session) ? 'p' : 'n'}|${url}`;
    let dataUrl = faviconCache.get(key) || null;
    if (!dataUrl) {
      let image = /^data:/i.test(url) ? policy.imageDataUrlBytes(url) : null;
      if (!image && /^https?:/i.test(url) && policy.iconFetchAllowed(url, contents.getURL())) {
        image = await fetchIcon(contents.session, url, contents.getURL());
      }
      // One at a time, and not an endless queue of them.
      if (!image || iconsWaiting >= 20) return;
      iconsWaiting += 1;
      const decoded = iconQueue.then(() => decodeIcon(image.bytes, image.type));
      iconQueue = decoded.catch(() => null);
      try { dataUrl = await decoded; } catch { dataUrl = null; } finally { iconsWaiting -= 1; }
    }
    if (!dataUrl || contents.isDestroyed()) return;
    if (faviconCache.size > 300) faviconCache.clear();
    faviconCache.set(key, dataUrl);
    send(contents.id, 'favicon', { dataUrl, pageUrl: contents.getURL() });
  }

  // ── What a page plays (Now Playing) ───────────────────────────────────────
  // The page's preload reports it (PAGE_MEDIA, checked in web-policy.cjs);
  // Core adds the artwork, fetched and drawn again as a site icon is, and
  // tells the tab's extension ('media'). Atmos Browser shows it in Now
  // Playing and sends the widget's controls back (atmos.web.media).

  // Artwork has a queue of its own (site icons don't wait behind it), and
  // few at once: a tab fetches one (a newer src aborts the one before), and
  // all tabs ARTWORK_FETCHES, checked before a download starts.
  let artworkQueue = Promise.resolve();
  let artworkFetching = 0;
  let artworkWaiting = 0;

  /** The artwork at `src` for the page, as a JPEG Core drew: a data URL, or null. */
  async function artworkFor(contents, src, signal) {
    const key = `${isPrivateSession(contents.session) ? 'p' : 'n'}|${src}`;
    if (artworkCache.has(key)) return artworkCache.get(key);
    let image = /^data:/i.test(src) ? policy.imageDataUrlBytes(src, policy.ARTWORK_MAX_BYTES) : null;
    if (!image && /^https?:/i.test(src) && policy.iconFetchAllowed(src, contents.getURL())) {
      if (artworkFetching >= ARTWORK_FETCHES) return null;
      artworkFetching += 1;
      try { image = await fetchIcon(contents.session, src, contents.getURL(), policy.ARTWORK_MAX_BYTES, signal); } finally { artworkFetching -= 1; }
    }
    if (!image || signal?.aborted || artworkWaiting >= ARTWORK_DECODES) return null;
    artworkWaiting += 1;
    const decoded = artworkQueue.then(() => (signal?.aborted ? null : decodeIcon(image.bytes, image.type, { artwork: true })));
    artworkQueue = decoded.catch(() => null);
    let dataUrl = null;
    try { dataUrl = await decoded; } catch { dataUrl = null; } finally { artworkWaiting -= 1; }
    if (signal?.aborted) return null;
    if (artworkCache.size > 40) artworkCache.clear();
    artworkCache.set(key, dataUrl);
    return dataUrl;
  }

  /**
   * To the tab's extension: what plays, and whether you acted in the page
   * (or moved it from the browser) a moment ago, so a page that starts
   * playing by itself can be told from one you started (`userActed`).
   */
  function sendMedia(contents) {
    if (contents.isDestroyed()) return;
    const entry = mediaOf.get(contents.id);
    const { artwork: _list, ...report } = entry?.report || {};
    const actedAt = Math.max(activations.lastAt(contents.id), coreActedAt.get(contents.id) || 0);
    send(contents.id, 'media', {
      media: entry?.report ? { ...report, artwork: entry.artwork || null } : null,
      userActed: Date.now() - actedAt < USER_STARTED_MS,
    });
  }

  /** A new page, or the page gone: what played is over. */
  function endMedia(contents) {
    const entry = mediaOf.get(contents.id);
    if (!entry) return;
    entry.fetch?.abort();
    mediaOf.delete(contents.id);
    if (entry.report) send(contents.id, 'media', { media: null, userActed: false });
  }

  // ── Ads and trackers (web-adblock.cjs) ──────────────────────────────────
  let listsSession = null;
  function listSession() {
    if (!listsSession) {
      listsSession = session.fromPartition(LISTS_PARTITION);
      listsSession.setUserAgent(policy.chromeUserAgent());
      listsSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      listsSession.setPermissionCheckHandler(() => false);
    }
    return listsSession;
  }

  /**
   * A filter list, conditionally when there's a copy: { status, text, etag,
   * lastModified }. From the address asked for only: a redirect isn't
   * followed (the mirror asked is the one that served it, which decides
   * what the list may do: web-adblock.cjs).
   */
  async function fetchList(url, { etag = null, lastModified = null } = {}) {
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await listSession().fetch(url, { headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (response.status === 304) return { status: 304 };
      const bytes = response.ok ? await readCapped(response, MAX_LIST_BYTES) : null;
      return {
        status: bytes ? response.status : (response.ok ? 413 : response.status), text: bytes ? bytes.toString('utf8') : '',
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The engine built from the lists in a utility process of its own (a parse takes seconds). */
  function buildInUtility(payload) {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'web-adblock-parser.cjs'), [], { serviceName: 'Atmos Browser filter lists', stdio: 'ignore' });
      let settled = false;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* gone */ }
        settle(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('building the filter lists took too long')), 180_000);
      child.once('message', message => (message?.ok
        ? finish(resolve, message)
        : finish(reject, new Error(message?.error || 'the filter lists could not be built'))));
      child.once('exit', code => finish(reject, new Error(`the filter-list builder stopped (${code})`)));
      child.once('spawn', () => child.postMessage(payload));
    });
  }

  /** The blocker, made the first time the browser needs it (loading its library costs a little). */
  function adblocker() {
    if (!adblock) {
      const { createAdblock } = require('./web-adblock.cjs');
      adblock = createAdblock({
        dir: path.join(userData, 'browser', 'adblock'),
        fetchText: fetchList,
        buildEngine: buildInUtility,
        localLists: testOptions.filterLists || null,
        onChange: status => {
          send(null, 'adblock', status);
          for (const id of live.keys()) { const contents = webContents.fromId(id); if (contents) sendState(contents); }
        },
      });
    }
    return adblock;
  }
  const blockAdsOn = () => settings.options().blockAds !== false;

  /** Whether the blocker applies to a page at `pageUrl`: on, and the site's shield up. */
  function blockingFor(pageUrl, isPrivate) {
    if (!blockAdsOn() || !adblock?.ready()) return false;
    const origin = policy.siteOf(pageUrl);
    return !!origin && !settings.adsAllowed(origin, { private: isPrivate });
  }

  /** A tab's shield: 'on', 'off' (the site's shield down), 'disabled' (blocking off) or 'none' (not a web page). */
  function shieldOf(contents) {
    const origin = policy.siteOf(contents.getURL());
    if (!origin) return 'none';
    if (!blockAdsOn()) return 'disabled';
    return settings.adsAllowed(origin, { private: isPrivateSession(contents.session) }) ? 'off' : 'on';
  }

  function countBlocked(id, url, isPrivate) {
    // The total on the new-tab page is kept on disk: private tabs don't add to it.
    if (!isPrivate) adblock.counted();
    if (!id) return;
    let entry = blockedByTab.get(id);
    if (!entry) { entry = { count: 0, hosts: new Map(), timer: null }; blockedByTab.set(id, entry); }
    entry.count += 1;
    const host = hostOf(url);
    if (host && (entry.hosts.has(host) || entry.hosts.size < 100)) entry.hosts.set(host, (entry.hosts.get(host) || 0) + 1);
    // The count shows in the tab's state, a few times a second at most.
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const contents = webContents.fromId(id);
        if (contents && live.has(id)) sendState(contents);
      }, 300);
    }
  }
  function resetBlocked(id) {
    const entry = blockedByTab.get(id);
    if (entry) clearTimeout(entry.timer);
    blockedByTab.delete(id);
  }

  /**
   * The page a request is for, and the document asking (for $third-party
   * and $domain): web-policy's requestContext, from the request and what
   * the browser knows of its frame (which lags a navigation: see there).
   */
  function requestContext(details) {
    const type = details.resourceType || 'other';
    // A frame gone mid-request throws when read.
    const read = get => { try { return get() ?? ''; } catch { return ''; } };
    const frame = read(() => details.frame) || null;
    const context = policy.requestContext({
      type,
      url: details.url,
      frame: frame && {
        url: read(() => frame.url),
        topUrl: read(() => frame.top?.url),
        parentUrl: type === 'subFrame' ? read(() => frame.parent?.url) : '',
        isTop: !read(() => frame.parent),
      },
      contentsUrl: read(() => details.webContents?.getURL()),
      referrer: details.referrer || '',
      initiator: details.initiatorOrigin || '',
    });
    return { type, ...context };
  }

  /** onBeforeRequest: blocked, redirected to a stand-in, or without its tracking parameters. */
  function blockRequest(details, isPrivate) {
    if (!blockAdsOn() || !adblock?.ready()) return {};
    const { type, pageUrl, sourceUrl } = requestContext(details);
    if (!blockingFor(pageUrl, isPrivate)) return {};
    const verdict = adblock.match({ url: details.url, type, sourceUrl });
    if (!verdict) return {};
    if (verdict.blocked) countBlocked(details.webContentsId, details.url, isPrivate);
    return verdict.cancel ? { cancel: true } : { redirectURL: verdict.redirectURL };
  }

  /** onHeadersReceived, documents only: a list's $csp added as a policy of its own (they all apply). */
  function addListCsp(details, isPrivate) {
    if (!blockAdsOn() || !adblock?.ready()) return {};
    const { type, pageUrl, sourceUrl } = requestContext(details);
    if (!blockingFor(pageUrl, isPrivate)) return {};
    const extra = adblock.csp({ url: details.url, type, sourceUrl });
    if (!extra) return {};
    const headers = { ...details.responseHeaders };
    const name = Object.keys(headers).find(key => key.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
    headers[name] = [...(headers[name] || []), extra];
    return { responseHeaders: headers };
  }

  /** A message on the page channel: the tab's or pop-up's main frame, on a web page, or null. */
  function pageFrom(event) {
    const contents = event.sender;
    if (!contents || contents.isDestroyed() || !isWebSession(contents.session) || !live.has(contents.id)) return null;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame) return null;
    const url = frame.url;
    if (!/^https?:/i.test(url)) return null;
    return { contents, url, isPrivate: isPrivateSession(contents.session) };
  }

  // As a page starts, synchronously (its scriptlets run before its own
  // scripts): the styles and scriptlets for the page's own address, which
  // Core reads from its frame. Nothing a page sends names another page.
  ipcMain.on(PAGE_FILTERS, event => {
    let reply = null;
    try {
      const page = pageFrom(event);
      if (page && blockingFor(page.url, page.isPrivate)) {
        // The page's budget of token messages, once per navigation: this
        // message comes from the page's preload once, but a page whose
        // renderer was taken over could send it again to refill it.
        const id = page.contents.id;
        const navigation = navigations.get(id) || 0;
        if (budgetFor.get(id) !== navigation) {
          budgetFor.set(id, navigation);
          tokenBudget.set(id, TOKEN_MESSAGES);
        }
        const found = adblock.pageStart(page.url);
        if (found) reply = { styles: found.styles, scripts: found.scripts, isolated: found.isolated, watch: true };
      }
    } catch (error) {
      console.warn('[web] page filters:', error.message);
      reply = null;
    } finally {
      event.returnValue = reply;
    }
  });
  // Then the styles for the class names, ids and links its DOM grows (bounded, and a budget per page).
  ipcMain.handle(PAGE_TOKENS, (event, tokens) => {
    const page = pageFrom(event);
    if (!page || !blockingFor(page.url, page.isPrivate)) return null;
    const left = tokenBudget.get(page.contents.id) || 0;
    if (left <= 0) return null;
    tokenBudget.set(page.contents.id, left - 1);
    return adblock.pageTokens(page.url, tokens);
  });
  // What plays in it: a few reports a second at most (the rest dropped; the
  // preload sends again on the next change), checked, then the artwork.
  ipcMain.on(PAGE_MEDIA, (event, input) => {
    const page = pageFrom(event);
    if (!page || !live.get(page.contents.id)?.tab) return;
    const { contents } = page;
    const entry = mediaOf.get(contents.id) || { report: null, artworkSrc: null, artwork: null, fetch: null, rate: { at: 0, count: 0 } };
    mediaOf.set(contents.id, entry);
    const now = Date.now();
    if (now - entry.rate.at >= 1000) entry.rate = { at: now, count: 0 };
    if (++entry.rate.count > MEDIA_MESSAGES_PER_SECOND) return;
    entry.report = policy.cleanMediaReport(input);
    const src = entry.report ? policy.pickArtwork(entry.report.artwork) : null;
    if (src !== entry.artworkSrc) {
      entry.artworkSrc = src;
      entry.artwork = null;
      entry.fetch?.abort();
      entry.fetch = null;
      if (src) {
        const fetch = entry.fetch = new AbortController();
        void artworkFor(contents, src, fetch.signal).then(dataUrl => {
          if (mediaOf.get(contents.id) !== entry || entry.artworkSrc !== src || fetch.signal.aborted) return;
          entry.fetch = null;
          entry.artwork = dataUrl;
          sendMedia(contents);
        }).catch(() => {});
      }
    }
    sendMedia(contents);
  });

  // ── Asking the user (the extension draws the prompt) ─────────────────────
  function askPermission(contents, origin, names, callback) {
    const guestId = contents.id;
    const isPrivate = isPrivateSession(contents.session);
    for (const request of permissionRequests.values()) {
      // The same question from the same page is asked once.
      if (request.guestId === guestId && request.origin === origin && request.names.join() === names.join()) {
        request.callbacks.push(callback);
        return;
      }
    }
    const id = `p${nextId++}`;
    const request = { id, guestId, origin, names, private: isPrivate, callbacks: [callback], timer: null };
    request.timer = setTimeout(() => settlePermission(id, false, false), PERMISSION_WAIT_MS);
    permissionRequests.set(id, request);
    send(guestId, 'permission-request', { requestId: id, origin, permissions: names });
  }
  function settlePermission(id, allow, remember) {
    const request = permissionRequests.get(id);
    if (!request) return false;
    permissionRequests.delete(id);
    clearTimeout(request.timer);
    if (remember) for (const name of request.names) settings.setPermission(request.origin, name, allow ? 'allow' : 'block', { private: request.private });
    for (const callback of request.callbacks) { try { callback(allow === true); } catch { /* the page is gone */ } }
    send(request.guestId, 'permission-settled', { requestId: id, allow: allow === true });
    return true;
  }
  function dropRequestsOf(guestId) {
    for (const request of [...permissionRequests.values()]) if (request.guestId === guestId) settlePermission(request.id, false, false);
    for (const [id, request] of [...externalRequests]) if (request.guestId === guestId) { clearTimeout(request.timer); externalRequests.delete(id); }
  }

  /**
   * A link to another program (mailto:, magnet:…): the user is asked first,
   * once at a time per tab. `site` is the asking page's (a pop-up's link is
   * asked in the tab you're on, which may be another site).
   */
  function askExternal(contents, url, scheme) {
    const guestId = contents.id;
    if ([...externalRequests.values()].some(request => request.guestId === guestId)) return;
    const id = `x${nextId++}`;
    const timer = setTimeout(() => externalRequests.delete(id), EXTERNAL_WAIT_MS);
    externalRequests.set(id, { guestId, url, timer });
    send(guestId, 'external-request', { requestId: id, url: url.slice(0, 2048), scheme, site: policy.siteOf(contents.getURL()) || '' });
  }

  // ── What a page may do because the user used it ──────────────────────────
  /** A click, tap or key in a page (or its pop-up): a pop-up, and another download, may follow. */
  function userActed(contents) {
    activations.activate(contents.id);
    downloadReady.add(contents.id);
  }

  const sameUrl = url => { try { return /^https?:/i.test(url) ? new URL(url).href : url; } catch { return url; } };

  /** Core asked this page for a download (a menu's Save, the notice's Download): it starts without a click. */
  function expectDownload(contents, url) {
    const now = Date.now();
    for (const [key, until] of expectedDownloads) if (until < now) expectedDownloads.delete(key);
    if (expectedDownloads.size < 200) expectedDownloads.set(`${contents.id}\n${sameUrl(url)}`, now + EXPECTED_DOWNLOAD_MS);
  }

  /**
   * Whether a download a page started goes ahead, as Chrome's download
   * limiter has it: one Core asked for; one after each click or key in the
   * page; one on its own when a tab or pop-up opens, and each time the user
   * sends it somewhere from the browser (the address bar, Back, a reload).
   * A page's own navigations don't renew it (Chrome's neither), so a page
   * can't pile files into Downloads without a click by moving on; the
   * browser says what it stopped.
   */
  /**
   * Whether a page's download may start: 'expected' (Core asked for it: a
   * menu's Save, a notice's Download), true (the page's own, the one it may
   * start or just after a click), false.
   */
  function downloadMayStart(contents, item) {
    const id = contents.id;
    if (!live.has(id)) return true;
    let first = '';
    try { first = item.getURLChain()[0] || item.getURL(); } catch { first = item.getURL(); }
    const key = `${id}\n${sameUrl(first)}`;
    if (expectedDownloads.has(key)) {
      const fresh = expectedDownloads.get(key) >= Date.now();
      expectedDownloads.delete(key);
      if (fresh) return 'expected';
    }
    return downloadReady.delete(id);
  }

  // ── The policy on every contents in the browser's sessions ───────────────
  function applyPolicy(contents) {
    const guestId = contents.id;
    // A new tab or pop-up may start one download on its own (as Chrome allows).
    downloadReady.add(guestId);
    contents.setWindowOpenHandler(details => {
      const verdict = policy.navigationPolicy(details.url, { frame: 'top' });
      if (verdict.action === 'external') { askExternal(contents, details.url, verdict.scheme); return { action: 'deny' }; }
      if (verdict.action !== 'allow') { send(guestId, 'refused', { url: details.url.slice(0, 2048), reason: verdict.reason }); return { action: 'deny' }; }
      // A new tab or window only just after a click or key in the page, one
      // each (Chrome's pop-up blocker): Electron has none, and pages opened
      // tabs and windows from a timer. Blocked, the browser says so and
      // offers to open it, or to allow the site's pop-ups from then on (its
      // "popups" setting, as Chrome's "Always allow pop-ups").
      const site = policy.siteOf(contents.getURL());
      const isPrivate = isPrivateSession(contents.session);
      if (!(site && settings.popupsAllowed(site, { private: isPrivate })) && !activations.take(guestId, 'popup')) {
        const target = details.url.length <= 2048 && details.url !== 'about:blank' ? details.url : null;
        send(guestId, 'popup-blocked', { url: target, private: isPrivate, site: site || '' });
        return { action: 'deny' };
      }
      // A pop-up asked for with features (a sign-in window) keeps its opener in
      // a small window of its own; a link or plain window.open becomes a tab.
      if (details.disposition === 'new-window' && details.url !== 'about:blank') {
        const size = features => {
          const read = name => Number((features.match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i')) || [])[1]);
          return { width: read('width'), height: read('height') };
        };
        const wanted = size(details.features || '');
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: Math.max(320, Math.min(1400, wanted.width || 520)),
            height: Math.max(240, Math.min(1000, wanted.height || 680)),
            parent: atmosWindow && !atmosWindow.isDestroyed() ? atmosWindow : undefined,
            modal: false,
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            title: policy.siteOf(details.url) || 'Atmos Browser',
            webPreferences: { ...policy.WEB_PREFERENCES, preload: PAGE_PRELOAD },
          },
        };
      }
      // A private page's links stay private.
      if (/^https:/i.test(contents.getURL()) && secureOpeners.size < 200) secureOpeners.set(sameUrl(details.url), Date.now() + EXPECTED_DOWNLOAD_MS);
      send(guestId, 'open-tab', { url: details.url, background: details.disposition === 'background-tab', private: isPrivateSession(contents.session) });
      return { action: 'deny' };
    });
    contents.on('did-create-window', win => watchPopup(win));
    contents.on('will-navigate', details => {
      const verdict = policy.navigationPolicy(details.url, { frame: 'top' });
      if (verdict.action === 'allow') return;
      details.preventDefault();
      if (verdict.action === 'external') askExternal(contents, details.url, verdict.scheme);
      else send(guestId, 'refused', { url: details.url.slice(0, 2048), reason: verdict.reason });
    });
    contents.on('will-frame-navigate', details => {
      if (details.isMainFrame) return;
      if (policy.navigationPolicy(details.url, { frame: 'sub' }).action !== 'allow') details.preventDefault();
    });
    contents.on('will-redirect', details => {
      const verdict = policy.navigationPolicy(details.url, { frame: details.isMainFrame ? 'top' : 'sub' });
      if (verdict.action !== 'allow') { details.preventDefault(); return; }
      // The site itself sending the upgraded page back to http, the same
      // host: it has no https really (upgradeRequest lets that through).
      const entry = details.isMainFrame ? upgrades.get(contents.id) : null;
      if (entry && sameHost(details.url, 'http:') === entry.host) entry.downgrade = true;
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    // A page that objects to being left (unsaved changes, after the user
    // used it). Closing it (a tab, or Atmos) goes ahead once its last
    // events have run (closePage). Leaving it for another address, Back or
    // a reload asks first, as Chrome does: Electron's default cancels
    // without a word, so a link or the address bar did nothing. Electron
    // needs the answer at once, so the question holds all of Atmos while
    // it's up: it names the site, and after a Cancel the page stays without
    // asking for half a minute, unless you act yourself (web-policy.cjs,
    // askBeforeLeaving), so a page can't bring it back again and again.
    contents.on('will-prevent-unload', event => {
      if (closing.has(contents.id)) { event.preventDefault(); return; }
      // Being put to sleep, nobody asked to leave it: it stays (sleepPage).
      if (sleeping.has(contents.id)) { sleeping.get(contents.id)(false); return; }
      const actedAt = Math.max(activations.lastAt(contents.id), coreActedAt.get(contents.id) || 0);
      if (!policy.askBeforeLeaving({ refusedAt: leaveRefusedAt.get(contents.id) || 0, actedAt, now: Date.now() })) return;
      const owner = (contents.getType() === 'window' && BrowserWindow.fromWebContents(contents)) || atmosWindow;
      const site = (() => { try { return new URL(contents.getURL()).host; } catch { return ''; } })();
      const question = {
        type: 'question', buttons: ['Leave', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'Leave site?', message: site ? `Leave ${site}?` : 'Leave site?', detail: 'Changes you made may not be saved.',
      };
      const answer = owner && !owner.isDestroyed() ? dialog.showMessageBoxSync(owner, question) : dialog.showMessageBoxSync(question);
      if (answer === 0) { leaveRefusedAt.delete(contents.id); event.preventDefault(); } else leaveRefusedAt.set(contents.id, Date.now());
    });
    // Web Bluetooth, and a device picker Electron would otherwise answer with the first device.
    contents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
    let fullscreen = false;
    contents.on('before-input-event', (event, input) => {
      // Escape leaves a page's fullscreen (the page doesn't get the key).
      if (fullscreen && input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.alt && !input.meta) {
        event.preventDefault();
        commands.exitFullscreen(contents);
        return;
      }
      const command = policy.shortcutFor(input);
      if (!command) {
        // Keys reach this for every frame of the page.
        if (policy.activatesUser(input)) userActed(contents);
        return;
      }
      event.preventDefault();
      send(guestId, 'command', { command });
    });
    // A click in a page doesn't move the Atmos page's keyboard focus to it on
    // its own; the web layer focuses the element (and closes Atmos menus).
    // Electron reports mouse events for every frame's widget, an embedded
    // frame of another site included.
    contents.on('before-mouse-event', (_event, mouse) => {
      // The mouse's back and forward buttons, as Alt+Left and Alt+Right.
      const command = policy.mouseCommand(mouse);
      if (command) { send(guestId, 'command', { command }); return; }
      if (mouse.type !== 'mouseDown') return;
      userActed(contents);
      send(guestId, 'mouse-down');
    });
    // A tap: Electron reports touch only for the page's own frame (not a
    // frame of another site in it).
    contents.on('input-event', (_event, input) => {
      if ((input.type === 'touchEnd' || input.type === 'gestureTap') && policy.activatesUser(input)) userActed(contents);
    });
    contents.on('zoom-changed', (_event, direction) => zoom(contents, direction === 'in' ? 'in' : 'out'));
    contents.on('context-menu', (_event, params) => send(guestId, 'context-menu', {
      x: params.x, y: params.y, linkURL: params.linkURL, linkText: String(params.linkText || '').slice(0, 200),
      srcURL: params.srcURL.slice(0, 4096), mediaType: params.mediaType, hasImageContents: params.hasImageContents,
      selectionText: String(params.selectionText || '').slice(0, 500), isEditable: params.isEditable,
      editFlags: { ...params.editFlags }, pageURL: params.pageURL,
    }));
    for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'audio-state-changed', 'dom-ready']) {
      contents.on(name, () => sendState(contents));
    }
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) {
        // A new navigation (not a redirect of one): whatever was being
        // tried over https before is over. Comes before its request.
        endUpgrade(guestId);
        navigations.set(guestId, (navigations.get(guestId) || 0) + 1);
        dropRequestsOf(guestId);
        resetBlocked(guestId);
        send(guestId, 'progress', { value: 0.15 });
      }
    });
    // A tab's page starts blank (web-layer.js) and is then sent where it's
    // going: that blank start isn't somewhere Back should return to.
    let started = contents.getType() !== 'webview';
    contents.on('did-navigate', (_event, url) => {
      if (!started && url !== 'about:blank') {
        started = true;
        contents.navigationHistory.clear();
      }
      // A new page: the click that led here was the page before's (a
      // landing page doesn't get a pop-up from it, as in Chrome), and so
      // was a "Leave site?" answered there.
      activations.forget(guestId);
      leaveRefusedAt.delete(guestId);
      endUpgrade(guestId);
      // What the page before played is over (only now: a navigation that
      // never commits, a download say, leaves it playing).
      endMedia(contents);
      applyZoom(contents);
      send(guestId, 'navigated', { url, title: contents.getTitle(), inPage: false });
      sendState(contents);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      send(guestId, 'navigated', { url, title: contents.getTitle(), inPage: true });
      sendState(contents);
    });
    contents.on('did-frame-finish-load', (_event, isMainFrame) => { if (isMainFrame) send(guestId, 'progress', { value: 0.7 }); });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted (a new navigation, or stopped)
      // A page tried over https that failed there (no https, a bad
      // certificate, no answer): over http instead, saying so.
      if (policy.httpsFallbackError(code) && fallBackToHttp(contents, url)) return;
      endUpgrade(guestId);
      send(guestId, 'load-failed', { url, code, description, certificate: code <= -200 && code > -300 });
    });
    contents.on('page-favicon-updated', (_event, favicons) => { void sendFavicon(contents, favicons); });
    contents.on('found-in-page', (_event, result) => send(guestId, 'find', {
      requestId: result.requestId, matches: result.matches, active: result.activeMatchOrdinal, final: result.finalUpdate,
    }));
    contents.on('enter-html-full-screen', () => { fullscreen = true; send(guestId, 'fullscreen', { on: true }); });
    contents.on('leave-html-full-screen', () => { fullscreen = false; send(guestId, 'fullscreen', { on: false }); });
    contents.on('render-process-gone', (_event, details) => { endMedia(contents); send(guestId, 'crashed', { reason: details.reason }); });
    contents.on('destroyed', () => forgetGuest(guestId));
  }

  /** A pop-up window with its opener (a sign-in window): its site is always in its title. */
  function watchPopup(win) {
    const contents = win.webContents;
    const title = () => {
      if (win.isDestroyed()) return;
      const site = policy.siteOf(contents.getURL()) || contents.getURL();
      const page = contents.getTitle();
      win.setTitle(page && page !== contents.getURL() ? `${site} — ${page}` : site);
    };
    contents.on('page-title-updated', event => { event.preventDefault(); title(); });
    contents.on('did-navigate', title);
    title();
    // Its own close button (or Atmos quitting) is the user acting, though
    // not in the page: "Leave site?" asks again rather than keeping the
    // window open without a word after an earlier Cancel. Emitted before
    // the page's beforeunload.
    win.on('close', () => { if (!contents.isDestroyed()) coreActedAt.set(contents.id, Date.now()); });
  }

  function track(contents) {
    if (live.has(contents.id)) return;
    live.set(contents.id, { private: isPrivateSession(contents.session), tab: contents.getType() === 'webview' });
  }

  function forgetGuest(guestId) {
    const gone = live.get(guestId);
    live.delete(guestId);
    memoryLevels.delete(guestId);
    endUpgrade(guestId);
    closing.delete(guestId);
    dropRequestsOf(guestId);
    resetBlocked(guestId);
    mediaOf.get(guestId)?.fetch?.abort();
    for (const map of [tokenBudget, navigations, budgetFor, leaveRefusedAt, coreActedAt, mediaOf]) map.delete(guestId);
    activations.forget(guestId);
    downloadReady.delete(guestId);
    for (const key of [...expectedDownloads.keys()]) if (key.startsWith(`${guestId}\n`)) expectedDownloads.delete(key);
    if (gone?.private && !endsPrivate.delete(guestId) && ![...live.values()].some(other => other.private)) void endPrivateSession();
  }

  /**
   * Close a page as Chrome closes a tab: its beforeunload, pagehide and
   * unload run first, then it goes. Sites save what they keep there
   * (Discord writes its sign-in back as its page closes); removing a
   * <webview>, or the window around it, skips them. A page that objects
   * (unsaved changes) is closed all the same: the user asked. Resolves
   * when it's gone, or after CLOSE_PAGE_MS (a page that hangs), closed
   * regardless.
   */
  function closePage(contents) {
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    const id = contents.id;
    const already = closing.has(id);
    closing.add(id);
    const gone = new Promise(resolve => {
      let timer = null;
      const done = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => {
        try { if (!contents.isDestroyed()) contents.close(); } catch { /* gone */ }
        done();
      }, CLOSE_PAGE_MS);
      contents.once('destroyed', done);
      try { contents.close({ waitForBeforeUnload: true }); } catch { done(); }
    });
    // The last private page closing: private browsing ends as it goes. A
    // private page opened while it runs its last events waits for that,
    // rather than sharing what this one kept (R27).
    if (!already && live.get(id)?.private && ![...live].some(([other, entry]) => other !== id && entry.private && !closing.has(other))) {
      endsPrivate.add(id);
      void endPrivateSession(gone);
    }
    return gone;
  }
  /**
   * Put a page to sleep (Atmos Browser does it to background tabs): its
   * beforeunload, pagehide and unload run as closePage runs them, but a page
   * that objects to being left (unsaved changes) stays as it is, without a
   * dialog: the user didn't ask to leave it. Closing can't do that for a
   * tab: Electron closes a <webview>'s page whatever its beforeunload says.
   * Leaving it can (a refused navigation is cancelled), so the page first
   * goes to about:blank, then closes. A page that doesn't answer in
   * SLEEP_PAGE_MS isn't refusing: it's closed. Resolves whether it closed.
   */
  function sleepPage(contents) {
    if (!contents || contents.isDestroyed()) return Promise.resolve(true);
    const id = contents.id;
    if (closing.has(id) || sleeping.has(id)) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer = null;
      const settle = closed => {
        if (!sleeping.has(id)) return;
        clearTimeout(timer);
        sleeping.delete(id);
        contents.removeListener('destroyed', gone);
        resolve(closed);
      };
      const gone = () => settle(true);
      // Left: it goes. Not answering either way (a hung page isn't
      // refusing): it goes after SLEEP_PAGE_MS, as closePage closes one.
      const close = () => {
        if (!sleeping.has(id)) return;
        settle(true);
        void closePage(contents);
      };
      sleeping.set(id, settle);
      contents.once('destroyed', gone);
      timer = setTimeout(close, SLEEP_PAGE_MS);
      contents.loadURL('about:blank').then(close, () => settle(contents.isDestroyed()));
    });
  }
  const openTabs = () => [...live.entries()].filter(([, entry]) => entry.tab)
    .map(([id]) => webContents.fromId(id)).filter(contents => contents && !contents.isDestroyed());
  /** Every tab's page, closed that way: before the Atmos window, or its page, goes. */
  const closePages = () => Promise.all(openTabs().map(closePage));

  /**
   * The last private tab closed: everything it kept goes (once `after`,
   * the page going, is done). A private page opened meanwhile waits for
   * it (R27: 'web:do'), or the clearing would take what that page keeps;
   * one more closing after it clears again. A clearing that hasn't ended
   * in PRIVATE_END_MS lets them go on (nothing else would, until a restart).
   */
  function endPrivateSession(after = null) {
    const limit = testOptions.privateEndMs || PRIVATE_END_MS;
    const ending = (privateEnding || Promise.resolve()).then(() => after).then(() => {
      let timer = null;
      const late = new Promise(resolve => {
        timer = setTimeout(() => { console.warn('[web] the private session is taking long to clear; private pages go on'); resolve(); }, limit);
      });
      return Promise.race([clearPrivateSession().finally(() => clearTimeout(timer)), late]);
    })
      .catch(error => console.warn('[web] could not end private browsing:', error.message))
      .finally(() => { if (privateEnding === ending) privateEnding = null; });
    privateEnding = ending;
    return ending;
  }
  async function clearPrivateSession() {
    const privateSession = configureSessions().private;
    settings.clearPrivate();
    httpOnly.private.clear();
    for (const cache of [faviconCache, artworkCache]) for (const key of [...cache.keys()]) if (key.startsWith('p|')) cache.delete(key);
    for (const [id, entry] of [...downloads]) {
      if (!entry.record.private) continue;
      // One still running is forgotten once it ends (R29: startDownload).
      if (entry.record.state === 'progressing') entry.forget = true;
      else { downloads.delete(id); send(null, 'download-removed', { id }); }
    }
    try {
      await privateSession.clearStorageData();
      await privateSession.clearCache();
      await privateSession.clearAuthCache();
      await privateSession.clearHostResolverCache();
      // Its connections too: one kept open would carry over to the next
      // private session (the in-memory session lives as long as Atmos).
      await privateSession.closeAllConnections();
    } catch (error) { console.warn('[web] could not clear the private session:', error.message); }
    send(null, 'private-ended');
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  /** The browser's sessions, made and given their handlers the first time they're needed. */
  function configureSessions() {
    if (webSessions) return webSessions;
    webSessions = { ordinary: session.fromPartition(policy.PARTITION), private: session.fromPartition(policy.PRIVATE_PARTITION) };
    const userAgent = policy.chromeUserAgent();
    for (const ses of [webSessions.ordinary, webSessions.private]) {
      const isPrivate = ses === webSessions.private;
      ses.setUserAgent(userAgent);
      // Ads and trackers: every request a page makes, and the $csp of documents.
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        if (details.resourceType === 'mainFrame') {
          let upgraded = null;
          try { upgraded = upgradeRequest(details, isPrivate); } catch (error) { console.warn('[web] https:', error.message); }
          if (upgraded) return callback({ redirectURL: upgraded });
        }
        let verdict = {};
        try { verdict = blockRequest(details, isPrivate); } catch (error) { console.warn('[web] blocking:', error.message); }
        callback(verdict);
      });
      ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] }, (details, callback) => {
        // An upgraded page answered over https: no falling back on a timer.
        if (details.resourceType === 'mainFrame') clearTimeout(upgrades.get(details.webContentsId)?.timer);
        let verdict = {};
        try { verdict = addListCsp(details, isPrivate); } catch (error) { console.warn('[web] list CSP:', error.message); }
        callback(verdict);
      });
      const filter = policy.CLIENT_HINTS_FILTER;
      ses.webRequest.onBeforeSendHeaders({ urls: [...filter.urls], types: [...filter.types] }, (details, callback) => {
        callback({ requestHeaders: policy.withClientHints(details.requestHeaders) });
      });
      // A permission is the page's, whichever of its frames asks (named and
      // kept for the site you're on: web-policy.cjs, permissionSite).
      const settingFor = origin => permissionName => settings.permission(origin, permissionName, { private: isPrivate });
      const isTab = contents => !!contents && live.get(contents.id)?.tab === true;
      ses.setPermissionRequestHandler((contents, permission, callback, details) => {
        const topUrl = contents?.getURL?.() || '';
        const origin = policy.permissionSite(permission, { requestingUrl: details?.requestingUrl || topUrl, topUrl });
        const activated = !!contents && Date.now() - activations.lastAt(contents.id) < policy.USER_ACTIVATION_MS;
        const decision = policy.permissionDecision(permission, details || {}, settingFor(origin), { origin, tab: isTab(contents), activated });
        if (decision === 'allow') {
          // The cursor is about to go: say whose page took it and how to get it back.
          if (permission === 'pointerLock') send(contents.id, 'pointer-lock', {});
          return callback(true);
        }
        // Only a tab asks: a pop-up has no browser around it to ask in.
        if (decision === 'deny' || !isTab(contents)) return callback(false);
        askPermission(contents, origin, policy.permissionNames(permission, details || {}), callback);
      });
      // Electron passes no contents for a frame of another origin, nor for
      // notifications; then the page is the embedding origin it names (the
      // top-level page's), or, for the page itself, the one asking.
      ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
        const requestingUrl = requestingOrigin || details?.requestingUrl || '';
        const topUrl = details?.embeddingOrigin || contents?.getURL?.() || requestingUrl;
        const origin = policy.permissionSite(permission, { requestingUrl, topUrl });
        return policy.permissionCheck(permission, details || {}, settingFor(origin), { origin, tab: isTab(contents) });
      });
      ses.setDevicePermissionHandler(() => false);
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      ses.setBluetoothPairingHandler?.((_details, callback) => callback({ confirmed: false }));
      ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(); });
      ses.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback(''); });
      ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
      ses.on('will-download', (event, item, contents) => startDownload(event, item, contents, isPrivate));
    }
    // The blocker loads what it kept (or fetches its lists) now, off to the side.
    adblocker();
    if (blockAdsOn()) void adblock.start();
    // Pages' storage and cookies go to disk every 30 s and as Atmos quits.
    // Chromium writes them in batches (a busy site's localStorage a minute
    // or more behind), so a hard stop (Ctrl+C on `npm start`, a crash) lost
    // what a site had just saved: Discord's sign-in token, say.
    const flush = () => {
      const ordinary = webSessions.ordinary;
      try { ordinary.flushStorageData(); } catch { /* nothing to write */ }
      ordinary.cookies.flushStore().catch(() => {});
    };
    setInterval(flush, STORAGE_FLUSH_MS).unref?.();
    app.on('before-quit', flush);
    setInterval(checkMemory, MEMORY_CHECK_MS).unref?.();
    return webSessions;
  }

  // ── Automatic https ───────────────────────────────────────────────────────
  /**
   * A page's address over https instead of http (policy.httpsUpgrade), as
   * Chrome's HTTPS-Upgrades: tried first, and back to http if that fails
   * (fallBackToHttp) or answers nothing in 3 s. The http address is
   * remembered for the tab until the page commits. A site that sends the
   * https address back to http (it has none, really) is let through and
   * remembered as http only; so is one redirecting between upgrades more
   * than a few times.
   */
  function upgradeRequest(details, isPrivate) {
    const id = details.webContentsId;
    if (!live.has(id) || details.method !== 'GET') return null; // a form's POST isn't retried as a GET
    const pending = upgrades.get(id);
    const host = sameHost(details.url, 'http:');
    if (!host) return null;
    const only = isPrivate ? httpOnly.private : httpOnly.ordinary;
    if (pending?.downgrade && pending.host === host) {
      // Sent back to http by the site (will-redirect): remembered, let through.
      if (only.size < 1000) only.add(host);
      endUpgrade(id);
      send(id, 'https-fallback', { url: details.url, site: host, redirected: true });
      return null;
    }
    // A chain of redirects between upgrades: this navigation goes as asked,
    // and nothing is remembered.
    if (pending && pending.redirects >= 4) return null;
    const upgraded = policy.httpsUpgrade(details.url, only);
    if (!upgraded) return null;
    clearTimeout(pending?.timer);
    const entry = { host, httpUrl: details.url, redirects: pending ? pending.redirects + 1 : 0, timer: null, isPrivate, downgrade: false };
    entry.timer = setTimeout(() => {
      const contents = webContents.fromId(id);
      if (contents && !contents.isDestroyed() && contents.isLoading() && upgrades.get(id) === entry) fallBackToHttp(contents, null);
    }, HTTPS_FALLBACK_MS);
    upgrades.set(id, entry);
    return upgraded;
  }

  /** The host of `url` when its scheme is `scheme` (lower case, no trailing dot), else ''. */
  function sameHost(url, scheme) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === scheme ? parsed.hostname.toLowerCase().replace(/\.$/, '') : '';
    } catch { return ''; }
  }

  function endUpgrade(id) {
    clearTimeout(upgrades.get(id)?.timer);
    upgrades.delete(id);
  }

  /**
   * The page being tried over https failed (`failedUrl`, its https address;
   * null: no answer in time): remember the site as http only, load the http
   * address and tell the tab. False when the page wasn't being upgraded.
   */
  function fallBackToHttp(contents, failedUrl) {
    const entry = upgrades.get(contents.id);
    if (!entry) return false;
    if (failedUrl && sameHost(failedUrl, 'https:') !== entry.host) return false;
    endUpgrade(contents.id);
    const only = entry.isPrivate ? httpOnly.private : httpOnly.ordinary;
    if (only.size < 1000) only.add(entry.host);
    send(contents.id, 'https-fallback', { url: entry.httpUrl, site: entry.host });
    contents.loadURL(entry.httpUrl).catch(() => { /* reported through did-fail-load */ });
    return true;
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  /**
   * Each tab's process, measured as Task Manager does (private bytes on
   * Windows; the working set elsewhere). A page past 2 GB, then each 2 GB
   * more, gets a 'memory' event with its size, so the browser can put a
   * background tab to sleep or say so of the one you're on: a runaway page
   * (X in a long session reached 14 GB) otherwise takes the whole machine.
   * A page that comes back down can be told again later.
   */
  function checkMemory() {
    const tabs = [...live].filter(([, entry]) => entry.tab).map(([id]) => webContents.fromId(id)).filter(contents => contents && !contents.isDestroyed());
    if (!tabs.length) return;
    let metrics;
    try { metrics = app.getAppMetrics(); } catch { return; }
    const bytesOf = new Map(metrics.map(metric => [metric.pid, 1024 * (metric.memory?.privateBytes || metric.memory?.workingSetSize || 0)]));
    const step = testOptions.memoryStepBytes || MEMORY_STEP_BYTES;
    for (const contents of tabs) {
      let pid;
      try { pid = contents.getOSProcessId(); } catch { continue; }
      const bytes = bytesOf.get(pid) || 0;
      const level = Math.floor(bytes / step);
      const told = memoryLevels.get(contents.id) || 0;
      if (level > told) send(contents.id, 'memory', { bytes });
      if (level !== told) memoryLevels.set(contents.id, level);
    }
  }

  // ── Downloads ─────────────────────────────────────────────────────────────
  function downloadRecord(id, item, contents, isPrivate) {
    return {
      id, guestId: contents?.id ?? null, url: item.getURL().slice(0, 2048), name: policy.downloadName(item.getFilename(), item.getURL()),
      path: null, state: 'progressing', paused: false, received: 0, total: item.getTotalBytes() || 0,
      started: Date.now(), private: isPrivate, openable: false,
    };
  }

  function startDownload(event, item, contents, isPrivate) {
    const page = contents && !contents.isDestroyed() ? contents : null;
    const may = page ? downloadMayStart(page, item) : true;
    // As Chrome: a secure page's download that comes over plain http is
    // stopped (anyone on the way could have swapped the file), unless you
    // then asked for it (the notice's Download anyway: 'expected').
    let chain = [];
    try { chain = item.getURLChain(); } catch { chain = []; }
    if (!chain.length) chain = [item.getURL()];
    // Who started it: the page, or (a tab it opened, with no page of its
    // own yet) the secure page that opened it.
    let starter = page ? page.getURL() : '';
    if (page && !/^https?:/i.test(starter)) {
      for (const [address, until] of secureOpeners) if (until < Date.now()) secureOpeners.delete(address);
      if (secureOpeners.has(sameUrl(chain[0]))) starter = 'https://opener.invalid/';
    }
    const insecure = !!page && may !== 'expected' && policy.insecureDownload(chain, starter);
    if (page && (!may || insecure)) {
      event.preventDefault();
      const url = item.getURL();
      send(page.id, 'download-blocked', {
        url: url.length <= 2048 ? url : null, name: policy.downloadName(item.getFilename(), url),
        site: policy.siteOf(page.getURL()) || '', private: isPrivate, insecure,
      });
      return;
    }
    const id = `d${nextId++}`;
    const record = downloadRecord(id, item, contents, isPrivate);
    const folder = testOptions.downloadsDir || app.getPath('downloads');
    // On disk, or given to a download still running (R30: two at once
    // would write the same file), or offered to one whose save dialog is
    // still open. Compared without case, as Windows and macOS compare names.
    const running = new Set([...downloads.values()].filter(({ record }) => record.state === 'progressing')
      .map(({ item: other, offered }) => (other.getSavePath() || offered || '').toLowerCase()).filter(Boolean));
    const taken = name => fs.existsSync(path.join(folder, name)) || running.has(path.join(folder, name).toLowerCase());
    const offered = path.join(folder, policy.uniqueName(record.name, taken));
    if (testOptions.downloadsDir || !settings.options().askWhereToSave) item.setSavePath(offered);
    else item.setSaveDialogOptions({ title: 'Save file', defaultPath: offered });
    const entry = { item, record, offered };
    downloads.set(id, entry);
    while (downloads.size > MAX_DOWNLOADS) {
      const oldest = [...downloads.entries()].find(([, entry]) => entry.record.state !== 'progressing');
      if (!oldest) break;
      downloads.delete(oldest[0]);
    }
    const update = () => {
      const savePath = item.getSavePath();
      Object.assign(record, {
        path: savePath || null, name: savePath ? path.basename(savePath) : record.name,
        state: item.getState(), paused: item.isPaused(), received: item.getReceivedBytes(), total: item.getTotalBytes() || record.total,
      });
      record.openable = record.state === 'completed' && policy.openableDownload(record.name);
      send(record.guestId, 'download', { ...record });
    };
    // Private browsing ended while it ran (R29): once it ends, it goes as
    // the private session's other downloads went.
    const forget = () => {
      if (downloads.get(id) !== entry) return;
      downloads.delete(id);
      send(null, 'download-removed', { id });
    };
    item.on('updated', () => {
      // Stopped part-way (it could be resumed, so it isn't done): from a
      // list it's no longer in, it won't be. Cancelled, and gone.
      if (entry.forget && item.getState() === 'interrupted') { forget(); item.cancel(); return; }
      update();
    });
    item.once('done', () => {
      if (entry.forget) { forget(); return; }
      update();
    });
    send(record.guestId, 'download', { ...record });
  }

  function downloadAction(id, action) {
    const entry = downloads.get(id);
    if (!entry) throw new Error('no such download');
    const { item, record } = entry;
    if (action === 'cancel') { if (record.state === 'progressing') item.cancel(); return true; }
    if (action === 'pause') { if (record.state === 'progressing') item.pause(); return true; }
    if (action === 'resume') { if (item.canResume()) item.resume(); return true; }
    if (action === 'remove') {
      if (record.state === 'progressing') item.cancel();
      downloads.delete(id);
      send(null, 'download-removed', { id });
      return true;
    }
    if (record.state !== 'completed' || !record.path || !fs.existsSync(record.path)) throw new Error('The file isn’t there any more');
    if (action === 'show') { shell.showItemInFolder(record.path); return true; }
    if (action === 'open') {
      if (!policy.openableDownload(record.name)) throw new Error('Atmos opens only documents, media and archives; use Show in folder');
      return shell.openPath(record.path).then(problem => { if (problem) throw new Error(problem); return true; });
    }
    throw new Error(`unknown download action ${action}`);
  }

  // ── Commands from the web layer ───────────────────────────────────────────
  function guestOf(id) {
    const contents = webContents.fromId(Number(id));
    if (!contents || contents.isDestroyed() || !isWebSession(contents.session)) return null;
    if (contents.hostWebContents !== atmosWindow?.webContents) return null;
    track(contents);
    return contents;
  }

  /**
   * The user sent a page somewhere from the browser (the address bar, Back,
   * a reload): "Leave site?" may ask (askBeforeLeaving), and what it loads
   * may be a download.
   */
  function userMoved(contents) {
    coreActedAt.set(contents.id, Date.now());
    downloadReady.add(contents.id);
  }

  const commands = {
    navigate(contents, url) {
      const verdict = policy.navigationPolicy(String(url), { frame: 'top' });
      if (verdict.action === 'external') { askExternal(contents, String(url), verdict.scheme); return 'external'; }
      if (verdict.action !== 'allow') throw new Error(verdict.reason);
      userMoved(contents);
      contents.loadURL(String(url)).catch(() => { /* reported through did-fail-load */ });
      return 'loading';
    },
    back: contents => { if (contents.navigationHistory.canGoBack()) { userMoved(contents); contents.navigationHistory.goBack(); } },
    forward: contents => { if (contents.navigationHistory.canGoForward()) { userMoved(contents); contents.navigationHistory.goForward(); } },
    reload: (contents, options) => { userMoved(contents); return options?.hard ? contents.reloadIgnoringCache() : contents.reload(); },
    stop: contents => { endUpgrade(contents.id); contents.stop(); },
    zoom: (contents, direction) => zoom(contents, ['in', 'out', 'reset'].includes(direction) ? direction : 'reset'),
    // options.findNext: the next match of the search already made (Enter
    // again). Electron's own findNext means the opposite: "begin a new
    // search", true for the first request of one.
    find(contents, text, options) {
      const query = String(text ?? '').slice(0, 500);
      if (!query) { contents.stopFindInPage('clearSelection'); return null; }
      return contents.findInPage(query, { forward: options?.forward !== false, findNext: options?.findNext !== true, matchCase: options?.matchCase === true });
    },
    stopFind: contents => contents.stopFindInPage('keepSelection'),
    print: contents => new Promise(resolve => contents.print({}, success => resolve(success))),
    mute: (contents, muted) => { contents.setAudioMuted(muted === true); sendState(contents); return contents.isAudioMuted(); },
    edit(contents, action) {
      if (!EDIT_ACTIONS.has(action)) throw new Error(`unknown edit ${action}`);
      contents[action]();
    },
    download(contents, url) {
      const target = String(url || '');
      if (!/^(https?:|data:|blob:)/i.test(target) || target.length > 2_000_000) throw new Error('not something to download');
      expectDownload(contents, target);
      contents.downloadURL(target);
    },
    // The image at a point of the page (a context menu's), onto the clipboard.
    copyImage(contents, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('copyImage(x, y)');
      contents.copyImageAt(Math.round(x), Math.round(y));
    },
    focus: contents => contents.focus(),
    state: contents => state(contents),
    // Now Playing's controls, for what plays in the page: play/pause, next,
    // previous, seek (seconds). The page's preload does it (web-page-preload.cjs).
    media(contents, action, value) {
      if (!policy.MEDIA_ACTIONS.includes(action)) throw new Error(`unknown media action ${String(action).slice(0, 20)}`);
      if (action === 'seek' && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('seek to a number of seconds, 0 or more');
      contents.send(MEDIA_CONTROL, { action, value: action === 'seek' ? value : null });
    },
    // The site's shield: up (blocking) or down (its ads and trackers allowed).
    // Kept per site; a private tab's choice stays with the private session.
    shield(contents, on) {
      const origin = policy.siteOf(contents.getURL());
      if (!origin) throw new Error('This isn’t a web page');
      settings.setPermission(origin, 'ads', on === false ? 'allow' : null, { private: isPrivateSession(contents.session) });
      for (const id of live.keys()) {
        const other = webContents.fromId(id);
        if (other && policy.siteOf(other.getURL()) === origin) sendState(other);
      }
      return shieldOf(contents);
    },
    // What was blocked on the page: the count, and by site.
    blocked(contents) {
      const entry = blockedByTab.get(contents.id);
      return {
        count: entry?.count || 0,
        hosts: [...(entry?.hosts || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([host, count]) => ({ host, count })),
      };
    },
    capture: async contents => {
      const image = await contents.capturePage();
      const size = image.getSize();
      const scaled = size.width > 960 ? image.resize({ width: 960, quality: 'good' }) : image;
      return `data:image/jpeg;base64,${scaled.toJPEG(76).toString('base64')}`;
    },
    // After the page attached it: settle its zoom, and tell the layer where it stands.
    attached(contents) { applyZoom(contents); return { ...state(contents), private: isPrivateSession(contents.session) }; },
    // The tab closing: its page's last events first (closePage).
    close: contents => closePage(contents),
    // The tab put to sleep: the same, if its page lets go (sleepPage).
    sleep: contents => sleepPage(contents),
    // Out of a page's HTML fullscreen (Escape, wherever the keyboard is). In
    // a world of Core's own, where the page's scripts can't have replaced
    // document.exitFullscreen.
    exitFullscreen(contents) {
      const code = 'document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false';
      void contents.executeJavaScriptInIsolatedWorld(CORE_WORLD, [{ code }], true).catch(() => false);
    },
  };

  function fromAtmosPage(event) {
    return !!atmosWindow && event.sender === atmosWindow.webContents && event.senderFrame === event.sender.mainFrame && isAppUrl(event.senderFrame?.url);
  }
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromAtmosPage(event)) throw new Error('Not allowed');
    return fn(...args);
  });

  handle('web:do', async (id, name, ...args) => {
    let contents = guestOf(id);
    if (!contents) throw new Error('That page is closed');
    if (!Object.hasOwn(commands, name)) throw new Error(`unknown command ${name}`);
    // A private page opened as the last one's session is cleared goes
    // nowhere until that's done (R27).
    if (privateEnding && isPrivateSession(contents.session)) {
      await privateEnding;
      contents = guestOf(id);
      if (!contents) throw new Error('That page is closed');
    }
    return commands[name](contents, ...args);
  });
  handle('web:downloads', () => [...downloads.values()].map(({ record }) => ({ ...record })).reverse());
  handle('web:download-do', (id, action) => downloadAction(String(id), String(action)));
  handle('web:permission-respond', (id, answer) => settlePermission(String(id), answer?.allow === true, answer?.remember !== false));
  handle('web:external-respond', (id, allow) => {
    const request = externalRequests.get(String(id));
    if (!request) return false;
    externalRequests.delete(String(id));
    clearTimeout(request.timer);
    if (allow === true) return openExternal(request.url).then(() => true, () => false);
    return false;
  });
  handle('web:site-settings', () => settings.listPermissions());
  handle('web:site-setting', (origin, name, value) => { settings.setPermission(String(origin), String(name), value === null ? null : String(value)); return settings.listPermissions(); });
  handle('web:options', () => settings.options());
  handle('web:set-options', patch => {
    const before = blockAdsOn();
    const options = settings.setOptions(patch);
    if (blockAdsOn() !== before) {
      if (webSessions && blockAdsOn()) void adblocker().start();
      for (const id of live.keys()) { const contents = webContents.fromId(id); if (contents) sendState(contents); }
    }
    return options;
  });
  // The blocker: its lists, when they were updated, what it has blocked in all.
  handle('web:adblock', () => {
    if (blockAdsOn()) void adblocker().start();
    return { ...adblocker().status(), enabled: blockAdsOn() };
  });
  handle('web:adblock-update', async () => {
    const blocker = adblocker();
    await blocker.start();
    await blocker.update({ force: true });
    return { ...blocker.status(), enabled: blockAdsOn() };
  });
  handle('web:clear-data', async what => {
    const ses = configureSessions().ordinary;
    if (what?.cookies) await ses.clearStorageData();
    if (what?.cache) { await ses.clearCache(); faviconCache.clear(); artworkCache.clear(); }
    if (what?.siteSettings) settings.clear({ permissions: true, zoom: true });
    return true;
  });
  // A link meant for the browser that nobody took (its frames went meanwhile).
  handle('web:open-external', url => (/^https?:\/\//i.test(String(url)) ? openExternal(String(url)).then(() => true) : false));
  // The extension listening for links from the rest of Atmos, while its frames run.
  handle('web:link-listener', ref => {
    linkListener = typeof ref === 'string' && isWebExtension(ref) ? ref : null;
    if (linkListener) {
      try { fs.mkdirSync(path.dirname(ownerFile), { recursive: true }); fs.writeFileSync(ownerFile, JSON.stringify({ ref: linkListener })); } catch { /* best effort */ }
    }
    return !!linkListener;
  });

  // ── The <webview>s the Atmos page may attach ─────────────────────────────
  function attachWebview(contents, event, webPreferences, params) {
    const fromAtmosPage = !!atmosWindow && contents === atmosWindow.webContents && isAppUrl(contents.getURL());
    const verdict = policy.webviewAttachment({ fromAtmosPage, params });
    if (!verdict.ok) {
      event.preventDefault();
      console.warn('[web] refused a <webview>:', verdict.reason);
      return;
    }
    // Its session has the browser's handlers before its page exists.
    configureSessions();
    for (const key of Object.keys(webPreferences)) delete webPreferences[key];
    Object.assign(webPreferences, verdict.webPreferences, { preload: PAGE_PRELOAD });
    for (const key of Object.keys(params)) delete params[key];
    Object.assign(params, verdict.params);
  }

  /**
   * A link the rest of Atmos would give the system browser: in a new tab of
   * Atmos Browser instead, when the user asked for that and it's running.
   * It comes to the front only just after a click or key in Atmos (one link
   * each); otherwise it waits in a tab behind, so an extension can't raise
   * the browser, and a page in your browsing session, whenever it likes.
   * Returns whether it took the link. `foreground`: you chose to open it
   * (an extension's link you said Open to), so it comes to the front.
   */
  function openLink(url, { foreground = false } = {}) {
    if (!settings.options().openLinks || !linkListener || !policy.isLoadable(url) || url === 'about:blank') return false;
    if (!isWebExtension(linkListener)) { linkListener = null; return false; }
    send(null, 'open-link', { url, background: !(foreground || activations.take('atmos', 'link')) });
    return true;
  }

  /**
   * shell.openExternal for everything in the main process, Core's own code
   * and official main.cjs alike, goes through openLink first, so "Open links
   * in Atmos Browser" covers every link Atmos would send to the system browser.
   */
  function routeShell() {
    shell.openExternal = (url, options) => (openLink(String(url)) ? Promise.resolve() : openExternal(url, options));
  }

  /** The extension that used the browser was removed with its data: its browsing data goes too. */
  async function forgetExtensionData(ref) {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).ref; } catch { return false; }
    if (owner !== ref) return false;
    if (webSessions) {
      for (const ses of [webSessions.ordinary, webSessions.private]) {
        try { await ses.clearStorageData(); await ses.clearCache(); } catch { /* best effort */ }
      }
    } else {
      // Not opened this run (removals are applied at startup, before any
      // page): the partition's folder goes whole.
      fs.rmSync(path.join(userData, 'Partitions', policy.PARTITION.replace(/^persist:/, '')), { recursive: true, force: true });
    }
    fs.rmSync(path.join(userData, 'browser'), { recursive: true, force: true });
    return true;
  }

  let lastPointerDown = null; // the Atmos window's last mouse-button press (setWindow)
  return {
    isWebSession,
    applyPolicy(contents) { applyPolicy(contents); track(contents); },
    attachWebview,
    configureSessions,
    openLink,
    openExternal,
    routeShell,
    /** When the Atmos window last had a click or key (its page or a frame in it), in ms. */
    atmosActedAt: () => activations.lastAt('atmos'),
    /**
     * Where and when the Atmos window last had a mouse button pressed:
     * { x, y, at } in its page's pixels, as Chromium reported it (a frame
     * can't make one up), or null.
     */
    atmosPointerDown: () => lastPointerDown,
    forgetExtensionData,
    closePages,
    setWindow(win) {
      atmosWindow = win;
      // The Atmos window's own input (its page and extensions' frames; a
      // tap only on Atmos's own page, as Electron reports touch): a link
      // Atmos then opens here comes to the front (openLink).
      const acted = () => activations.activate('atmos');
      win.webContents.on('before-input-event', (_event, input) => { if (policy.activatesUser(input)) acted(); });
      win.webContents.on('before-mouse-event', (_event, mouse) => {
        if (mouse.type !== 'mouseDown') return;
        acted();
        const zoom = win.webContents.getZoomFactor?.() || 1;
        lastPointerDown = { x: mouse.x / zoom, y: mouse.y / zoom, at: Date.now() };
      });
      win.webContents.on('input-event', (_event, input) => { if (input.type === 'touchEnd' || input.type === 'gestureTap') acted(); });
      // Before the window goes (closed, or Atmos quitting), its tabs' pages
      // close as Chrome closes them: destroying the window would destroy
      // its <webview>s without their last events. Once per window.
      let pagesClosed = false;
      win.on('close', event => {
        if (pagesClosed || !openTabs().length) return;
        event.preventDefault();
        pagesClosed = true;
        void closePages().finally(() => {
          if (quitting) app.quit();
          else if (!win.isDestroyed()) win.close();
        });
      });
    },
    settings,
  };
}

module.exports = { createWebHost };

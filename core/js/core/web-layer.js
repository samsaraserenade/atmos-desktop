/**
 * Atmos Browser, page side: one <webview> per open tab, in a layer Core
 * owns, shown where the extension's panel says (atmos.web.setSurface).
 *
 * The main process (web-host.cjs) decides what a page may do; this file
 * decides only where it shows, and relays. Pages composite with the rest of
 * Atmos, so menus, Settings, Task View, glass and a transparent window's
 * rounded corners draw over and around them as over anything else.
 *
 * How a page sits in a panel:
 *   - The layer (#atmos-web-layer-<extension>) is a child of the panel host
 *     (#media-fullscreen), before the panels, so it paints under the
 *     extension's panel section and above anything stacked lower (freeform
 *     windows). It never moves in the DOM: a <webview> moved or taken out of
 *     the page reloads, so panels can come and go around it.
 *   - The panel's frame is clipped where the page is (clip-path), except
 *     where it draws over the page itself (its "over" rectangles: address-bar
 *     suggestions, prompts), and the panel's boxes let the pointer through
 *     to the page (pointer-events), so the page shows and takes input there.
 *   - Its geometry follows the panel in the same frame: ResizeObservers run
 *     after layout and before paint; a freeform window moved (no size change)
 *     is seen through its style.
 *
 * Every tab belongs to the extension whose frame opened it; only that
 * extension's frames can drive it or hear from it.
 */
import { closeOpenMenu } from './context-menu.js';

const api = window.atmosCore?.web ?? null;
const PARTITION = 'persist:atmos-browser';
const PRIVATE_PARTITION = 'atmos-browser-private';
const ATTACH_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 5000;  // the page's own closing has 3 s (web-host.cjs); then the element goes regardless

const _tabs = new Map();    // "owner tabId" -> tab
const _byGuest = new Map(); // guest webContents id -> tab
const _owners = new Map();  // owner ("plugin:<id>") -> { listeners, surface, shown, fullscreen, layer, watch, passThrough }

const tabKey = (owner, tabId) => `${owner} ${tabId}`;

function ownerState(owner) {
  if (!_owners.has(owner)) {
    _owners.set(owner, { listeners: new Set(), surface: null, shown: null, fullscreen: null, layer: null, watch: null, passThrough: [] });
  }
  return _owners.get(owner);
}

function emit(owner, payload) {
  for (const fn of [...ownerState(owner).listeners]) {
    try { fn(payload); } catch (error) { console.error('[web-layer] listener failed:', error); }
  }
}

/** The extension whose frames are listening (for links and downloads that belong to no tab). */
function listeningOwner() {
  return [..._owners].find(([, state]) => state.listeners.size)?.[0] ?? null;
}

function publicTab(tab) {
  return { tabId: tab.tabId, private: tab.private, ...tab.state };
}

function layerOf(owner) {
  const state = ownerState(owner);
  if (state.layer?.isConnected) return state.layer;
  const host = document.getElementById('media-fullscreen');
  const layer = document.createElement('div');
  layer.className = 'atmos-web-layer';
  layer.dataset.extension = owner;
  // user-select: none, so no selection in the Atmos page can take in a page:
  // Chromium tints a selected frame grey, over the whole page.
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;display:none;background:transparent;user-select:none;-webkit-user-select:none';
  host.prepend(layer);
  state.layer = layer;
  return layer;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

async function open(owner, tabId, { url = 'about:blank', private: isPrivate = false } = {}) {
  if (!api) throw new Error('web pages are unavailable');
  const key = tabKey(owner, tabId);
  if (_tabs.has(key)) throw new Error(`tab ${tabId} is already open`);
  const element = document.createElement('webview');
  element.setAttribute('partition', isPrivate ? PRIVATE_PARTITION : PARTITION);
  element.setAttribute('src', 'about:blank');
  element.className = 'atmos-web-page';
  element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden;background:transparent;user-select:none;-webkit-user-select:none';
  const tab = { owner, tabId, private: isPrivate === true, element, guestId: null, state: { url: 'about:blank', title: '', loading: true } };
  _tabs.set(key, tab);
  // getWebContentsId() throws until dom-ready; did-attach alone isn't enough.
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the page did not start')), ATTACH_TIMEOUT_MS);
    element.addEventListener('dom-ready', () => { clearTimeout(timer); resolve(element.getWebContentsId()); }, { once: true });
  });
  layerOf(owner).appendChild(element);
  try {
    tab.guestId = await ready;
  } catch (error) {
    _tabs.delete(key);
    element.remove();
    throw error;
  }
  if (!_tabs.has(key)) throw new Error(`tab ${tabId} was closed`);
  _byGuest.set(tab.guestId, tab);
  Object.assign(tab.state, await api.command(tab.guestId, 'attached'));
  if (url && url !== 'about:blank') {
    await api.command(tab.guestId, 'navigate', url).catch(error => {
      emit(owner, { type: 'refused', tabId, url, reason: error.message });
    });
  }
  place(owner);
  emit(owner, { type: 'opened', tabId, tab: publicTab(tab) });
  return publicTab(tab);
}

function close(owner, tabId) {
  const tab = _tabs.get(tabKey(owner, tabId));
  if (!tab) return false;
  _tabs.delete(tabKey(owner, tabId));
  if (tab.guestId !== null) _byGuest.delete(tab.guestId);
  // Gone from view at once; the page closes as Chrome closes a tab, its
  // beforeunload, pagehide and unload first (web-host.cjs closePage: sites
  // save what they keep there), and only then is the element removed.
  // Removing it straight away would destroy the page without them.
  tab.element.style.visibility = 'hidden';
  const remove = () => tab.element.remove();
  if (tab.guestId !== null && api) {
    const fallback = setTimeout(remove, CLOSE_TIMEOUT_MS);
    api.command(tab.guestId, 'close').catch(() => {}).finally(() => { clearTimeout(fallback); remove(); });
  } else {
    remove();
  }
  const state = ownerState(owner);
  if (state.shown === tabId) state.shown = null;
  if (state.fullscreen === tabId) state.fullscreen = null;
  place(owner);
  emit(owner, { type: 'closed', tabId });
  return true;
}

function show(owner, tabId) {
  const state = ownerState(owner);
  if (tabId !== null && !_tabs.has(tabKey(owner, tabId))) throw new Error(`no tab ${tabId}`);
  const changed = state.shown !== tabId;
  state.shown = tabId;
  for (const tab of _tabs.values()) {
    if (tab.owner === owner) tab.element.style.visibility = tab.tabId === tabId ? 'visible' : 'hidden';
  }
  place(owner);
  if (changed) window.dispatchEvent(new Event('atmos:panel-content-changed'));
  return true;
}

function tabOf(owner, tabId) {
  const tab = _tabs.get(tabKey(owner, tabId));
  if (!tab || tab.guestId === null) throw new Error(`no tab ${tabId}`);
  return tab;
}

async function command(owner, tabId, name, ...args) {
  const tab = tabOf(owner, tabId);
  if (name === 'focus') {
    // The element first: the Atmos page's own focus has to move to it.
    tab.element.focus();
  }
  return api.command(tab.guestId, name, ...args);
}

// ── Where the page shows ─────────────────────────────────────────────────────

/** The panel's frame says where the page goes, in its own pixels (null: nowhere). */
function setSurface(owner, iframe, rect) {
  const state = ownerState(owner);
  if (!rect) {
    if (state.surface?.iframe !== iframe) return;
    state.watch?.disconnect();
    state.watch = null;
    state.surface = null;
    iframe.style.clipPath = '';
    passThrough(state, null, null);
    place(owner);
    return;
  }
  const changedFrame = state.surface?.iframe !== iframe;
  state.surface = { iframe, rect };
  if (changedFrame) {
    state.watch?.disconnect();
    const section = iframe.closest('.panel-section');
    const resize = new ResizeObserver(() => place(owner));
    const moves = new MutationObserver(() => place(owner));
    resize.observe(iframe);
    resize.observe(document.getElementById('media-fullscreen'));
    if (section) {
      resize.observe(section);
      moves.observe(section, { attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    state.watch = { disconnect() { resize.disconnect(); moves.disconnect(); } };
  }
  place(owner);
}

/** The panel's boxes around its frame let the pointer through to the page; the frame and a window's title bar and handle still take it. */
function passThrough(state, iframe, section) {
  for (const element of state.passThrough) element.style.pointerEvents = '';
  state.passThrough = [];
  if (!iframe || !section) return;
  for (let element = iframe.parentElement; element && element !== section.parentElement; element = element.parentElement) {
    element.style.pointerEvents = 'none';
    state.passThrough.push(element);
  }
  for (const element of [iframe, ...section.querySelectorAll(':scope > .panel-window-titlebar, :scope > .panel-window-resizer')]) {
    element.style.pointerEvents = 'auto';
    state.passThrough.push(element);
  }
}

function webRectOf(state) {
  const { iframe, rect } = state.surface;
  const frame = iframe.getBoundingClientRect();
  const x = Math.max(frame.left, frame.left + rect.x);
  const y = Math.max(frame.top, frame.top + rect.y);
  return {
    x, y,
    width: Math.max(0, Math.min(frame.right, frame.left + rect.x + rect.width) - x),
    height: Math.max(0, Math.min(frame.bottom, frame.top + rect.y + rect.height) - y),
    frame,
  };
}

function place(owner) {
  const state = ownerState(owner);
  const layer = layerOf(owner);
  const host = document.getElementById('media-fullscreen');
  const iframe = state.surface?.iframe;
  const visible = !!iframe?.isConnected && state.shown !== null;
  // A page in HTML fullscreen fills the window, above the rest of Atmos: the
  // panel host rises (the layer itself can't move).
  if (state.fullscreen !== null && state.fullscreen === state.shown) {
    host.style.zIndex = '2000';
    Object.assign(layer.style, { display: 'block', position: 'fixed', zIndex: '100', left: '0px', top: '0px', width: '100vw', height: '100vh' });
    if (iframe) iframe.style.clipPath = '';
    return;
  }
  if (host.style.zIndex === '2000') host.style.zIndex = '';
  if (!visible) {
    layer.style.display = 'none';
    if (iframe) iframe.style.clipPath = '';
    passThrough(state, null, null);
    return;
  }
  const web = webRectOf(state);
  if (web.width < 1 || web.height < 1) { layer.style.display = 'none'; return; }
  const section = iframe.closest('.panel-section');
  const hostRect = host.getBoundingClientRect();
  Object.assign(layer.style, {
    display: 'block', position: 'absolute',
    // Freeform: in the browser window's place in the stack, under its section.
    zIndex: section?.style.zIndex || '',
    left: `${web.x - hostRect.left}px`, top: `${web.y - hostRect.top}px`, width: `${web.width}px`, height: `${web.height}px`,
  });
  // The frame keeps everything but the page, and what it draws over the page.
  const r = { x: web.x - web.frame.left, y: web.y - web.frame.top, width: web.width, height: web.height };
  const box = ({ x, y, width, height }, clockwise) => (clockwise
    ? `M${x} ${y}H${x + width}V${y + height}H${x}Z`
    : `M${x} ${y}V${y + height}H${x + width}V${y}Z`);
  const parts = [box({ x: 0, y: 0, width: web.frame.width, height: web.frame.height }, true), box(r, false)];
  for (const over of state.surface.rect.over || []) parts.push(box(over, true));
  const clip = `path(nonzero, '${parts.join('')}')`;
  if (iframe.style.clipPath !== clip) iframe.style.clipPath = clip;
  if (!state.passThrough.includes(iframe)) passThrough(state, iframe, section);
}

/**
 * For Task View: the page showing in `bounds` (page pixels), as a capture
 * and where it sits, so the preview can include it (Core's own capture of
 * its window doesn't).
 */
export async function previewParts(bounds) {
  const parts = [];
  for (const [owner, state] of _owners) {
    if (!state.surface || state.shown === null) continue;
    const tab = _tabs.get(tabKey(owner, state.shown));
    if (!tab?.guestId || state.layer?.style.display === 'none') continue;
    const web = webRectOf(state);
    if (web.x >= bounds.x + bounds.width || web.y >= bounds.y + bounds.height || web.x + web.width <= bounds.x || web.y + web.height <= bounds.y) continue;
    const image = await api.command(tab.guestId, 'capture').catch(() => null);
    if (image) parts.push({ image, rect: { x: web.x, y: web.y, width: web.width, height: web.height } });
  }
  return parts;
}

/** "example.com" for a page's address (punycode as the address has it), or ''. */
function siteOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * A page that goes fullscreen covers everything, Atmos included, so it could
 * draw something that looks like Atmos or a sign-in screen: Core says which
 * site it is and how to leave, over the page, for a few seconds (as Chrome
 * does). Plain text, never markup. A page that takes the mouse (pointer
 * lock) gets the same: the cursor is gone, and Esc brings it back.
 */
let _noticeTimer = null;
function fullscreenNotice(site) {
  pageNotice(site === null ? null : `${site || 'This page'} is full screen · Press Esc to exit`);
}
function pointerLockNotice(site, element) {
  // Over the page itself (it may be in a tile, or under the browser's own bar), unless it fills the window.
  const box = document.fullscreenElement ? null : element?.getBoundingClientRect();
  pageNotice(`${site || 'This page'} has hidden your cursor · Press Esc to show it`, box?.width ? box : null);
}
function pageNotice(text, box = null) {
  let notice = document.getElementById('atmos-web-fullscreen-notice');
  clearTimeout(_noticeTimer);
  const remove = () => { try { notice?.hidePopover(); } catch { /* not shown */ } notice?.remove(); };
  if (text === null) { remove(); return; }
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'atmos-web-fullscreen-notice';
    notice.setAttribute('role', 'status');
    // A popover: the fullscreen page is in the top layer, above any z-index,
    // and a popover shown after it is drawn over it.
    notice.popover = 'manual';
    notice.style.cssText = 'position:fixed;inset:auto;left:50%;top:28px;transform:translateX(-50%);margin:0;border:0;pointer-events:none;'
      + 'max-width:min(90vw,640px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:10px 18px;border-radius:10px;'
      + 'background:rgba(22,22,24,.92);color:#fff;font:13px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);transition:opacity .3s';
    document.body.append(notice);
  }
  notice.textContent = text;
  notice.style.left = box ? `${Math.round(box.left + box.width / 2)}px` : '50%';
  notice.style.top = box ? `${Math.round(box.top + 16)}px` : '28px';
  notice.style.opacity = '1';
  raiseNotice();
  // The page may reach the top layer after this (its frame's fullscreen
  // settles in this page a moment later): shown again, it stays above it.
  for (const delay of [150, 500]) setTimeout(raiseNotice, delay);
  _noticeTimer = setTimeout(() => {
    notice.style.opacity = '0';
    _noticeTimer = setTimeout(remove, 400);
  }, 4000);
}

/** The notice, last into the top layer, so drawn over whatever went fullscreen. */
function raiseNotice() {
  const notice = document.getElementById('atmos-web-fullscreen-notice');
  if (!notice) return;
  try { notice.hidePopover(); } catch { /* not shown yet */ }
  try { notice.showPopover(); } catch { /* not in the page any more */ }
}
document.addEventListener('fullscreenchange', raiseNotice);

// Escape pressed in Atmos (not in the page) while a page is fullscreen: out of it.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey) return;
  for (const [owner, state] of _owners) {
    const tab = state.fullscreen !== null ? _tabs.get(tabKey(owner, state.fullscreen)) : null;
    if (tab?.guestId) { void api.command(tab.guestId, 'exitFullscreen').catch(() => {}); event.preventDefault(); }
  }
}, true);

// ── Events from the main process ─────────────────────────────────────────────

api?.onEvent((guestId, type, payload) => {
  if (guestId === null) {
    const owner = listeningOwner();
    if (owner) emit(owner, { type, ...payload });
    else if (type === 'open-link') api.openExternal?.(payload.url);
    return;
  }
  const tab = _byGuest.get(guestId);
  if (!tab) {
    // Not a tab: a pop-up window's download, link or blocked pop-up belongs to whoever listens.
    const owner = listeningOwner();
    if (owner && ['download', 'download-blocked', 'open-tab', 'popup-blocked', 'external-request'].includes(type)) emit(owner, { type, tabId: null, ...payload });
    return;
  }
  const { owner, tabId } = tab;
  // Ctrl+\ in a page: Atmos's command bar, not the browser's. Alt+`: the sidebar.
  if (type === 'command' && payload?.command === 'command-bar') {
    window.dispatchEvent(new Event('atmos:command-bar'));
    return;
  }
  if (type === 'command' && payload?.command === 'sidebar') {
    window.dispatchEvent(new Event('atmos:toggle-sidebar'));
    return;
  }
  if (type === 'mouse-down') {
    closeOpenMenu();
    // Whatever the Atmos page had selected goes, as a click elsewhere would
    // clear it (a selection that took in a page tinted it grey; the layer is
    // user-select: none as well).
    window.getSelection()?.removeAllRanges();
    if (document.activeElement !== tab.element) tab.element.focus();
    return;
  }
  if (type === 'context-menu') {
    // Electron gives a guest's context-menu point in the window's
    // coordinates: the page's own point (for copyImage) and the panel
    // frame's (for the menu) are worked out here.
    const view = tab.element.getBoundingClientRect();
    const frame = ownerState(owner).surface?.iframe?.getBoundingClientRect();
    payload = {
      ...payload,
      x: Math.round(payload.x - view.left), y: Math.round(payload.y - view.top),
      menuX: frame ? Math.round(payload.x - frame.left) : null, menuY: frame ? Math.round(payload.y - frame.top) : null,
    };
  }
  if (type === 'state') {
    Object.assign(tab.state, payload);
    // A page finished loading where it shows: Task View's preview is stale.
    if (payload.loading === false && ownerState(owner).shown === tabId) window.dispatchEvent(new Event('atmos:panel-content-changed'));
  }
  if (type === 'fullscreen') {
    const state = ownerState(owner);
    state.fullscreen = payload.on ? tabId : (state.fullscreen === tabId ? null : state.fullscreen);
    place(owner);
    fullscreenNotice(payload.on ? siteOf(tab.state.url) : null);
  }
  if (type === 'pointer-lock') pointerLockNotice(siteOf(tab.state.url), tab.element);
  emit(owner, { type, tabId, ...payload, ...(type === 'state' ? { tab: publicTab(tab) } : {}) });
});

/**
 * What a frame of `extension` (an official extension with "web") gets: the
 * bridge has checked the tier and the permission; setSurface only for its
 * panel.
 */
export function webFor(extension, iframe, surfaceType) {
  const owner = `${extension.kind}:${extension.id}`;
  return {
    open: (tabId, options) => open(owner, tabId, options),
    close: tabId => close(owner, tabId),
    show: tabId => show(owner, tabId),
    do: (tabId, name, ...args) => command(owner, tabId, name, ...args),
    list: () => [..._tabs.values()].filter(tab => tab.owner === owner).map(publicTab),
    setSurface(rect) {
      if (surfaceType !== 'panel') throw new Error('only the panel shows web pages');
      setSurface(owner, iframe, rect);
    },
    clearSurface: () => setSurface(owner, iframe, null),
    subscribe(fn) {
      const state = ownerState(owner);
      state.listeners.add(fn);
      void api?.listenForLinks(owner);
      return () => {
        state.listeners.delete(fn);
        if (!listeningOwner()) void api?.listenForLinks(null);
      };
    },
    downloads: () => api.downloads(),
    download: (id, action) => api.download(id, action),
    respondPermission: (id, answer) => api.respondPermission(id, answer),
    respondExternal: (id, allow) => api.respondExternal(id, allow),
    siteSettings: () => api.siteSettings(),
    setSiteSetting: (origin, name, value) => api.setSiteSetting(origin, name, value),
    options: () => api.options(),
    setOptions: patch => api.setOptions(patch),
    clearData: what => api.clearData(what),
    adblock: () => api.adblock(),
    adblockUpdate: () => api.adblockUpdate(),
  };
}

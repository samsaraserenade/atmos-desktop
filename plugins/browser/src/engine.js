/**
 * Atmos Browser's engine, in its background frame (boot.js): the tabs and
 * what each page is doing, history, bookmarks, site icons, downloads and the
 * questions pages ask. The panel and the widgets are views of it; they find
 * it through atmos.background() (ui/engine-client.js) and follow its
 * changes.
 *
 * Pages themselves are Core's (atmos.web): Core opens one per loaded tab,
 * shows the selected one where the panel says, and decides what a page may
 * do. Here a tab that isn't loaded is only its address, title and icon; it
 * loads when you go to it ("lazily"), and a tab left alone for a while, or
 * past the most loaded at once, is put away again (its page closed).
 */
import { createTabList, pagesToPutAway } from './tabs.js';
import { createHistory } from './history.js';
import { createBookmarks } from './bookmarks.js';
import { interpret, hostOf, isPageUrl, searchUrl, siteName } from './address.js';

export const DEFAULT_SETTINGS = Object.freeze({
  searchEngine: '',          // '' is the list's default
  putAwayAfterMinutes: 30,   // 0: never
  maxLoadedTabs: 10,         // 0: no limit
});
const PUT_AWAY_CHOICES = [0, 10, 30, 60, 240];
const LOADED_CHOICES = [0, 5, 10, 20];
// Bursts (a page loading) are saved once; Core keeps its own write delay
// and writes what's waiting as Atmos closes.
const SAVE_DELAY_MS = 60;
const CHECK_EVERY_MS = 60 * 1000;
const MAX_ICONS = 600;
const MAX_ICON_BYTES = 64 * 1024;

/** Whether `title` is just an address (Chromium's title for a page that has none yet). */
export function isAddress(title, url) {
  const bare = value => String(value || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  return title === 'about:blank' || title === url || bare(title) === bare(url) || /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(title);
}

export function cleanSettings(value, engines) {
  const input = value && typeof value === 'object' ? value : {};
  const ids = new Set((engines?.engines || []).map(engine => engine.id));
  return {
    searchEngine: ids.has(input.searchEngine) ? input.searchEngine : '',
    putAwayAfterMinutes: PUT_AWAY_CHOICES.includes(input.putAwayAfterMinutes) ? input.putAwayAfterMinutes : DEFAULT_SETTINGS.putAwayAfterMinutes,
    maxLoadedTabs: LOADED_CHOICES.includes(input.maxLoadedTabs) ? input.maxLoadedTabs : DEFAULT_SETTINGS.maxLoadedTabs,
  };
}

/** What a tab's page is doing (not kept across starts). */
function freshRuntime() {
  return {
    live: false, opening: null,
    loading: false, progress: 0,
    canGoBack: false, canGoForward: false,
    audible: false, muted: false, zoom: 1, secure: false,
    blocked: 0,         // ads and trackers blocked on the page (Core counts)
    shield: 'none',     // 'on', 'off' (the site's ads allowed), 'disabled', 'none'
    favicon: null,
    error: null,        // { kind: 'certificate' | 'load' | 'crashed', url, code, description }
    notice: null,       // { text, id?, actions? } something refused, or blocked with ways to go ahead ([{ label, kind, … }])
    permissions: [],    // [{ requestId, origin, permissions }]
    external: null,     // { requestId, url, scheme }
    find: null,         // { text, matches, active }
    fullscreen: false,
    typed: null,        // what was typed, when a typed address failed: { text, query }
  };
}

export function createEngine({ atmos, store, engines, now = () => Date.now(), timers = globalThis }) {
  const web = atmos.web;
  const list = createTabList({ now });
  const runtime = new Map();         // tab id -> freshRuntime()
  const history = createHistory(store.history, { now });
  const bookmarks = createBookmarks(store.bookmarks, { now });
  const icons = new Map();           // host -> data URL (ordinary tabs; kept)
  const privateIcons = new Map();    // host -> data URL (private tabs; memory only)
  const downloads = new Map();       // id -> record (Core's, this session)
  const listeners = new Set();
  let settings = cleanSettings(null, engines);
  let options = { openLinks: true, askWhereToSave: true, blockAds: true };
  let adblock = null;                // Core's blocker status, as last heard
  let panels = 0;
  let shown = undefined;             // what Core was last told to show
  let saveTimer = null;
  let started = false;
  let noticeSerial = 0;              // each notice with a button is new, even with the same words

  // ── Telling the views ─────────────────────────────────────────────────────
  function emit(change) {
    for (const fn of [...listeners]) {
      try { fn(change); } catch (error) { console.error('[browser] view listener failed:', error); }
    }
  }
  const rt = id => {
    if (!runtime.has(id)) runtime.set(id, freshRuntime());
    return runtime.get(id);
  };

  function searchTemplate() {
    const all = engines?.engines || [];
    const chosen = all.find(engine => engine.id === settings.searchEngine)
      || all.find(engine => engine.id === engines?.default) || all[0];
    return chosen?.search || '';
  }
  function searchEngine() {
    const all = engines?.engines || [];
    return all.find(engine => engine.search === searchTemplate()) || null;
  }

  function iconFor(tab) {
    const host = hostOf(tab.url);
    if (!host) return null;
    return (tab.private ? privateIcons.get(host) : null) || icons.get(host) || null;
  }

  /** What a view sees of a tab. */
  function view(tab) {
    if (!tab) return null;
    const state = rt(tab.id);
    const kind = tab.page ? tab.page : state.error ? 'error' : isPageUrl(tab.url) ? 'page' : 'new';
    return {
      id: tab.id, url: tab.url, title: tab.title, private: tab.private, kind,
      selected: tab.id === list.selected, index: list.indexOf(tab.id),
      live: state.live, loading: state.loading, progress: state.progress,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      audible: state.audible, muted: state.muted, zoom: state.zoom, secure: state.secure,
      blocked: state.blocked, shield: state.shield,
      favicon: state.favicon || iconFor(tab),
      error: state.error, notice: state.notice, typed: state.typed,
      permission: state.permissions[0] || null, external: state.external,
      find: state.find, fullscreen: state.fullscreen,
      bookmarked: isPageUrl(tab.url) && bookmarks.has(tab.url),
    };
  }

  // ── Saving the session ────────────────────────────────────────────────────
  function scheduleSave() {
    if (!started) return;
    timers.clearTimeout(saveTimer);
    saveTimer = timers.setTimeout(save, SAVE_DELAY_MS);
  }
  function save() {
    timers.clearTimeout(saveTimer);
    saveTimer = null;
    return atmos.state.update({ session: list.serialize() }).catch(error => console.warn('[browser] could not save the tabs:', error.message));
  }

  // ── What the panel shows ──────────────────────────────────────────────────
  function wanted() {
    const tab = list.get(list.selected);
    if (!tab) return null;
    const state = rt(tab.id);
    return state.live && !tab.page && !state.error && isPageUrl(tab.url) ? tab.id : null;
  }
  function syncShown() {
    const next = wanted();
    if (next === shown) return;
    shown = next;
    web.show(next).catch(error => console.warn('[browser] show:', error.message));
  }

  /** Load the tab's page if it has one to load and a panel is there to show it. */
  function ensureLive(id, { force = false } = {}) {
    const tab = list.get(id);
    if (!tab) return Promise.resolve(false);
    const state = rt(id);
    if (state.live) return Promise.resolve(true);
    if (state.opening) return state.opening;
    if (!force && (!panels || tab.page || !isPageUrl(tab.url))) return Promise.resolve(false);
    state.loading = true;
    state.progress = 0.1;
    state.opening = web.open(id, { url: isPageUrl(tab.url) ? tab.url : 'about:blank', private: tab.private })
      .then(page => {
        state.live = true;
        applyState(tab, page);
        return true;
      })
      .catch(error => {
        state.loading = false;
        state.progress = 0;
        state.notice = { text: error.message || 'The page could not open' };
        return false;
      })
      .finally(() => {
        state.opening = null;
        if (!list.get(id)) { if (state.live) void web.close(id).catch(() => {}); return; }
        syncShown();
        emit({ type: 'tab', id });
        checkPutAway();
      });
    emit({ type: 'tab', id });
    return state.opening;
  }

  /** Close a tab's page but keep the tab (its address, title and icon). */
  function putAway(id) {
    const state = runtime.get(id);
    if (!state?.live) return;
    const kept = { favicon: state.favicon, muted: state.muted };
    runtime.set(id, Object.assign(freshRuntime(), kept));
    void web.close(id).catch(() => {});
    emit({ type: 'tab', id });
  }

  function checkPutAway() {
    const live = new Set([...runtime].filter(([, state]) => state.live).map(([id]) => id));
    const ids = pagesToPutAway(list.tabs, {
      live, now: now(),
      idleMs: settings.putAwayAfterMinutes * 60 * 1000,
      maxLive: settings.maxLoadedTabs,
      keep: tab => {
        const state = rt(tab.id);
        return tab.id === list.selected || tab.private || state.audible || state.fullscreen || !!state.opening
          || state.permissions.length > 0 || !!state.external;
      },
    });
    for (const id of ids) putAway(id);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  function tabsChanged() {
    syncShown();
    emit({ type: 'tabs' });
    scheduleSave();
  }

  function newTab({ url = '', private: isPrivate = false, select = true, after = null, opener = null, page = null } = {}) {
    const tab = list.add({ url: isPageUrl(url) ? url : '', private: isPrivate, select, after, opener, page });
    rt(tab.id);
    if (url && !isPageUrl(url)) {
      // Something Core decides about (mailto: and the like): the page asks.
      void go(tab.id, url);
    } else {
      // Loads now if the panel is there (a tab opened behind this one too).
      void ensureLive(tab.id);
    }
    tabsChanged();
    return view(tab);
  }

  function selectTab(id) {
    if (!list.select(id)) return false;
    void ensureLive(id);
    tabsChanged();
    return true;
  }

  function closeTab(id) {
    const tab = list.get(id);
    if (!tab) return false;
    const state = runtime.get(id);
    list.close(id);
    runtime.delete(id);
    if (state?.live || state?.opening) void web.close(id).catch(() => {});
    if (tab.private && !list.tabs.some(other => other.private)) list.forgetPrivate();
    void ensureLive(list.selected);
    tabsChanged();
    return true;
  }

  function reopenClosed() {
    const tab = list.reopen();
    if (!tab) return null;
    rt(tab.id);
    void ensureLive(tab.id);
    tabsChanged();
    return view(tab);
  }

  function moveTab(id, index) {
    if (!list.move(id, index)) return false;
    tabsChanged();
    return true;
  }

  function duplicateTab(id) {
    const tab = list.get(id);
    if (!tab) return null;
    return newTab({ url: tab.url, private: tab.private, after: id, page: tab.page });
  }

  function closeOtherTabs(id) {
    for (const tab of [...list.tabs]) if (tab.id !== id) closeTab(tab.id);
    selectTab(id);
  }

  // ── Going places ──────────────────────────────────────────────────────────
  /**
   * The address bar: go where `text` says in tab `id`. Resolves
   * { ok, reason? }; a refusal is also left on the tab as a notice.
   */
  async function navigate(id, text) {
    const tab = list.get(id);
    if (!tab) return { ok: false, reason: 'That tab is closed' };
    const meaning = interpret(text, { searchTemplate: searchTemplate() });
    if (!meaning) return { ok: false, reason: '' };
    const state = rt(id);
    if (meaning.kind === 'refused') {
      state.notice = { text: meaning.reason };
      emit({ type: 'tab', id });
      return { ok: false, reason: meaning.reason };
    }
    state.typed = meaning.kind === 'url' ? { text: String(text).trim(), query: String(text).trim() } : null;
    return go(id, meaning.url);
  }

  /** Load `url` in tab `id` (a link, a bookmark, a suggestion). */
  async function go(id, url) {
    const tab = list.get(id);
    if (!tab) return { ok: false, reason: 'That tab is closed' };
    const state = rt(id);
    state.notice = null;
    state.error = null;
    if (isPageUrl(url)) {
      tab.page = null;
      tab.url = url;
      tab.title = '';
      state.favicon = null;
    }
    emit({ type: 'tab', id });
    scheduleSave();
    try {
      if (!state.live) {
        const opened = await ensureLive(id, { force: true });
        if (!opened) return { ok: false, reason: state.notice?.text || 'The page could not open' };
        if (isPageUrl(url)) { syncShown(); return { ok: true }; }
      }
      const result = await web.navigate(id, url);
      syncShown();
      return { ok: true, external: result === 'external' };
    } catch (error) {
      state.notice = { text: error.message };
      emit({ type: 'tab', id });
      return { ok: false, reason: error.message };
    }
  }

  const onLive = (id, run) => {
    const state = runtime.get(id);
    if (!state?.live) return Promise.resolve(null);
    return run().catch(error => { console.warn('[browser]', error.message); return null; });
  };

  function reload(id, { hard = false } = {}) {
    const tab = list.get(id);
    if (!tab) return;
    const state = rt(id);
    if (!state.live) { void ensureLive(id, { force: isPageUrl(tab.url) }); return; }
    if (state.error?.kind === 'crashed') {
      // A page whose renderer went: a fresh page for it.
      putAway(id);
      void ensureLive(id, { force: true });
      return;
    }
    state.error = null;
    syncShown();
    void onLive(id, () => web.reload(id, { hard }));
  }

  // ── Events from Core ──────────────────────────────────────────────────────
  function applyState(tab, page) {
    if (!page) return;
    const state = rt(tab.id);
    for (const key of ['loading', 'canGoBack', 'canGoForward', 'audible', 'muted', 'zoom', 'secure', 'blocked', 'shield']) {
      if (page[key] !== undefined) state[key] = page[key];
    }
    if (isPageUrl(page.url) && page.url !== tab.url) {
      tab.url = page.url;
      tab.page = null;
      scheduleSave();
    }
    const title = String(page.title || '');
    // Until a page has a title (and on a failed page) Chromium's is its
    // address: the tab keeps its own until a real one arrives.
    if (title && !state.error && !isAddress(title, page.url) && title !== tab.title) {
      tab.title = title;
      if (!tab.private && isPageUrl(tab.url)) void history.setTitle(tab.url, title);
      scheduleSave();
    }
    if (!state.loading) state.progress = 0;
  }

  function onEvent(event) {
    const type = event?.type;
    const id = event?.tabId ?? null;
    const tab = id ? list.get(id) : null;
    switch (type) {
      case 'state': {
        if (!tab || !(runtime.get(id)?.live || runtime.get(id)?.opening)) return;
        const wasAudible = rt(id).audible;
        applyState(tab, event);
        emit({ type: 'tab', id });
        if (wasAudible && !rt(id).audible) checkPutAway();
        return;
      }
      case 'navigated': {
        if (!tab) return;
        const state = rt(id);
        if (isPageUrl(event.url)) {
          if (hostOf(event.url) !== hostOf(tab.url)) state.favicon = null;
          tab.url = event.url;
          tab.page = null;
          const title = event.title && !isAddress(event.title, event.url) ? String(event.title) : '';
          if (title) tab.title = title;
          if (!tab.private) void history.visit(event.url, title);
        }
        if (!event.inPage) state.find = null;
        emit({ type: 'tab', id });
        scheduleSave();
        return;
      }
      case 'progress': {
        if (!tab) return;
        const state = rt(id);
        if (event.value <= 0.2) {
          // A new page starts: what the last one asked, failed or refused goes.
          state.error = null;
          state.notice = null;
          state.permissions = [];
          state.external = null;
          syncShown();
        }
        state.progress = event.value;
        state.loading = true;
        emit({ type: 'tab', id });
        return;
      }
      case 'favicon': {
        if (!tab || typeof event.dataUrl !== 'string' || hostOf(event.pageUrl) !== hostOf(tab.url)) return;
        const host = hostOf(tab.url);
        rt(id).favicon = event.dataUrl;
        if (tab.private) privateIcons.set(host, event.dataUrl);
        else if (event.dataUrl.length <= MAX_ICON_BYTES * 1.4) rememberIcon(host, event.dataUrl);
        emit({ type: 'tab', id });
        return;
      }
      case 'load-failed': {
        if (!tab) return;
        const state = rt(id);
        state.error = {
          kind: event.certificate ? 'certificate' : 'load',
          url: String(event.url || tab.url), code: event.code, description: String(event.description || ''),
        };
        state.loading = false;
        state.progress = 0;
        if (isPageUrl(event.url) && event.url !== tab.url) { tab.url = event.url; tab.title = ''; }
        syncShown();
        emit({ type: 'tab', id });
        return;
      }
      case 'refused': {
        if (!tab) return;
        rt(id).notice = { text: String(event.reason || 'That address isn’t opened in Atmos Browser'), url: event.url };
        emit({ type: 'tab', id });
        return;
      }
      case 'crashed': {
        if (!tab || event.reason === 'clean-exit') return;
        const state = rt(id);
        state.error = { kind: 'crashed', url: tab.url, code: 0, description: String(event.reason || '') };
        state.loading = false;
        syncShown();
        emit({ type: 'tab', id });
        return;
      }
      case 'find': {
        if (!tab) return;
        const state = rt(id);
        state.find = { ...(state.find || { text: '' }), matches: event.matches ?? 0, active: event.active ?? 0 };
        emit({ type: 'find', id });
        return;
      }
      case 'fullscreen': {
        if (!tab) return;
        rt(id).fullscreen = event.on === true;
        emit({ type: 'tab', id });
        return;
      }
      case 'context-menu': {
        if (!tab) return;
        emit({ type: 'context-menu', id, params: event });
        return;
      }
      case 'command': {
        runCommand(String(event.command || ''), { tabId: tab ? id : list.selected });
        return;
      }
      case 'open-tab': {
        const opener = tab;
        newTab({
          url: String(event.url || ''),
          private: event.private === true || opener?.private === true,
          select: event.background !== true,
          after: opener ? id : null,
          opener: opener ? id : null,
        });
        return;
      }
      case 'open-link': {
        // Behind the tab you're on unless you just clicked or typed in Atmos (Core decides).
        const background = event.background === true;
        newTab({ url: String(event.url || ''), select: !background });
        if (!background) void atmos.panel.show().catch(() => {});
        return;
      }
      case 'popup-blocked': {
        // A pop-up window's own pop-up is told in the tab you're on.
        const target = tab ? id : list.selected;
        if (!target) return;
        const site = siteName(String(event.site || '')) || 'This page';
        const url = isPageUrl(event.url) ? String(event.url) : null;
        const isPrivate = event.private === true || list.get(target)?.private === true;
        // Open: the address in a tab (a pop-up that answers its page, a
        // sign-in, can't be one: allow the site, then click again). Always
        // allow: the site's pop-ups from now on (an ordinary tab's choice,
        // kept; not offered in a private tab, which keeps nothing).
        const origin = /^https?:\/\//i.test(String(event.site || '')) ? String(event.site) : null;
        rt(target).notice = {
          id: ++noticeSerial,
          text: `Pop-up blocked: ${site} tried to open one without a click.`,
          actions: [
            url ? { label: 'Open', kind: 'popup', url, private: isPrivate } : null,
            origin && !isPrivate ? { label: 'Always allow', kind: 'allow-popups', origin } : null,
          ].filter(Boolean),
        };
        emit({ type: 'tab', id: target });
        return;
      }
      case 'download-blocked': {
        const target = tab ? id : list.selected;
        if (!target) return;
        const site = siteName(String(event.site || '')) || 'This page';
        const name = String(event.name || 'a file').slice(0, 120);
        const url = /^(https?:|data:|blob:)/i.test(String(event.url || '')) ? String(event.url) : null;
        rt(target).notice = {
          id: ++noticeSerial,
          text: `Download blocked: ${site} tried to save “${name}” without a click.`,
          actions: url && tab ? [{ label: 'Download', kind: 'download', url }] : [],
        };
        emit({ type: 'tab', id: target });
        return;
      }
      case 'download': {
        if (!event.id) return;
        const isNew = !downloads.has(event.id);
        downloads.set(event.id, { ...event });
        emit({ type: 'downloads', started: isNew ? event.id : null });
        return;
      }
      case 'download-removed': {
        downloads.delete(event.id);
        emit({ type: 'downloads' });
        return;
      }
      case 'permission-request': {
        const target = tab ? id : null;
        if (!target) return;
        const state = rt(target);
        state.permissions = [...state.permissions.filter(request => request.requestId !== event.requestId), {
          requestId: event.requestId, origin: event.origin, permissions: [...(event.permissions || [])],
        }];
        emit({ type: 'tab', id: target });
        return;
      }
      case 'permission-settled': {
        for (const [tabId, state] of runtime) {
          const before = state.permissions.length;
          state.permissions = state.permissions.filter(request => request.requestId !== event.requestId);
          if (state.permissions.length !== before) emit({ type: 'tab', id: tabId });
        }
        return;
      }
      case 'external-request': {
        // A pop-up window's link asks in the tab you're on.
        const target = tab ? id : list.selected;
        if (!target) return;
        rt(target).external = { requestId: event.requestId, url: String(event.url || ''), scheme: String(event.scheme || ''), site: String(event.site || '') };
        emit({ type: 'tab', id: target });
        return;
      }
      case 'adblock': {
        const { type: _type, tabId: _tab, ...status } = event;
        adblock = { ...(adblock || {}), ...status };
        emit({ type: 'adblock' });
        return;
      }
      case 'private-ended': {
        list.forgetPrivate();
        privateIcons.clear();
        emit({ type: 'tabs' });
        return;
      }
      default:
    }
  }

  function rememberIcon(host, dataUrl) {
    if (icons.get(host) === dataUrl) return;
    icons.delete(host);
    icons.set(host, dataUrl);
    void store.icons.put({ host, dataUrl, updated: now() }).catch(() => {});
    if (icons.size > MAX_ICONS) {
      const oldest = [...icons.keys()].slice(0, icons.size - MAX_ICONS);
      for (const key of oldest) icons.delete(key);
      void store.icons.deleteMany(oldest).catch(() => {});
    }
  }

  // ── Commands (keys, menus) ────────────────────────────────────────────────
  const VIEW_COMMANDS = new Set(['focus-address', 'find', 'downloads']);

  function runCommand(command, { tabId = list.selected } = {}) {
    const id = list.get(tabId) ? tabId : list.selected;
    const tab = list.get(id);
    switch (command) {
      case 'new-tab': newTab({}); emit({ type: 'command', command: 'focus-address' }); return true;
      case 'new-private-tab': newTab({ private: true }); emit({ type: 'command', command: 'focus-address' }); return true;
      case 'reopen-tab': reopenClosed(); return true;
      case 'close-tab': if (id) closeTab(id); return true;
      case 'next-tab': selectTab(list.neighbour(1)?.id); return true;
      case 'previous-tab': selectTab(list.neighbour(-1)?.id); return true;
      case 'last-tab': selectTab(list.tabs.at(-1)?.id); return true;
      case 'reload': reload(id); return true;
      case 'hard-reload': reload(id, { hard: true }); return true;
      case 'back': void onLive(id, () => web.back(id)); return true;
      case 'forward': void onLive(id, () => web.forward(id)); return true;
      case 'zoom-in': case 'zoom-out': case 'zoom-reset':
        void zoom(id, command.slice(5));
        return true;
      case 'print': void onLive(id, () => web.print(id)); return true;
      case 'bookmark': if (tab) void toggleBookmark(id); return true;
      case 'history': openHistory(); return true;
      default:
    }
    if (/^tab-[1-8]$/.test(command)) {
      const target = list.tabs[Number(command.slice(4)) - 1];
      if (target) selectTab(target.id);
      return true;
    }
    if (VIEW_COMMANDS.has(command)) { emit({ type: 'command', command, id }); return true; }
    return false;
  }

  async function zoom(id, direction) {
    const factor = await onLive(id, () => web.zoom(id, direction));
    if (factor !== null && runtime.get(id)) { rt(id).zoom = factor; emit({ type: 'tab', id }); }
    return factor;
  }

  function openHistory() {
    const existing = list.tabs.find(tab => tab.page === 'history' && !tab.private);
    if (existing) { selectTab(existing.id); return view(existing); }
    return newTab({ page: 'history', after: list.selected });
  }

  async function toggleBookmark(id) {
    const tab = list.get(id);
    if (!tab || !isPageUrl(tab.url)) return false;
    const now = await bookmarks.toggle(tab.url, tab.title || siteName(tab.url));
    return now;
  }

  // ── Find in page ──────────────────────────────────────────────────────────
  async function find(id, text, { forward = true, findNext = false } = {}) {
    const state = rt(id);
    const query = String(text || '');
    state.find = query ? { ...(state.find || {}), text: query, matches: findNext ? state.find?.matches ?? 0 : 0, active: state.find?.active ?? 0 } : null;
    emit({ type: 'find', id });
    if (!query) return onLive(id, () => web.find(id, ''));
    return onLive(id, () => web.find(id, query, { forward, findNext }));
  }
  function stopFind(id) {
    const state = runtime.get(id);
    if (state) state.find = null;
    emit({ type: 'find', id });
    return onLive(id, () => web.stopFind(id));
  }

  // ── Answers to what pages ask ─────────────────────────────────────────────
  async function answerPermission(id, requestId, allow) {
    const state = rt(id);
    state.permissions = state.permissions.filter(request => request.requestId !== requestId);
    emit({ type: 'tab', id });
    return web.permissions.respond(requestId, { allow: allow === true, remember: true });
  }
  async function dismissPermission(id, requestId) {
    const state = rt(id);
    state.permissions = state.permissions.filter(request => request.requestId !== requestId);
    emit({ type: 'tab', id });
    return web.permissions.respond(requestId, { allow: false, remember: false });
  }
  /**
   * The answer to the link prompt the user saw (`requestId`): nothing if
   * another has taken its place meanwhile (a pop-up's link asks in the tab
   * you're on), so a click meant for one never answers the next.
   */
  async function answerExternal(id, allow, requestId = undefined) {
    const state = rt(id);
    const request = state.external;
    if (!request || (requestId !== undefined && request.requestId !== requestId)) return false;
    state.external = null;
    emit({ type: 'tab', id });
    return web.external.respond(request.requestId, allow === true);
  }
  function dismissNotice(id) {
    const state = runtime.get(id);
    if (!state?.notice) return;
    state.notice = null;
    emit({ type: 'tab', id });
  }
  /**
   * A notice's button (`index`, in its order) on the notice the user saw
   * (`noticeId`; nothing if another has replaced it meanwhile): open the
   * blocked pop-up in a tab, allow the site's pop-ups from now on, or start
   * the blocked download (as Core's own).
   */
  async function noticeAction(id, index = 0, noticeId = undefined) {
    const state = runtime.get(id);
    if (noticeId !== undefined && state?.notice?.id !== noticeId) return null;
    const action = state?.notice?.actions?.[index];
    if (!action) return null;
    state.notice = null;
    emit({ type: 'tab', id });
    if (action.kind === 'popup') return newTab({ url: action.url, private: action.private === true, after: id, opener: id });
    if (action.kind === 'allow-popups') return web.permissions.set(action.origin, 'popups', 'allow');
    if (action.kind === 'download') return onLive(id, () => web.download(id, action.url));
    return null;
  }

  // ── Suggestions for the address bar ───────────────────────────────────────
  async function suggest(text, { limit = 7 } = {}) {
    const typed = String(text || '').trim();
    if (!typed) return [];
    const meaning = interpret(typed, { searchTemplate: searchTemplate() });
    const out = [];
    const seen = new Set();
    const push = item => { if (!item.url || seen.has(item.url)) return; seen.add(item.url); out.push(item); };
    if (meaning?.kind === 'url') push({ kind: 'url', url: meaning.url, title: meaning.url });
    const engine = searchEngine();
    if (meaning?.kind !== 'refused') push({ kind: 'search', url: searchUrl(searchTemplate(), typed), title: typed, engine: engine?.name || 'Search' });
    const lower = typed.toLowerCase();
    const marks = (await bookmarks.list()).filter(item => `${item.title} ${item.url}`.toLowerCase().includes(lower)).slice(0, 3);
    for (const item of marks) push({ kind: 'bookmark', url: item.url, title: item.title, favicon: icons.get(hostOf(item.url)) || null });
    for (const item of await history.suggest(typed, { limit: 6 })) push({ kind: 'history', url: item.url, title: item.title, favicon: icons.get(hostOf(item.url)) || null });
    return out.slice(0, limit);
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async function setSettings(patch) {
    settings = cleanSettings({ ...settings, ...(patch || {}) }, engines);
    await atmos.state.update({ settings });
    emit({ type: 'settings' });
    checkPutAway();
    return { ...settings };
  }
  async function setOptions(patch) {
    options = await web.setOptions(patch);
    emit({ type: 'settings' });
    if (patch && 'blockAds' in patch) void adblockStatus();
    return { ...options };
  }

  // ── Ads and trackers (Core blocks; this shows it) ─────────────────────────
  async function adblockStatus() {
    adblock = await web.adblock.status().catch(() => adblock);
    emit({ type: 'adblock' });
    return adblock ? { ...adblock } : null;
  }
  async function updateFilters() {
    adblock = await web.adblock.update();
    emit({ type: 'adblock' });
    return { ...adblock };
  }
  /** The site's shield for a tab's page: up (blocking) or down; the page reloads to show it. */
  async function setShield(id, on) {
    const tab = list.get(id);
    if (!tab || !rt(id).live) return null;
    const shield = await web.shield(id, on !== false);
    rt(id).shield = shield;
    emit({ type: 'tab', id });
    reload(id);
    return shield;
  }

  async function clearData({ history: clearHistory = false, cookies = false, cache = false, siteSettings = false } = {}) {
    if (clearHistory) {
      await history.clear();
      icons.clear();
      await store.icons.clear().catch(() => {});
    }
    if (cookies || cache || siteSettings) await web.clearData({ cookies, cache, siteSettings });
    emit({ type: 'history' });
    return true;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  async function start() {
    const saved = await atmos.state.get().catch(() => ({})) || {};
    settings = cleanSettings(saved.settings, engines);
    list.restore(saved.session);
    for (const tab of list.tabs) rt(tab.id);
    for (const row of await store.icons.getAll().catch(() => [])) {
      if (row?.host && typeof row.dataUrl === 'string') icons.set(row.host, row.dataUrl);
    }
    // Pages left from an earlier run of this frame (Atmos itself didn't restart) go.
    for (const page of await web.list().catch(() => [])) await web.close(page.tabId).catch(() => {});
    web.onEvent(onEvent);
    options = await web.options().catch(() => options);
    void adblockStatus();
    for (const record of await web.downloads.list().catch(() => [])) downloads.set(record.id, record);
    await Promise.all([history.load(), bookmarks.load()]);
    history.subscribe(() => emit({ type: 'history' }));
    bookmarks.subscribe(() => { emit({ type: 'bookmarks' }); emit({ type: 'tabs' }); });
    atmos.state.onChange?.(next => {
      if (next?.settings && JSON.stringify(cleanSettings(next.settings, engines)) !== JSON.stringify(settings)) {
        settings = cleanSettings(next.settings, engines);
        emit({ type: 'settings' });
      }
    });
    timers.setInterval(checkPutAway, CHECK_EVERY_MS);
    void history.prune().catch(() => {});
    started = true;
    syncShown();
    emit({ type: 'tabs' });
  }

  const ready = start();

  return {
    ready,
    // Reading
    tabs: () => list.tabs.map(view),
    tab: id => view(list.get(id)),
    selected: () => view(list.get(list.selected)),
    selectedId: () => list.selected,
    closedCount: () => list.closedCount,
    downloads: () => [...downloads.values()].sort((a, b) => b.started - a.started).map(record => ({ ...record })),
    settings: () => ({ ...settings }),
    options: () => ({ ...options }),
    searchEngines: () => (engines?.engines || []).map(({ id, name }) => ({ id, name })),
    searchEngine: () => searchEngine()?.id || '',
    iconFor: url => icons.get(hostOf(url)) || null,
    // Tabs
    newTab, selectTab, closeTab, closeOtherTabs, reopenClosed, moveTab, duplicateTab, openHistory,
    // Pages
    navigate, go, reload,
    back: id => onLive(id, () => web.back(id)),
    forward: id => onLive(id, () => web.forward(id)),
    stop: id => onLive(id, () => web.stop(id)),
    zoom,
    mute: (id, muted) => onLive(id, async () => { const result = await web.mute(id, muted); rt(id).muted = result; emit({ type: 'tab', id }); return result; }),
    print: id => onLive(id, () => web.print(id)),
    edit: (id, action) => onLive(id, () => web.edit(id, action)),
    download: (id, url) => onLive(id, () => web.download(id, url)),
    copyImage: (id, x, y) => onLive(id, () => web.copyImage(id, x, y)),
    focusPage: id => onLive(id, () => web.focus(id)),
    find, stopFind,
    answerPermission, dismissPermission, answerExternal, dismissNotice, noticeAction,
    runCommand,
    suggest,
    // Collections
    history, bookmarks, toggleBookmark,
    downloadAction: (id, action) => {
      if (!['open', 'show', 'cancel', 'pause', 'resume', 'remove'].includes(action)) return Promise.reject(new Error(`unknown action ${action}`));
      return web.downloads[action](id);
    },
    // Settings
    setSettings, setOptions,
    adblock: () => (adblock ? { ...adblock } : null),
    adblockStatus, updateFilters, setShield,
    blocked: id => onLive(id, () => web.blocked(id)),
    sitePermissions: () => web.permissions.list(),
    setSitePermission: (origin, name, value) => web.permissions.set(origin, name, value),
    clearData,
    // Views
    attachPanel() {
      panels += 1;
      void ensureLive(list.selected);
      syncShown();
      let attached = true;
      return () => { if (attached) { attached = false; panels = Math.max(0, panels - 1); } };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Tests
    _save: save,
    _checkPutAway: checkPutAway,
  };
}

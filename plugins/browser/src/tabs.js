/**
 * The tab list: order, which tab is selected, recently closed tabs, and
 * which pages to put away. Pure: the engine (engine.js) keeps the pages.
 *
 * A tab is { id, url, title, private, lastActive, opener }. An empty url is
 * a new-tab page; `page` names another page the browser draws itself
 * ('history'). There is always at least one tab.
 */

const MAX_CLOSED = 25;

let counter = 0;
/** A tab id Core accepts (letters, digits, - and _; at most 64). */
export function newTabId(now = Date.now()) {
  counter = (counter + 1) % 1_000_000;
  return `t${now.toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function cleanTab(tab, now) {
  return {
    id: String(tab.id),
    url: typeof tab.url === 'string' ? tab.url : '',
    title: typeof tab.title === 'string' ? tab.title.slice(0, 500) : '',
    private: tab.private === true,
    page: tab.page === 'history' ? 'history' : null,
    lastActive: Number.isFinite(tab.lastActive) ? tab.lastActive : now,
    opener: typeof tab.opener === 'string' ? tab.opener : null,
  };
}

export function createTabList({ now = () => Date.now(), makeId = () => newTabId(now()) } = {}) {
  let tabs = [];
  let selected = null;
  let closed = []; // most recent last: { tab, index }

  const indexOf = id => tabs.findIndex(tab => tab.id === id);
  const get = id => tabs.find(tab => tab.id === id) || null;

  function add({ url = '', title = '', private: isPrivate = false, page = null, after = null, select = true, opener = null } = {}) {
    const tab = cleanTab({ id: makeId(), url, title, private: isPrivate, page, opener, lastActive: now() }, now());
    const at = after !== null && indexOf(after) >= 0 ? indexOf(after) + 1 : tabs.length;
    // Tabs opened from one tab go after it and after the ones it opened before.
    let index = at;
    if (after !== null && opener) {
      while (index < tabs.length && tabs[index].opener === opener) index += 1;
    }
    tabs.splice(index, 0, tab);
    if (select || selected === null) selectTab(tab.id);
    return tab;
  }

  function selectTab(id) {
    const tab = get(id);
    if (!tab) return null;
    selected = id;
    tab.lastActive = now();
    return tab;
  }

  /** Close `id`: returns { closed, selected } (the tab now selected), or null. */
  function close(id, { remember = true } = {}) {
    const index = indexOf(id);
    if (index < 0) return null;
    const [tab] = tabs.splice(index, 1);
    // Opened tabs no longer follow it.
    for (const other of tabs) if (other.opener === id) other.opener = null;
    if (remember && (tab.url || tab.page)) {
      closed.push({ tab: { ...tab }, index });
      if (closed.length > MAX_CLOSED) closed = closed.slice(-MAX_CLOSED);
    }
    if (!tabs.length) {
      const fresh = add({ select: true });
      return { closed: tab, selected: fresh.id };
    }
    if (selected === id) {
      // The one it was opened from, if that is still there; else the one to
      // its right, else to its left.
      const opener = tab.opener && get(tab.opener);
      const next = opener || tabs[Math.min(index, tabs.length - 1)];
      selectTab(next.id);
    }
    return { closed: tab, selected };
  }

  /** The most recently closed tab back, where it was; null if none. */
  function reopen() {
    const last = closed.pop();
    if (!last) return null;
    const tab = cleanTab({ ...last.tab, id: makeId(), opener: null, lastActive: now() }, now());
    tabs.splice(Math.min(last.index, tabs.length), 0, tab);
    selectTab(tab.id);
    return tab;
  }

  function move(id, toIndex) {
    const from = indexOf(id);
    if (from < 0) return false;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(tabs.length, Math.round(toIndex))), 0, tab);
    return true;
  }

  /** The tab `step` places away from the selected one, round the ends. */
  function neighbour(step) {
    if (!tabs.length) return null;
    const index = Math.max(0, indexOf(selected));
    return tabs[(index + step + tabs.length * 4) % tabs.length];
  }

  /** Forget closed private tabs (their session has ended). */
  function forgetPrivate() {
    closed = closed.filter(entry => !entry.tab.private);
  }

  /** What is kept across starts: ordinary tabs only. */
  function serialize() {
    const kept = tabs.filter(tab => !tab.private);
    return {
      tabs: kept.map(({ id, url, title, page, lastActive }) => ({ id, url, title, page, lastActive })),
      selected: kept.some(tab => tab.id === selected) ? selected : (kept.at(-1)?.id ?? null),
    };
  }

  function restore(saved) {
    const list = Array.isArray(saved?.tabs) ? saved.tabs : [];
    const seen = new Set();
    tabs = [];
    for (const item of list.slice(0, 500)) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)) continue;
      if (item.url && !/^https?:\/\//i.test(item.url)) continue;
      seen.add(item.id);
      tabs.push(cleanTab({ ...item, private: false, opener: null }, now()));
    }
    closed = [];
    selected = null;
    if (!tabs.length) add({ select: true });
    else selectTab(tabs.some(tab => tab.id === saved?.selected) ? saved.selected : tabs.at(-1).id);
  }

  return {
    get tabs() { return tabs; },
    get selected() { return selected; },
    get closedCount() { return closed.length; },
    get: id => get(id),
    indexOf,
    add,
    select: selectTab,
    close,
    reopen,
    move,
    neighbour,
    forgetPrivate,
    serialize,
    restore,
  };
}

/**
 * Which live pages to put away (discard): background tabs unused for
 * `idleMs`, then the least recently used while more than `maxLive` are
 * loaded. `keep(tab)` protects one (the selected tab, one playing sound,
 * one asking something, a private one).
 */
export function pagesToPutAway(tabs, { live, now, idleMs, maxLive, keep = () => false }) {
  const candidates = tabs.filter(tab => live.has(tab.id) && !keep(tab));
  const out = new Set();
  if (Number.isFinite(idleMs) && idleMs > 0) {
    for (const tab of candidates) if (now - tab.lastActive >= idleMs) out.add(tab.id);
  }
  if (Number.isFinite(maxLive) && maxLive > 0) {
    let count = [...live].filter(id => !out.has(id)).length;
    const oldest = candidates.filter(tab => !out.has(tab.id)).sort((a, b) => a.lastActive - b.lastActive);
    for (const tab of oldest) {
      if (count <= maxLive) break;
      out.add(tab.id);
      count -= 1;
    }
  }
  return [...out];
}

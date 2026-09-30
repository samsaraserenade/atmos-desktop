/**
 * History: one entry per address visited in an ordinary tab (private tabs
 * keep none), searchable and clearable. Kept in the browser's own database
 * (store.js), and in memory while Atmos runs.
 *
 *   { url, title, visits, firstVisit, lastVisit }
 */

const DAY = 24 * 60 * 60 * 1000;
const isPage = url => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 8192;

/** The text an address is matched on: no scheme, no "www.". */
export function bareUrl(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

export function createHistory(table, { now = () => Date.now(), maxEntries = 20000, maxAgeDays = 90 } = {}) {
  let entries = null; // url -> entry
  let loading = null;
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch (error) { console.error('[browser] history listener failed:', error); } } };

  function load() {
    if (entries) return Promise.resolve(entries);
    loading ||= table.getAll().then(rows => {
      entries = new Map();
      for (const row of rows) if (isPage(row?.url)) entries.set(row.url, row);
      return entries;
    }).catch(error => {
      console.warn('[browser] history could not be read:', error?.message || error);
      entries = new Map();
      return entries;
    });
    return loading;
  }

  async function visit(url, title = '') {
    if (!isPage(url)) return null;
    await load();
    const at = now();
    const previous = entries.get(url);
    const entry = {
      url,
      title: String(title || previous?.title || '').slice(0, 500),
      visits: (previous?.visits || 0) + 1,
      firstVisit: previous?.firstVisit || at,
      lastVisit: at,
    };
    entries.set(url, entry);
    await table.put(entry);
    if (entries.size > maxEntries + 500) await prune();
    changed();
    return entry;
  }

  /** A page's title arrived after it was visited. */
  async function setTitle(url, title) {
    await load();
    const entry = entries.get(url);
    const clean = String(title || '').slice(0, 500);
    if (!entry || !clean || entry.title === clean) return;
    entry.title = clean;
    await table.put(entry);
    changed();
  }

  const newestFirst = (a, b) => b.lastVisit - a.lastVisit;

  /** Entries whose title or address has every word of `query`, newest first. */
  async function search(query = '', { limit = 300, before = Infinity } = {}) {
    await load();
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const entry of entries.values()) {
      if (entry.lastVisit >= before) continue;
      const text = `${entry.title} ${bareUrl(entry.url)}`.toLowerCase();
      if (words.every(word => text.includes(word))) out.push(entry);
    }
    return out.sort(newestFirst).slice(0, limit);
  }

  function score(entry, at) {
    const ageDays = Math.max(0, (at - entry.lastVisit) / DAY);
    return entry.visits / (1 + ageDays / 7);
  }

  /** For the address bar: addresses starting with what was typed first, then titles and addresses containing it. */
  async function suggest(text, { limit = 5 } = {}) {
    await load();
    const typed = String(text || '').trim().toLowerCase();
    if (!typed) return [];
    const bareTyped = bareUrl(typed);
    const at = now();
    const scored = [];
    for (const entry of entries.values()) {
      const bare = bareUrl(entry.url).toLowerCase();
      const title = entry.title.toLowerCase();
      let rank = 0;
      if (bare.startsWith(bareTyped)) rank = 3;
      else if (bare.split(/[/.?#=&-]/).some(part => part.startsWith(bareTyped))) rank = 2;
      else if (title.includes(typed) || bare.includes(bareTyped)) rank = 1;
      if (rank) scored.push({ entry, value: rank * 1000 + score(entry, at) });
    }
    return scored.sort((a, b) => b.value - a.value).slice(0, limit).map(item => item.entry);
  }

  /** The sites visited most (one address per site), for the new-tab page. */
  async function topSites(count = 8) {
    await load();
    const at = now();
    const bySite = new Map();
    for (const entry of entries.values()) {
      let host = '';
      try { host = new URL(entry.url).host; } catch { continue; }
      const value = score(entry, at);
      const best = bySite.get(host);
      if (!best) bySite.set(host, { entry, value, total: value });
      else {
        best.total += value;
        if (value > best.value) { best.entry = entry; best.value = value; }
      }
    }
    return [...bySite.values()].sort((a, b) => b.total - a.total).slice(0, count).map(item => item.entry);
  }

  async function remove(url) {
    await load();
    if (!entries.delete(url)) return false;
    await table.delete(url);
    changed();
    return true;
  }

  /** Clear everything, or only what was visited since `since` (ms). */
  async function clear({ since = 0 } = {}) {
    await load();
    if (!since) {
      entries.clear();
      await table.clear();
    } else {
      const gone = [...entries.values()].filter(entry => entry.lastVisit >= since).map(entry => entry.url);
      for (const url of gone) entries.delete(url);
      await table.deleteMany(gone);
    }
    changed();
  }

  /** Drop entries older than `maxAgeDays`, then the oldest past `maxEntries`. */
  async function prune() {
    await load();
    const cutoff = now() - maxAgeDays * DAY;
    const sorted = [...entries.values()].sort(newestFirst);
    const gone = sorted.filter((entry, index) => entry.lastVisit < cutoff || index >= maxEntries).map(entry => entry.url);
    if (!gone.length) return 0;
    for (const url of gone) entries.delete(url);
    await table.deleteMany(gone);
    return gone.length;
  }

  return {
    load,
    visit,
    setTitle,
    search,
    suggest,
    topSites,
    remove,
    clear,
    prune,
    get size() { return entries?.size ?? 0; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

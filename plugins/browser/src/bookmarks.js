/**
 * Bookmarks: one list, in the order you put them (v1 has no folders). Kept
 * in the browser's own database (store.js).
 *
 *   { id, url, title, position, added }
 */

const isPage = url => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 8192;
let counter = 0;
const makeId = at => `b${at.toString(36)}${(counter = (counter + 1) % 1e6).toString(36)}`;

export function createBookmarks(table, { now = () => Date.now() } = {}) {
  let rows = null;
  let loading = null;
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch (error) { console.error('[browser] bookmarks listener failed:', error); } } };

  function load() {
    if (rows) return Promise.resolve(rows);
    loading ||= table.getAll().then(all => {
      rows = all.filter(row => row && typeof row.id === 'string' && isPage(row.url)).sort((a, b) => a.position - b.position);
      return rows;
    }).catch(error => {
      console.warn('[browser] bookmarks could not be read:', error?.message || error);
      rows = [];
      return rows;
    });
    return loading;
  }

  const copy = row => ({ ...row });

  async function list() { return (await load()).map(copy); }

  async function find(url) {
    const row = (await load()).find(item => item.url === url);
    return row ? copy(row) : null;
  }

  async function add({ url, title = '' }) {
    if (!isPage(url)) throw new Error('Only web pages can be bookmarked');
    await load();
    const existing = rows.find(item => item.url === url);
    if (existing) return copy(existing);
    const at = now();
    const row = { id: makeId(at), url, title: String(title || url).slice(0, 500), position: (rows.at(-1)?.position ?? 0) + 1, added: at };
    rows.push(row);
    await table.put(row);
    changed();
    return copy(row);
  }

  async function remove(id) {
    await load();
    const index = rows.findIndex(item => item.id === id);
    if (index < 0) return false;
    rows.splice(index, 1);
    await table.delete(id);
    changed();
    return true;
  }

  async function rename(id, title) {
    await load();
    const row = rows.find(item => item.id === id);
    const clean = String(title ?? '').trim().slice(0, 500);
    if (!row || !clean) return false;
    row.title = clean;
    await table.put(row);
    changed();
    return true;
  }

  async function move(id, toIndex) {
    await load();
    const from = rows.findIndex(item => item.id === id);
    if (from < 0) return false;
    const [row] = rows.splice(from, 1);
    rows.splice(Math.max(0, Math.min(rows.length, Math.round(toIndex))), 0, row);
    rows.forEach((item, index) => { item.position = index + 1; });
    await table.putMany(rows);
    changed();
    return true;
  }

  /** Bookmark the page, or take its bookmark away: resolves whether it is bookmarked now. */
  async function toggle(url, title) {
    const existing = await find(url);
    if (existing) { await remove(existing.id); return false; }
    await add({ url, title });
    return true;
  }

  return {
    load, list, find, add, remove, rename, move, toggle,
    has: url => !!rows?.some(item => item.url === url),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

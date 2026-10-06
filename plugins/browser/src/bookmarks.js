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
    // In the list at once (a second add of it finds it), out again if it
    // can't be saved: trying again then saves it (R36).
    rows.push(row);
    try { await table.put(row); }
    catch (error) {
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
      throw error;
    }
    changed();
    return copy(row);
  }

  async function remove(id) {
    await load();
    const index = rows.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [row] = rows.splice(index, 1);
    try { await table.delete(id); }
    catch (error) {
      // Not deleted: still there, and a second try deletes it.
      if (!rows.some(item => item.url === row.url)) rows.splice(Math.min(index, rows.length), 0, row);
      throw error;
    }
    changed();
    return true;
  }

  async function rename(id, title) {
    await load();
    const row = rows.find(item => item.id === id);
    const clean = String(title ?? '').trim().slice(0, 500);
    if (!row || !clean) return false;
    const before = row.title;
    row.title = clean;
    try { await table.put(row); }
    catch (error) { if (row.title === clean) row.title = before; throw error; }
    changed();
    return true;
  }

  async function move(id, toIndex) {
    await load();
    const from = rows.findIndex(item => item.id === id);
    if (from < 0) return false;
    const before = rows.map(item => [item, item.position]);
    const [row] = rows.splice(from, 1);
    rows.splice(Math.max(0, Math.min(rows.length, Math.round(toIndex))), 0, row);
    rows.forEach((item, index) => { item.position = index + 1; });
    try { await table.putMany(rows); }
    catch (error) {
      // As it was: the order saved is the one before.
      rows.splice(0, rows.length, ...before.map(([item]) => item));
      for (const [item, position] of before) item.position = position;
      throw error;
    }
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

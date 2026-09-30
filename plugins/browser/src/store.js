/**
 * Where history, bookmarks and site icons are kept: IndexedDB in Atmos
 * Browser's own origin (no other extension can read it), one object store
 * per table. A table is { getAll, put, delete, clear }; memoryTable() is the
 * same in memory, for private data and tests.
 */

const DB_NAME = 'atmos-browser';
const DB_VERSION = 1;
const TABLES = { history: 'url', bookmarks: 'id', icons: 'host' };

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(TABLES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('the browser database is in use elsewhere'));
  });
}

function idbTable(db, name) {
  const store = mode => db.transaction(name, mode).objectStore(name);
  const write = run => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    run(tx.objectStore(name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
  return {
    getAll: () => request(store('readonly').getAll()),
    put: value => write(os => os.put(value)),
    putMany: values => write(os => { for (const value of values) os.put(value); }),
    delete: key => write(os => os.delete(key)),
    deleteMany: keys => write(os => { for (const key of keys) os.delete(key); }),
    clear: () => write(os => os.clear()),
  };
}

/** The browser's tables: { history, bookmarks, icons }. */
export async function openStore(indexedDB = globalThis.indexedDB) {
  const db = await openDatabase(indexedDB);
  return Object.fromEntries(Object.keys(TABLES).map(name => [name, idbTable(db, name)]));
}

/** A table in memory, keyed by `keyPath`. */
export function memoryTable(keyPath) {
  const rows = new Map();
  const copy = value => structuredClone(value);
  return {
    getAll: async () => [...rows.values()].map(copy),
    put: async value => { rows.set(value[keyPath], copy(value)); },
    putMany: async values => { for (const value of values) rows.set(value[keyPath], copy(value)); },
    delete: async key => { rows.delete(key); },
    deleteMany: async keys => { for (const key of keys) rows.delete(key); },
    clear: async () => { rows.clear(); },
    get size() { return rows.size; },
  };
}

/** The same tables in memory (tests, or when IndexedDB can't open). */
export function memoryStore() {
  return Object.fromEntries(Object.entries(TABLES).map(([name, keyPath]) => [name, memoryTable(keyPath)]));
}

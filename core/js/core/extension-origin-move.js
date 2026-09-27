/**
 * Copies an extension's storage from the shared first-party origin into the
 * origin of its own (see extension-frames.cjs sharedOriginMove and main.js
 * _moveToOwnOrigins). Core's own code, served at /__atmos/move.js only while a
 * move is running, in two pages:
 *
 *   export  atmos-ext://first-party/__atmos/move.html?role=export. It reads
 *           the declared IndexedDB databases (schema and every record, Blobs
 *           included) and localStorage keys, and later deletes them.
 *   import  atmos-ext://<the extension's own host>/__atmos/move.html?role=import.
 *           It writes what it is sent.
 *
 * Both are frames in a hidden page of the Atmos origin (atmos-app://local),
 * because Chromium keys a frame's storage by the page it is embedded in as
 * well as by its own origin: only frames inside an atmos-app page see the
 * storage extensions' frames use in the Atmos window. The page hands them a
 * MessageChannel, so records keep their structured-clone types. Nothing is deleted from the shared origin here: that happens at a
 * later start, once the extension has run from its own origin. Before
 * writing, the import side clears only the databases and keys it is about to
 * write (what an interrupted earlier attempt may have left), and at the end
 * it counts every store so a short copy fails instead of passing.
 */
(() => {
  'use strict';
  const role = document.currentScript?.dataset.role === 'import' ? 'import' : 'export';
  const CHUNK = 200;

  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
  const matches = (name, patterns) => patterns.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  const openDb = (name, version, upgrade) => new Promise((resolve, reject) => {
    const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
    r.onupgradeneeded = () => upgrade?.(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${name} is open elsewhere`));
  });
  const deleteDb = name => new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${name} is open elsewhere`));
  });

  async function countRecords(name) {
    const db = await openDb(name);
    try {
      let total = 0;
      for (const store of db.objectStoreNames) total += await request(db.transaction(store).objectStore(store).count());
      return total;
    } finally {
      db.close();
    }
  }

  if (role === 'import') {
    const handlers = {
      async reset({ indexedDB: names, localStorage: keys }) {
        for (const name of names) await deleteDb(name);
        for (const key of keys) localStorage.removeItem(key);
      },
      async create({ name, version, stores }) {
        const db = await openDb(name, version, created => {
          for (const store of stores) {
            const objectStore = created.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
            for (const index of store.indexes) objectStore.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
          }
        });
        db.close();
      },
      async put({ name, store, inline, keys, values }) {
        const db = await openDb(name);
        try {
          const tx = db.transaction(store, 'readwrite');
          const objectStore = tx.objectStore(store);
          values.forEach((value, i) => (inline ? objectStore.put(value) : objectStore.put(value, keys[i])));
          await done(tx);
        } finally {
          db.close();
        }
      },
      async local({ items }) {
        for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
      },
      async count({ indexedDB: names, localStorage: keys }) {
        const counts = {};
        for (const name of names) counts[name] = await countRecords(name);
        return { indexedDB: counts, localStorage: keys.filter(key => localStorage.getItem(key) !== null).length };
      },
    };
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.atmosMove !== 'port' || !event.ports[0]) return;
      const port = event.ports[0];
      port.onmessage = async ({ data }) => {
        try {
          const result = await handlers[data.op](data);
          port.postMessage({ id: data.id, result: result ?? null });
        } catch (error) {
          port.postMessage({ id: data.id, error: String(error?.message || error) });
        }
      };
      port.postMessage({ ready: true });
    });
    return;
  }

  // The export side: a frame in the shared origin, told by Core's hidden
  // storage page (main.js) what to do, and answering it.
  async function copy(spec, port) {
    const names = (await indexedDB.databases()).map(db => db.name).filter(name => name && matches(name, spec.indexedDB));
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && matches(key, spec.localStorage)) keys.push(key);
    }

    const pending = new Map();
    let next = 1;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the new storage did not answer')), 20000);
      port.onmessage = ({ data }) => {
        if (data?.ready) { clearTimeout(timer); resolve(); return; }
        const call = pending.get(data.id);
        pending.delete(data.id);
        if (call) (data.error ? call.reject(new Error(data.error)) : call.resolve(data.result));
      };
    });
    await ready;
    const send = message => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      port.postMessage({ ...message, id });
    });

    await send({ op: 'reset', indexedDB: names, localStorage: keys });
    const copied = { indexedDB: {}, localStorage: keys.length };
    for (const name of names) {
      const db = await openDb(name);
      try {
        const stores = [...db.objectStoreNames].map(storeName => {
          const store = db.transaction(storeName).objectStore(storeName);
          return {
            name: storeName,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].map(indexName => {
              const index = store.index(indexName);
              return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
            }),
          };
        });
        await send({ op: 'create', name, version: db.version, stores });
        let records = 0;
        for (const store of stores) {
          const allKeys = await request(db.transaction(store.name).objectStore(store.name).getAllKeys());
          for (let start = 0; start < allKeys.length; start += CHUNK) {
            const chunk = allKeys.slice(start, start + CHUNK);
            const objectStore = db.transaction(store.name).objectStore(store.name);
            const values = await Promise.all(chunk.map(k => request(objectStore.get(k))));
            await send({ op: 'put', name, store: store.name, inline: store.keyPath !== null, keys: chunk, values });
          }
          records += allKeys.length;
        }
        copied.indexedDB[name] = records;
      } finally {
        db.close();
      }
    }
    await send({ op: 'local', items: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])) });

    const counted = await send({ op: 'count', indexedDB: names, localStorage: keys });
    for (const [name, records] of Object.entries(copied.indexedDB)) {
      if (counted.indexedDB[name] !== records) throw new Error(`${name}: ${counted.indexedDB[name]} of ${records} records arrived`);
    }
    if (counted.localStorage !== keys.length) throw new Error(`${counted.localStorage} of ${keys.length} localStorage keys arrived`);
    return copied;
  }

  /** Delete the databases and keys matching the patterns (the shared copies of moved data). */
  async function remove({ indexedDB: patterns, localStorage: keyPatterns }) {
    const names = (await indexedDB.databases()).map(db => db.name).filter(name => name && matches(name, patterns));
    for (const name of names) await deleteDb(name);
    const keys = [];
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && matches(key, keyPatterns)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    return [...names, ...keys];
  }

  window.addEventListener('message', async event => {
    if (event.source !== window.parent || !event.data?.atmosMove) return;
    const reply = message => window.parent.postMessage({ atmosMoveResult: true, ...message }, '*');
    try {
      if (event.data.atmosMove === 'export' && event.ports[0]) reply({ result: await copy(event.data.spec, event.ports[0]) });
      else if (event.data.atmosMove === 'remove') reply({ result: await remove(event.data) });
    } catch (error) {
      reply({ error: String(error?.message || error) });
    }
  });
})();

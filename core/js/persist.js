/** Versioned persistence for Core-owned shell state and extension namespaces. */

// id -> { serialize, hydrate }
const _extensionPersisters = new Map();
const _stateNamespaces = new Map(); // id -> { state, defaults, version, serialize, hydrate, migrate }
const _coreStateNamespaces = new Map();

const _clone = value => {
  try { return structuredClone(value); }
  catch (_error) { return JSON.parse(JSON.stringify(value)); }
};

function _assertNamespaceId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new TypeError('persist: namespace id must contain lowercase letters, numbers, and hyphens');
  }
}

function _hydrateNamespace(id, def, stored, blob) {
  let data = stored?.data;
  const fromVersion = Number.isFinite(stored?.version) ? stored.version : 0;
  if (data === undefined && typeof def.migrateLegacy === 'function') {
    data = def.migrateLegacy(_clone(def.defaults), blob);
  }
  if (data !== undefined && fromVersion !== def.version && typeof def.migrate === 'function') {
    data = def.migrate(_clone(data), fromVersion, def.version);
  }
  Object.keys(def.state).forEach(key => delete def.state[key]);
  Object.assign(def.state, _clone(def.defaults));
  if (data && typeof data === 'object') {
    if (typeof def.hydrate === 'function') def.hydrate(def.state, data);
    else Object.assign(def.state, data);
  }
}

function _hydrateStateNamespace(id, def, blob) {
  _hydrateNamespace(id, def, blob?.extensionState?.[id], blob);
}

function _hydrateCoreStateNamespace(id, def, blob) {
  _hydrateNamespace(id, def, blob?.coreState?.[id], blob);
}

/** Register state owned by a Core registry or shell controller. */
export function registerCoreStateNamespace(id, {
  defaults = {}, version = 1, serialize, hydrate, migrate, migrateLegacy,
} = {}) {
  _assertNamespaceId(id);
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new TypeError('persist: core namespace defaults must be an object');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('persist: core namespace version must be a positive integer');
  }
  if (_coreStateNamespaces.has(id)) throw new Error(`persist: core state namespace '${id}' is already registered`);
  const namespace = {};
  const def = {
    state: namespace, defaults: _clone(defaults), version,
    serialize, hydrate, migrate, migrateLegacy,
  };
  _coreStateNamespaces.set(id, def);
  _hydrateCoreStateNamespace(id, def, _lastLoadedBlob || {});
  return namespace;
}

/**
 * Register collision-free, versioned extension state. The returned object is
 * stable for the renderer lifetime and is persisted under extensionState[id].
 * Legacy registerPersist() remains supported for existing flat storage.
 */
export function registerStateNamespace(id, {
  defaults = {}, version = 1, serialize, hydrate, migrate,
} = {}) {
  _assertNamespaceId(id);
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new TypeError('persist: namespace defaults must be an object');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('persist: namespace version must be a positive integer');
  }
  if (_stateNamespaces.has(id)) throw new Error(`persist: state namespace '${id}' is already registered`);
  const namespace = {};
  const def = { state: namespace, defaults: _clone(defaults), version, serialize, hydrate, migrate };
  _stateNamespaces.set(id, def);
  _hydrateStateNamespace(id, def, _lastLoadedBlob || {});
  return namespace;
}

// Snapshot of the last blob load() actually parsed (or {} if there was
// nothing saved), so a plugin that registers AFTER load() has already run
// still gets hydrate() called against real data instead of silently
// missing its turn. app.js calls loadPluginPersist() before load() so this
// is normally just a defensive fallback, not the common path — same
// "late subscriber still gets called" reasoning onStateLoaded() below
// already relies on, for the same underlying cause (dynamic import()
// resolves asynchronously and can't be assumed to beat anything else).
let _lastLoadedBlob = null;

/**
 * Register a plugin's persisted-field handlers. Safe to call at any point
 * relative to load()/save() — see _lastLoadedBlob above for what happens
 * if this runs after load() already parsed a saved blob.
 */
export function registerPersist(id, { serialize, hydrate }) {
  _extensionPersisters.set(id, { serialize, hydrate });
  if (_lastLoadedBlob !== null) {
    try {
      hydrate(_lastLoadedBlob);
    } catch (e) {
      console.error(`[persist] hydrate() failed for late-registered extension '${id}':`, e);
    }
  }
}

function _serializeExtensions() {
  const out = {};
  for (const [id, { serialize }] of _extensionPersisters) {
    try {
      Object.assign(out, serialize());
    } catch (e) {
      console.error(`[persist] serialize() failed for extension '${id}':`, e);
    }
  }
  return out;
}

function _hydrateExtensions(s) {
  for (const [id, { hydrate }] of _extensionPersisters) {
    try {
      hydrate(s);
    } catch (e) {
      console.error(`[persist] hydrate() failed for extension '${id}':`, e);
    }
  }
}

function _serializeStateNamespaces() {
  // Preserve namespaces belonging to temporarily disabled or unavailable
  // extensions. Active registrations only overwrite their own snapshot.
  const saved = _lastLoadedBlob?.extensionState;
  const out = saved && typeof saved === 'object' ? _clone(saved) : {};
  for (const [id, def] of _stateNamespaces) {
    try {
      const data = typeof def.serialize === 'function' ? def.serialize(def.state) : def.state;
      out[id] = { version: def.version, data: _clone(data) };
    } catch (error) {
      console.error(`[persist] state namespace '${id}' failed to serialize:`, error);
    }
  }
  return out;
}

function _serializeCoreStateNamespaces() {
  const out = {};
  for (const [id, def] of _coreStateNamespaces) {
    try {
      const data = typeof def.serialize === 'function' ? def.serialize(def.state) : def.state;
      out[id] = { version: def.version, data: _clone(data) };
    } catch (error) {
      console.error(`[persist] core state namespace '${id}' failed to serialize:`, error);
    }
  }
  return out;
}

function _hydrateStateNamespaces(blob) {
  for (const [id, def] of _stateNamespaces) {
    try { _hydrateStateNamespace(id, def, blob); }
    catch (error) { console.error(`[persist] state namespace '${id}' failed to hydrate:`, error); }
  }
}

function _hydrateCoreStateNamespaces(blob) {
  for (const [id, def] of _coreStateNamespaces) {
    try { _hydrateCoreStateNamespace(id, def, blob); }
    catch (error) { console.error(`[persist] core state namespace '${id}' failed to hydrate:`, error); }
  }
}

// ── "State loaded" signal ────────────────────────────────────────────────────
// load() below dispatches a plain 'app:state-loaded' event once namespaces
// have settled. That's fine for subscribers registered synchronously at boot —
// but plugins load via dynamic import() (see js/core/plugin-loader.js),
// which resolves asynchronously and can easily lose the race against
// load()'s dispatch. A subscriber that registers even one tick late would
// silently miss the event forever with a plain addEventListener.
//
// _stateLoaded + onStateLoaded() fix that: onStateLoaded() calls the
// callback immediately if load() already ran, or subscribes if it hasn't
// yet — so it behaves correctly regardless of when the caller shows up.
// The raw 'app:state-loaded' event is still dispatched too, for anything
// that doesn't need this safety and just wants the original behavior.
let _stateLoaded = false;

/**
 * A copy of what was last saved for an extension state namespace, whether
 * or not anything has registered it this session (null if never saved).
 * Used to hand a namespace to an extension that moved into frames.
 */
export function readSavedNamespace(id) {
  if (_stateNamespaces.has(id)) {
    const def = _stateNamespaces.get(id);
    return _clone(typeof def.serialize === 'function' ? def.serialize(def.state) : def.state);
  }
  const saved = _lastLoadedBlob?.extensionState?.[id]?.data;
  return saved === undefined ? null : _clone(saved);
}

export function onStateLoaded(fn) {
  if (_stateLoaded) { fn(); return () => {}; }
  const handler = () => fn();
  window.addEventListener('app:state-loaded', handler, { once: true });
  return () => window.removeEventListener('app:state-loaded', handler);
}

const STORAGE_KEY_V4 = 'samsara_v4';
const STORAGE_KEY_V3 = 'samsara_v3';

// ── localStorage ─────────────────────────────────────────────────────────────

// Assigns obj[key] = getter(), but a throwing getter only drops that one
// field instead of aborting the whole save. Before this, save() built one
// big object literal and ran JSON.stringify() on it inside a single try —
// any one field throwing (or a circular reference) meant NOTHING got
// written that call, silently, with no way to tell which field did it.
// Now a bad field just gets skipped (loudly) and everything else still
// saves normally.
function _safeField(obj, key, getter) {
  try {
    obj[key] = getter();
  } catch (e) {
    console.error(`[persist] save() field '${key}' threw, skipping it this save:`, e);
  }
}

// ── Batched saves ──────────────────────────────────────────────────────────
// save() serialises every namespace and writes synchronously, which is too
// heavy to run on every 'input' event of a slider or colour picker.
// scheduleSave() coalesces a burst of changes into one write shortly after
// the last one. Explicit save() calls still write immediately (and absorb any
// pending scheduled write), and a pending write is flushed before the page
// unloads, including Ctrl+R, closing the window, and Atmos restarts.
const SCHEDULED_SAVE_DELAY_MS = 250;
let _scheduledSave = null;

export function scheduleSave(delay = SCHEDULED_SAVE_DELAY_MS) {
  if (_scheduledSave !== null) clearTimeout(_scheduledSave);
  _scheduledSave = setTimeout(() => {
    _scheduledSave = null;
    save();
  }, delay);
  _scheduledSave?.unref?.(); // never keep a Node test process alive
}

/** Write a pending scheduled save now. Returns whether one was pending. */
export function flushPendingSave() {
  if (_scheduledSave === null) return false;
  save();
  return true;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushPendingSave);
  window.addEventListener('beforeunload', flushPendingSave);
}

export function save() {
  if (_scheduledSave !== null) {
    clearTimeout(_scheduledSave);
    _scheduledSave = null;
  }
  // FIX: refuse to write until load() has actually run. Something calling
  // save() before load() (e.g. a settings-sync path racing load() via
  // dynamic import()) would otherwise flush in-memory defaults over the
  // real saved blob before it's ever been read back — silently wiping
  // history/settings on every boot that lost the race.
  if (!_stateLoaded) {
    console.warn('[persist] save() called before load() has run — skipping to avoid overwriting saved data with defaults');
    return;
  }

  const out = {};
  _safeField(out, 'coreState',           () => _serializeCoreStateNamespaces());
  _safeField(out, 'extensionState',      () => _serializeStateNamespaces());

  // Extensions already isolate per-extension failures internally (see
  // _serializeExtensions() above), so this one is safe to spread directly —
  // but wrap it too in case a future change to that function removes that
  // guarantee.
  _safeField(out, '__extensions', () => _serializeExtensions());
  const extensions = out.__extensions;
  delete out.__extensions;
  if (extensions) Object.assign(out, extensions);

  try {
    const payload = JSON.stringify(out);
    localStorage.setItem(STORAGE_KEY_V4, payload);
  } catch (_e) {
    // At this point `out` is just plain already-resolved values (no
    // getters left to throw), so this only fires for genuine
    // JSON.stringify/localStorage problems — a real circular reference
    // slipping through, quota exceeded, or private-browsing style
    // storage denial. Individual bad fields never reach this catch
    // anymore; they were already dropped by _safeField() above.
    console.error('[persist] save() failed — settings were NOT written to localStorage:', _e);
  }
}

export function load() {
  const raw = localStorage.getItem(STORAGE_KEY_V4) || localStorage.getItem(STORAGE_KEY_V3);
  if (raw) {
    _applyLoaded(raw);
  } else {
    // Nothing saved yet — still give every registered plugin a hydrate()
    // pass against an empty object so its own defaults apply consistently,
    // and so _lastLoadedBlob is no longer null (see registerPersist).
    _lastLoadedBlob = {};
    _hydrateCoreStateNamespaces(_lastLoadedBlob);
    _hydrateStateNamespaces(_lastLoadedBlob);
    _hydrateExtensions(_lastLoadedBlob);
  }

  _stateLoaded = true;
  window.dispatchEvent(new Event('app:state-loaded'));
}

function _applyLoaded(raw) {
  try {
    const s = JSON.parse(raw);

    _lastLoadedBlob = s;
    _hydrateCoreStateNamespaces(s);
    _hydrateStateNamespaces(s);
    _hydrateExtensions(s);

  } catch (_e) {
    console.error('[persist] load() failed to apply saved state:', _e);
  }
}

// ── IndexedDB extension assets ───────────────────────────────────────────────

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('samsara_db', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('assets');
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => {
      _dbPromise = null; // allow a retry on a later call rather than caching a rejection forever
      rej(e.target.error);
    };
  });
  return _dbPromise;
}

export async function saveAsset(key, value) {
  try {
    const transaction = (await openDB()).transaction('assets', 'readwrite');
    transaction.objectStore('assets').put(value, key);
    return await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (_e) { return false; }
}

export async function deleteAsset(key) {
  try {
    const transaction = (await openDB()).transaction('assets', 'readwrite');
    transaction.objectStore('assets').delete(key);
    return await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (_e) { return false; }
}

export async function loadAsset(key, fallback = null) {
  try {
    const db = await openDB();
    const value = await new Promise(resolve => {
      const request = db.transaction('assets', 'readonly').objectStore('assets').get(key);
      request.onsuccess = event => resolve(event.target.result ?? fallback);
      request.onerror = () => resolve(fallback);
    });
    return value;
  } catch (_e) { return fallback; }
}

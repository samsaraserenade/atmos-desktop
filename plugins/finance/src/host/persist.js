/**
 * Stands in for Atmos Core's persist.js inside Finance's frames.
 *
 * Settings: Finance's three state namespaces ('portfolio-tracker', 'markets',
 * 'watchlist') keep their shape, hydrate/migrate/serialize and ids, and are
 * shared by all of its frames through Finance's Atmos state. Each field is
 * its own top-level key there, `ns:<namespace>:<field>`, with the namespace's
 * version at `nsv:<namespace>`. A frame writes only the fields it changed:
 * Atmos merges top-level keys in one step, so two frames saving at once
 * can't undo each other's change. Fields a namespace lists as `large` (an
 * imported font) live in this origin's localStorage instead, to stay well
 * under Atmos state's 1 MB.
 *
 * Assets (chart and per-source history): IndexedDB in Finance's frame
 * origin, same keys as before.
 *
 * Before any frame reads settings, the engine prepares them once: from the
 * earlier layout (all namespaces in one `namespaces` key, Finance 1.0.2 and
 * older), or, the first time Finance runs in frames, from what the in-page
 * Finance left in the Atmos page (legacyStorage in extension.json). Views
 * wait for it.
 */

import { atmos, isEngine, role, SELF } from './frame.js';

const LEGACY_NAMESPACES = ['portfolio-tracker', 'markets', 'watchlist'];
const LARGE_PREFIX = 'finance:state:';
const ASSET_DB = 'finance-assets';

/** state.settingsLayout once settings are kept a field per key. */
const LAYOUT = 2;
const FIELD_PREFIX = 'ns:';
const VERSION_PREFIX = 'nsv:';
const fieldKey = (id, field) => `${FIELD_PREFIX}${id}:${field}`;
const versionKey = id => `${VERSION_PREFIX}${id}`;
/** The namespace a settings key belongs to, or null for Finance's other state (pendingAction, ...). */
function namespaceOf(key) {
  if (key.startsWith(VERSION_PREFIX)) return key.slice(VERSION_PREFIX.length);
  if (!key.startsWith(FIELD_PREFIX)) return null;
  const rest = key.slice(FIELD_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? null : rest.slice(0, colon);
}

// ── Assets (IndexedDB) ───────────────────────────────────────────────────────

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB, 1);
    request.onupgradeneeded = event => event.target.result.createObjectStore('assets');
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => { _dbPromise = null; reject(event.target.error); };
  });
  return _dbPromise;
}

export async function saveAsset(key, value) {
  try {
    const transaction = (await openDB()).transaction('assets', 'readwrite');
    transaction.objectStore('assets').put(value, key);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  } catch (error) {
    console.error(`[finance] could not save ${key}:`, error);
  }
}

export async function deleteAsset(key) {
  try {
    const transaction = (await openDB()).transaction('assets', 'readwrite');
    transaction.objectStore('assets').delete(key);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  } catch (error) {
    console.error(`[finance] could not delete ${key}:`, error);
  }
}

export async function loadAsset(key, fallback = null) {
  try {
    const request = (await openDB()).transaction('assets', 'readonly').objectStore('assets').get(key);
    const value = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return value === undefined ? fallback : value;
  } catch (error) {
    console.error(`[finance] could not load ${key}:`, error);
    return fallback;
  }
}

// ── Preparing settings (engine, once) ────────────────────────────────────────

/** One-time copy from the Atmos page: { id: { data } } for each namespace it had. */
async function copyFromPage() {
  const namespaces = {};
  for (const id of LEGACY_NAMESPACES) {
    const data = await atmos.legacy.readState(id).catch(() => null);
    if (data && typeof data === 'object') namespaces[id] = { data };
  }
  // The display currency, if the in-page Finance never took it over from the
  // Currency service's old namespace.
  const portfolio = namespaces['portfolio-tracker']?.data;
  if (portfolio && !portfolio.outputCurrency) {
    const currency = await atmos.legacy.readState('currency').catch(() => null);
    if (['GBP', 'USD', 'EUR', 'CHF'].includes(currency?.outputCurrency)) portfolio.outputCurrency = currency.outputCurrency;
  }
  // The imported balance font is too big for Atmos state.
  const fonts = namespaces['portfolio-tracker']?.data?.customBalanceFonts;
  if (Array.isArray(fonts)) {
    try { localStorage.setItem(`${LARGE_PREFIX}portfolio-tracker:customBalanceFonts`, JSON.stringify(fonts)); } catch {}
    delete namespaces['portfolio-tracker'].data.customBalanceFonts;
  }
  // Chart history and per-source history, from the page's shared asset database.
  const assets = await atmos.legacy.readIndexedDB('samsara_db').catch(error => {
    console.warn('[finance] could not read the Atmos page\'s saved history:', error.message);
    return null;
  });
  const ABSENT = Symbol('absent');
  for (const [key, value] of assets?.stores?.assets || []) {
    if (await loadAsset(key, ABSENT) === ABSENT) await saveAsset(key, value);
  }
  // Charting's saved settings and chart views (src/chart-storage.js).
  const chartKeys = await atmos.legacy.readLocalStorage(['atmos:charting-*']).catch(() => ({}));
  for (const [key, value] of Object.entries(chartKeys || {})) {
    try { if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch {}
  }
  return namespaces;
}

/** { id: { version?, data } } as one state patch, a key per field. */
function fieldsOf(namespaces) {
  const patch = {};
  for (const [id, stored] of Object.entries(namespaces || {})) {
    if (Number.isFinite(stored?.version)) patch[versionKey(id)] = stored.version;
    if (!stored?.data || typeof stored.data !== 'object') continue;
    for (const [field, value] of Object.entries(stored.data)) patch[fieldKey(id, field)] = value;
  }
  return patch;
}

/**
 * Settings as this module reads them. If the engine couldn't write the new
 * layout, the earlier one is read in its place; fields saved since win.
 */
function readable(state) {
  return state.settingsLayout === LAYOUT || !state.namespaces ? state : { ...fieldsOf(state.namespaces), ...state };
}

async function prepareSettings(saved) {
  const patch = { settingsLayout: LAYOUT };
  if (saved.namespaces) {
    // Finance 1.0.2's layout. The old key stays, unread, so going back to an
    // earlier Finance finds its settings rather than copying the page again.
    Object.assign(patch, fieldsOf(saved.namespaces));
  } else {
    Object.assign(patch, fieldsOf(await copyFromPage()));
    patch.copiedFromPage = new Date().toISOString();
  }
  // If Atmos refuses it, carry on with it here: views read the old layout
  // the same way (below), and each save writes the fields it changes.
  await atmos.state.update(patch).catch(error => console.error('[finance] could not prepare settings:', error.message));
  return { ...saved, ...patch };
}

let _saved = await atmos.state.get().catch(() => ({})) || {};
if (_saved.settingsLayout !== LAYOUT) {
  if (isEngine()) {
    _saved = await prepareSettings(_saved);
  } else {
    // The engine prepares settings once; wait for it.
    await atmos.call(SELF, 'ready').catch(error => console.warn(`[finance:${role}] engine not ready:`, error.message));
    _saved = readable(await atmos.state.get().catch(() => ({})) || {});
  }
}

// ── State namespaces ─────────────────────────────────────────────────────────

const _clone = value => {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};
const _json = value => JSON.stringify(value);
const _defs = new Map(); // id -> { state, defaults, version, serialize, hydrate, migrate, large }

function _readLarge(id, field) {
  try {
    const raw = localStorage.getItem(`${LARGE_PREFIX}${id}:${field}`);
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

/** The namespace's saved fields as one object, or undefined if nothing is saved. */
function _storedData(id) {
  const prefix = `${FIELD_PREFIX}${id}:`;
  let data;
  for (const [key, value] of Object.entries(_saved)) {
    if (key.startsWith(prefix)) (data ??= {})[key.slice(prefix.length)] = _clone(value);
  }
  return data;
}

function _hydrate(id, def) {
  let data = _storedData(id);
  if (data && typeof data === 'object') {
    for (const field of def.large) {
      const value = _readLarge(id, field);
      if (value !== undefined) data[field] = value;
    }
  }
  const stored = _saved[versionKey(id)];
  const fromVersion = Number.isFinite(stored) ? stored : def.version;
  if (data !== undefined && fromVersion !== def.version && typeof def.migrate === 'function') {
    data = def.migrate(data, fromVersion, def.version);
  }
  for (const key of Object.keys(def.state)) delete def.state[key];
  Object.assign(def.state, _clone(def.defaults));
  if (data && typeof data === 'object') {
    if (typeof def.hydrate === 'function') def.hydrate(def.state, data);
    else Object.assign(def.state, data);
  }
}

/** Same contract as Core's registerStateNamespace(); `large` fields are kept out of Atmos state. */
export function registerStateNamespace(id, { defaults = {}, version = 1, serialize, hydrate, migrate, large = [] } = {}) {
  if (_defs.has(id)) throw new Error(`persist: state namespace '${id}' is already registered`);
  const state = {};
  const def = { state, defaults: _clone(defaults), version, serialize, hydrate, migrate, large };
  _defs.set(id, def);
  _hydrate(id, def);
  return state;
}

/** Settings are loaded before any Finance module runs. */
export function onStateLoaded(fn) {
  fn();
  return () => {};
}

const _localListeners = new Set();
/** fn() after this frame saved changed settings. */
export function onLocalStateChange(fn) {
  _localListeners.add(fn);
  return () => _localListeners.delete(fn);
}

// Fields this frame has sent that Atmos hasn't confirmed yet: key -> { seq, value }.
// Another frame's change can arrive in between, carrying the state from just
// before ours was merged; these are laid over it so ours isn't lost here.
const _unconfirmed = new Map();
let _writeSeq = 0;

function _write(patch) {
  const seq = ++_writeSeq;
  for (const [key, value] of Object.entries(patch)) _unconfirmed.set(key, { seq, value });
  _saved = { ..._saved, ...patch };
  for (const fn of [..._localListeners]) { try { fn(); } catch (error) { console.error('[finance] settings listener failed:', error); } }
  atmos.state.update(patch)
    .catch(error => console.error('[finance] could not save settings:', error.message))
    .finally(() => {
      for (const key of Object.keys(patch)) if (_unconfirmed.get(key)?.seq === seq) _unconfirmed.delete(key);
    });
}

let _saveQueued = false;
function _flush() {
  _saveQueued = false;
  const patch = {};
  for (const [id, def] of _defs) {
    let data;
    try { data = _clone(typeof def.serialize === 'function' ? def.serialize(def.state) : def.state); }
    catch (error) { console.error(`[finance] state namespace '${id}' failed to serialize:`, error); continue; }
    for (const field of def.large) {
      const key = `${LARGE_PREFIX}${id}:${field}`;
      const json = _json(data[field] ?? null);
      try { if (localStorage.getItem(key) !== json) localStorage.setItem(key, json); } catch (error) { console.error(`[finance] could not save ${field}:`, error); }
      delete data[field];
    }
    if (_saved[versionKey(id)] !== def.version) patch[versionKey(id)] = def.version;
    for (const [field, value] of Object.entries(data)) {
      const key = fieldKey(id, field);
      if (_json(value) !== _json(_saved[key])) patch[key] = value;
    }
  }
  if (Object.keys(patch).length) _write(patch);
}

/** Save what changed in any namespace (coalesced; only changed fields are written). */
export function save() {
  if (_saveQueued) return;
  _saveQueued = true;
  queueMicrotask(_flush);
}
export const scheduleSave = () => save();
export const flushPendingSave = () => { if (_saveQueued) _flush(); };

// ── Other frames' changes ────────────────────────────────────────────────────

const _externalListeners = new Set();
/** fn() after another Finance frame changed settings; re-render from them. */
export function onExternalStateChange(fn) {
  _externalListeners.add(fn);
  return () => _externalListeners.delete(fn);
}
function _notifyExternal() {
  for (const fn of [..._externalListeners]) {
    try { fn(); } catch (error) { console.error('[finance] settings listener failed:', error); }
  }
}

atmos.state.onChange(next => {
  if (!next || typeof next !== 'object') return;
  const merged = { ...readable(next) };
  for (const [key, { value }] of _unconfirmed) merged[key] = value;
  const before = _saved;
  _saved = merged;
  const changed = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(merged)])) {
    const id = namespaceOf(key);
    if (id && _defs.has(id) && !changed.has(id) && _json(before[key]) !== _json(merged[key])) changed.add(id);
  }
  if (!changed.size) return;
  for (const id of changed) _hydrate(id, _defs.get(id));
  _notifyExternal();
});

window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || !event.key?.startsWith(LARGE_PREFIX)) return;
  const id = event.key.slice(LARGE_PREFIX.length).split(':')[0];
  const def = _defs.get(id);
  if (!def) return;
  _hydrate(id, def);
  _notifyExternal();
});

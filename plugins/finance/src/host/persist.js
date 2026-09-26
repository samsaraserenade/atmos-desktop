/**
 * Stands in for Atmos Core's persist.js inside Finance's frames.
 *
 * Settings: Finance's three state namespaces ('portfolio-tracker', 'markets',
 * 'watchlist') keep their shape, hydrate/migrate/serialize and ids, and are
 * saved together in Finance's Atmos state as { namespaces: { id: { version,
 * data } } }, shared by all of its frames. Fields a namespace lists as
 * `large` (an imported font) live in this origin's localStorage instead, to
 * stay well under Atmos state's 1 MB.
 *
 * Assets (chart and per-source history): IndexedDB in Finance's frame
 * origin, same keys as before.
 *
 * The first time Finance runs in frames, the engine copies all of this from
 * what the in-page Finance left in the Atmos page (legacyStorage in
 * extension.json); views wait for it.
 */

import { atmos, isEngine, role, SELF } from './frame.js';

const LEGACY_NAMESPACES = ['portfolio-tracker', 'markets', 'watchlist'];
const LARGE_PREFIX = 'finance:state:';
const ASSET_DB = 'finance-assets';

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

// ── One-time copy from the Atmos page ────────────────────────────────────────

async function copyFromPage(saved) {
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
  const next = { ...saved, namespaces, copiedFromPage: new Date().toISOString() };
  await atmos.state.update({ namespaces, copiedFromPage: next.copiedFromPage });
  return next;
}

let _saved = await atmos.state.get().catch(() => ({})) || {};
if (!_saved.namespaces) {
  if (isEngine()) {
    _saved = await copyFromPage(_saved);
  } else {
    // The engine copies the page's data once; wait for it.
    await atmos.call(SELF, 'ready').catch(error => console.warn(`[finance:${role}] engine not ready:`, error.message));
    _saved = await atmos.state.get().catch(() => ({})) || {};
  }
}

// ── State namespaces ─────────────────────────────────────────────────────────

const _clone = value => {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};
const _defs = new Map(); // id -> { state, defaults, version, serialize, hydrate, migrate, large }
let _lastJson = JSON.stringify(_saved.namespaces || {});

function _readLarge(id, field) {
  try {
    const raw = localStorage.getItem(`${LARGE_PREFIX}${id}:${field}`);
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

function _hydrate(id, def) {
  const stored = _saved.namespaces?.[id];
  let data = stored?.data === undefined ? undefined : _clone(stored.data);
  if (data && typeof data === 'object') {
    for (const field of def.large) {
      const value = _readLarge(id, field);
      if (value !== undefined) data[field] = value;
    }
  }
  const fromVersion = Number.isFinite(stored?.version) ? stored.version : def.version;
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

let _saveQueued = false;
function _flush() {
  _saveQueued = false;
  const namespaces = { ..._saved.namespaces };
  for (const [id, def] of _defs) {
    let data;
    try { data = _clone(typeof def.serialize === 'function' ? def.serialize(def.state) : def.state); }
    catch (error) { console.error(`[finance] state namespace '${id}' failed to serialize:`, error); continue; }
    for (const field of def.large) {
      const key = `${LARGE_PREFIX}${id}:${field}`;
      const json = JSON.stringify(data[field] ?? null);
      try { if (localStorage.getItem(key) !== json) localStorage.setItem(key, json); } catch (error) { console.error(`[finance] could not save ${field}:`, error); }
      delete data[field];
    }
    namespaces[id] = { version: def.version, data };
  }
  const json = JSON.stringify(namespaces);
  if (json === _lastJson) return;
  _lastJson = json;
  _saved = { ..._saved, namespaces };
  for (const fn of [..._localListeners]) { try { fn(); } catch (error) { console.error('[finance] settings listener failed:', error); } }
  atmos.state.update({ namespaces }).catch(error => console.error('[finance] could not save settings:', error.message));
}

/** Save every namespace (coalesced; unchanged settings aren't written). */
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
  if (!next?.namespaces) return;
  const json = JSON.stringify(next.namespaces);
  _saved = next;
  if (json === _lastJson) return;
  _lastJson = json;
  for (const [id, def] of _defs) _hydrate(id, def);
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

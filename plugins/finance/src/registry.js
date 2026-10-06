/**
 * plugins/finance/src/registry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance's portfolio store. The portfolio is collected by the user's VPS
 * (plugins/finance/backend) and read here through remote.js; the desktop no
 * longer runs connection plugins of its own. This file keeps the list of
 * sources the VPS reports, their latest data and status, the saved
 * per-source history the charts combine with the VPS's, and the
 * Portfolio Connections widget's data (its list is ./connections-list.js).
 *
 * Currency conversion is the Currency library's (services/currency); the
 * totals and the currency toggle are in ./totals.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { initCurrencyService, startRatesPolling } from './totals.js';
import {
  loadConnectionHistory, loadConnectionHistoryChunk, loadConnectionHistoryManifest,
  saveConnectionHistoryChunk, saveConnectionHistoryManifest,
} from './storage.js';
import { MAX_HISTORY_POINTS } from './history-constants.js';
import { getConnection, startVpsPortfolio, fetchHoldingsHistory, fetchHoldingsPage } from './remote.js';
import { renderConnections } from './connections-list.js';
import { isEngine } from './host/frame.js';
import { applyHistoryChange, composeHistoryChanges, diffHistoryTail } from './history-change.js';

const exchanges   = [];
const _portfolios = new Map();
let _remoteMode = false;
let _connection = { configured: false }; // { configured, address?, protected? } — never the token
let _remote = null;                      // the running VPS reader (engine only)
let _engineContext = null;
let _remoteTotalHistory = [];
let _refreshRemoteHistory = null;
const _remoteHistoryHooks = new Set();

// Re-exported so UI code importing history helpers from registry.js
// (the existing pattern for getRemoteTotalHistory etc.) can reach the
// new point-in-time holdings lookup the same way, without needing to
// know it actually lives in remote.js.
export { fetchHoldingsHistory, fetchHoldingsPage };
export function isRemotePortfolioMode() { return _remoteMode; }
export function getRemoteTotalHistory() { return _remoteTotalHistory; }
/**
 * fn(change) after the VPS history changed: `change` is { from, points }
 * (everything at or after `from` was replaced by `points`, see
 * history-change.js), or undefined when the whole history was replaced.
 */
export function onRemoteTotalHistoryUpdate(fn) {
  _remoteHistoryHooks.add(fn);
  return () => _remoteHistoryHooks.delete(fn);
}
export function refreshRemoteHistory() {
  return _refreshRemoteHistory?.() ?? Promise.resolve();
}

function _historyReplaced(change) {
  for (const hook of _remoteHistoryHooks) {
    try { hook(change); } catch (error) { console.error('[registry] history listener failed:', error); }
  }
}

/** Engine: start again from `points` (a server disconnected or switched). Views are sent all of it. */
function _setRemoteTotalHistory(points) {
  _remoteTotalHistory = Array.isArray(points) ? points : [];
  _historyRevision++;
  _unpublishedChange = null;
  _historyReplaced();
  _engineChanged();
}

/**
 * Engine: the newest samples, replacing everything at or after `from`
 * (-Infinity: a reload of the whole history). Views are sent only what differs.
 */
function _mergeRemoteTotalHistory(from, points) {
  const change = diffHistoryTail(_remoteTotalHistory, from, Array.isArray(points) ? points : []);
  if (!change) return;
  _remoteTotalHistory = applyHistoryChange(_remoteTotalHistory, change);
  if (_historyRevision === _publishedRevision) _unpublishedChange = change;
  else if (_unpublishedChange) _unpublishedChange = composeHistoryChanges(_unpublishedChange, change);
  // (else a full replacement is still unpublished, and views get all of it anyway)
  _historyRevision++;
  _historyReplaced(change);
  _engineChanged();
}

// ── Engine and views (src/host/mirror.js) ────────────────────────────────────
// The engine frame reads the VPS; every other Finance frame applies what it
// publishes, so the rest of this module works the same everywhere.

const _statuses = new Map(); // source id -> 'ok' | 'partial' | 'error'
// The VPS history's revision, counted from 0 in each engine session (the epoch).
const _historyEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let _historyRevision = 0;
let _publishedRevision = 0;
// What changed since _publishedRevision ({ from, points }), or null when
// the whole history has to be sent (it was reloaded).
let _unpublishedChange = null;
const _engineListeners = new Set();
/** Engine: fn() after anything views mirror changed. */
export function onEngineChange(fn) {
  _engineListeners.add(fn);
  return () => _engineListeners.delete(fn);
}
function _engineChanged() {
  if (!isEngine()) return;
  for (const fn of _engineListeners) { try { fn(); } catch (error) { console.error('[registry] engine listener failed:', error); } }
}

/**
 * Engine: everything a view needs. Of the VPS history: nothing when
 * `sinceRevision` is current, what changed when it is the last published
 * revision, and otherwise all of it (a frame that has just opened).
 */
export function exportEngineState(sinceRevision = -1) {
  let history = {};
  if (sinceRevision === _historyRevision) { /* the view has it all */ }
  else if (sinceRevision === _publishedRevision && _unpublishedChange) history = { historyChange: { base: sinceRevision, ..._unpublishedChange } };
  else history = { remoteTotalHistory: _remoteTotalHistory };
  return {
    remoteMode: _remoteMode,
    connection: _connection,
    exchanges: exchanges.map(ex => ({ ...ex })),
    portfolios: [..._portfolios],
    statuses: [..._statuses],
    historyEpoch: _historyEpoch,
    historyRevision: _historyRevision,
    ...history,
  };
}

/** Engine: every view has been sent the history up to `revision`; collect changes from there. */
export function markHistoryPublished(revision) {
  if (revision !== _historyRevision) return;
  _publishedRevision = revision;
  _unpublishedChange = null;
}

let _appliedHistoryEpoch = null;
let _appliedHistoryRevision = -1;
/**
 * View: take the engine's state, then redraw as if it had been fetched
 * here. Returns false when this frame's history is behind and can't be
 * brought up to date from `snapshot` (a change it missed): ask the engine
 * for a full snapshot then.
 */
export function applyEngineState(snapshot) {
  if (!snapshot) return true;
  _remoteMode = !!snapshot.remoteMode;
  _connection = snapshot.connection || { configured: _remoteMode };
  exchanges.length = 0;
  for (const ex of snapshot.exchanges || []) exchanges.push(ex);
  _portfolios.clear();
  for (const [id, data] of snapshot.portfolios || []) _portfolios.set(id, data);
  const sameEpoch = snapshot.historyEpoch === _appliedHistoryEpoch;
  if (Array.isArray(snapshot.remoteTotalHistory)) {
    // A snapshot can arrive after a newer change: keep the newer.
    if (!sameEpoch || snapshot.historyRevision > _appliedHistoryRevision) {
      _appliedHistoryEpoch = snapshot.historyEpoch;
      _appliedHistoryRevision = snapshot.historyRevision;
      _remoteTotalHistory = snapshot.remoteTotalHistory;
      _historyReplaced();
    }
  } else if (snapshot.historyChange && sameEpoch && snapshot.historyChange.base === _appliedHistoryRevision) {
    const { from, points } = snapshot.historyChange;
    const change = { from, points };
    _appliedHistoryRevision = snapshot.historyRevision;
    _remoteTotalHistory = applyHistoryChange(_remoteTotalHistory, change);
    _historyReplaced(change);
  }
  for (const [id, status] of snapshot.statuses || []) setExchangeStatus(id, status);
  renderExchangeList();
  notifyPortfolioUpdate();
  return snapshot.historyEpoch === _appliedHistoryEpoch && _appliedHistoryRevision >= snapshot.historyRevision;
}

// ── Portfolio value history (for candlestick/time-series charting) ────────────
//
// Kept separate from _portfolios: _portfolios is the live state, while this
// map is the durable source history. A frame records every live connector at
// one shared timestamp, so totals can be reconstructed later without the
// partial-startup dips caused by independently arriving connector updates.

const _history = new Map(); // id -> [{ ts, active, value, currency, snapshot }], oldest first

const HISTORY_CHUNK_SIZE = 1024;
let _historySaveTimer = null;
let _historyDirtyFrom = new Map();
let _historyManifest = { version: 2, chunkSize: HISTORY_CHUNK_SIZE, connections: {} };
let _historyFlushPromise = Promise.resolve();

async function _loadPortfolioHistories() {
  const manifest = await loadConnectionHistoryManifest();
  if (manifest?.version === 2 && manifest.connections && typeof manifest.connections === 'object') {
    _historyManifest = manifest;
    await Promise.all(Object.entries(manifest.connections).map(async ([id, meta]) => {
      const length = Math.max(0, Number(meta?.length) || 0);
      const chunkCount = Math.ceil(length / HISTORY_CHUNK_SIZE);
      const chunks = await Promise.all(Array.from(
        { length: chunkCount }, (_, chunkIndex) => loadConnectionHistoryChunk(id, chunkIndex),
      ));
      _history.set(id, chunks.flat().slice(0, length)
        .filter(point => Number.isFinite(point?.ts))
        .slice(-MAX_HISTORY_POINTS));
    }));
    return;
  }
  const saved = await loadConnectionHistory();
  const connections = saved?.version === 1 && saved.connections && typeof saved.connections === 'object'
    ? saved.connections
    : {};
  for (const [id, points] of Object.entries(connections)) {
    if (!Array.isArray(points)) continue;
    _history.set(id, points
      .filter(point => Number.isFinite(point?.ts))
      .slice(-MAX_HISTORY_POINTS));
    _historyDirtyFrom.set(id, 0);
  }
  if (_historyDirtyFrom.size) _schedulePortfolioHistorySave();
}

function _markPortfolioHistoryDirty(id, index) {
  const current = _historyDirtyFrom.get(id);
  _historyDirtyFrom.set(id, current == null ? index : Math.min(current, index));
}

async function _flushPortfolioHistoriesNow() {
  if (!_historyDirtyFrom.size) return;
  const dirty = _historyDirtyFrom;
  _historyDirtyFrom = new Map();
  const nextManifest = structuredClone(_historyManifest);
  try {
    for (const [id, firstDirty] of dirty) {
      const points = (_history.get(id) ?? []).slice(-MAX_HISTORY_POINTS);
      const firstChunk = Math.floor(firstDirty / HISTORY_CHUNK_SIZE);
      const chunkCount = Math.ceil(points.length / HISTORY_CHUNK_SIZE);
      await Promise.all(Array.from({ length: Math.max(0, chunkCount - firstChunk) }, (_, offset) => {
        const chunkIndex = firstChunk + offset;
        const start = chunkIndex * HISTORY_CHUNK_SIZE;
        return saveConnectionHistoryChunk(id, chunkIndex, points.slice(start, start + HISTORY_CHUNK_SIZE));
      }));
      nextManifest.connections[id] = { length: points.length };
    }
    await saveConnectionHistoryManifest(nextManifest);
    _historyManifest = nextManifest;
  } catch (error) {
    for (const [id, index] of dirty) _markPortfolioHistoryDirty(id, index);
    console.error('[registry] unable to save portfolio history:', error);
  }
}

function _flushPortfolioHistories() {
  _historyFlushPromise = _historyFlushPromise.then(
    _flushPortfolioHistoriesNow,
    _flushPortfolioHistoriesNow,
  );
  return _historyFlushPromise;
}

function _schedulePortfolioHistorySave() {
  if (_historySaveTimer) return;
  _historySaveTimer = setTimeout(() => {
    _historySaveTimer = null;
    _flushPortfolioHistories();
  }, 60_000);
}

// Every mounted Finance surface may react to one mirrored portfolio update.
// A Set keeps the chart, allocation widget and future views independent.
const _portfolioUpdateHooks = new Set();
export function onPortfolioUpdate(fn) {
  _portfolioUpdateHooks.add(fn);
  return () => _portfolioUpdateHooks.delete(fn);
}

let _notifying        = false; // reentrancy guard — unchanged: stops the hook
                                // (e.g. total-chart.js's _sample -> _render)
                                // indirectly triggering setPortfolioData again
                                // and recursing.
let _notifyScheduled  = false; // true while a coalesced notify is queued for
                                // the next animation frame.

// Exported (renamed from the old private _notifyTicker) so totals.js can
// trigger the same redraw hook after a rate fetch or output-currency change.
//
// Coalesced to at most one hook call per animation frame. Previously this
// ran the hook synchronously on every single call — fine for one exchange
// updating occasionally, but with several connections (or a plugin that
// updates a few fields in quick succession) their polling can land close
// together, firing several full chart re-renders back-to-back in the same
// tick. Nothing downstream can be seen faster than the screen repaints
// anyway, so batching every call within a frame into a single notify (using
// the fully-settled _portfolios state by the time that frame's callback
// runs, since the Map writes in setPortfolioData() are still synchronous —
// only the notify is deferred) drops redundant renders without losing or
// delaying any real update by more than a frame.
export function notifyPortfolioUpdate() {
  _engineChanged();
  if (_notifying) return;
  if (_notifyScheduled) return;
  _notifyScheduled = true;
  requestAnimationFrame(() => {
    _notifyScheduled = false;
    _notifying = true;
    try {
      for (const hook of [..._portfolioUpdateHooks]) {
        try { hook(); } catch (error) { console.error('[registry] portfolio update listener failed:', error); }
      }
    }
    finally { _notifying = false; }
  });
}

// ── Sources ───────────────────────────────────────────────────────────────────
// One entry per source the VPS reports: { id, name }. Kept in the order the
// VPS first reported them.

function _trackSource(id, label) {
  const existing = exchanges.find(e => e.id === id);
  if (existing) { if (label) existing.name = String(label); return; }
  exchanges.push({ id, name: String(label || id) });
}

function _forgetSource(id) {
  const index = exchanges.findIndex(e => e.id === id);
  if (index !== -1) exchanges.splice(index, 1);
  _statuses.delete(id);
}

/** The sources the VPS reports, as [{ id, name }]. */
export function getExchanges() { return exchanges; }

// ── Portfolio data store ──────────────────────────────────────────────────────

export function setPortfolioData(id, data) {
  if (data == null) {
    _portfolios.set(id, null);
  } else {
    const observedValue = Number(data.value);
    if (!Number.isFinite(observedValue)) {
      console.warn('[registry] connector published an invalid portfolio value:', id);
      return;
    }
    const previous = _portfolios.get(id);
    const errorCount = Math.max(0, Number(data.errorCount) || 0);
    const stale = !!data.stale || errorCount > 0;
    const canReusePrevious = stale
      && previous?.lastUpdate !== null
      && Number.isFinite(Number(previous?.value));
    const suppliedUpdate = data.lastUpdate == null ? null : Number(data.lastUpdate);
    _portfolios.set(id, {
      ...data,
      label: String(data.label || id).slice(0, 12),
      value: canReusePrevious ? Number(previous.value) : observedValue,
      ...(canReusePrevious ? { observedValue } : {}),
      currency: data.currency ?? '$',
      lastUpdate: suppliedUpdate == null
        ? null
        : (Number.isFinite(suppliedUpdate) ? suppliedUpdate : Date.now()),
      errorCount,
      stale,
    });
  }
  notifyPortfolioUpdate();
}

export function getAllPortfolios() {
  return _portfolios;
}

// ── Portfolio value history ────────────────────────────────────────────────

function _clonePortfolioSnapshot(data) {
  try {
    return structuredClone(data);
  } catch {
    // The published contract is expected to be data-only. If a third-party
    // connector includes a non-cloneable field, retain the universal fields
    // rather than letting its history failure interrupt live totals.
    return {
      label: data.label ?? null,
      value: data.value,
      currency: data.currency ?? '$',
      lastUpdate: data.lastUpdate ?? null,
      errorCount: Math.max(0, Number(data.errorCount) || 0),
    };
  }
}

/**
 * Record one synchronized time-series frame for every connector. This is
 * called by the chart sampler only after its startup-settling buffer, keeping
 * persistence generic and centralized without requiring connector changes.
 */
export function recordPortfolioHistoryFrame(ts = Date.now(), { settled = true } = {}) {
  if (_remoteMode) return;
  const liveIds = new Set();
  for (const [id, data] of _portfolios) {
    if (!data || data.lastUpdate === null || !Number.isFinite(Number(data.value))) continue;
    liveIds.add(id);
    const arr = _history.get(id) ?? [];
    const point = {
      ts,
      active: true,
      settled,
      value: Number(data.value),
      currency: data.currency ?? '$',
      // Retain the complete connector publication for future asset/ticker
      // views. Current connectors need no changes; richer future connectors
      // can add fields without another storage migration.
      snapshot: _clonePortfolioSnapshot(data),
    };
    let dirtyIndex;
    if (arr.length && ts - arr[arr.length - 1].ts < 1_000) {
      dirtyIndex = arr.length - 1;
      arr[dirtyIndex] = point;
    } else {
      dirtyIndex = arr.length;
      arr.push(point);
    }
    const shifted = arr.length > MAX_HISTORY_POINTS;
    if (shifted) arr.shift();
    _history.set(id, arr);
    _markPortfolioHistoryDirty(id, shifted ? 0 : dirtyIndex);
  }

  // A connector that was present in an earlier frame but is no longer live
  // gets an explicit tombstone, allowing reconstruction to drop it exactly
  // when it was disconnected rather than carrying its last value forever.
  for (const [id, arr] of _history) {
    if (liveIds.has(id) || arr[arr.length - 1]?.active === false) continue;
    arr.push({ ts, active: false, settled, value: 0, currency: '$', snapshot: null });
    const shifted = arr.length > MAX_HISTORY_POINTS;
    if (shifted) arr.shift();
    _markPortfolioHistoryDirty(id, shifted ? 0 : arr.length - 1);
  }
  _schedulePortfolioHistorySave();
}

// Read-only-by-convention view used to reconstruct the aggregate chart.
export function getAllPortfolioHistories() {
  return _history;
}

// ── Source status ─────────────────────────────────────────────────────────────

export function setExchangeStatus(id, status) {
  if (_statuses.get(id) !== status) { _statuses.set(id, status); _engineChanged(); }
  const current = _portfolios.get(id);
  if (current?.lastUpdate !== null) {
    if (status === 'error' || status === 'partial') {
      _portfolios.set(id, {
        ...current,
        stale: true,
        errorCount: Math.max(1, Number(current.errorCount) || 0),
        lastAttempt: Date.now(),
      });
      notifyPortfolioUpdate();
    } else if (status === 'ok' && (current.stale || current.errorCount)) {
      _portfolios.set(id, { ...current, stale: false, errorCount: 0, lastAttempt: Date.now() });
      notifyPortfolioUpdate();
    }
  }
}

/** 'ok', 'partial', 'error', or undefined before the first poll. */
export function getSourceStatus(id) { return _statuses.get(id); }

/** { configured, address?, protected? }: the portfolio server Finance reads (never the token). */
export function getServerConnection() { return _connection; }

// ── UI ────────────────────────────────────────────────────────────────────────

/** Redraw the Portfolio Connections widget, if this frame shows it (./connections-list.js). */
export function renderExchangeList(context) {
  renderConnections(context);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initExchanges(context) {
  await initCurrencyService();
  await _loadPortfolioHistories();
  if (!isEngine()) {
    // A view: the engine frame reads the VPS and rates; src/host/mirror.js
    // applies what it publishes (applyEngineState).
    renderExchangeList(context);
    return;
  }
  if (context) {
    context.listen(window, 'beforeunload', _flushPortfolioHistories);
    context.onCleanup(() => {
      if (_historySaveTimer) clearTimeout(_historySaveTimer);
      _historySaveTimer = null;
      _flushPortfolioHistories();
    });
  }
  startRatesPolling();
  _engineContext = context;
  await _connect();
  renderExchangeList(context);
}

let _connectSerial = 0;

/** Engine: read the saved connection and, if there is one, start reading that server. */
async function _connect() {
  // A reconnect while this one is still starting supersedes it: what it
  // reads then is the server paired before, and it stops (R13).
  const serial = ++_connectSerial;
  const current = () => serial === _connectSerial;
  let connection;
  try {
    connection = await getConnection();
  } catch (error) {
    connection = { configured: false };
    console.warn('[registry] unable to check the portfolio server:', error.message);
  }
  if (!current()) return;
  _connection = connection;
  _remoteMode = !!_connection.configured;
  if (!_remoteMode) return;
  const remote = await startVpsPortfolio(_engineContext, {
    publish: (id, data) => { if (!current()) return; _trackSource(id, data?.label); setPortfolioData(id, data); },
    remove: id => { if (!current()) return; _forgetSource(id); setPortfolioData(id, null); },
    setStatus: (id, status) => { if (current()) setExchangeStatus(id, status); },
    setHistory: points => { if (current()) _mergeRemoteTotalHistory(-Infinity, points); },
    mergeHistory: (from, points) => { if (current()) _mergeRemoteTotalHistory(from, points); },
  });
  if (!current()) { remote.stop(); return; }
  _remote = remote;
  _refreshRemoteHistory = remote.refreshHistory;
  for (const [id, data] of _portfolios) {
    if (!data) continue;
    setExchangeStatus(id, data.errorCount > 0 ? 'partial' : 'ok');
  }
}

/**
 * Engine: the user connected, switched or disconnected a server (main.cjs
 * has already saved or cleared it). Stop reading the old one, forget its
 * sources and history, and start again from what is saved now.
 */
export async function reconnectPortfolio() {
  if (!isEngine()) return false;
  _remote?.stop();
  _remote = null;
  _refreshRemoteHistory = null;
  for (const { id } of [...exchanges]) { _forgetSource(id); setPortfolioData(id, null); }
  _portfolios.clear();
  notifyPortfolioUpdate();
  _remoteMode = false;
  _setRemoteTotalHistory([]);
  await _connect();
  renderExchangeList();
  _engineChanged();
  return _remoteMode;
}

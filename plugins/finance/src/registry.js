/**
 * plugins/finance/src/registry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance's portfolio store. The portfolio is collected by the user's VPS
 * (plugins/finance/backend) and read here through remote.js; the desktop no
 * longer runs connection plugins of its own. This file keeps the list of
 * sources the VPS reports, their latest data and status, the saved
 * per-source history the charts combine with the VPS's, and the
 * Portfolio Connections widget's list.
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
import { portfolioState } from '../persist.js';
import { save } from './host/persist.js';
import { getConnection, startVpsPortfolio, fetchHoldingsHistory } from './remote.js';
import { mountConnectionForm, mountConnectionFooter } from './connection-form.js';
import { isEngine } from './host/frame.js';

let _connectionsContext = null;

// Markets is part of Finance; share its module instance and watchlist state.
let _watchlistModPromise = null;
function _loadWatchlist() {
  return _watchlistModPromise ??= import('../markets/watchlist.js');
}
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
export { fetchHoldingsHistory };
export function isRemotePortfolioMode() { return _remoteMode; }
export function getRemoteTotalHistory() { return _remoteTotalHistory; }
export function onRemoteTotalHistoryUpdate(fn) {
  _remoteHistoryHooks.add(fn);
  return () => _remoteHistoryHooks.delete(fn);
}
export function refreshRemoteHistory() {
  return _refreshRemoteHistory?.() ?? Promise.resolve();
}

function _setRemoteTotalHistory(points) {
  _remoteTotalHistory = Array.isArray(points) ? points : [];
  _historyRevision++;
  for (const hook of _remoteHistoryHooks) hook();
  _engineChanged();
}

// ── Engine and views (src/host/mirror.js) ────────────────────────────────────
// The engine frame reads the VPS; every other Finance frame applies what it
// publishes, so the rest of this module works the same everywhere.

const _statuses = new Map(); // source id -> 'ok' | 'partial' | 'error'
let _historyRevision = 0;
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

/** Engine: everything a view needs. The VPS history only when `sinceRevision` is behind. */
export function exportEngineState(sinceRevision = -1) {
  return {
    remoteMode: _remoteMode,
    connection: _connection,
    exchanges: exchanges.map(ex => ({ ...ex })),
    portfolios: [..._portfolios],
    statuses: [..._statuses],
    historyRevision: _historyRevision,
    ...(sinceRevision === _historyRevision ? {} : { remoteTotalHistory: _remoteTotalHistory }),
  };
}

let _appliedHistoryRevision = -1;
/** View: take the engine's state, then redraw as if it had been fetched here. */
export function applyEngineState(snapshot) {
  if (!snapshot) return;
  _remoteMode = !!snapshot.remoteMode;
  _connection = snapshot.connection || { configured: _remoteMode };
  exchanges.length = 0;
  for (const ex of snapshot.exchanges || []) exchanges.push(ex);
  _portfolios.clear();
  for (const [id, data] of snapshot.portfolios || []) _portfolios.set(id, data);
  if (Array.isArray(snapshot.remoteTotalHistory)) {
    _appliedHistoryRevision = snapshot.historyRevision;
    _remoteTotalHistory = snapshot.remoteTotalHistory;
    for (const hook of _remoteHistoryHooks) hook();
  }
  renderExchangeList();
  for (const [id, status] of snapshot.statuses || []) setExchangeStatus(id, status);
  notifyPortfolioUpdate();
}
/** View: the VPS history revision this frame has, so the engine can skip resending it. */
export function appliedHistoryRevision() { return _appliedHistoryRevision; }

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

// ── Ticker-enabled persistence ────────────────────────────────────────────────

function _loadEnabledMap() {
  return portfolioState.tickerEnabled;
}

function _saveEnabledMap(map) {
  portfolioState.tickerEnabled = { ...map };
  save();
}

export function isTickerEnabled(id) {
  return _loadEnabledMap()[id] !== false;
}

export function setTickerEnabled(id, enabled) {
  _setTickerEnabled(id, enabled);
}

function _setTickerEnabled(id, enabled) {
  const map = _loadEnabledMap();
  map[id] = enabled;
  _saveEnabledMap(map);
}

// ── Styles ────────────────────────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('exchange-registry-styles')) return;
  const style = document.createElement('style');
  style.id = 'exchange-registry-styles';
  style.textContent = `
    .exch-sub-acc {
      display:flex; align-items:center; gap:9px;
      padding:7px 12px; cursor:pointer; border-radius:6px;
      transition:background .08s; user-select:none;
    }
    .exch-sub-acc:hover   { background:rgba(var(--ink-rgb),.07); }
    .exch-sub-acc.is-open { background:rgba(var(--ink-rgb),.04); }
    .exch-sub-name {
      flex:1; font-size:.7rem;
      color:rgba(var(--ink-rgb),.75); letter-spacing:.04em;
    }
    .exch-sub-chevron {
      font-size:.55rem; opacity:.4; transition:transform .25s ease;
    }
    .exch-sub-acc.is-open .exch-sub-chevron { transform:rotate(180deg); }
    .exch-sub-body {
      overflow:hidden; max-height:0; opacity:0;
      transition:max-height .38s cubic-bezier(.22,1,.36,1), opacity .22s ease;
      pointer-events:none;
    }
    .exch-sub-body.open { max-height:700px; opacity:1; pointer-events:all; }
    .exch-sub-wrap + .exch-sub-wrap { border-top:1px solid rgba(var(--ink-rgb),.05); }
    .exch-status-badge {
      display:flex; align-items:center; justify-content:center;
      width:14px; flex-shrink:0;
    }
    .exch-ticker-toggle {
      display:flex; align-items:center; justify-content:center;
      width:22px; height:22px; flex-shrink:0;
      background:none; border:none; padding:0;
      cursor:pointer; border-radius:4px;
      color:rgba(var(--ink-rgb),.22);
      transition:color .12s, background .12s;
    }
    .exch-ticker-toggle:hover   { background:rgba(var(--ink-rgb),.08); color:rgba(var(--ink-rgb),.7); }
    .exch-ticker-toggle.enabled { color:rgba(var(--ink-rgb),.65); }
    .exch-ticker-toggle.enabled:hover { color:rgb(var(--ink-rgb)); }
    .exch-vps-note {
      margin:0; padding:10px 12px 12px;
      color:rgba(var(--ink-rgb),.42); font-size:.64rem; line-height:1.45;
    }
  `;
  document.head.appendChild(style);
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

export function getPortfolioData(id) {
  return _portfolios.get(id) ?? null;
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

// Timestamped connector publications for one id, oldest first. Returns a
// shallow array copy; snapshot payloads are read-only by convention.
export function getPortfolioHistory(id) {
  return (_history.get(id) ?? []).slice();
}

// Read-only-by-convention view used to reconstruct the aggregate chart.
export function getAllPortfolioHistories() {
  return _history;
}

// ── Status badge ──────────────────────────────────────────────────────────────

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

  const mount  = document.getElementById('exchange-mount');
  const wrap   = mount?.querySelector(`.exch-sub-wrap[data-exchange-id="${id}"]`);
  const header = wrap?.querySelector('.exch-sub-acc');
  if (!header) return;

  let badge = header.querySelector('.exch-status-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'exch-status-badge';
    const before = header.querySelector('.exch-ticker-toggle') ?? header.querySelector('.exch-sub-chevron');
    header.insertBefore(badge, before);
  }

  if (status === 'ok') {
    badge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    badge.title = 'Connected';
  } else if (status === 'error') {
    badge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    badge.title = 'Connection failed';
  } else if (status === 'partial') {
    badge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="13"/><circle cx="12" cy="18" r="1" fill="#fbbf24" stroke="none"/></svg>`;
    badge.title = 'Partial data — using last confirmed values where needed';
  } else {
    badge.innerHTML = '';
    badge.title = '';
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────

export function renderExchangeList(context) {
  if (context) {
    _connectionsContext = context;
    context.onCleanup(() => {
      if (_connectionsContext === context) _connectionsContext = null;
    });
  }
  const mount = document.getElementById('exchange-mount');
  if (!mount) return;

  _injectStyles();
  mount.innerHTML = '';

  if (!_remoteMode) {
    mountConnectionForm(mount);
    return;
  }
  const visibleExchanges = exchanges.filter(ex => _portfolios.get(ex.id) != null);

  visibleExchanges.forEach(ex => {
    const wrap = document.createElement('div');
    wrap.className = 'exch-sub-wrap';
    wrap.dataset.exchangeId = ex.id;

    const enabled   = isTickerEnabled(ex.id);
    const tickerBtn = document.createElement('button');
    tickerBtn.className = 'exch-ticker-toggle' + (enabled ? ' enabled' : '');
    tickerBtn.title     = enabled ? 'Showing in ticker — click to hide' : 'Hidden from ticker — click to show';
    tickerBtn.innerHTML = _eyeIcon(enabled);

    tickerBtn.addEventListener('click', e => {
      e.stopPropagation();
      const next = !isTickerEnabled(ex.id);
      _setTickerEnabled(ex.id, next);
      tickerBtn.className = 'exch-ticker-toggle' + (next ? ' enabled' : '');
      tickerBtn.title     = next ? 'Showing in ticker — click to hide' : 'Hidden from ticker — click to show';
      tickerBtn.innerHTML = _eyeIcon(next);
      _loadWatchlist()
        .then(m => { m.renderTickerRows(); m.updateTickerActive(); })
        .catch(err => console.warn('[registry] watchlist unavailable — ticker UI not refreshed:', err.message));
    });

    const header = document.createElement('div');
    header.className = 'exch-sub-acc';
    header.innerHTML = `<span class="exch-sub-name">${ex.name ?? ex.id}</span>`;
    header.appendChild(tickerBtn);
    header.insertAdjacentHTML('beforeend', `<span class="exch-sub-chevron">▼</span>`);

    const body = document.createElement('div');
    body.className = 'exch-sub-body';

    // Append to live DOM BEFORE render() so getElementById works inside plugins
    wrap.appendChild(header);
    wrap.appendChild(body);
    mount.appendChild(wrap);

    const data = _portfolios.get(ex.id);
    const note = document.createElement('p');
    note.className = 'exch-vps-note';
    note.textContent = data
      ? 'Collected privately by your portfolio server. Portfolio visibility is controlled from the Spot and Futures rows.'
      : 'No balance is currently reported by this source.';
    body.append(note);

    header.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = body.classList.contains('open');
      mount.querySelectorAll('.exch-sub-body.open').forEach(b  => b.classList.remove('open'));
      mount.querySelectorAll('.exch-sub-acc.is-open').forEach(h => h.classList.remove('is-open'));
      if (!isOpen) { body.classList.add('open'); header.classList.add('is-open'); }
    });
  });

  mountConnectionFooter(mount, _connection);
}

function _eyeIcon(visible) {
  return visible
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
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

/** Engine: read the saved connection and, if there is one, start reading that server. */
async function _connect() {
  try {
    _connection = await getConnection();
  } catch (error) {
    _connection = { configured: false };
    console.warn('[registry] unable to check the portfolio server:', error.message);
  }
  _remoteMode = !!_connection.configured;
  if (!_remoteMode) return;
  const remote = await startVpsPortfolio(_engineContext, {
    publish: (id, data) => { _trackSource(id, data?.label); setPortfolioData(id, data); },
    remove: id => { _forgetSource(id); setPortfolioData(id, null); },
    setStatus: setExchangeStatus,
    setHistory: _setRemoteTotalHistory,
  });
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

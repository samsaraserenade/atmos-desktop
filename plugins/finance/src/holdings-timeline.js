/**
 * js/plugins/portfolio-tracker/src/holdings-timeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * On-demand, cached lookup of "what was I holding at time T", backed by
 * registry.js's fetchHoldingsHistory() (→ the VPS's /v1/holdings-history).
 *
 * Deliberately NOT part of any polling loop. loadSnapshotNear() (below)
 * reads the one poll a caller needs (balance.js: what you held a day or a
 * week ago, or at a time hovered on the cash/invested pane) from a few
 * minutes of polls; loadHoldingsTimeline() reads a whole range, for a
 * caller that needs every poll in it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { fetchHoldingsHistory, fetchHoldingsPage, getServerConnection } from './registry.js';

let _cache = null;   // { from, to, sortedTs: number[], byTs: Map<number, Array<row>> }
let _pending = null; // { from, to, promise }

export function bucketByTimestamp(rows) {
  const byTs = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = Number(row?.ts_ms);
    if (!Number.isFinite(ts)) continue;
    const list = byTs.get(ts);
    if (list) list.push(row); else byTs.set(ts, [row]);
  }
  return { byTs, sortedTs: [...byTs.keys()].sort((a, b) => a - b) };
}

/**
 * Fetch (or reuse an in-flight/previous fetch for the same range) the
 * holdings-history rows covering [from, to] and index them by poll
 * timestamp. Returns the cache object nearestSnapshot() expects.
 *
 * @param {{from: number, to: number}} range
 */
export async function loadHoldingsTimeline({ from, to }) {
  if (_cache && _cache.from === from && _cache.to === to) return _cache;
  if (_pending && _pending.from === from && _pending.to === to) return _pending.promise;
  const promise = fetchHoldingsHistory({ from, to }).then(rows => {
    const { byTs, sortedTs } = bucketByTimestamp(rows);
    _cache = { from, to, byTs, sortedTs };
    return _cache;
  }).finally(() => { _pending = null; });
  _pending = { from, to, promise };
  return promise;
}

/**
 * The poll nearest to (at or before) `timestamp`, falling back to the
 * earliest cached poll when `timestamp` predates everything fetched.
 * Returns null only when the cache itself is empty.
 *
 * @param {{sortedTs: number[], byTs: Map<number, Array>}} cache
 * @param {number} timestamp
 */
export function nearestSnapshot(cache, timestamp) {
  if (!cache?.sortedTs?.length) return null;
  const { sortedTs, byTs } = cache;
  let lo = 0, hi = sortedTs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid] <= timestamp) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) found = 0; // before the earliest cached poll — show the earliest we have
  const ts = sortedTs[found];
  return { ts, holdings: byTs.get(ts) || [] };
}

// ── One snapshot, near a time ──────────────────────────────────────────────
// The server keeps every poll (a minute apart) for 30 days, the last of
// each hour to a year and the last of each day after (its retention). A
// snapshot is read from a few minutes of polls, a few hundred rows, and
// from wider windows only when there's none (thinned history, a gap):
// never a day of every poll (up to 50,000 rows, megabytes of JSON, on a
// server capped at a quarter of a CPU).
const MINUTE_MS = 60_000;
const SNAPSHOT_WINDOWS_MS = [5 * MINUTE_MS, 60 * MINUTE_MS, 6 * 60 * MINUTE_MS, 48 * 60 * MINUTE_MS];
const SNAPSHOT_CACHE_MAX = 120;
const _snapshots = new Map(); // key -> Promise<{ ts, holdings } | null>
let _snapshotsConnection = null; // the pairing (main.cjs's id) they came from

/** The windows to try for up to `span`, narrowest first (the last one `span` itself). */
export function snapshotWindows(span) {
  if (!(span > 0)) return [];
  const windows = SNAPSHOT_WINDOWS_MS.filter(window => window < span);
  return [...windows, span];
}

/** A fetch's answer as { points, polls, truncated, order } (a plain array: all of it, oldest first). */
function asPage(answer) {
  return Array.isArray(answer) ? { points: answer, polls: null, truncated: false, order: 'asc' } : answer;
}

/**
 * A page's rows by poll. A poll the server names (`polls`) with no rows held
 * nothing: an empty snapshot, not a gap to look past. A server from 0.9.1 or
 * before names none.
 */
function bucketPage(page) {
  const { byTs, sortedTs } = bucketByTimestamp(page.points);
  if (!Array.isArray(page.polls)) return { byTs, sortedTs };
  for (const value of page.polls) {
    const ts = Number(value);
    if (Number.isFinite(ts) && !byTs.has(ts)) byTs.set(ts, []);
  }
  return { byTs, sortedTs: [...byTs.keys()].sort((a, b) => a - b) };
}

/**
 * The holdings at the poll nearest `at`: the last one at or before it, no
 * more than `before` earlier; failing that, the first one after it, no more
 * than `after` later. null when there's none that close. Answers are kept
 * (a past poll doesn't change), so asking again costs nothing: for the
 * server paired now only. Another pairing drops them, and an answer for a
 * server no longer paired (or from one this frame hasn't heard of yet) is
 * neither kept nor given: null.
 *
 * Looking back, the newest polls are asked for first (order=desc): a window
 * holding more rows than the server sends would otherwise come back as its
 * oldest polls. A server that ignores that (0.9.1 or before) and cuts the
 * answer gives no snapshot, rather than an older or cut one.
 *
 * @param {number} at
 * @param {{before?: number, after?: number, fetch?: Function}} options
 */
export function loadSnapshotNear(at, { before = 48 * 60 * MINUTE_MS, after = 0, fetch = fetchHoldingsPage } = {}) {
  const connection = getServerConnection()?.id ?? null;
  if (connection !== _snapshotsConnection) {
    _snapshots.clear();
    _snapshotsConnection = connection;
  }
  const key = `${at}|${before}|${after}`;
  if (_snapshots.has(key)) return _snapshots.get(key);
  // Each answer: still for the server this lookup is for?
  const ask = async range => {
    const page = asPage(await fetch(range));
    const answered = page.connection ?? connection;
    if (answered === connection && (getServerConnection()?.id ?? null) === connection) return page;
    if (_snapshots.get(key) === promise) _snapshots.delete(key);
    return null;
  };
  const promise = (async () => {
    for (const window of snapshotWindows(before)) {
      const page = await ask({ from: at - window, to: at, order: 'desc' });
      if (!page || (page.truncated && page.order !== 'desc')) return null;
      const { byTs, sortedTs } = bucketPage(page);
      if (sortedTs.length) { const ts = sortedTs.at(-1); return { ts, holdings: byTs.get(ts) }; }
    }
    for (const window of snapshotWindows(after)) {
      const page = await ask({ from: at, to: at + window });
      if (!page) return null;
      const { byTs, sortedTs } = bucketPage(page);
      if (sortedTs.length) { const ts = sortedTs[0]; return { ts, holdings: byTs.get(ts) }; }
    }
    return null;
  })();
  _snapshots.set(key, promise);
  // A failed read is asked again next time; the oldest answers make room.
  promise.catch(() => _snapshots.delete(key));
  while (_snapshots.size > SNAPSHOT_CACHE_MAX) _snapshots.delete(_snapshots.keys().next().value);
  return promise;
}

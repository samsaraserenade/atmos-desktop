/**
 * js/plugins/portfolio-tracker/src/holdings-timeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * On-demand, cached lookup of "what was I holding at time T", backed by
 * registry.js's fetchHoldingsHistory() (→ the VPS's /v1/holdings-history).
 *
 * Deliberately NOT part of any polling loop: a caller (balance.js's ratio-
 * history hover, currently the only one) asks once for a time range the
 * first time it actually needs historical detail, and every subsequent
 * lookup within that range is a local Map lookup — no network round-trip
 * per hover frame.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { fetchHoldingsHistory } from './registry.js';

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

/** Drop the cached range — e.g. if a caller wants to force a fresh fetch. */
export function resetHoldingsTimeline() {
  _cache = null;
  _pending = null;
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

import { atmos, SELF, invokeFinance as invoke } from './host/frame.js';
import { excludedGroupKeys, excludedHoldingKeys, excludedSourceIds } from './portfolio-scope.js';

const HISTORY_TIERS = [
  { resolution: '1d', from: 0, until: 365 * 24 * 60 * 60_000 },
  { resolution: '1h', until: 30 * 24 * 60 * 60_000 },
  { resolution: '5m', until: 2 * 24 * 60 * 60_000 },
  { resolution: 'raw', until: 0 },
];

async function fetchJson(route) {
  const result = await invoke('vps:fetch', route);
  if (!result?.ok) throw new Error(result?.status ? `VPS HTTP ${result.status}` : 'VPS unavailable');
  try { return JSON.parse(result.body); }
  catch { throw new Error('VPS returned invalid data'); }
}

/** { configured, address?, protected? } from main.cjs. The token never leaves the main process. */
export async function getConnection() {
  return (await invoke('vps:status')) || { configured: false };
}

export async function isVpsConfigured() {
  return !!(await getConnection()).configured;
}

/** request: { code } (a pairing code) or { baseUrl, token }. */
export const testServer = request => invoke('vps:test', request);
export const connectServer = request => invoke('vps:connect', request);
export const disconnectServer = () => invoke('vps:disconnect');
/** Ask the engine frame to re-read the saved connection and restart. */
export const requestEngineReconnect = () => atmos.call(SELF, 'reconnect');

async function loadHistory(exclusions = excludedHoldingKeys(), excludedSources = excludedSourceIds(), excludedGroups = excludedGroupKeys()) {
  const now = Date.now();
  const boundaries = [
    0,
    now - HISTORY_TIERS[0].until,
    now - HISTORY_TIERS[1].until,
    now - HISTORY_TIERS[2].until,
    now,
  ];
  const batches = await Promise.all(HISTORY_TIERS.map((tier, index) => {
    const from = Math.max(0, boundaries[index]);
    const to = Math.max(from, boundaries[index + 1] - (index < HISTORY_TIERS.length - 1 ? 1 : 0));
    const params = new URLSearchParams({ from: String(from), to: String(to), resolution: tier.resolution });
    for (const key of exclusions) params.append('exclude', key);
    for (const sourceId of excludedSources) params.append('excludeSource', sourceId);
    for (const key of excludedGroups) params.append('excludeGroup', key);
    return fetchJson(`/v1/history?${params}`);
  }));
  const byTime = new Map();
  for (const batch of batches) {
    for (const point of batch.points || []) {
      const timestamp = Number(point.t);
      const value = Number(point.v);
      if (Number.isFinite(timestamp) && Number.isFinite(value)) {
        byTime.set(timestamp, {
          t: timestamp,
          value,
          spot: point.spot != null && Number.isFinite(Number(point.spot)) ? Number(point.spot) : null,
          perp: point.perp != null && Number.isFinite(Number(point.perp)) ? Number(point.perp) : null,
          currency: point.currency || 'USD',
          errorCount: Math.max(0, Number(point.errorCount) || 0),
          // Present on every point once the VPS backend tracks cash/invested
          // history (added alongside per-symbol quantity/price tracking).
          // Older backend versions simply won't send these, and callers that
          // don't know about them keep working unchanged.
          invested: Number.isFinite(Number(point.invested)) ? Number(point.invested) : null,
          cash: Number.isFinite(Number(point.cash)) ? Number(point.cash) : null,
          investedRatio: Number.isFinite(Number(point.investedRatio)) ? Number(point.investedRatio) : null,
          cashRatio: Number.isFinite(Number(point.cashRatio)) ? Number(point.cashRatio) : null,
        });
      }
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Point-in-time holdings: quantity, price and value per symbol per source,
 * across a time range. Backed by the VPS's /v1/holdings-history, which
 * retains every poll rather than only the latest snapshot. Call this on
 * demand (e.g. when a chart/table actually needs a historical breakdown) --
 * it is intentionally not part of the 60s refresh loops below, since most
 * of the time nothing is asking for history.
 *
 * @param {{from?: number, to?: number, source?: string, symbol?: string}} options
 * @returns {Promise<Array<{ts_ms: number, source_id: string, symbol: string, kind: string, quantity: number, price: number, value: number, currency: string}>>}
 */
export async function fetchHoldingsHistory({ from, to, source, symbol } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(from)) params.set('from', String(Math.trunc(from)));
  if (Number.isFinite(to)) params.set('to', String(Math.trunc(to)));
  if (source) params.set('source', String(source));
  if (symbol) params.set('symbol', String(symbol));
  const query = params.toString();
  const data = await fetchJson(`/v1/holdings-history${query ? `?${query}` : ''}`);
  return Array.isArray(data.points) ? data.points : [];
}

export async function startVpsPortfolio(context, { publish, remove, setStatus, setHistory }) {
  const remoteIds = new Set();
  let pending = null;
  let historyPending = null;
  let historyPendingScope = '';

  let stopped = false;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = fetchJson('/v1/portfolio').then(data => {
      if (stopped) return;
      const holdingsBySource = new Map();
      for (const holding of data.holdings || []) {
        const id = String(holding.source_id || '');
        if (!id) continue;
        const list = holdingsBySource.get(id) || [];
        list.push({
          id: holding.holding_id || `${holding.symbol}:${holding.kind}`,
          symbol: holding.symbol,
          value: Number(holding.value) || 0,
          kind: holding.kind === 'cash' ? 'cash' : 'invested',
          currency: holding.currency || 'USD',
          // Units held and the price used to value them, kept separate so a
          // later change can be attributed to a price move vs an actual
          // change in units (a deposit, withdrawal, or swap) -- not present
          // from older backend versions, in which case both stay null.
          quantity: Number.isFinite(Number(holding.quantity)) ? Number(holding.quantity) : null,
          price: Number.isFinite(Number(holding.price)) ? Number(holding.price) : null,
          // Opaque per-holding extras (funding rate, leverage, liquidation
          // price, ...) a specific collector attaches for its own UI to
          // read back -- this plugin's generic paths (composition, daily
          // attribution) never look at it, only src/totals.js's
          // getFuturesPositions() does. Absent from older backend versions
          // and from any holding that simply has nothing extra to report.
          meta: (holding.meta && typeof holding.meta === 'object') ? holding.meta : null,
        });
        holdingsBySource.set(id, list);
      }

      const nextIds = new Set();
      for (const source of data.sources || []) {
        const id = String(source.source_id || '');
        if (!id) continue;
        nextIds.add(id);
        const errors = Math.max(0, Number(source.error_count) || 0);
        publish(id, {
          label: source.label || id,
          value: Number(source.value) || 0,
          currency: source.currency || data.currency || 'USD',
          holdings: holdingsBySource.get(id) || [],
          spot: source.spot, perp: source.perp,
          lastUpdate: Number(source.updated_at_ms) || Number(data.timestamp) || Date.now(),
          errorCount: errors,
          stale: errors > 0,
        });
        setStatus(id, errors > 0 ? 'partial' : 'ok');
      }
      for (const id of remoteIds) if (!nextIds.has(id)) remove(id);
      remoteIds.clear();
      for (const id of nextIds) remoteIds.add(id);
    }).catch(error => {
      for (const id of remoteIds) setStatus(id, 'error');
      console.warn('[portfolio-vps] refresh failed:', error.message);
    }).finally(() => { pending = null; });
    return pending;
  };

  const refreshHistory = () => {
    const exclusions = excludedHoldingKeys();
    const excludedSources = excludedSourceIds();
    const excludedGroups = excludedGroupKeys();
    const scope = [...exclusions.map(key => `h:${key}`), ...excludedSources.map(id => `s:${id}`), ...excludedGroups.map(key => `g:${key}`)].sort().join('\n');
    if (historyPending) {
      if (historyPendingScope === scope) return historyPending;
      return historyPending.then(() => refreshHistory());
    }
    historyPendingScope = scope;
    historyPending = loadHistory(exclusions, excludedSources, excludedGroups)
      .then(points => { if (!stopped) setHistory(points); })
      .catch(error => console.warn('[portfolio-vps] history load failed:', error.message))
      .finally(() => { historyPending = null; historyPendingScope = ''; });
    return historyPending;
  };

  await Promise.allSettled([refreshHistory(), refresh()]);
  // History is cheap at this scale. Refresh it independently so a transient
  // launch failure cannot leave the desktop chart empty until the next app
  // restart, and so VPS samples continue to arrive in an open chart.
  const timers = [setInterval(refresh, 60_000), setInterval(refreshHistory, 60_000)];
  // stop(): the user disconnected or switched servers.
  const stop = () => { stopped = true; timers.forEach(clearInterval); };
  context?.onCleanup?.(stop);
  return { ids: remoteIds, refresh, refreshHistory, stop };
}

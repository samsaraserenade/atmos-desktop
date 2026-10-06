// Loaded into Electron's main process by finance.cjs
// (NODE_OPTIONS=--require): answers Finance's VPS requests with synthetic
// data and counts them, so the checks need no real VPS. Test data only.
'use strict';

const BASE = 'http://100.100.1.1:8080';
const now = Date.now();
const realFetch = globalThis.fetch;
globalThis.__vpsCalls = {};

const sources = [
  { source_id: 'exchange-a', label: 'Exchange A', value: 1500, currency: 'USD', spot: 1500, perp: 0, updated_at_ms: now, error_count: 0 },
  { source_id: 'wallet-b', label: 'Wallet B', value: 500, currency: 'USD', spot: 500, perp: 0, updated_at_ms: now, error_count: 0 },
];
const holdings = [
  { source_id: 'exchange-a', holding_id: 'btc-spot', symbol: 'BTC', value: 1000, kind: 'invested', currency: 'USD', quantity: 0.01, price: 100000 },
  { source_id: 'exchange-a', holding_id: 'usdt-spot', symbol: 'USDT', value: 500, kind: 'cash', currency: 'USD', quantity: 500, price: 1 },
  { source_id: 'wallet-b', holding_id: 'eth-spot', symbol: 'ETH', value: 500, kind: 'invested', currency: 'USD', quantity: 0.2, price: 2500 },
];
// What each holding was worth at each sample, so the history can leave
// holdings out as the server does (?exclude=source|holding): hiding one, or
// a coin's chart (the total less the total without it). ETH goes 400 → 494.
const worth = {
  'exchange-a|btc-spot': i => 900 + i * 2,
  'exchange-a|usdt-spot': () => 500,
  'wallet-b|eth-spot': i => 400 + i * 2,
};
// 48 half-hourly samples, or as many as a script sets first (globalThis.__fakeVpsPoints).
const POINTS = Number(globalThis.__fakeVpsPoints) || 48;
const history = Array.from({ length: POINTS }, (_, i) => ({
  t: now - (POINTS - 1 - i) * 30 * 60_000, v: 1800 + i * 4, spot: 1800 + i * 4, perp: 0, currency: 'USD', i,
}));

function respond(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.origin !== BASE) return realFetch(input, init);
  globalThis.__vpsCalls[url.pathname] = (globalThis.__vpsCalls[url.pathname] || 0) + 1;
  if (url.pathname === '/v1/info') return respond({ name: 'atmos-portfolio', version: 'test', apiVersion: 1, sources: sources.length, lastUpdate: now });
  if (url.pathname === '/v1/portfolio') return respond({ timestamp: now, currency: 'USD', sources, holdings });
  if (url.pathname === '/v1/history') {
    const from = Number(url.searchParams.get('from')) || 0;
    const to = Number(url.searchParams.get('to')) || Infinity;
    const excluded = url.searchParams.getAll('exclude').filter(key => worth[key]);
    return respond({ points: history.filter(point => point.t >= from && point.t <= to).map(({ i, ...point }) => {
      const less = excluded.reduce((sum, key) => sum + worth[key](i), 0);
      return { ...point, v: point.v - less, spot: point.spot - less };
    }) });
  }
  if (url.pathname === '/v1/holdings-history') return respond({ points: [] });
  return new Response('not found', { status: 404 });
};

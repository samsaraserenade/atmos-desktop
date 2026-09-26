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
  { source_id: 'exchange-a', symbol: 'BTC', value: 1000, kind: 'invested', currency: 'USD', quantity: 0.01, price: 100000 },
  { source_id: 'exchange-a', symbol: 'USDT', value: 500, kind: 'cash', currency: 'USD', quantity: 500, price: 1 },
  { source_id: 'wallet-b', symbol: 'ETH', value: 500, kind: 'invested', currency: 'USD', quantity: 0.2, price: 2500 },
];
const history = Array.from({ length: 48 }, (_, i) => ({
  t: now - (47 - i) * 30 * 60_000, v: 1800 + i * 4, spot: 1800 + i * 4, perp: 0, currency: 'USD',
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
    return respond({ points: history.filter(point => point.t >= from && point.t <= to) });
  }
  if (url.pathname === '/v1/holdings-history') return respond({ points: [] });
  return new Response('not found', { status: 404 });
};

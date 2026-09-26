/**
 * Finance's fetch. CoinGecko is reached through Finance's main process
 * ('network:fetch'), which caches responses and serves the last good one
 * during rate limiting, and isn't subject to the browser's CORS rules.
 * Everything else is an ordinary fetch().
 */
const RELAYED_HOSTS = new Set(['api.coingecko.com']);
import { invokeFinance as invoke } from './host/frame.js';

export async function financeFetch(input, init = {}) {
  const url = new URL(String(input), window.location.href);
  if (!RELAYED_HOSTS.has(url.hostname)) return fetch(input, init);
  const result = await invoke('network:fetch', { url: url.href, method: 'GET' });
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
}

/**
 * Whether the Market Data service is here this session.
 *
 * Market Data is an optional dependency of Finance: without it (not
 * installed, switched off, or failed to start) Finance hides its market
 * charts and the watchlist's "open chart" instead of showing them offline.
 * Extensions change only at a restart, so this is decided once per frame,
 * before any view mounts (frame-panel.js, widget.js).
 */
import { atmos } from './frame.js';

let available = null;

export async function checkMarketData() {
  if (available === null) {
    available = await atmos.library('service:market-data', 'api.js').then(() => true, () => false);
    document.documentElement.classList.toggle('finance-no-market-data', !available);
  }
  return available;
}

/** After checkMarketData(); true until it has run (the in-page tests have no frames). */
export const hasMarketData = () => available !== false;

/**
 * services/currency/rates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Headless exchange-rate fetching/polling service. Owns nothing beyond "what
 * are today's rates" — no knowledge of portfolios, plugins, or the DOM, so
 * anything (portfolio tracking, trading bots, charts, tax tools) can depend
 * on it without pulling in unrelated code.
 *
 * Rates are fetched from moneyconvert every 5 minutes and rebased so they're
 * expressed as "units of X per 1 GBP" (converter.js builds on top of that).
 * Consumers that need to react to a refresh (e.g. to redraw) should use
 * onRatesUpdate() rather than polling ratesReady()/getRates() themselves.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RATES_POLL_MS = 5 * 60_000;
export const BASE_CURRENCY = 'GBP';

let _rates      = {};   // { USD: 1.27, EUR: 1.17, ... } — units per 1 GBP
let _ratesReady = false;
let _ratesTimer = null;

const _listeners = new Set();

export function getRates()   { return _rates; }
export function ratesReady() { return _ratesReady; }

// Fired whenever a rate refresh succeeds. Returns an unsubscribe function.
export function onRatesUpdate(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

async function _fetchRates() {
  try {
    const res  = await fetch('https://cdn.moneyconvert.net/api/latest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // API is USD-relative; rebase to GBP: rates[X] = units of X per 1 GBP
    const raw    = data.rates ?? {};
    const gbpUsd = raw['GBP'];
    if (!gbpUsd) throw new Error('GBP rate missing from response');
    const rebased = {};
    for (const [iso, ratePerUsd] of Object.entries(raw)) {
      rebased[iso] = ratePerUsd / gbpUsd;
    }
    _rates      = rebased;
    _ratesReady = true;
    for (const fn of _listeners) fn();
  } catch (err) {
    console.warn('[currency] rate fetch failed:', err.message);
  }
}

/**
 * For a consumer that gets rates from elsewhere (another of its frames that
 * polls, say) instead of fetching them itself: use these, as returned by
 * getRates() there. Listeners are told as after a fetch.
 */
export function useRates(rates) {
  if (!rates || typeof rates !== 'object') return;
  _rates = { ...rates };
  _ratesReady = true;
  for (const fn of _listeners) fn();
}

export function startRatesPolling() {
  _fetchRates();
  if (_ratesTimer) clearInterval(_ratesTimer);
  _ratesTimer = setInterval(_fetchRates, RATES_POLL_MS);
}

export function stopRatesPolling() {
  if (!_ratesTimer) return;
  clearInterval(_ratesTimer);
  _ratesTimer = null;
}

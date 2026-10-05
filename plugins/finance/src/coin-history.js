/**
 * A coin in your portfolio, as its own chart (the picker's Portfolio rows,
 * rev/portfolio sol): the value of what you hold of it over time, across
 * every source that holds it. The portfolio server keeps each holding's
 * value with every sample, and leaves holdings out of the total as hiding
 * them does, so a coin's history is the total less the total without it
 * (remote.js loadHoldingsValueHistory): no history of its own to keep.
 *
 * In the portfolio's scope, like the total: a holding you hid isn't
 * counted. Grouped holdings (a perp position and its collateral, say) are
 * counted only with their group, so a coin's chart leaves them out.
 *
 * Loaded when a chart shows the coin, and while one does, kept up with the
 * portfolio's history (the newest samples only, as the engine does).
 */
import { getSpotScopePositions, convertToGbp, convertFromGbp } from './totals.js';
import { holdingScopeGroup, holdingScopeKey, historyScopeKey } from './portfolio-scope.js';
import { isRemotePortfolioMode, onRemoteTotalHistoryUpdate } from './registry.js';
import { loadHoldingsValueHistory } from './remote.js';

// As the engine's refresh: re-read this much before the newest point, and
// all of it after six hours (older samples settle into coarser tiers).
const RECENT_OVERLAP_MS = 10 * 60_000;
const FULL_RELOAD_MS = 6 * 60 * 60_000;
// Charts showing a coin follow the portfolio's history, at most this often.
const FOLLOW_DELAY_MS = 2_000;

const coins = new Map();
let following = false;
let followTimer = null;

/** A coin's holdings that its chart counts: included, not grouped. */
function countedHoldings(position) {
  return (position?.holdings || []).filter(item => item.included && !holdingScopeGroup(item.connectionId, item.holding));
}

const positionOf = symbol => getSpotScopePositions().find(item => item.symbol === symbol);

/**
 * The scope keys ("source|holding") of a coin's counted holdings, sorted:
 * the ones held now (a holding sold off before isn't known here, so its
 * past isn't counted).
 */
export function coinHoldingKeys(symbol) {
  return countedHoldings(positionOf(symbol)).map(item => holdingScopeKey(item.connectionId, item.holding)).sort();
}

function valueOf(position) {
  let gbp = 0;
  for (const { holding } of countedHoldings(position)) gbp += convertToGbp(Math.max(0, Number(holding?.value) || 0), holding?.currency ?? '$');
  return convertFromGbp(gbp);
}

/**
 * The coins you hold that have a chart, largest first: [{ symbol, value }]
 * (value in the display currency, as the chart's last point). None without
 * a portfolio server, where the history comes from.
 */
export function portfolioCoins() {
  if (!isRemotePortfolioMode()) return [];
  return getSpotScopePositions()
    .map(position => ({ symbol: position.symbol, value: valueOf(position) }))
    .filter(coin => coin.value > 0)
    .sort((a, b) => b.value - a.value);
}

/** What a coin's counted holdings are worth now, in the display currency. */
export function coinValue(symbol) {
  return valueOf(positionOf(symbol));
}

function entry(symbol) {
  let item = coins.get(symbol);
  if (!item) {
    item = { symbol, users: new Set(), points: [], status: 'idle', basis: null, loadedAt: 0, pending: null, again: false };
    coins.set(symbol, item);
  }
  return item;
}

function notify(item) {
  for (const fn of [...item.users]) {
    try { fn(); } catch (error) { console.error('[finance] coin chart listener failed:', error); }
  }
}

/**
 * Load a coin's history: in full the first time, when what it counts
 * changed (a holding hidden, a source added) or after six hours; else only
 * the newest samples.
 */
function load(item) {
  if (item.pending) { item.again = true; return; }
  if (!isRemotePortfolioMode()) { item.points = []; item.basis = null; item.status = 'unavailable'; notify(item); return; }
  const keys = coinHoldingKeys(item.symbol);
  const basis = `${historyScopeKey()}\n#\n${keys.join('\n')}`;
  if (!keys.length) {
    item.points = []; item.basis = basis; item.status = 'none';
    notify(item);
    return;
  }
  const now = Date.now();
  const recent = item.basis === basis && item.points.length > 0 && now - item.loadedAt < FULL_RELOAD_MS;
  const from = recent ? Math.max(0, item.points.at(-1).t - RECENT_OVERLAP_MS) : null;
  // What's drawn stays until the new history arrives (hiding another
  // holding doesn't change this one's); with nothing drawn yet, it says so.
  if (!item.points.length && item.status !== 'loading') { item.status = 'loading'; notify(item); }
  item.pending = loadHoldingsValueHistory(keys, { from }).then(({ points, truncated }) => {
    if (from === null) {
      item.points = points;
      item.loadedAt = now;
    } else if (truncated) {
      item.loadedAt = 0; // the server held some back: all of it next time
      item.again = true;
    } else {
      const keep = item.points.filter(point => point.t < from);
      item.points = keep.concat(points);
    }
    item.basis = basis;
    item.status = 'ready';
  }).catch(error => {
    console.warn(`[finance] ${item.symbol}'s history could not be read:`, error?.message || error);
    if (!item.points.length) item.status = 'failed';
  }).finally(() => {
    item.pending = null;
    notify(item);
    if (item.again) { item.again = false; if (item.users.size) load(item); }
  });
}

function follow() {
  if (following) return;
  following = true;
  // The portfolio's history changed (a new sample, a holding hidden): the
  // coins being shown follow, together, a moment later. Replaced whole (a
  // server paired or switched, the scope changed): read whole again too.
  onRemoteTotalHistoryUpdate(change => {
    if (change === undefined) for (const item of coins.values()) item.loadedAt = 0;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      for (const item of coins.values()) if (item.users.size) load(item);
    }, FOLLOW_DELAY_MS);
  });
}

/**
 * A coin's history as last read: { points: [{ t, value, currency }],
 * status: 'idle' | 'loading' | 'ready' | 'none' (nothing counted) |
 * 'failed' | 'unavailable' (no portfolio server) }.
 */
export function coinHistory(symbol) {
  const item = coins.get(symbol);
  return item ? { points: item.points, status: item.status } : { points: [], status: 'idle' };
}

/**
 * Show a coin: `fn()` whenever its history arrives or changes. Loads it
 * (again, if it was read before) and keeps it up while anything shows it.
 * Returns the function that stops.
 */
export function useCoinHistory(symbol, fn) {
  follow();
  const item = entry(symbol);
  item.users.add(fn);
  // Another chart showing it already asked: this one hears the same answer.
  if (!item.pending) load(item);
  return () => { item.users.delete(fn); };
}

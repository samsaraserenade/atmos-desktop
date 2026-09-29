import { save } from '../../src/host/persist.js';
import { financeFetch } from '../../src/network.js';
import { atmos, isEngine, SELF } from '../../src/host/frame.js';
import { flushPendingSave } from '../../src/host/persist.js';
import { watchlistState } from '../persist.js';
import { getPortfolioComposition, getSpotScopePositions } from '../../src/totals.js';

// Building raw Spot scope rows re-walks every connection/holding and converts
// currencies. Cache one snapshot for the current synchronous render pass so
// heldSymbols()/accountShareFor()/holdingValueFor() all share the same result.
let _spotScopeCache = null;
let _compositionCache = null;
function spotScopeSnapshot() {
  if (!_spotScopeCache) {
    _spotScopeCache = getSpotScopePositions();
    queueMicrotask(() => { _spotScopeCache = null; });
  }
  return _spotScopeCache;
}
function compositionSnapshot() {
  if (!_compositionCache) {
    _compositionCache = getPortfolioComposition();
    queueMicrotask(() => { _compositionCache = null; });
  }
  return _compositionCache;
}

const listeners = new Set();
export const tickerData = Object.create(null);
const binanceFailCount = Object.create(null);
let pollTimer = null;
let _pollSaveTimer = null;
function pollSave(delayMs = 800) {
  if (_pollSaveTimer) return;
  _pollSaveTimer = setTimeout(() => { _pollSaveTimer = null; save(); }, delayMs);
}
const BINANCE_FAIL_THRESHOLD = 2;

// Where a symbol's price comes from is decided again each session, Binance
// first. Before 1.0.10 two Binance failures in a row (the network not up yet
// at login, say) moved a symbol to CoinGecko for good, and it never came
// back. Now a symbol moved off Binance by failures tries Binance again after
// BINANCE_RETRY_MS, and every CoinGecko choice is checked again at the start
// of a session (a cached CoinGecko id makes that free for coins Binance
// doesn't list).
const BINANCE_RETRY_MS = 10 * 60_000;
const binanceRetryAt = Object.create(null); // symbol -> when to try Binance again
let sourcesCheckedThisSession = false;

// CoinGecko's keyless API refuses callers that ask too often (a 403 from its
// CDN, or a 429), sometimes for hours. Ask at most once a minute, and after a
// refusal not again for ten minutes; the last prices stay meanwhile.
const COINGECKO_EVERY_MS = 60_000;
const COINGECKO_PAUSE_MS = 10 * 60_000;
let coinGeckoNextAt = 0;
const coinGeckoPaused = () => Date.now() < coinGeckoNextAt;
function pauseCoinGecko() { coinGeckoNextAt = Date.now() + COINGECKO_PAUSE_MS; }
// Symbols that failed Binance, CoinGecko, *and* DexScreener at least once
// this session. Without this, fetchTickers()'s 15s loop would retry (and
// re-fail, re-logging the same blocked/404 network error) forever for any
// held token that simply never made it onto a tracked source — pump.fun
// launches that rugged, delisted coins, etc. Clears on restart, same as
// binanceFailCount below — if a token does get listed later, reopening
// Atmos picks it up.
const unresolvedSymbols = new Set();

// Some connectors report a holding's symbol with a descriptive suffix —
// e.g. Solana staking reports "JUP (staked)" rather than plain "JUP" — so
// it reads better in a detail list, but that string is never a real,
// tradable ticker. Strip a trailing "(...)" annotation before treating an
// asset's symbol as something to price-lookup or display as a ticker.
function baseSymbol(rawSymbol) {
  return String(rawSymbol || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase();
}

// Symbols you actually hold get a live price whether or not you've also
// added them to the watchlist — that's what lets Markets show your
// positions inline in the same rows, instead of requiring you to
// separately watchlist everything you already own. Plain fiat cash is
// still excluded: it has no meaningful "market price" of its own. A
// stablecoin (USDT, etc.) is different — it trades on the same exchanges
// as everything else here, so it gets a row too, alongside still counting
// toward the invested/cash split bar. A coin split across variants that
// all resolve to the same base symbol (a liquid balance plus a "(staked)"
// one, say) collapses to one ticker.
//
// Leveraged positions are excluded by getSpotScopePositions(); they get rich
// cards in Futures rather than generic price/24h-change ticker rows here.
export function heldSymbols() {
  return spotScopeSnapshot().map(position => position.symbol);
}

// Share (0-1) of the total portfolio a held symbol represents, or null if
// you don't actually hold it. Sums every variant that resolves to this
// base symbol (see baseSymbol above), so a staked balance still counts
// toward its ticker's total account share. Used to annotate its row.
export function accountShareFor(symbol) {
  const total = compositionSnapshot().total;
  if (!(total > 0)) return null;
  const value = holdingValueFor(symbol);
  return value != null && value > 0 ? value / total : null;
}

/** Total $ value currently held of `symbol`, summed across every connection
 *  that reports it (same filter accountShareFor() uses for its own share
 *  fraction, just returning the raw amount instead of dividing it by the
 *  account total) -- null if nothing is held. */
export function holdingValueFor(symbol) {
  const position = spotScopeSnapshot().find(item => item.symbol === symbol);
  return position?.value > 0 ? position.value : null;
}

function trackedSymbols() {
  return [...new Set([...watchlistState.tickers, ...heldSymbols()])];
}

export function onUpdate(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Separate from onUpdate() above: that one just says "something changed,
// re-render", with no way to tell which symbol, if any, dropped out of
// tracking entirely. Callers that keep their own per-symbol cache keyed
// off a ticker (panel.js's chart-history buffer, currently the only one)
// need that specific signal so they can evict just that symbol's entry
// instead of either leaking it forever or clearing everything on every
// update.
const removalListeners = new Set();
export function onTickerRemoved(listener) {
  removalListeners.add(listener);
  return () => removalListeners.delete(listener);
}

/** Re-render every watchlist view (after another Finance frame changed settings). */
export function refresh() { notify(); }

function notify() {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error('[markets/watchlist] update listener failed:', error); }
  }
}

/**
 * A symbol's CoinGecko id: the cached one, or a search. null when CoinGecko
 * knows no such coin; undefined when it couldn't be asked (paused, refused,
 * unreachable), so the caller can try again later rather than give up.
 */
async function cgIdFor(symbol) {
  if (watchlistState.cgIdCache[symbol]) return watchlistState.cgIdCache[symbol];
  if (coinGeckoPaused()) return undefined;
  try {
    const response = await financeFetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (!response.ok) { pauseCoinGecko(); return undefined; }
    const data = await response.json();
    const match = (data.coins || []).find(coin => coin.symbol.toUpperCase() === symbol);
    if (!match) return null;
    watchlistState.cgIdCache[symbol] = match.id;
    pollSave();
    return match.id;
  } catch (_error) { return undefined; }
}

/** One CoinGecko request for every symbol that uses it, at most once a minute. */
async function fetchCoinGecko(symbols) {
  if (!symbols.length || coinGeckoPaused()) return;
  coinGeckoNextAt = Date.now() + COINGECKO_EVERY_MS;
  try {
    const pairs = symbols.map(symbol => [symbol, watchlistState.cgIdCache[symbol]]);
    const ids = [...new Set(pairs.filter(([, id]) => id).map(([, id]) => id))];
    if (!ids.length) return;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`;
    const response = await financeFetch(url);
    if (!response.ok) { pauseCoinGecko(); return; }
    const data = await response.json();
    for (const [symbol, id] of pairs) {
      if (id && data[id]) tickerData[symbol] = { price: data[id].usd, change: data[id].usd_24h_change ?? null };
    }
  } catch (_error) { /* retain stale data */ }
}

// A lot of newer pump.fun-style Solana meme launches never make it onto
// Binance or a CoinGecko listing at all — they only ever trade on a DEX.
// DexScreener indexes those pools directly by searching on the raw ticker
// text, so it's the last resort for a symbol you actually hold but that
// nothing else recognizes.
async function dexScreenerBestPair(symbol) {
  try {
    const data = await (await financeFetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`)).json();
    const pairs = (data.pairs || []).filter(pair => pair.baseToken?.symbol?.toUpperCase() === symbol);
    if (!pairs.length) return null;
    // Ticker text isn't unique — plenty of unrelated (or impersonating)
    // tokens can share a symbol. The most liquid pool is the least likely
    // to be a clone/rug, so that's the one whose price gets trusted.
    return pairs.reduce((best, pair) => (Number(pair.liquidity?.usd) || 0) > (Number(best.liquidity?.usd) || 0) ? pair : best);
  } catch (_error) { return null; }
}

async function fetchDexScreener(symbols) {
  if (!symbols.length) return;
  await Promise.allSettled(symbols.map(async symbol => {
    const best = await dexScreenerBestPair(symbol);
    if (!best) return;
    const price = Number(best.priceUsd);
    if (!Number.isFinite(price)) return;
    const change = Number(best.priceChange?.h24);
    tickerData[symbol] = { price, change: Number.isFinite(change) ? change : null };
  }));
}

async function probeSource(symbol) {
  if (unresolvedSymbols.has(symbol)) return false;
  try {
    const data = await (await financeFetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`)).json();
    if (data.price) { watchlistState.tickerSource[symbol] = 'binance'; delete binanceRetryAt[symbol]; return true; }
  } catch (_error) { /* try CoinGecko */ }
  const id = await cgIdFor(symbol);
  if (id) { watchlistState.tickerSource[symbol] = 'coingecko'; return true; }
  // CoinGecko couldn't be asked: try again later, rather than settle for a
  // DexScreener pool that may be another token with the same ticker.
  if (id === undefined) return false;
  if (await dexScreenerBestPair(symbol)) { watchlistState.tickerSource[symbol] = 'dexscreener'; return true; }
  unresolvedSymbols.add(symbol);
  return false;
}

/** Move a symbol to CoinGecko after Binance failures, until BINANCE_RETRY_MS has passed. */
function leaveBinance(symbol) {
  watchlistState.tickerSource[symbol] = 'coingecko';
  binanceRetryAt[symbol] = Date.now() + BINANCE_RETRY_MS;
}

/** Symbols to decide the source of again: every CoinGecko one once a session, and those whose Binance retry is due. */
function recheckSources(symbols) {
  const now = Date.now();
  for (const symbol of symbols) {
    const source = watchlistState.tickerSource[symbol];
    if (source !== 'coingecko') continue;
    if (!sourcesCheckedThisSession || (binanceRetryAt[symbol] && now >= binanceRetryAt[symbol])) {
      delete watchlistState.tickerSource[symbol];
      delete binanceRetryAt[symbol];
      binanceFailCount[symbol] = 0;
    }
  }
  sourcesCheckedThisSession = true;
}

async function fetchBinance(symbols) {
  if (!symbols.length) return;
  try {
    const query = encodeURIComponent(JSON.stringify(symbols.map(symbol => `${symbol}USDT`)));
    const data = await (await financeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${query}`)).json();
    if (!Array.isArray(data)) throw new Error('invalid Binance response');
    const returned = new Set();
    for (const item of data) {
      const symbol = item.symbol.replace(/USDT$/, '');
      tickerData[symbol] = { price: Number(item.lastPrice), change: Number(item.priceChangePercent) };
      binanceFailCount[symbol] = 0;
      returned.add(symbol);
    }
    const missing = symbols.filter(symbol => !returned.has(symbol));
    if (missing.length) {
      for (const symbol of missing) leaveBinance(symbol);
      pollSave();
    }
  } catch (_error) {
    // One symbol Binance doesn't know fails the whole list, so ask for each.
    let moved = false;
    await Promise.allSettled(symbols.map(async symbol => {
      try {
        const data = await (await financeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`)).json();
        if (!data.lastPrice) throw new Error('missing price');
        tickerData[symbol] = { price: Number(data.lastPrice), change: Number(data.priceChangePercent) };
        binanceFailCount[symbol] = 0;
      } catch (_innerError) {
        binanceFailCount[symbol] = (binanceFailCount[symbol] || 0) + 1;
        if (binanceFailCount[symbol] >= BINANCE_FAIL_THRESHOLD) { leaveBinance(symbol); moved = true; }
      }
    }));
    if (moved) pollSave();
  }
}

/** View: take the engine's prices (src/host/mirror.js). */
export function applyTickerData(data) {
  for (const symbol of Object.keys(tickerData)) if (!(symbol in (data || {}))) delete tickerData[symbol];
  Object.assign(tickerData, data || {});
  notify();
}

export async function fetchTickers() {
  if (!isEngine()) {
    // Prices are fetched once, by the engine frame; this frame mirrors them.
    flushPendingSave();
    return atmos.call(SELF, 'fetchTickers').catch(error => console.warn('[markets/watchlist] engine unavailable:', error.message));
  }
  const symbols = trackedSymbols();
  if (!symbols.length) { notify(); return; }
  recheckSources(symbols);
  const unknown = symbols.filter(symbol => !watchlistState.tickerSource[symbol]);
  if (unknown.length) {
    await Promise.allSettled(unknown.map(probeSource));
    pollSave();
  }
  const from = source => symbols.filter(symbol => watchlistState.tickerSource[symbol] === source);
  await Promise.all([fetchBinance(from('binance')), fetchDexScreener(from('dexscreener'))]);
  // Last, so what Binance just gave up on is in the same single request.
  await fetchCoinGecko(from('coingecko'));
  notify();
}

export function startPolling(context) {
  if (pollTimer) clearInterval(pollTimer);
  fetchTickers();
  pollTimer = context.setInterval(fetchTickers, 15_000);
  context.onCleanup(() => { pollTimer = null; });
}

export function updateTickerActive(symbol) {
  if (!watchlistState.tickers.includes(symbol) || watchlistState.activeT === symbol) return;
  watchlistState.activeT = symbol;
  notify();
  save();
}

export function removeTicker(symbol) {
  watchlistState.tickers = watchlistState.tickers.filter(item => item !== symbol);
  // A symbol you still hold keeps its price data and source classification
  // — it stays visible (as a held position, not a watchlist entry) and
  // keeps polling normally rather than reverting to "…" until the next
  // fetch happens to re-probe it from scratch.
  if (!heldSymbols().includes(symbol)) {
    delete watchlistState.tickerSource[symbol];
    delete watchlistState.cgIdCache[symbol];
    delete binanceFailCount[symbol];
    delete tickerData[symbol];
    for (const listener of removalListeners) {
      try { listener(symbol); } catch (error) { console.error('[markets/watchlist] removal listener failed:', error); }
    }
  }
  if (watchlistState.activeT === symbol) watchlistState.activeT = watchlistState.tickers[0] || null;
  notify();
  save();
}

export async function addTicker(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!symbol || watchlistState.tickers.includes(symbol)) return false;
  if (!await probeSource(symbol)) return false;
  binanceFailCount[symbol] = 0;
  watchlistState.tickers.push(symbol);
  notify();
  save();
  fetchTickers();
  return true;
}

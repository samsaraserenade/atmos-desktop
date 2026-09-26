import { isPerpHolding, splitPortfolio } from './portfolio-sections.js';
import { isGroupIncluded, isHoldingIncluded, scopedPortfolioData } from './portfolio-scope.js';
﻿/**
 * js/plugins/portfolio-tracker/src/totals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Portfolio-total logic, split out of registry.js (which is now just the
 * plugin-loading/connection machinery). Formerly currency.js — generic
 * currency conversion and rate-fetching have moved to js/services/currency/
 * (converter.js + rates.js) since they're not portfolio-specific; this file
 * now only owns portfolio-tracker's own concerns: summing portfolios into a
 * total, and the currency toggle button rendered in the Connections header.
 *
 * This module reads the exchange/portfolio data that registry.js owns (via
 * getAllPortfolios / getExchanges / isTickerEnabled) and pushes redraw
 * notifications back through notifyPortfolioUpdate(). registry.js in turn
 * calls initCurrencyService() / startRatesPolling() from here, so the two
 * modules import each other — that's expected, just don't rely on either
 * module's top-level exports before both have finished loading (only call
 * the imported functions from inside other functions, never at module scope).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAllPortfolios, getExchanges, isTickerEnabled, notifyPortfolioUpdate } from './registry.js';
import { portfolioState } from '../persist.js';
import { save } from './host/persist.js';
import { getServiceFileUrl } from './host/service-loader.js';

// From the Currency library service (pure conversion; no stored state).
let {
  convertToGbp,
  convertFromGbp: _convertFromGbp,
  isOutputCurrency,
  symbolForIso,
  OUTPUT_CURRENCIES,
} = {};
let { startRatesPolling, onRatesUpdate, ratesReady, getRates, useRates } = {};
let _currencyServicePromise = null;

export function initCurrencyService() {
  if (!_currencyServicePromise) _currencyServicePromise = (async () => {
    const [converterUrl, ratesUrl] = await Promise.all([
      getServiceFileUrl('currency', 'converter.js'),
      getServiceFileUrl('currency', 'rates.js'),
    ]);
    if (!converterUrl || !ratesUrl) throw new Error("Portfolio Tracker requires the 'currency' service.");
    ({ convertToGbp, convertFromGbp: _convertFromGbp, isOutputCurrency,
       symbolForIso, OUTPUT_CURRENCIES } = await import(converterUrl));
    ({ startRatesPolling, onRatesUpdate, ratesReady, getRates, useRates } = await import(ratesUrl));
    _shownCurrency = portfolioState.outputCurrency;
    onRatesUpdate(() => notifyPortfolioUpdate());
    onCurrencyChange(() => notifyPortfolioUpdate());
  })();
  return _currencyServicePromise;
}

// Re-exported so other portfolio-tracker files (total-chart.js, ticker.js)
// can keep importing conversion helpers from this module rather than
// reaching into the currency service directly.
export { convertToGbp, startRatesPolling };

/** Engine: the exchange rates it fetched (null until the first fetch). */
export function exportRates() { return ratesReady?.() ? getRates() : null; }
/** View: use the engine's rates instead of fetching them here. */
export function applyRates(rates) { if (rates) useRates?.(rates); }

// ── Output currency (Finance's own preference, in portfolioState) ────────────

export function getOutputCurrency() { return portfolioState.outputCurrency; }

/** GBP → the chosen output currency. */
export function convertFromGbp(gbpAmount) {
  return _convertFromGbp(gbpAmount, getOutputCurrency());
}

// Fired whenever the output currency changes, so consumers holding onto
// already-converted values (e.g. a plotted chart) can re-express them
// without re-fetching. Returns an unsubscribe function.
const _currencyChangeListeners = new Set();
let _shownCurrency = null; // what this frame's views last showed (set by initCurrencyService)
/** After another Finance frame changed the output currency: tell this frame's listeners. */
export function syncOutputCurrency() {
  if (_shownCurrency === null || _shownCurrency === portfolioState.outputCurrency) return;
  _shownCurrency = portfolioState.outputCurrency;
  for (const fn of [..._currencyChangeListeners]) fn();
}
export function onCurrencyChange(fn) {
  _currencyChangeListeners.add(fn);
  return () => _currencyChangeListeners.delete(fn);
}

// A rate refresh or an output-currency change both mean everything on screen
// needs redrawing (see the listeners registered in initCurrencyService()).
export function setOutputCurrency(iso) {
  if (!isOutputCurrency?.(iso) || iso === portfolioState.outputCurrency) return;
  portfolioState.outputCurrency = iso;
  save();
  _shownCurrency = iso;
  for (const fn of [..._currencyChangeListeners]) fn();
}

// ── Total API (consumed by ticker.js) ────────────────────────────────────────

export function getTotal() {
  let totalGbp     = 0;
  let liveCount    = 0;
  let pendingCount = 0;
  let errorCount   = 0;

  for (const [connectionId, data] of getAllPortfolios()) {
    if (!data) continue;
    if (data.lastUpdate === null) { pendingCount++; continue; }
    liveCount++;
    const scoped = scopedPortfolioData(data, connectionId);
    totalGbp += convertToGbp(scoped.value ?? 0, scoped.currency ?? '$');
    errorCount += Math.max(0, Number(data.errorCount) || 0);
  }

  const value = convertFromGbp(totalGbp);
  const iso   = getOutputCurrency();
  const sym   = symbolForIso(iso);
  return { value, symbol: sym, iso, ready: ratesReady(), liveCount, pendingCount, errorCount, gbp: totalGbp };
}

// Per-connection values (same GBP→output-currency normalisation as getTotal(),
// but broken out per exchange id instead of summed). Used by the chart to
// plot individual connection lines. Only includes connections with live data.
export function getConnectionTotals() {
  const iso       = getOutputCurrency();
  const sym       = symbolForIso(iso);
  const exchanges = getExchanges();
  const out       = [];
  for (const [id, data] of getAllPortfolios().entries()) {
    if (!data || data.lastUpdate === null) continue;
    const scoped = scopedPortfolioData(data, id);
    const gbp   = convertToGbp(scoped.value ?? 0, scoped.currency ?? '$');
    const value = convertFromGbp(gbp);
    const ex    = exchanges.find(e => e.id === id);
    out.push({ id, name: ex?.name ?? id, value, symbol: sym, enabled: isTickerEnabled(id) });
  }
  return out;
}

const FIAT_SYMBOLS = new Set(['GBP', 'USD', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

// Crypto-pegged "stable" tokens — unlike plain fiat cash, these still get
// a live price/24h-change row in the Positions accordion (see
// markets/src/watchlist-data.js's heldSymbols()), since they trade on the
// same exchanges as everything else there. They still count as 'cash' for
// the invested/cash split below — this only changes whether a holding
// also gets its own ticker row.
export const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'PYUSD',
  'GUSD', 'FRAX', 'LUSD', 'USDD', 'EURC', 'EURT', 'FUSDT',
]);
const CASH_SYMBOLS = new Set([...FIAT_SYMBOLS, ...STABLECOIN_SYMBOLS]);

function _holdingKind(holding) {
  if (holding?.kind === 'cash' || holding?.kind === 'invested') return holding.kind;
  return CASH_SYMBOLS.has(String(holding?.symbol || '').trim().toUpperCase()) ? 'cash' : 'invested';
}

// The VPS backend (backend/server.py's clean_frame) fabricates
// quantity = value, price = 1 for any source/holding that doesn't
// genuinely report units -- it's the only way a "value" published
// without a unit count can still be stored in the quantity/price
// columns at all. That fallback is indistinguishable from a real holding
// in the abstract, but no real market price lands on exactly 1.000000
// while the fallback produces it by construction, so this is what
// actually tells the two apart -- Number.isFinite(quantity) alone can't,
// since the fallback always produces a finite number too. Used to keep
// a source with no real quantity tracking out of the flow-vs-market
// split in daily-attribution.js, where treating its whole value change
// as a "deposit" (which is what quantity=value, price=1 does if taken
// at face value) would be actively wrong rather than merely imprecise.
//
// This heuristic only makes sense for 'invested' holdings, though: it
// exists to tell "no real price move happened, so any $ change here must
// be a trade" apart from "we genuinely don't know". For 'cash' holdings
// (plain fiat, and stablecoins -- see _holdingKind above) there's no
// separate price to move in the first place: a real stablecoin position
// legitimately reports quantity=value at price=1 (collectors.py hard-codes
// 1.0 for stablecoin prices), which is bit-for-bit the same shape as the
// backend's fabricated fallback. Rejecting it there throws out real
// quantity data for every stablecoin trade, which is exactly backwards --
// it's cash's whole value change that should count as flow (a deposit or
// withdrawal), never as unattributed "market movement"/profit.
function _hasGenuineQuantity(rawValue, quantity, price) {
  if (!Number.isFinite(quantity) || !Number.isFinite(price)) return false;
  return !(price === 1 && Math.abs(quantity - rawValue) < 1e-6);
}

function _hasKnownQuantity(kind, rawValue, quantity, price) {
  if (kind === 'cash') return Number.isFinite(quantity);
  return _hasGenuineQuantity(rawValue, quantity, price);
}

// Normalized asset/cash breakdown published by newer connectors. `holdings`
// is deliberately an optional addition to the existing setPortfolioData()
// payload, so older and third-party connectors continue to work unchanged.
// Values are converted independently before aggregation: a broker can publish
// GBP holdings while a wallet publishes USD holdings and the sidebar still
// gets one coherent ratio in the selected output currency.
export function getPortfolioComposition() {
  // Guard against being called (e.g. from Markets, which doesn't gate its
  // own mount on the currency service the way this plugin's own sidebar
  // section does) before initCurrencyService() has resolved and wired up
  // real convertToGbp/convertFromGbp implementations. Same "nothing to
  // report yet" shape callers already handle when there's no data.
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') {
    return { invested: 0, cash: 0, total: 0, unknown: 0, coverage: 0, symbol: '', assets: [] };
  }
  const assets = new Map();
  let investedGbp = 0;
  let cashGbp = 0;
  let reportedGbp = 0;
  let totalGbp = 0;

  for (const [connectionId, data] of getAllPortfolios().entries()) {
    if (!data || !Number.isFinite(Number(data.value))) continue;
    const scoped = scopedPortfolioData(data, connectionId);
    const dataCurrency = scoped.currency ?? '$';
    const connectorGbp = Math.max(0, convertToGbp(Number(scoped.value), dataCurrency));
    if (!Array.isArray(scoped.holdings)) { totalGbp += connectorGbp; continue; }

    // This bar is Spot-only -- a leveraged position isn't "invested" the
    // way a spot token is (see collect_hyperliquid's docstring on why its
    // equity figure isn't a market-priced holding), and its matching cash
    // (below) is really that same connector's locked/floating position
    // value wearing a cash costume. Both get held out of this connector's
    // contribution to totalGbp entirely, rather than added and then
    // showing up as an "unknown" gap -- they're not missing data, they're
    // just Futures' to report (see the accordion's own header total).
    let perpGbp = 0;

    for (const holding of scoped.holdings) {
      const rawValue = Number(holding?.value);
      if (!(rawValue > 0)) continue;
      const gbp = convertToGbp(rawValue, holding.currency ?? dataCurrency);
      if (!(gbp > 0)) continue;
      const kind = _holdingKind(holding);
      const instrument = holding?.meta?.instrument;
      if (isPerpHolding(holding, connectionId)) {
        perpGbp += gbp;
        continue;
      }
      const symbol = String(holding.symbol || holding.name || (kind === 'cash' ? 'Cash' : 'Asset')).trim().slice(0, 24);
      const key = `${kind}:${symbol.toUpperCase()}`;
      const previous = assets.get(key);
      const qty = Number(holding?.quantity);
      const qtyKnown = _hasKnownQuantity(kind, rawValue, qty, Number(holding?.price));
      assets.set(key, {
        symbol: previous?.symbol ?? symbol,
        kind,
        gbp: (previous?.gbp ?? 0) + gbp,
        connections: (previous?.connections ?? new Set()).add(connectionId),
        // Units, not currency -- summable across sources for the same
        // symbol regardless of which fiat each source reports value in.
        // quantityKnown only stays true if every contributing holding
        // actually reported a quantity, so a partial figure never gets
        // presented as the whole position's unit count.
        quantity: (previous?.quantity ?? 0) + (qtyKnown ? qty : 0),
        quantityKnown: (previous?.quantityKnown ?? true) && qtyKnown,
        // Always 'spot' now -- a leveraged position never reaches this far
        // (see the perp/perp-cash `continue` above), so there's no 'perp'
        // case left to route around. Kept in the public composition shape for
        // compatibility with any other consumers.
        market: 'spot',
      });
      reportedGbp += gbp;
      if (kind === 'cash') cashGbp += gbp;
      else investedGbp += gbp;
    }

    totalGbp += Math.max(0, connectorGbp - perpGbp);
  }

  const classifiedGbp = investedGbp + cashGbp;
  const denominatorGbp = Math.max(totalGbp, classifiedGbp);
  const minimumVisibleHoldingGbp = convertToGbp(1, '$');
  return {
    invested: convertFromGbp(investedGbp),
    cash: convertFromGbp(cashGbp),
    total: convertFromGbp(denominatorGbp),
    unknown: convertFromGbp(Math.max(0, denominatorGbp - reportedGbp)),
    coverage: denominatorGbp > 0 ? Math.min(1, reportedGbp / denominatorGbp) : 0,
    symbol: symbolForIso(getOutputCurrency()),
    assets: [...assets.values()]
      // Keep dust in the ratio/portfolio maths but omit it from the visible
      // list. Aggregate first so the same token held across wallets still
      // appears when its combined value reaches US$1.
      .filter(asset => asset.gbp >= minimumVisibleHoldingGbp)
      .sort((a, b) => b.gbp - a.gbp)
      .map(asset => ({
        symbol: asset.symbol,
        kind: asset.kind,
        value: convertFromGbp(asset.gbp),
        connectionCount: asset.connections.size,
        quantity: asset.quantityKnown ? asset.quantity : null,
        market: asset.market,
      })),
  };
}

const _spotScopeSymbol = value => String(value || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase();

// Raw Spot rows, including excluded holdings. They remain visible in the
// sidebar so their right-click menu can restore them to portfolio scope.
export function getSpotScopePositions() {
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') return [];
  const positions = new Map();
  const minimumVisibleHoldingGbp = convertToGbp(1, '$');
  for (const [connectionId, data] of getAllPortfolios()) {
    if (!data || !Array.isArray(data.holdings)) continue;
    const dataCurrency = data.currency ?? '$';
    for (const holding of data.holdings) {
      if (isPerpHolding(holding, connectionId)) continue;
      const rawValue = Number(holding?.value);
      if (!(rawValue > 0)) continue;
      const kind = _holdingKind(holding);
      const symbol = _spotScopeSymbol(holding.symbol || holding.name || (kind === 'cash' ? 'Cash' : 'Asset'));
      if (!symbol || (kind !== 'invested' && !STABLECOIN_SYMBOLS.has(symbol))) continue;
      const gbp = convertToGbp(rawValue, holding.currency ?? dataCurrency);
      if (!(gbp > 0)) continue;
      const previous = positions.get(symbol) || { symbol, gbp: 0, holdings: [] };
      previous.gbp += gbp;
      previous.holdings.push({ connectionId, holding, included: isHoldingIncluded(connectionId, holding) });
      positions.set(symbol, previous);
    }
  }
  return [...positions.values()]
    .filter(position => position.gbp >= minimumVisibleHoldingGbp)
    .map(position => ({
      ...position,
      value: convertFromGbp(position.gbp),
      included: position.holdings.every(item => item.included),
      partiallyIncluded: position.holdings.some(item => item.included) && position.holdings.some(item => !item.included),
    }))
    .sort((a, b) => b.gbp - a.gbp);
}

// Leveraged positions (currently: Hyperliquid perps -- see collectors.py's
// collect_hyperliquid) carry a bunch of their own extra numbers -- funding
// rate, leverage, entry/mark/liquidation price, margin, 24h fees -- that a
// generic "symbol + $ value" composition asset (above) has no room for and
// has no business knowing about. This walks the raw per-connector holdings
// directly (same source getPortfolioComposition reduces from) and returns
// just the perp positions with their full meta intact, for the Futures
// sidebar section's richer per-position cards. Not merged into
// getPortfolioComposition's own assets list: that list backs the Spot
// section, the invested/cash bar and daily-attribution's flow model, none
// of which should have to filter perp rows back out of their own path.
export function getFuturesPositions() {
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') return [];
  const positions = [];
  for (const [connectionId, data] of getAllPortfolios().entries()) {
    if (!data || !Array.isArray(data.holdings)) continue;
    const dataCurrency = data.currency ?? '$';
    for (const holding of data.holdings) {
      if (holding?.meta?.instrument !== 'perp') continue;
      const rawValue = Number(holding?.value);
      // Cross-margin losses can exceed a position's nominal margin while
      // the unified account still supports a genuinely open position.
      // Such rows carry zero equity but retain non-zero notional exposure;
      // keep them visible without adding fabricated value to account totals.
      const rawPositionValue = Number(holding?.meta?.positionValue);
      if (!(rawValue > 0) && !(rawPositionValue > 0)) continue;
      const gbp = convertToGbp(rawValue, holding.currency ?? dataCurrency);
      if (!(gbp >= 0)) continue;
      const meta = holding.meta;
      positions.push({
        // Connectors publish the perp symbol as "<coin> Perp" (see
        // collectors.py) -- stripped back to the plain coin here since the
        // "Perp" suffix is now this section's whole reason to exist, not
        // something that needs repeating on every row.
        coin: String(holding.symbol || '').replace(/\s+Perp$/i, '').trim() || 'Position',
        connectionId,
        value: convertFromGbp(gbp),
        side: meta.side === 'short' ? 'short' : 'long',
        leverage: Number.isFinite(Number(meta.leverage)) ? Number(meta.leverage) : null,
        entryPrice: Number.isFinite(Number(meta.entryPrice)) ? Number(meta.entryPrice) : null,
        markPrice: Number.isFinite(Number(meta.markPrice)) ? Number(meta.markPrice) : null,
        liquidationPrice: Number.isFinite(Number(meta.liquidationPrice)) ? Number(meta.liquidationPrice) : null,
        // Notional exposure (size x mark price) -- distinct from `value`
        // above (the equity/PnL figure) and from marginUsed (collateral
        // locked, not shown in the Futures panel at all).
        positionValue: Number.isFinite(Number(meta.positionValue)) ? Number(meta.positionValue) : null,
        marginUsed: Number.isFinite(Number(meta.marginUsed)) ? Number(meta.marginUsed) : null,
        unrealizedPnl: Number.isFinite(Number(meta.unrealizedPnl)) ? Number(meta.unrealizedPnl) : null,
        fundingRate: Number.isFinite(Number(meta.fundingRate)) ? Number(meta.fundingRate) : null,
        funding24h: Number.isFinite(Number(meta.funding24h)) ? Number(meta.funding24h) : null,
        fees24h: Number.isFinite(Number(meta.fees24h)) ? Number(meta.fees24h) : null,
      });
    }
  }
  return positions.sort((a, b) => b.value - a.value);
}

// Include idle collateral independently of open positions.
export function getFuturesSourceTotal() {
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') return 0;
  let gbp = 0;
  for (const [id, data] of getAllPortfolios()) {
    if (!data || data.lastUpdate === null) continue;
    gbp += splitPortfolio(scopedPortfolioData(data, id), id, convertToGbp).perp ?? 0;
  }
  return convertFromGbp(gbp);
}

export function getFuturesBalances() {
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') {
    return { perp: 0, earn: 0, perpIncluded: true, earnIncluded: true };
  }
  let perpGbp = 0;
  let earnGbp = 0;
  for (const [id, data] of getAllPortfolios()) {
    if (!data || data.lastUpdate === null) continue;
    const currency = data.currency ?? '$';
    if (id === 'hyperliquid-wallet' && Array.isArray(data.holdings)) {
      const earn = data.holdings
        .filter(holding => holding?.meta?.account === 'earn')
        .reduce((sum, holding) => sum + Math.max(0, Number(holding.value) || 0), 0);
      earnGbp += convertToGbp(earn, currency);
      perpGbp += convertToGbp(Math.max(0, (Number(data.value) || 0) - earn), currency);
    } else {
      perpGbp += splitPortfolio(data, id, convertToGbp).perp ?? 0;
    }
  }
  return {
    perp: convertFromGbp(perpGbp),
    earn: convertFromGbp(earnGbp),
    perpIncluded: isGroupIncluded('hyperliquid-wallet', 'perp'),
    earnIncluded: isGroupIncluded('hyperliquid-wallet', 'earn'),
  };
}

// Long vs short split across every open perp position, by equity value
// (the same `value` field getFuturesPositions() already returns -- what
// closing each one right now would hand back, not its leveraged notional
// size). Same shape as getPortfolioComposition()'s invested/cash split so
// markets/sidebar.js's Futures composition bar can reuse composition.js's
// bar-rendering markup wholesale, just fed long/short instead of
// invested/cash.
export function getFuturesDirectionSplit() {
  // Same currency-service race as getPortfolioComposition()/
  // getFuturesPositions() above -- can be called (via this section's own
  // mount(), through onStateLoaded) before initCurrencyService() has
  // wired up symbolForIso/getOutputCurrency. getFuturesPositions() already
  // guards this internally and returns [] rather than throwing, but
  // symbolForIso(getOutputCurrency()) below is called unconditionally, so
  // it needs its own guard rather than relying on positions being empty.
  if (typeof symbolForIso !== 'function' || typeof getOutputCurrency !== 'function') {
    return { long: 0, short: 0, symbol: '' };
  }
  const positions = getFuturesPositions();
  let long = 0;
  let short = 0;
  for (const position of positions) {
    // Notional exposure -- the same figure each card's own left-hand
    // value already shows (see markets/sidebar.js's updateFuturesCard),
    // not `position.value` (equity: marginUsed + unrealizedPnl, the
    // figure that feeds the *portfolio* total instead -- see
    // collectors.py's collect_hyperliquid docstring). A long/short split
    // is about market exposure/direction, which is what positionValue
    // answers; equity is "how much money is in this," which doesn't
    // change what "long" or "short" as a fraction of exposure means.
    const exposure = position.positionValue ?? position.value;
    if (position.side === 'short') short += exposure;
    else long += exposure;
  }
  return { long, short, symbol: symbolForIso(getOutputCurrency()) };
}

// Same output shape as getPortfolioComposition(), but built from a single
// holdings-history snapshot (the rows for one ts_ms poll, as returned by
// ./holdings-timeline.js's nearestSnapshot()) instead of the live
// per-connector state. Lets the sidebar render "what was I invested in at
// this point in time" through the exact same composition-bar/allocation-
// donut renderers already used for the live view (see balance.js).
export function compositionFromHoldingsSnapshot(holdings) {
  if (typeof convertToGbp !== 'function' || typeof convertFromGbp !== 'function') {
    return { invested: 0, cash: 0, total: 0, unknown: 0, coverage: 0, symbol: '', assets: [] };
  }
  const assets = new Map();
  let investedGbp = 0;
  let cashGbp = 0;

  for (const holding of Array.isArray(holdings) ? holdings : []) {
    if (!isHoldingIncluded(holding?.source_id || '', holding)) continue;
    const rawValue = Number(holding?.value);
    if (!(rawValue > 0)) continue;
    const gbp = convertToGbp(rawValue, holding.currency || 'USD');
    if (!(gbp > 0)) continue;
    // Same Spot-only exclusion as getPortfolioComposition() above, and for
    // the same reason -- kept consistent here specifically because this
    // function's whole job is diffing against that live one (daily-
    // attribution's before/after mover math). If this side still counted
    // Futures while the live side doesn't, every position's normal PnL
    // swing would show up as a phantom deposit/withdrawal or market move
    // in "Portfolio Change" the next time either side's total shifted.
    const instrument = holding?.meta?.instrument;
    if (isPerpHolding(holding, holding.source_id || '')) continue;
    const kind = _holdingKind(holding);
    const symbol = String(holding.symbol || (kind === 'cash' ? 'Cash' : 'Asset')).trim().slice(0, 24);
    const key = `${kind}:${symbol.toUpperCase()}`;
    const previous = assets.get(key);
    const qty = Number(holding?.quantity);
    const qtyKnown = _hasKnownQuantity(kind, rawValue, qty, Number(holding?.price));
    assets.set(key, {
      symbol: previous?.symbol ?? symbol,
      kind,
      gbp: (previous?.gbp ?? 0) + gbp,
      connections: (previous?.connections ?? new Set()).add(holding.source_id || ''),
      quantity: (previous?.quantity ?? 0) + (qtyKnown ? qty : 0),
      quantityKnown: (previous?.quantityKnown ?? true) && qtyKnown,
    });
    if (kind === 'cash') cashGbp += gbp;
    else investedGbp += gbp;
  }

  const classifiedGbp = investedGbp + cashGbp;
  // Same dust cutoff as getPortfolioComposition() above, and for the same
  // reason: without it, a sub-$1 position that's dust today AND was dust
  // in this snapshot would only get excluded from the *live* assets list
  // (getPortfolioComposition filters it there), never from this historical
  // one -- so daily-attribution.js's before/after diff would see it
  // "vanish" from $0.30 to nothing and report a phantom 100%-loss mover
  // for a coin the user barely holds, every single day. Filtering both
  // snapshots the same way keeps a dust position dust on both sides, so
  // it nets to no mover at all instead of a fake loss.
  const minimumVisibleHoldingGbp = convertToGbp(1, '$');
  return {
    invested: convertFromGbp(investedGbp),
    cash: convertFromGbp(cashGbp),
    total: convertFromGbp(classifiedGbp),
    unknown: 0,
    coverage: classifiedGbp > 0 ? 1 : 0,
    symbol: symbolForIso(getOutputCurrency()),
    assets: [...assets.values()]
      .filter(asset => asset.gbp >= minimumVisibleHoldingGbp)
      .sort((a, b) => b.gbp - a.gbp)
      .map(asset => ({
        symbol: asset.symbol,
        kind: asset.kind,
        value: convertFromGbp(asset.gbp),
        connectionCount: asset.connections.size,
        quantity: asset.quantityKnown ? asset.quantity : null,
      })),
  };
}

// ── Currency choice ─────────────────────────────────────────────────────────

/** The Balance widget's right-click menu: the currency totals are shown in. */
export function currencyMenuItem() {
  return {
    id: 'finance.balance.currency', type: 'select', label: 'Currency',
    value: getOutputCurrency(),
    options: (OUTPUT_CURRENCIES || []).map(currency => ({ value: currency.iso, label: currency.label })),
    run: iso => setOutputCurrency(iso),
  };
}

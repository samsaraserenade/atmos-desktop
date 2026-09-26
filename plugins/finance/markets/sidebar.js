import { masked, isPrivate, MASK } from '../src/privacy.js';
import { registerSection } from '../src/host/sidebar-registry.js';
import { atmos, requestPanelAction } from '../src/host/frame.js';
import { save } from '../src/host/persist.js';
import { watchlistState } from './persist.js';
import { portfolioState } from '../persist.js';
import { tickerData, onUpdate, addTicker, removeTicker, updateTickerActive, heldSymbols, accountShareFor, holdingValueFor } from './src/watchlist-data.js';
import { queueMarketQuery } from './src/session.js';
import { mountCompositionBar } from '../src/balance.js';
import { getPortfolioComposition, getFuturesBalances, getFuturesPositions, getFuturesDirectionSplit, getSpotScopePositions } from '../src/totals.js';
import { notifyPortfolioUpdate } from '../src/registry.js';
import { setGroupIncluded, setHoldingIncluded, setSourceIncluded } from '../src/portfolio-scope.js';
import { renderDirectionMarkup } from '../src/composition.js';

import { colorForChange, onPriceColorChange } from '../src/host/semantic-colors.js';

const icon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 18V9m5 9V5m5 13v-7m5 7V3"/><path d="M3 21h18"/></svg>';
const positionsIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M16.5 12h.01"/></svg>';
const futuresIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/></svg>';
const styleUrl = new URL('./styles.css', import.meta.url).href;
const CHART_MODE_EVENT = 'atmos:chart-mode';
let positionsRowsHost = null;
let marketsRowsHost = null;
let futuresRowsHost = null;
let spotTotalEl = null;
let futuresPerpBalanceEl = null;
let futuresEarnBalanceEl = null;
let futuresDirectionEl = null;
let _lastFuturesDirectionKey = null;
// symbol -> row entry, one cache per host, so renderRows() can patch
// existing rows instead of rebuilding the whole list every render.
const positionsRowCache = new Map();
const marketsRowCache = new Map();
const futuresRowCache = new Map();
let positionsEmptyEl = null;
let futuresEmptyEl = null;

// Same "compact, lossy, fits a tight column" philosophy as the ticker
// symbol's slice(0, 5) below: a plain toFixed()/toLocaleString() price
// can run well past a 7-character budget at either extreme -- a 6+
// figure price, or a sub-cent altcoin price with a run of leading zeros
// (WEN's $0.000007560 is 11 characters as a raw string). So a large
// price folds into a k/M/B suffix (mantissa is always 1-999.99, so
// "XXX.XX" + suffix never exceeds 7), and a tiny one folds its leading
// zero run into a single subscript digit -- the same "0.0₅756" shorthand
// most trading apps use for it -- keeping the digits-after-$ portion at
// 7 characters or fewer either way. Ordinary $1-$999 prices are
// untouched (toFixed(2) already fits), and anything with 0-1 leading
// zeros (0.5768, 0.01281, ...) keeps the plain 4-significant-figure form
// since that already fits too and compressing it would lose precision
// for no reason.
const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
const toSubscript = n => String(n).split('').map(digit => SUBSCRIPT_DIGITS[+digit]).join('');

function formatTinyPrice(price) {
  // Derive the leading-zero count from the ACTUAL rounded mantissa, not
  // the pre-rounding exponent -- toPrecision(3) can round e.g. 9.996 up
  // to "10.0", which crosses into the next order of magnitude and would
  // otherwise leave the zero count off by one (0.0009996 -> "0.0₃100",
  // read as 0.000100, when the rounded value is really ~0.00100).
  let exp = Math.floor(Math.log10(price));
  let mantissa = price / 10 ** exp;
  let sigFigs = mantissa.toPrecision(3);
  if (Number(sigFigs) >= 10) { exp += 1; sigFigs = (price / 10 ** exp).toPrecision(3); }
  const leadingZeros = -exp - 1;
  return `$0.0${toSubscript(leadingZeros)}${sigFigs.replace('.', '')}`;
}

// Same rounding-carry problem formatTinyPrice() guards against, just at
// the top of each tier instead of the bottom: (999999.99 / 1000).toFixed(2)
// rounds UP to "1000.00", which is 4 integer digits -- one past this
// tier's budget -- and belongs in the M tier instead. Walk up through
// TIERS (largest first) and re-check after rounding rather than trusting
// the pre-rounding magnitude.
const TIERS = [{ scale: 1e9, suffix: 'B' }, { scale: 1e6, suffix: 'M' }, { scale: 1e3, suffix: 'k' }];
function formatLargePrice(price) {
  let tierIndex = TIERS.findIndex(tier => price >= tier.scale);
  let { scale, suffix } = TIERS[tierIndex];
  let mantissa = (price / scale).toFixed(2);
  if (Number(mantissa) >= 1000 && tierIndex > 0) {
    ({ scale, suffix } = TIERS[tierIndex - 1]);
    mantissa = (price / scale).toFixed(2);
  }
  return `$${mantissa}${suffix}`;
}

const formatPrice = price => {
  if (price == null || !Number.isFinite(price)) return '…';
  if (price >= 1000) return formatLargePrice(price);
  if (price >= 1) return '$' + price.toFixed(2);
  if (price <= 0) return '$0.00';
  const leadingZeros = -Math.floor(Math.log10(price)) - 1;
  return leadingZeros >= 2 ? formatTinyPrice(price) : '$' + price.toPrecision(4);
};
const formatChange = change => change == null ? '' : `${change >= 0 ? '▲ ' : '▼ '}${Math.abs(change).toFixed(2)}%`;
// A holding's total $ value, not a per-unit price -- so unlike formatPrice
// above it's always rounded to the nearest whole dollar rather than
// carrying cents or compressing into k/M/B: a position row is tight on
// space and the cents on a "how much of this do I own" figure aren't
// worth the extra characters the way they are on the headline balance.
const _holdingValueFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const formatHoldingValue = masked(value => '$' + _holdingValueFmt.format(value));

// ── Futures card formatting ──────────────────────────────────────────────────
// Smaller figures than a headline holding value (PnL, funding, fees) are
// worth showing to the cent and with an explicit sign, so "$0.00" and "did
// nothing" aren't the same string, and a loss reads as a loss at a glance
// rather than needing the reader to notice a bare minus sign.
const formatSignedUsd = masked(formatSignedUsdPlain);
function formatSignedUsdPlain(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatEntryPrice(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return formatPrice(value);
}

// Hyperliquid's funding rate is a fraction paid/received per funding
// interval (currently hourly), not an APR -- shown as a plain percentage
// of the position's notional rather than annualized, since compounding
// that out would claim a precision about future funding this figure
// doesn't actually have.
function formatFundingRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`;
}

// Single header row now, laid out the same way a Spot/watchlist row is
// (see createRowEntry() above): a fixed-width figure on each outer edge
// with the identifying label centered and flexing between them. Value on
// the left, PnL on the right, coin centered -- no separate "top" row and
// no Long/Short pill any more; direction now reads purely from the coin
// label's own color (see updateFuturesCard's _directionalColor call),
// same as how a Spot row's price/change bar communicates direction
// without a text badge. Leverage moved out of the header entirely, into
// the data grid below (see makeStat('Leverage')) alongside the position's
// other secondary numbers.
function createFuturesCard() {
  const card = document.createElement('div');
  card.className = 'futures-card';

  const header = document.createElement('div');
  header.className = 'futures-card-header';
  const valueEl = document.createElement('span');
  valueEl.className = 'futures-card-value';
  const coinEl = document.createElement('span');
  coinEl.className = 'futures-card-coin';
  const pnlEl = document.createElement('span');
  pnlEl.className = 'futures-card-pnl';
  const chevronEl = document.createElement('span');
  chevronEl.className = 'futures-card-chevron';
  chevronEl.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  header.append(valueEl, coinEl, pnlEl, chevronEl);

  const grid = document.createElement('div');
  grid.className = 'futures-card-grid';
  const makeStat = label => {
    const stat = document.createElement('div');
    stat.className = 'futures-card-stat';
    const labelEl = document.createElement('span');
    labelEl.className = 'futures-card-stat-label';
    labelEl.textContent = label;
    const valEl = document.createElement('span');
    valEl.className = 'futures-card-stat-value';
    stat.append(labelEl, valEl);
    grid.append(stat);
    return valEl;
  };
  const leverageEl = makeStat('Leverage');
  const entryEl = makeStat('Entry');
  const markEl = makeStat('Mark');
  const liqEl = makeStat('Liquidation');
  const positionValueEl = makeStat('Position Value');
  const fundingRateEl = makeStat('Funding rate');
  const funding24hEl = makeStat('Funding (24h)');
  const fees24hEl = makeStat('Fees (24h)');

  card.append(header, grid);
  return {
    card, header, coinEl, valueEl, pnlEl, chevronEl,
    leverageEl, entryEl, markEl, liqEl, positionValueEl, fundingRateEl, funding24hEl, fees24hEl,
  };
}

// Every directional/gain-loss element on the card is colored through the
// same price-color service the rest of the app uses (colorForChange, from
// markets/sidebar.js's own top-of-file import) rather than a hardcoded
// green/red, so a Futures card matches whatever palette the user has set
// (see chartLineColorUp/chartLineColorDown in persist.js) instead of
// carrying its own fixed one. Plain informational numbers (entry/mark/
// liquidation price, leverage, position value) aren't a "change" of
// anything and stay in the neutral stat-value color instead.
function _directionalColor(isPositive, alpha) {
  return hexToRgba(colorForChange(isPositive ? 1 : -1), alpha);
}

function updateFuturesCard(entry, position) {
  const isLong = position.side !== 'short';
  // Direction now reads from the coin label's own color (long -> up
  // color, short -> down color) instead of a separate "Long"/"Short"
  // pill -- same principle as a Spot row, which never spells out
  // "gained"/"lost" next to its change bar either.
  entry.coinEl.textContent = position.coin;
  entry.coinEl.style.color = _directionalColor(isLong, .95);

  // Headline figure is the position's notional exposure (size x mark
  // price) -- "how much SOL am I short", which is what you actually care
  // about glancing at, not the equity/margin figure (that one only
  // matters for the portfolio total behind the scenes -- see totals.js's
  // getFuturesPositions() and the file-level docstring in collectors.py).
  entry.valueEl.textContent = formatHoldingValue(position.positionValue ?? position.value);
  const pnl = position.unrealizedPnl;
  entry.pnlEl.textContent = pnl == null ? '' : formatSignedUsd(pnl);
  entry.pnlEl.style.color = pnl == null ? '' : _directionalColor(pnl >= 0, .95);

  entry.leverageEl.textContent = position.leverage ? `${position.leverage}×` : '—';
  entry.entryEl.textContent = isPrivate() ? MASK : formatEntryPrice(position.entryPrice);
  entry.markEl.textContent = formatEntryPrice(position.markPrice);
  entry.liqEl.textContent = isPrivate() ? MASK : formatEntryPrice(position.liquidationPrice);
  // Notional exposure (size x mark price), not marginUsed -- "how much BTC
  // am I actually carrying", not "how much collateral is locked for it".
  entry.positionValueEl.textContent = position.positionValue == null ? '—' : formatHoldingValue(position.positionValue);
  entry.fundingRateEl.textContent = formatFundingRate(position.fundingRate);
  entry.fundingRateEl.style.color = position.fundingRate == null ? '' : _directionalColor(position.fundingRate >= 0, .85);

  entry.funding24hEl.textContent = formatSignedUsd(position.funding24h);
  entry.funding24hEl.style.color = position.funding24h == null ? '' : _directionalColor(position.funding24h >= 0, .85);

  // Fees are always a cost -- shown as a negative amount (formatSignedUsd
  // takes the raw signed number, so this negates rather than string-hacks
  // a minus sign onto a formatted string) and colored as a loss, never a gain.
  entry.fees24hEl.textContent = position.fees24h == null ? '—' : formatSignedUsd(-Math.abs(position.fees24h));
  entry.fees24hEl.style.color = position.fees24h == null ? '' : _directionalColor(false, .85);
}

function updateFuturesTotal() {
  if (!futuresPerpBalanceEl?.isConnected || !futuresEarnBalanceEl?.isConnected) return;
  const balances = getFuturesBalances();
  futuresPerpBalanceEl.textContent = formatHoldingValue(balances.perp);
  futuresEarnBalanceEl.textContent = formatHoldingValue(balances.earn);
  futuresPerpBalanceEl.closest('.portfolio-section-summary')?.classList.toggle('is-excluded', !balances.perpIncluded);
  futuresEarnBalanceEl.closest('.portfolio-section-summary')?.classList.toggle('is-excluded', !balances.earnIncluded);
}

function openFuturesBalanceMenu(event, group) {
  const balances = getFuturesBalances();
  const included = group === 'earn' ? balances.earnIncluded : balances.perpIncluded;
  const label = group === 'earn' ? 'Earn Balance' : 'Perp Balance';
  void atmos.contextMenu.open(event.clientX, event.clientY, [
    { type: 'heading', label },
    {
      id: `finance.futures.scope.${group}`,
      type: 'toggle',
      label: 'Included in portfolio',
      checked: included,
      run(checked) {
        setGroupIncluded('hyperliquid-wallet', group, checked);
        save();
        updateFuturesTotal();
        notifyPortfolioUpdate();
      },
    },
  ]).catch(error => console.error('[finance] futures balance menu:', error));
}

function updateSpotTotal() {
  if (!spotTotalEl?.isConnected) return;
  const { total } = getPortfolioComposition();
  spotTotalEl.textContent = total > 0 ? formatHoldingValue(total) : '';
}

// Long/short bar above the position cards -- same widget as Spot's own
// invested/cash bar (see balance.js's mountCompositionBar and
// composition.js's renderCompositionMarkup), fed a long/short split
// instead (totals.js's getFuturesDirectionSplit) and colored the same way
// a position's own coin label is (colorForChange, long -> up color,
// short -> down color) rather than a fixed green/red, so it matches
// whatever palette the user has set.
function updateFuturesDirectionBar() {
  if (!futuresDirectionEl?.isConnected) return;
  const split = getFuturesDirectionSplit();
  const showAmount = !!portfolioState.futuresDirectionShowAmount;
  const longColor = colorForChange(1);
  const shortColor = colorForChange(-1);
  // Match the invested/cash bar's cache behavior: palette colors are part
  // of the render key, so a price-color change repaints even when the ratio
  // values themselves have not moved.
  const key = `${longColor}|${shortColor}|${showAmount}|${split.long}|${split.short}`;
  if (key === _lastFuturesDirectionKey) return;
  _lastFuturesDirectionKey = key;
  futuresDirectionEl.style.setProperty('--pt-long-fill', hexToRgba(longColor, .25));
  futuresDirectionEl.style.setProperty('--pt-short-fill', hexToRgba(shortColor, .25));
  futuresDirectionEl.innerHTML = renderDirectionMarkup(split, { showAmount });
}

function renderFuturesRows() {
  const sortMode = portfolioState.futuresSortMode === 'size' ? 'size' : 'pnl';
  const positions = getFuturesPositions().sort((a, b) => {
    if (sortMode === 'size') {
      return (b.positionValue ?? b.value ?? -Infinity) - (a.positionValue ?? a.value ?? -Infinity);
    }
    return (b.unrealizedPnl ?? -Infinity) - (a.unrealizedPnl ?? -Infinity);
  });
  updateFuturesTotal();
  updateFuturesDirectionBar();
  if (!futuresRowsHost?.isConnected) return;
  if (!positions.length) {
    for (const entry of futuresRowCache.values()) entry.card.remove();
    futuresRowCache.clear();
    if (!futuresEmptyEl) {
      futuresEmptyEl = document.createElement('div');
      futuresEmptyEl.className = 'watchlist-empty';
      futuresEmptyEl.textContent = 'No open positions';
    }
    if (!futuresEmptyEl.isConnected) futuresRowsHost.appendChild(futuresEmptyEl);
    return;
  }
  if (futuresEmptyEl?.isConnected) futuresEmptyEl.remove();

  const seen = new Set();
  let previousCard = null;
  for (const position of positions) {
    const key = `${position.connectionId}:${position.coin}`;
    seen.add(key);
    let entry = futuresRowCache.get(key);
    if (!entry) {
      entry = createFuturesCard();
      entry.card.dataset.key = key;
      // Restore whatever collapsed/expanded state was persisted for this
      // exact position (see persist.js's collapsedFutures) -- only done
      // once, right when the card is first built; the class then just
      // rides along on the cached DOM node for the rest of this session,
      // same as it did before this was made persistent.
      if (portfolioState.collapsedFutures?.[key]) entry.card.classList.add('is-collapsed');
      futuresRowCache.set(key, entry);
    }
    updateFuturesCard(entry, position);
    const targetNext = previousCard ? previousCard.nextSibling : futuresRowsHost.firstChild;
    if (targetNext !== entry.card) futuresRowsHost.insertBefore(entry.card, targetNext);
    previousCard = entry.card;
  }
  for (const [key, entry] of futuresRowCache) {
    if (!seen.has(key)) { entry.card.remove(); futuresRowCache.delete(key); }
  }
}

function openTicker(symbol) {
  updateTickerActive(symbol);
  // The chart is in the Finance panel, another frame: ask it (frame-panel.js).
  requestPanelAction({ type: 'open-market', query: `${symbol}USDT` });
}

const formatShare = share => `${Math.round(share * 100)}%`;

function byChange(a, b) {
  const first = tickerData[a]?.change;
  const second = tickerData[b]?.change;
  if (first == null) return second == null ? 0 : 1;
  if (second == null) return -1;
  return second - first;
}

// Position-size ordering for Spot's right-click sort menu — largest share
// of the account first.
// Markets' plain watchlist rows always stay change-sorted; this only
// applies to actual holdings, which are the only rows accountShareFor()
// has an answer for anyway.
function byShare(a, b) {
  const first = accountShareFor(a) ?? -Infinity;
  const second = accountShareFor(b) ?? -Infinity;
  return second - first;
}

// Rows used to be torn down and rebuilt from scratch (replaceChildren() +
// a fresh buildTickerRow() per symbol) on every single re-render — every
// 15s poll tick, every ticker add/remove, every color-theme change. For a
// list that's mostly the same symbols in mostly the same order tick to
// tick, that's a lot of throwaway DOM churn for no visible difference.
// createRowEntry() builds a row's DOM once; updateRowEntry() patches an
// existing row's text/attributes in place; renderRows() below keeps a
// symbol->entry cache per host and only creates/removes nodes for symbols
// that actually entered or left the list, reusing (and just repositioning)
// everything else.
// Day-change magnitude (in percent) that fills the change bar out to its
// own max width (100% of the row, from the right edge -- see
// updateRowEntry's cap below; the stake bar on the left runs the full
// row uncapped too, so a 100% move now paints the change bar as fully
// as a 100% stake would) -- past this, further magnitude just clamps
// there instead of growing, so one big mover doesn't flatten the rest
// of the list's bars to nothing.
const CHANGE_BAR_CAP = 100;

// colorForChange() always returns a plain 6-digit hex (see the
// price-color service) since it's normally applied as a solid text
// color; the change bar wants it translucent instead so the price text
// painted on top of it stays legible.
function hexToRgba(hex, alpha) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Both bars live directly on the row itself now (same box that lights up
// on .watchlist-row:hover, same "% painted as a bar" mechanism the
// original single alloc-bar used -- position:absolute against a
// position:relative row, inset flush to its real edges rather than some
// inset sub-box), just two of them anchored to opposite sides instead of
// one spanning the whole thing: the stake bar is pinned to the left edge
// and grows rightward with account share (only held rows have one),
// the change bar is pinned to the right edge and grows leftward with
// today's % move, colored by direction. The ticker stays centered
// between them; the $ value and price labels are plain flex children
// sitting at the row's outer edges, above both bars.
function createRowEntry(symbol, isHeld) {
  const row = document.createElement('div');
  row.className = isHeld ? 'watchlist-row' : 'watchlist-row watchlist-row-market';
  row.dataset.symbol = symbol;

  // A held position isn't something you "remove" from a watchlist — it's
  // your actual money, so only it gets a stake bar/value; a plain
  // watch-only row has nothing to show there. isHeld is fixed per host
  // (Positions rows are always held, Markets rows never are), so this
  // never needs to be added/removed later by updateRowEntry.
  let allocBar = null, valueEl = null;
  if (isHeld) {
    allocBar = document.createElement('span');
    allocBar.className = 'watchlist-row-alloc-bar';
    row.append(allocBar);
  }

  const changeBar = document.createElement('span');
  changeBar.className = 'watchlist-row-change-bar';
  row.append(changeBar);

  if (isHeld) {
    valueEl = document.createElement('span');
    valueEl.className = 'watchlist-row-value';
    row.append(valueEl);
  }

  const symbolEl = document.createElement('span');
  symbolEl.className = `watchlist-row-symbol${isHeld ? ' is-held' : ''}`;
  symbolEl.textContent = symbol.slice(0, 5);
  row.append(symbolEl);

  const priceEl = document.createElement('span');
  priceEl.className = 'watchlist-row-price';
  row.append(priceEl);

  // Same reasoning as before: only a plain watch-only row gets a remove
  // control, and isHeld is fixed per host so this never needs to be
  // added/removed later by updateRowEntry.
  let removeEl = null;
  if (!isHeld) {
    row.insertBefore(priceEl, symbolEl);
    removeEl = document.createElement('span');
    removeEl.className = 'watchlist-row-change';
    row.append(removeEl);
    const bar = document.createElement('span');
    bar.className = 'watchlist-row-remove-bar';
    bar.setAttribute('aria-hidden', 'true');
    row.append(bar);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${symbol}: click to open chart, hold to remove`);
    row.title = 'Click to open chart · hold to remove';
  }

  return { row, allocBar, symbolEl, valueEl, changeBar, priceEl, removeEl };
}

function updateRowEntry(entry, symbol, isHeld) {
  const data = tickerData[symbol];

  // Stake bar: same "% painted as a bar" language as before — sized to
  // the account share, in a low-opacity white-on-dark tone. Only held
  // rows have one.
  if (isHeld) {
    const share = accountShareFor(symbol);
    // Full 0-100% of the row -- no cap. The change bar (see below) has
    // its own separate, much smaller cap instead.
    entry.allocBar.style.width = share != null ? `${Math.max(0, Math.min(100, share * 100))}%` : '0%';
    const holdingValue = holdingValueFor(symbol);
    entry.valueEl.textContent = holdingValue != null ? formatHoldingValue(holdingValue) : '';
    entry.valueEl.title = share == null ? '' : `${formatShare(share)} of your account`;
  }

  entry.symbolEl.title = isHeld ? `${symbol} · your position` : symbol;

  entry.priceEl.textContent = data ? formatPrice(data.price) : '…';

  // Change bar: today's % move painted as a bar behind the price instead
  // of spelled out next to it — width scaled to the change's magnitude
  // (capped at CHANGE_BAR_CAP so one outlier mover doesn't flatten every
  // other row's bar to nothing) and colored by direction with the shared
  // price-color palette, so gains/losses read the same way here as
  // everywhere else in the app. Exact value moves into the price's
  // tooltip, same declutter-into-title move as the stake bar.
  const change = data?.change ?? null;
  if (change == null) {
    entry.changeBar.style.width = '0%';
    entry.changeBar.style.background = 'transparent';
  } else {
    const magnitude = Math.min(Math.abs(change), CHANGE_BAR_CAP);
    // Scales up to the full row width, anchored to the right edge, as
    // the move approaches a 100% swing -- same peak as the uncapped
    // stake bar (above), so an extreme mover can dominate the row too.
    // No minimum width: a 0.05% move stays genuinely tiny rather than
    // tying visually with a 5% one at some artificial floor.
    entry.changeBar.style.width = `${Math.min(100, (magnitude / CHANGE_BAR_CAP) * 100)}%`;
    entry.changeBar.style.background = hexToRgba(colorForChange(change), .15);
  }
  entry.priceEl.title = data && change != null ? `${symbol} · ${formatChange(change)} today` : symbol;

  if (entry.removeEl) {
    entry.removeEl.textContent = change == null ? '…' : formatChange(change);
    entry.removeEl.title = '24-hour change';
    entry.removeEl.style.color = change == null ? '' : colorForChange(change);
    entry.row.style.setProperty('--remove-color', hexToRgba(colorForChange(-1), .3));
  }
}

// Patches `host` to show exactly `symbolList`, in that order, reusing any
// existing row whose symbol is already cached rather than recreating it.
// Reordering moves existing nodes (insertBefore/appendChild relocate,
// they don't clone) instead of rebuilding the list, so a sort-mode flip
// or a single price tick only touches the rows that actually need it.
function renderRows(host, cache, symbolList, isHeld) {
  if (!host?.isConnected) return;
  const seen = new Set();
  let previousRow = null;
  for (const symbol of symbolList) {
    seen.add(symbol);
    let entry = cache.get(symbol);
    if (!entry) {
      entry = createRowEntry(symbol, isHeld);
      cache.set(symbol, entry);
    }
    updateRowEntry(entry, symbol, isHeld);
    const targetNext = previousRow ? previousRow.nextSibling : host.firstChild;
    if (targetNext !== entry.row) host.insertBefore(entry.row, targetNext);
    previousRow = entry.row;
  }
  for (const [symbol, entry] of cache) {
    if (!seen.has(symbol)) { entry.row.remove(); cache.delete(symbol); }
  }
}

function clearRowCache(cache) {
  for (const entry of cache.values()) entry.row.remove();
  cache.clear();
}

// Two independent lists now, not one merged one with a splitter in the
// middle — your positions (pulled in automatically from actual holdings,
// see heldSymbols() in watchlist-data.js) live in their own accordion,
// sorted on their own by 24h change, and everything you're just watching
// lives in Markets, sorted on its own. A symbol you hold never shows up
// twice — it's a position first, so it's excluded from the plain
// watchlist even if you'd previously added it there too.
export function renderPositionRows() {
  updateSpotTotal();
  if (!positionsRowsHost?.isConnected) return;
  const sortMode = portfolioState.positionsSortMode === 'share' ? 'share' : 'change';
  const heldList = heldSymbols().sort(sortMode === 'share' ? byShare : byChange);
  if (!heldList.length) {
    clearRowCache(positionsRowCache);
    if (!positionsEmptyEl) {
      positionsEmptyEl = document.createElement('div');
      positionsEmptyEl.className = 'watchlist-empty';
      positionsEmptyEl.textContent = 'No holdings yet';
    }
    if (!positionsEmptyEl.isConnected) positionsRowsHost.appendChild(positionsEmptyEl);
    return;
  }
  if (positionsEmptyEl?.isConnected) positionsEmptyEl.remove();
  renderRows(positionsRowsHost, positionsRowCache, heldList, true);
  const scopeBySymbol = new Map(getSpotScopePositions().map(position => [position.symbol, position]));
  for (const [symbol, entry] of positionsRowCache) {
    const scope = scopeBySymbol.get(symbol);
    entry.row.classList.toggle('is-excluded', !!scope && !scope.included);
    entry.row.classList.toggle('is-partially-excluded', !!scope?.partiallyIncluded);
  }
}

function openSpotVisibilityMenu(event, symbol) {
  const position = getSpotScopePositions().find(item => item.symbol === symbol);
  if (!position) return;
  const included = position.included;
  void atmos.contextMenu.open(event.clientX, event.clientY, [
    { type: 'heading', label: symbol },
    {
      id: 'finance.spot.scope.include',
      type: 'toggle',
      label: 'Included in portfolio',
      checked: included,
      run(checked) {
        for (const item of position.holdings) {
          if (checked) setSourceIncluded(item.connectionId, true);
          setHoldingIncluded(item.connectionId, item.holding, checked);
        }
        save();
        renderPositionRows();
        notifyPortfolioUpdate();
      },
    },
    ...(position.holdings.length > 1
      ? [{ type: 'meta', label: `${position.holdings.length} balances grouped in this row` }]
      : []),
  ]).catch(error => console.error('[finance] Spot visibility menu:', error));
}

export function renderTickerRows() {
  if (!marketsRowsHost?.isConnected) return;
  const held = new Set(heldSymbols());
  const watchList = watchlistState.tickers.filter(symbol => !held.has(symbol)).sort(byChange);
  renderRows(marketsRowsHost, marketsRowCache, watchList, false);
}

function spotSortMenuItems() {
  return [{
    id: 'finance.spot.sort',
    type: 'select',
    label: 'Sort by',
    value: portfolioState.positionsSortMode === 'share' ? 'share' : 'change',
    options: [
      { value: 'change', label: 'Daily performance' },
      { value: 'share', label: 'Position size' },
    ],
    run(value) {
      portfolioState.positionsSortMode = value === 'share' ? 'share' : 'change';
      save();
      renderPositionRows();
    },
  }];
}

function futuresSortMenuItems() {
  return [{
    id: 'finance.futures.sort',
    type: 'select',
    label: 'Sort by',
    value: portfolioState.futuresSortMode === 'size' ? 'size' : 'pnl',
    options: [
      { value: 'pnl', label: 'PnL' },
      { value: 'size', label: 'Position size' },
    ],
    run(value) {
      portfolioState.futuresSortMode = value === 'size' ? 'size' : 'pnl';
      save();
      renderFuturesRows();
    },
  }];
}

registerSection('portfolio-positions', {
  // Sits right before Futures/Markets, after the rest of the Portfolio
  // group — both this and Markets are watchlist-styled ticker rows, just
  // split into "yours" and "everything else" as separate accordions
  // rather than one list with a divider in it. Section id kept as
  // 'portfolio-positions' even though the label reads "Spot" now, so any
  // persisted per-section enabled/order state keyed by id isn't disturbed.
  order: 0,
  icon: positionsIcon,
  label: 'Spot',
  defaultEnabled: true,
  contextMenuItems: spotSortMenuItems,
  mount(body, context) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = styleUrl;
    document.head.appendChild(link);
    context.onCleanup(() => link.remove());
    body.innerHTML = '<div class="portfolio-section-summary"><span class="portfolio-section-summary-label">Total</span><span id="spot-total-balance" class="portfolio-section-total"></span></div><div id="tc-sidebar-composition"></div><div class="watchlist-rows"></div>';
    // The invested/cash split used to live in the Performance section,
    // above the balance figure — moved here, right above the positions
    // it's summarizing. Rendering itself still lives in balance.js; this
    // just hands it the DOM node to paint into.
    mountCompositionBar(body.querySelector('#tc-sidebar-composition'), context);
    positionsRowsHost = body.querySelector('.watchlist-rows');
    context.onCleanup(() => { if (positionsRowsHost?.closest('.fin-section-body') === body) positionsRowsHost = null; });
    spotTotalEl = body.querySelector('#spot-total-balance');
    context.onCleanup(() => { spotTotalEl = null; });
    context.onCleanup(() => clearRowCache(positionsRowCache));
    // Held positions depend on the currency service (see totals.js's
    // getPortfolioComposition), which may still be initializing when this
    // section first mounts. Held rows self-heal
    // on the next 15s ticker price poll (fetchTickers() always calls
    // notify() at its end), by which point currency init has long finished
    // — a short one-time delay on first load, not a bug.
    context.onCleanup(onUpdate(renderPositionRows));
    context.onCleanup(onPriceColorChange(renderPositionRows));

    context.listen(body, 'click', event => {
      const row = event.target.closest('.watchlist-row');
      if (!row || !body.contains(row)) return;
      event.stopPropagation();
      openTicker(row.dataset.symbol);
    });
    context.listen(body, 'contextmenu', event => {
      const row = event.target.closest('.watchlist-row');
      if (!row || !body.contains(row)) return;
      event.preventDefault();
      event.stopPropagation();
      openSpotVisibilityMenu(event, row.dataset.symbol);
    });

    renderPositionRows();
  },
});

registerSection('portfolio-futures', {
  // Sits between Spot and Markets — its own accordion rather than folded
  // into Spot's rows, since a leveraged position carries a bunch of its
  // own numbers (funding, fees, leverage, liquidation price) that don't
  // fit a plain ticker row and shouldn't be forced to.
  order: 1,
  icon: futuresIcon,
  label: 'Futures',
  defaultEnabled: true,
  contextMenuItems: futuresSortMenuItems,
  mount(body, context) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = styleUrl;
    document.head.appendChild(link);
    context.onCleanup(() => link.remove());
    body.innerHTML = '<div class="portfolio-section-summary-stack"><div class="portfolio-section-summary" data-futures-balance="perp"><span class="portfolio-section-summary-label">Perp Balance</span><span id="futures-perp-balance" class="portfolio-section-total"></span></div><div class="portfolio-section-summary" data-futures-balance="earn"><span class="portfolio-section-summary-label">Earn Balance</span><span id="futures-earn-balance" class="portfolio-section-total"></span></div></div><div id="futures-direction-bar"></div><div class="futures-rows"></div>';
    futuresRowsHost = body.querySelector('.futures-rows');
    context.onCleanup(() => { if (futuresRowsHost?.closest('.fin-section-body') === body) futuresRowsHost = null; });
    futuresPerpBalanceEl = body.querySelector('#futures-perp-balance');
    futuresEarnBalanceEl = body.querySelector('#futures-earn-balance');
    context.onCleanup(() => { futuresPerpBalanceEl = null; futuresEarnBalanceEl = null; });
    futuresDirectionEl = body.querySelector('#futures-direction-bar');
    _lastFuturesDirectionKey = null;
    context.onCleanup(() => { futuresDirectionEl = null; });
    context.onCleanup(() => {
      for (const entry of futuresRowCache.values()) entry.card.remove();
      futuresRowCache.clear();
    });
    // Click (or Enter/Space, it's role="button") flips the long/short bar
    // between percentages and amounts -- same affordance as Spot's own
    // invested/cash bar (see balance.js's mountCompositionBar), just its
    // own persisted flag so the two bars can be in different modes.
    const flipFuturesDirectionMode = event => {
      if (!event.target.closest('.pt-direction-bar')) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      portfolioState.futuresDirectionShowAmount = !portfolioState.futuresDirectionShowAmount;
      save();
      _lastFuturesDirectionKey = null;
      updateFuturesDirectionBar();
    };
    context.listen(futuresDirectionEl, 'click', flipFuturesDirectionMode);
    context.listen(futuresDirectionEl, 'keydown', flipFuturesDirectionMode);
    // Same self-heal cadence as Spot's held rows above (see its onUpdate
    // comment) — there's no live market-price feed backing a perp
    // position's own numbers, but riding the same ~15s ticker-poll tick
    // is a simple, already-wired way to pick up a fresh VPS poll without
    // adding another dedicated portfolio listener here.
    context.onCleanup(onUpdate(renderFuturesRows));
    context.onCleanup(onPriceColorChange(renderFuturesRows));
    context.listen(body, 'contextmenu', event => {
      const row = event.target.closest('[data-futures-balance]');
      if (!row || !body.contains(row)) return;
      event.preventDefault();
      event.stopPropagation();
      openFuturesBalanceMenu(event, row.dataset.futuresBalance);
    });

    // Click the coin/side/leverage header row to collapse just that
    // card's data grid (Entry/Mark/Liquidation/Position Value/Funding/
    // Fees) — the top line and value/PnL row stay visible either way,
    // it's only the detail grid that folds away. State lives on the
    // card's own classList, which the render loop's cache keeps reusing
    // across polls, so a card you've collapsed stays collapsed as its
    // numbers keep updating underneath — it just resets (back to
    // expanded) if the position closes and reopens, since that's a new
    // cache entry.
    context.listen(body, 'click', event => {
      const header = event.target.closest('.futures-card-header');
      if (!header || !body.contains(header)) return;
      event.stopPropagation();
      const card = header.closest('.futures-card');
      const key = card?.dataset.key;
      if (!card || !key) return;
      const collapsed = card.classList.toggle('is-collapsed');
      // Persisted the same way moversCollapsed/flowCollapsed/athCollapsed
      // are for their own sections (see persist.js) -- survives an app
      // restart instead of resetting to expanded every time.
      if (collapsed) portfolioState.collapsedFutures[key] = true;
      else delete portfolioState.collapsedFutures[key];
      save();
    });

    renderFuturesRows();
  },
});

registerSection('markets', {
  order: 10,
  icon,
  label: 'Watchlist',
  defaultEnabled: true,
  mount(body, context) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = styleUrl;
    document.head.appendChild(link);
    context.onCleanup(() => link.remove());
    body.innerHTML = '<div class="watchlist-body-add"><input id="markets-watchlist-input" type="text" class="watchlist-input" placeholder="Add ticker (BTC, ETH…)" maxlength="10" autocomplete="off" aria-label="Add ticker symbol"></div><div class="watchlist-rows"></div>';
    marketsRowsHost = body.querySelector('.watchlist-rows');
    let hold = null;
    let suppressClickUntil = 0;
    function cancelHold() {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold.row.classList.remove('is-removing');
      hold = null;
    }
    function startHold(row, pointerId = null, key = null) {
      cancelHold();
      row.classList.add('is-removing');
      hold = { row, pointerId, key, timer: setTimeout(() => {
        if (!row.isConnected || document.hidden) { cancelHold(); return; }
        const symbol = row.dataset.symbol;
        suppressClickUntil = Date.now() + 700;
        cancelHold();
        removeTicker(symbol);
      }, 1000) };
    }
    context.onCleanup(cancelHold);
    context.listen(body, 'pointerdown', event => {
      const row = event.target.closest('.watchlist-row-market');
      if (!row || !body.contains(row) || event.button !== 0 || !event.isPrimary) return;
      startHold(row, event.pointerId);
    });
    context.listen(window, 'pointerup', cancelHold);
    context.listen(window, 'pointercancel', cancelHold);
    context.listen(window, 'blur', cancelHold);
    context.listen(document, 'visibilitychange', cancelHold);
    context.listen(window, 'pointermove', event => {
      if (!hold || hold.pointerId !== event.pointerId) return;
      const rect = hold.row.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancelHold();
    });
    context.listen(body, 'contextmenu', event => {
      if (hold) { event.preventDefault(); cancelHold(); }
    });
    context.listen(body, 'keydown', event => {
      const row = event.target.closest('.watchlist-row-market');
      if (!row) return;
      if (event.key === 'Escape') { cancelHold(); return; }
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) startHold(row, null, event.key);
    });
    context.listen(body, 'keyup', event => {
      if (!hold || event.key !== hold.key) return;
      event.preventDefault();
      const symbol = hold.row.dataset.symbol;
      cancelHold();
      openTicker(symbol);
    });
    context.listen(body, 'focusout', cancelHold);
    context.onCleanup(() => { if (marketsRowsHost?.closest('.fin-section-body') === body) marketsRowsHost = null; });
    context.onCleanup(() => clearRowCache(marketsRowCache));
    context.onCleanup(onUpdate(renderTickerRows));
    context.onCleanup(onPriceColorChange(renderTickerRows));

    context.listen(body, 'click', event => {
      const row = event.target.closest('.watchlist-row');
      if (!row || !body.contains(row)) return;
      event.stopPropagation();
      if (Date.now() >= suppressClickUntil) openTicker(row.dataset.symbol);
    });

    const input = body.querySelector('#markets-watchlist-input');
    if (input) context.listen(input, 'keydown', async event => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const symbol = event.currentTarget.value.trim().toUpperCase();
      const added = await addTicker(symbol);
      if (context.signal.aborted || !event.currentTarget.isConnected) return;
      if (added) event.currentTarget.value = '';
      else if (symbol) {
        event.currentTarget.classList.add('err');
        context.setTimeout(() => event.currentTarget?.classList.remove('err'), 700);
      }
    });
    renderTickerRows();
  },
});

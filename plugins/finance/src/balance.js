/**
 * js/plugins/portfolio-tracker/src/balance.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sidebar "Balance" widget: the tweened balance figure + its mini
 * sparkline, mounted as a sidebar-registry section (see sidebar.js in this
 * same directory) instead of a hardcoded slot in index.html — this is what
 * lets it show up in the Settings → Sidebar list alongside Watchlist,
 * Weather, etc. and be enabled/disabled/reordered like any other section.
 *
 * Split out of total-chart.js. Shares the main Portfolio Chart's live
 * history feed and hidden-range (spike-hide) filter, but is otherwise a
 * self-contained sub-feature — it keeps updating even when the Portfolio
 * Chart card itself is toggled off.
 *
 * Two separate entry points, matching the sidebar-section vs. data-layer
 * split described in PANEL_SIDEBAR_INTEGRATION.md:
 *
 *   - initBalanceWidget({ history, isHidden, getColors }) — pure data
 *     wiring, called once from total-chart.js's initTotalChart(). No DOM.
 *   - mountBalanceSection(bodyEl) — builds this widget's DOM into the
 *     `.fin-section-body` handed to it by sidebar-registry.js's
 *     registerSection() mount callback. Called once, ever (sidebar
 *     sections don't unmount).
 *
 * These can run in either order — both just assign into shared, live
 * module state, so whichever fires first sees sensible defaults and the
 * other one's later update just takes effect on the next render.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { privateFormat } from './privacy.js';
import { smoothingAlpha } from './chart-service.js';
import { getPortfolioComposition, compositionFromHoldingsSnapshot } from './totals.js';
import { renderCompositionMarkup } from './composition.js';
import { loadHoldingsTimeline, nearestSnapshot } from './holdings-timeline.js';
import { computeDailyAttribution } from './daily-attribution.js';
import { portfolioState } from '../persist.js';
import { onStateLoaded, save } from './host/persist.js';

// Share the expensive holdings walk across synchronous tile renders, just
// like watchlist-data.js. Expire before the next tick so updates stay fresh.
let _compositionCache = null;
function compositionSnapshot() {
  if (!_compositionCache) {
    _compositionCache = getPortfolioComposition();
    queueMicrotask(() => { _compositionCache = null; });
  }
  return _compositionCache;
}

// ── Mini sparkline layout ───────────────────────────────────────────────────

const MINI_W = 56, MINI_H = 30, MINI_PAD = 2;

// ── DOM refs ─────────────────────────────────────────────────────────────────

let _balanceEl       = null;   // wrapper div, mounted in the sidebar
let _balanceHeroEl   = null;
let _balanceTextEl   = null;   // amount wrapper in the summary row
let _balanceAmountEl = null;
let _performanceEl   = null;
let _performanceCards = new Map();
let _athEl            = null;   // "All-Time High/Low" list, below Flow
let _moversEl         = null;   // "Today's Movers" list, below the tiles
let _flowEl           = null;   // market-vs-flow breakdown, below Movers
let _balanceVisible  = true;
let _miniChartSvgEl  = null;
let _compositionEl   = null;
let _balanceContext  = null;
let _balanceWidth    = 0;
let _balanceMeasureCtx = null;
let _lastBalanceFitTemplate = null;
// Debounces resizing the figure/hero for an ORDINARY balance tick that
// crosses a digit-count boundary (see _fitBalanceText) -- not used for
// the deliberate, immediate-apply triggers (font change, container
// resize, first paint).
let _pendingFitTimer = null;

// Cached on-screen width of the mini chart SVG, kept in sync by a
// ResizeObserver rather than measured with getBoundingClientRect() inside
// _renderMiniChart(). That function runs on every call to
// updateBalanceDisplay() — which total-chart.js fires once per animation
// frame while the fullscreen player is moving — so a synchronous
// getBoundingClientRect() read there was forcing a reflow every frame any
// time it landed after a pending style/attribute write elsewhere on the
// page (see _applyFullscreen in total-chart.js). ResizeObserver reports
// size changes asynchronously, off the hot render path, so reads become
// free.
let _miniChartWidth  = MINI_W;
let _miniChartRO     = null;

// ── Shared data source, wired in by total-chart.js via initBalanceWidget ───
// _history is the SAME array object the main chart samples into — it's
// mutated in place (push/shift) over there, so holding this one reference
// is enough to always see current data. _isHidden and _getColors are the
// main chart's own functions, called live so they always reflect its
// current spike-hide ranges / configured line colors.

let _history   = [];
let _isHidden  = () => false;
let _getColors = () => ({ up: '#34d399', down: '#f87171' });

// ── Mini-chart smoothing ────────────────────────────────────────────────────
// Independent of the main Portfolio Chart's smoothing level — the mini
// chart isn't gated by the main chart's visibility, so it has its own.

const _miniSmoothingLvl = 75; // Fixed mini-chart smoothing (0–100).

// ── Number-tween state ──────────────────────────────────────────────────────
// Animates the centre balance figure smoothly between old/new values
// instead of snapping, with a brief colour flash (green/red) hinting at
// the direction of the change.

let _balanceAnimValue = null;   // numeric value currently displayed (mid-tween or settled)
let _balanceAnimRAF   = null;   // requestAnimationFrame handle for the in-flight tween
let _lastBalanceText  = null;   // avoids repainting when formatting produces the same cents
let _lastMiniChartKey = null;
let _lastCompositionKey = null;
let _balanceLayerReleaseTimer = null;

// ── Point-in-time composition (driven by total-chart.js's cash/invested
// indicator pane, mounted below the main chart) ─────────────────────────────
// While the user hovers that pane, it calls showHistoricalComposition() with
// a timestamp + the hovered pane's visible time range; this repaints the
// composition bar and allocation donut above with the holdings that were
// live at that moment instead of the current live totals, reverting via
// clearHistoricalComposition() on pointerleave. See holdings-timeline.js for
// the on-demand fetch/cache this is built on.
const HOLDINGS_TIMELINE_LOOKBACK_MS = 30 * 24 * 60 * 60_000; // cap the on-demand fetch to the last 30 days
let _hoveringHistory = false;
let _holdingsTimelineCache = null;
let _holdingsTimelineLoading = false;
let _holdingsTimelineRangeKey = null;
const _balanceAnimMs = 60_000; // Fixed one-minute balance transition.
// The hero box (sparkline + big figure) no longer has a fixed height that
// the balance figure has to be squeezed to fit -- a width-constrained
// figure (a long/many-digit balance, in a narrow sidebar) naturally never
// needed anywhere near a tall fixed box, which is exactly what left a big
// empty gap above the number. Instead _fitBalanceText sizes the FONT from
// available width up to a flat design ceiling, then sizes the HERO to
// match whatever that font's real rendered height turns out to be (via
// its own measured metrics, not a guess) -- the box now follows the
// content instead of the other way around.
const BALANCE_FONT_MAX_PX = 90;   // Design ceiling on the figure itself, independent of any box.
const BALANCE_HERO_MIN_PX = 48;   // Floor so a very long balance's small font doesn't leave the sparkline a sliver.
const BALANCE_HERO_VPAD_PX = 8;   // Small breathing room added around the fitted content's own height.
const BALANCE_COLOR_BASE  = 'rgba(var(--ink-rgb),0.82)';
const BALANCE_FLASH_ALPHA = 0.95;    // opacity applied to the chart's up/down hex when flashing
const CHANGE_RANGES = Object.freeze([
  { id: '1d', label: 'DAY', duration: 24 * 60 * 60_000 },
  { id: '1w', label: 'WEEK', duration: 7 * 24 * 60 * 60_000 },
  { id: 'total', label: 'TOTAL', duration: null },
]);

// The bundled default for the big total-balance figure. The context menu
// offers this plus, at most, one user-imported replacement.
export const BALANCE_FONTS = Object.freeze([
  { id: 'bebas', label: 'Bebas Neue', stack: `'Bebas Neue','Arial Narrow','Segoe UI',sans-serif` },
]);
const DEFAULT_BALANCE_FONT_ID = 'bebas';

// User-imported fonts (Balance's "Import font..." menu action, see
// importBalanceFont below). Kept separate from the curated BALANCE_FONTS
// list above -- these persist as data URLs in portfolioState rather than
// bundled files. Only one is retained: importing a new font replaces the
// previous custom choice and its persisted data.
const MAX_CUSTOM_FONT_BYTES = 2 * 1024 * 1024; // 2MB source file (~2.7MB once base64-encoded for storage)
const CUSTOM_FONT_EXTENSIONS = /\.(ttf|otf|woff2?|ttc)$/i;
// id -> FontFace actually registered with this page's document.fonts.
// document.fonts doesn't survive a reload, so this is rebuilt from
// portfolioState.customBalanceFonts's data URLs each time (see
// _registerAllCustomFonts) -- this map just avoids re-adding the same
// font twice within one page session.
const _customFontFaces = new Map();

function _slugifyFontLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || 'font';
}

function _uniqueCustomFontId(baseSlug) {
  const suffix = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `custom-${baseSlug}-${suffix}`;
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the font file'));
    reader.readAsDataURL(file);
  });
}

function _registerCustomFont(font) {
  if (_customFontFaces.has(font.id)) return _customFontFaces.get(font.id);
  try {
    const face = new FontFace(font.label, `url(${font.dataUrl})`);
    _customFontFaces.set(font.id, face);
    document.fonts?.add(face);
    face.load().catch(error => {
      console.warn('[portfolio-tracker] custom balance font failed to load:', font.label, error?.message);
    });
    return face;
  } catch (error) {
    console.warn('[portfolio-tracker] could not register custom balance font:', font.label, error?.message);
    return null;
  }
}

// Re-registers the persisted custom font's FontFace -- call before
// reading/painting with the font list so a fresh page load (where
// document.fonts is empty regardless of what's in portfolioState) doesn't
// briefly fall through to each entry's fallback stack.
function _registerAllCustomFonts() {
  for (const font of portfolioState.customBalanceFonts ?? []) _registerCustomFont(font);
}

// The default plus the one imported font, if present.
export function getAllBalanceFonts() {
  const custom = (portfolioState.customBalanceFonts ?? []).slice(-1).map(font => ({
    id: font.id,
    label: font.label,
    stack: `'${font.label.replace(/'/g, "\\'")}','Segoe UI',sans-serif`,
  }));
  return [...BALANCE_FONTS, ...custom];
}

function _balanceFontStack() {
  const match = getAllBalanceFonts().find(font => font.id === portfolioState.balanceFontFamily);
  return (match || BALANCE_FONTS[0]).stack;
}

// Repaints the live element (if mounted) and forces a re-fit, since a new
// typeface can measure wider/narrower than the last one at the same text.
function _applyBalanceFont() {
  if (!_balanceAmountEl) return;
  _balanceAmountEl.style.fontFamily = _balanceFontStack();
  _fitBalanceText(_lastBalanceText, true);
}

export function setBalanceFont(id) {
  const match = getAllBalanceFonts().find(font => font.id === id);
  portfolioState.balanceFontFamily = match ? match.id : DEFAULT_BALANCE_FONT_ID;
  save();
  _applyBalanceFont();
}

/**
 * Loads a user-supplied .ttf/.otf/.woff/.woff2 file as the custom Balance
 * font: registers it with the page's FontFaceSet right away and replaces
 * the previous persisted import with its data URL so it
 * survives a reload. Awaiting FontFace.load() before persisting means a
 * corrupt/unsupported file rejects here instead of silently saving a
 * font choice that would never actually render. Doesn't switch the
 * active font itself -- pair with setBalanceFont(id) to select it.
 *
 * @param {File} file
 * @returns {Promise<{id: string, label: string}>}
 */
export async function importBalanceFont(file) {
  if (!file) throw new Error('No file selected');
  if (!CUSTOM_FONT_EXTENSIONS.test(file.name || '')) {
    throw new Error('Choose a .ttf, .otf, .woff, or .woff2 file');
  }
  if (file.size > MAX_CUSTOM_FONT_BYTES) {
    throw new Error(`Font file is too large (max ${(MAX_CUSTOM_FONT_BYTES / (1024 * 1024)).toFixed(1)}MB)`);
  }
  const dataUrl = await _readFileAsDataUrl(file);
  const label = (file.name || 'Custom Font').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 40) || 'Custom Font';
  const id = _uniqueCustomFontId(_slugifyFontLabel(label));

  const face = new FontFace(label, `url(${dataUrl})`);
  try {
    await face.load();
  } catch (error) {
    throw new Error(`That file doesn't look like a valid font (${error?.message || 'failed to parse'})`);
  }
  for (const previous of portfolioState.customBalanceFonts ?? []) {
    const previousFace = _customFontFaces.get(previous.id);
    if (previousFace) document.fonts?.delete(previousFace);
    _customFontFaces.delete(previous.id);
  }
  _customFontFaces.set(id, face);
  document.fonts?.add(face);

  portfolioState.customBalanceFonts = [{ id, label, dataUrl }];
  save();
  return { id, label };
}

/**
 * Removes a previously imported font. If it was the active Balance Font,
 * falls back to the default built-in (Bebas Neue) rather than leaving
 * balanceFontFamily pointing at an id that no longer exists.
 *
 * @param {string} id
 */
export function removeBalanceFont(id) {
  const existing = portfolioState.customBalanceFonts ?? [];
  if (!existing.some(font => font.id === id)) return;
  portfolioState.customBalanceFonts = existing.filter(font => font.id !== id);
  const face = _customFontFaces.get(id);
  if (face) { document.fonts?.delete(face); _customFontFaces.delete(id); }
  if (portfolioState.balanceFontFamily === id) {
    portfolioState.balanceFontFamily = DEFAULT_BALANCE_FONT_ID;
  }
  save();
  _applyBalanceFont();
}

// ── ATH / drawdown + Movers + flow-vs-market ────────────────────────────────
// All three read the same two data sources: _history (already loaded, see
// initBalanceWidget) for the all-time-high badge, and one on-demand
// holdings-history fetch (see holdings-timeline.js) shared between Movers
// and the flow split, since both just need "what did I hold ~24h ago".

const DAILY_ATTRIBUTION_RANGE_MS = 24 * 60 * 60_000;
// Fetched further back than the 24h window itself so a missed poll right
// at the boundary still resolves to something close to "yesterday",
// rather than falling through to nearestSnapshot()'s earliest-available
// fallback and silently comparing against whenever tracking began.
const DAILY_ATTRIBUTION_LOOKBACK_BUFFER_MS = 6 * 60 * 60_000;
// If the closest poll we can find is further from 24h ago than this,
// there's a real gap (a new install, a VPS outage) -- better to hide the
// feature than label a stale comparison "today".
const DAILY_ATTRIBUTION_STALE_TOLERANCE_MS = 36 * 60 * 60_000;
const DAILY_ATTRIBUTION_REFRESH_MS = 5 * 60_000;
const MAX_MOVERS_PER_SIDE = 5; // top N winners + top N losers, each its own column

let _dailyAttribution = null; // { movers, flow, flowConfident } | null
let _lastAthRenderKey = null;
let _lastMoversRenderKey = null;
let _lastFlowRenderKey = null;
let _athCache = null;         // memoized _computeAth() result
let _athCacheLen = -1;        // _history.length it was computed at

export function setAthVisible(value) {
  portfolioState.athVisible = value !== false;
  save();
  _renderAth();
}

export function setMoversVisible(value) {
  portfolioState.moversVisible = value !== false;
  save();
  _renderMovers();
}

export function setFlowVisible(value) {
  portfolioState.flowVisible = value !== false;
  save();
  _renderFlow();
}

// updateBalanceDisplay() (and so _renderAth()) fires once per animation
// frame while the fullscreen chart player is moving (see the
// ResizeObserver comment near _miniChartWidth above) -- a fresh O(n) scan
// of the whole history on every frame would reintroduce exactly the kind
// of hot-path cost that comment describes fixing elsewhere. _history.length
// only changing when a point is actually pushed (or the array is trimmed
// at the MAX_HISTORY_POINTS cap, a rare edge case worth one stale frame
// rather than scanning every frame) makes it a cheap enough proxy for
// "did anything change" to gate the real scan behind.
function _computeAth() {
  if (_history.length === _athCacheLen) return _athCache;
  let peak = -Infinity, peakTs = null;
  let trough = Infinity, troughTs = null;
  for (const point of _history) {
    if (_isHidden(point) || !Number.isFinite(point.v)) continue;
    if (point.v > peak) { peak = point.v; peakTs = point.t; }
    if (point.v < trough) { trough = point.v; troughTs = point.t; }
  }
  _athCacheLen = _history.length;
  _athCache = peak > -Infinity
    ? { high: { value: peak, ts: peakTs }, low: { value: trough, ts: troughTs } }
    : null;
  return _athCache;
}

function _renderAth() {
  if (!_athEl) return;
  if (portfolioState.athVisible === false) { _athEl.style.display = 'none'; return; }
  let i = _history.length - 1;
  while (i >= 0 && _isHidden(_history[i])) i--;
  const last = i >= 0 ? _history[i] : null;
  const extremes = _computeAth();
  // Need a real high AND a real low that differ from each other -- a
  // single-point (or perfectly flat) history has nothing to be extreme
  // relative to yet.
  if (!last || !extremes || !(extremes.high.value > 0) || extremes.high.value === extremes.low.value) {
    _athEl.style.display = 'none';
    return;
  }
  const { up, down } = _getColors();
  const { symbol } = compositionSnapshot();
  const atHigh = last.v >= extremes.high.value - 1e-9;
  const atLow = last.v <= extremes.low.value + 1e-9;
  const drawdownPct = atHigh ? 0 : ((extremes.high.value - last.v) / extremes.high.value) * 100;
  const upliftPct = (atLow || !(extremes.low.value > 0)) ? 0 : ((last.v - extremes.low.value) / extremes.low.value) * 100;
  const highValueText = `${symbol}${_deltaFmt.format(extremes.high.value)}`;
  const lowValueText = `${symbol}${_deltaFmt.format(extremes.low.value)}`;
  const highText = atHigh ? 'At all-time high' : `${highValueText}  ↓${drawdownPct.toFixed(1)}%`;
  const lowText = atLow ? 'At all-time low' : `${lowValueText}  ↑${upliftPct.toFixed(1)}%`;
  // Must include up/down -- text alone is unchanged by a price-color
  // change, so a key built from text only would skip the rebuild below
  // (and so the new row colors) on exactly the event this exists to catch.
  const renderKey = `${highText}|${lowText}|${up}|${down}`;
  _athEl.style.display = '';
  if (renderKey === _lastAthRenderKey) return;
  _lastAthRenderKey = renderKey;

  const highValueEl = document.createElement('span');
  highValueEl.className = 'pt-mini-list-row-values';
  highValueEl.style.color = atHigh ? _hexToRgba(up, 0.85) : _hexToRgba(down, 0.75);
  highValueEl.textContent = highText;
  const highRow = _buildMiniListRow('All-Time High', highValueEl);
  highRow.title = atHigh
    ? 'This is your highest recorded balance'
    : `Down ${drawdownPct.toFixed(1)}% from your all-time high of ${highValueText}`;

  const lowValueEl = document.createElement('span');
  lowValueEl.className = 'pt-mini-list-row-values';
  lowValueEl.style.color = atLow ? _hexToRgba(down, 0.85) : _hexToRgba(up, 0.75);
  lowValueEl.textContent = lowText;
  const lowRow = _buildMiniListRow('All-Time Low', lowValueEl);
  lowRow.title = atLow
    ? 'This is your lowest recorded balance'
    : `Up ${upliftPct.toFixed(1)}% from your all-time low of ${lowValueText}`;

  _athEl.querySelector('.pt-ath-rows').replaceChildren(highRow, lowRow);
}

async function _refreshDailyAttribution() {
  try {
    const now = Date.now();
    const dayAgo = now - DAILY_ATTRIBUTION_RANGE_MS;
    const cache = await loadHoldingsTimeline({
      from: dayAgo - DAILY_ATTRIBUTION_LOOKBACK_BUFFER_MS,
      to: now,
    });
    const snapshot = nearestSnapshot(cache, dayAgo);
    if (!snapshot || Math.abs(dayAgo - snapshot.ts) > DAILY_ATTRIBUTION_STALE_TOLERANCE_MS) {
      _dailyAttribution = null;
    } else {
      const previous = compositionFromHoldingsSnapshot(snapshot.holdings);
      const current = compositionSnapshot();
      _dailyAttribution = computeDailyAttribution(current, previous);
    }
  } catch (error) {
    console.warn('[portfolio-tracker] daily attribution unavailable:', error.message);
    _dailyAttribution = null;
  }
  _renderMovers();
  _renderFlow();
}

function _moverPercentText(pct) {
  return pct == null ? '' : `${pct >= 0 ? '▲ ' : '▼ '}${Math.abs(pct).toFixed(1)}%`;
}

function _buildMiniListRow(labelText, valueEl) {
  const row = document.createElement('div');
  row.className = 'pt-mini-list-row';
  const label = document.createElement('span');
  label.className = 'pt-mini-list-row-symbol';
  label.textContent = labelText;
  row.append(label, valueEl);
  return row;
}

// Builds one of the three mini-lists below the tiles (Movers, Flow,
// All-Time) as a clickable header + a rows container that the header
// folds away. `stateKey` is a persist.js boolean field (moversCollapsed /
// flowCollapsed / athCollapsed) -- undefined reads as "expanded" so no
// migration is needed for anyone who already has this section mounted.
// Collapsing is independent from each section's own *Visible toggle in
// Finance Visuals: that hides the section outright (see _renderMovers/
// _renderFlow/_renderAth's `el.style.display = show ? '' : 'none'`), this
// just folds its rows away while the header stays put as a way back in.
function _mountMiniList(context, id, headText, rowsClassName, stateKey) {
  const el = document.createElement('div');
  el.id = id;

  const head = document.createElement('div');
  head.className = 'pt-mini-list-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;

  const labelEl = document.createElement('span');
  labelEl.className = 'pt-mini-list-head-label';
  labelEl.textContent = headText;

  const chevron = document.createElement('span');
  chevron.className = 'pt-mini-list-chevron';
  chevron.textContent = '▾';

  head.append(labelEl, chevron);

  const rows = document.createElement('div');
  rows.className = `${rowsClassName} pt-mini-list-rows`;

  el.append(head, rows);

  const applyCollapsed = () => {
    const collapsed = portfolioState[stateKey] === true;
    el.classList.toggle('pt-mini-list-collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
  };
  applyCollapsed();
  const stopCollapseSync = onStateLoaded(applyCollapsed);
  if (typeof stopCollapseSync === 'function') context.onCleanup(stopCollapseSync);

  const toggleCollapsed = event => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    portfolioState[stateKey] = portfolioState[stateKey] !== true;
    save();
    applyCollapsed();
  };
  head.addEventListener('click', toggleCollapsed);
  head.addEventListener('keydown', toggleCollapsed);
  context.onCleanup(() => {
    head.removeEventListener('click', toggleCollapsed);
    head.removeEventListener('keydown', toggleCollapsed);
  });

  return { el, rows };
}

function _renderMovers() {
  if (!_moversEl) return;
  // Already sorted by |valueChange| descending (see daily-attribution.js),
  // so filtering by sign keeps each side's own correct ranking without
  // needing to re-sort here.
  const movers = _dailyAttribution?.movers ?? [];
  const winners = movers.filter(m => m.valueChange >= 0).slice(0, MAX_MOVERS_PER_SIDE);
  const losers = movers.filter(m => m.valueChange < 0).slice(0, MAX_MOVERS_PER_SIDE);
  const show = portfolioState.moversVisible !== false && (winners.length > 0 || losers.length > 0);
  _moversEl.style.display = show ? '' : 'none';
  if (!show) return;
  const { symbol } = compositionSnapshot();
  const { up, down } = _getColors();
  // Ties the rebuild to the data AND the current up/down colors, so a
  // price-color change (see updateBalanceDisplay's callers) repaints this
  // list too instead of only the tiles/ATH -- and so calling this every
  // updateBalanceDisplay() pass (including the once-per-frame path during
  // fullscreen scrubbing) is a cheap no-op on frames where neither moved.
  const keyOf = list => list.map(m => `${m.symbol}:${m.valueChange}:${m.percentChange}`).join(',');
  const renderKey = `${symbol}|${up}|${down}|${keyOf(winners)}|${keyOf(losers)}`;
  if (renderKey === _lastMoversRenderKey) return;
  _lastMoversRenderKey = renderKey;

  const buildMoverRow = mover => {
    const isUp = mover.valueChange >= 0;
    const values = document.createElement('span');
    values.className = 'pt-mini-list-row-values';
    values.style.color = _hexToRgba(isUp ? up : down, 0.85);
    values.textContent = `${isUp ? '+' : '-'}${symbol}${_deltaFmt.format(Math.abs(mover.valueChange))}`;
    const row = _buildMiniListRow(mover.symbol, values);
    const pctText = _moverPercentText(mover.percentChange);
    row.title = `${mover.symbol} · ${isUp ? '+' : '-'}${symbol}${_deltaFmt.format(Math.abs(mover.valueChange))}${pctText ? ` (${pctText})` : ''} over the last 24h`;
    return row;
  };

  // Two side-by-side columns (winners left, losers right) instead of one
  // stacked list -- fits the top 5 of each in about the vertical space a
  // single mixed-list column used to take for its top 4.
  const winnersCol = document.createElement('div');
  winnersCol.className = 'pt-movers-col';
  winnersCol.append(...winners.map(buildMoverRow));

  const losersCol = document.createElement('div');
  losersCol.className = 'pt-movers-col';
  losersCol.append(...losers.map(buildMoverRow));

  const rows = _moversEl.querySelector('.pt-movers-rows');
  rows.replaceChildren(winnersCol, losersCol);
}

function _renderFlow() {
  if (!_flowEl) return;
  const flow = _dailyAttribution?.flow;
  const show = portfolioState.flowVisible !== false && !!flow && _dailyAttribution.flowConfident;
  _flowEl.style.display = show ? '' : 'none';
  if (!show) return;
  const { symbol } = compositionSnapshot();
  const { up, down } = _getColors();
  const fmt = amount => `${amount >= 0 ? '+' : '-'}${symbol}${_deltaFmt.format(Math.abs(amount))}`;
  const colorFor = amount => _hexToRgba(amount >= 0 ? up : down, 0.85);
  // Which symbols are behind a bucket, so a wrong-looking number has a
  // concrete "why" on hover instead of just the total.
  const contributorsTitle = contributors => contributors.length
    ? contributors.slice(0, 4).map(c => `${c.symbol} ${fmt(c.amount)}`).join(', ')
    : null;
  const { depositContributors = [], withdrawalContributors = [] } = _dailyAttribution;
  // See _renderMovers' matching comment -- same reasoning, same cheap-noop
  // goal once this is called from updateBalanceDisplay() below.
  const renderKey = `${symbol}|${up}|${down}|${flow.market}|${flow.deposits}|${flow.withdrawals}|${flow.net}`;
  if (renderKey === _lastFlowRenderKey) return;
  _lastFlowRenderKey = renderKey;
  const rows = _flowEl.querySelector('.pt-flow-rows');
  rows.replaceChildren(
    ...[
      ['Market movement', flow.market, null],
      ['Deposits', flow.deposits, contributorsTitle(depositContributors)],
      ['Withdrawals', flow.withdrawals, contributorsTitle(withdrawalContributors)],
      ['Net change', flow.net, null],
    ].map(([label, amount, detail]) => {
      const value = document.createElement('span');
      value.className = 'pt-mini-list-row-values';
      value.style.color = colorFor(amount);
      value.textContent = fmt(amount);
      const row = _buildMiniListRow(label, value);
      row.title = detail ? `${label}: ${fmt(amount)} — ${detail}` : `${label}: ${fmt(amount)}`;
      return row;
    }),
  );
}

// Turns a '#rrggbb' hex string into 'rgba(r,g,b,alpha)'. Falls back to the
// raw input unchanged if it isn't a hex color (e.g. someone configures a
// named color or an already-rgba string via getColors()).
function _hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const _balanceFmt = privateFormat(new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Whole-number formatter for the performance tiles' $ deltas — these are
// small secondary figures next to the % change, not the precise headline
// balance, so no decimals (matches composition.js's own amount formatting).
const _deltaFmt = privateFormat(new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }));

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * Wire the widget to the main chart's shared data. Pure data plumbing, no
 * DOM — safe to call before or after mountBalanceSection() since both just
 * assign into shared module state. Call once, from initTotalChart().
 *
 * @param {object}   opts
 * @param {Array}    opts.history   - reference to the main chart's live _history array
 * @param {Function} opts.isHidden  - (point) => boolean, the main chart's spike-hide filter
 * @param {Function} opts.getColors - () => { up, down } current line colors
 */
export function initBalanceWidget({ history, isHidden, getColors }) {
  _history   = history;
  _isHidden  = isHidden;
  _getColors = getColors;

  // If the sidebar section already mounted before the data layer finished
  // loading, push a repaint now that there's real data/colors to show.
  updateBalanceDisplay();
}


/**
 * Build this widget's DOM into `bodyEl` — the empty `.fin-section-body`
 * handed to us by sidebar-registry.js's registerSection() mount callback
 * (see sidebar.js in this directory). Called exactly once, ever: sidebar
 * sections are mounted once and live for the app's lifetime, there's no
 * unmount() to pair with this.
 *
 * @param {HTMLElement} bodyEl
 */
export function mountBalanceSection(bodyEl, context) {
  _balanceContext = context;
  context.onCleanup(() => {
    _miniChartRO?.disconnect();
    _miniChartRO = null;
    if (_balanceAnimRAF) cancelAnimationFrame(_balanceAnimRAF);
    clearTimeout(_balanceLayerReleaseTimer);
    _balanceAnimRAF = null;
    _balanceLayerReleaseTimer = null;
    _lastBalanceText = null;
    _lastMiniChartKey = null;
    _lastCompositionKey = null;
    _lastBalanceFitTemplate = null;
    clearTimeout(_pendingFitTimer);
    _pendingFitTimer = null;
    _balanceMeasureCtx = null;
    _balanceWidth = 0;
    _balanceEl = _balanceHeroEl = _balanceTextEl = _balanceAmountEl = _miniChartSvgEl = null;
    _hoveringHistory = false;
    _holdingsTimelineCache = null;
    _holdingsTimelineLoading = false;
    _holdingsTimelineRangeKey = null;
    _balanceContext = null;
  });
  // Padding lives on this inner wrapper, NOT on bodyEl itself. bodyEl *is*
  // .fin-section-body — the element sidebar-registry's CSS collapses via
  // max-height:0 when the section is closed. Padding placed directly on
  // that element still renders at max-height:0 (padding isn't clipped by
  // max-height the way content height is), which left a visible sliver of
  // the widget showing even while "closed". Padding on a child instead
  // collapses away cleanly along with everything else under max-height:0.
  const wrap = document.createElement('div');
  wrap.className = 'pt-bal-body pt-bal-ticker-body';
  bodyEl.appendChild(wrap);

  _balanceEl = document.createElement('div');
  _balanceEl.id = 'tc-balance';
  _balanceEl.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:stretch', 'justify-content:flex-start',
    // A deliberate visible gap, not a hairline -- the descender trim
    // below already tightened the hero box itself, so this is the actual
    // breathing room between the balance figure and the tiles.
    'align-self:stretch', 'width:100%', 'gap:10px',
    'user-select:none',
    'transition:opacity 0.4s cubic-bezier(0.22,1,0.36,1)',
  ].join(';');

  _balanceTextEl = document.createElement('div');
  _balanceTextEl.id = 'tc-balance-text';
  _balanceTextEl.style.cssText = [
    // Bottom-aligned rather than centered: the hero box's fixed height
    // exists to give the sparkline room, not to center the number in
    // empty space, so any slack from a smaller auto-fit font collects
    // above the number instead of pushing it away from the tiles below.
    // No per-font offset needed here -- _fitBalanceText sizes the font
    // AND sets line-height to that font's own measured ascent+descent at
    // that size (see below), so the box below always tightly contains
    // whatever's actually selected instead of this element having to
    // guess an overshoot to compensate.
    'display:flex', 'flex-direction:column', 'align-items:stretch', 'justify-content:flex-end',
    'position:absolute', 'top:0', 'left:0', 'right:0', 'bottom:0', 'z-index:2', 'width:100%',
    'pointer-events:none',
  ].join(';');

  _balanceAmountEl = document.createElement('div');
  _balanceAmountEl.id = 'tc-balance-amount';
  _balanceAmountEl.style.cssText = [
    `font-family:${_balanceFontStack()}`,
    // font-size and line-height are both placeholders here, overwritten
    // by _fitBalanceText() on the first real paint -- see that function
    // for why line-height in particular is computed per font rather than
    // left at a fixed ratio.
    'font-size:1.9rem', 'font-weight:400',
    'letter-spacing:0.015em', 'color:rgba(var(--ink-rgb),0.9)',
    'line-height:1', 'font-variant-numeric:tabular-nums',
    'text-align:center', 'width:100%',
    // A wider digit-count's resize is debounced (see _fitBalanceText), so
    // for up to that debounce window the text can be briefly sized for
    // the PREVIOUS, narrower template. nowrap keeps that from wrapping
    // into an overlapping second line in the meantime -- it just
    // overflows horizontally instead, cleanly clipped by the hero's own
    // overflow:hidden until the debounced resize catches up.
    'white-space:nowrap',
    // Isolate per-frame digit repaints from the rest of the glass sidebar.
    'contain:layout paint style',
  ].join(';');
  _balanceAmountEl.textContent = '—';

  _balanceTextEl.appendChild(_balanceAmountEl);

  // The balance amount and sparkline each get a full-width row. This keeps
  // the hierarchy clean and gives the line enough horizontal resolution to
  // remain useful in the narrow sidebar.
  _miniChartSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  _miniChartSvgEl.id = 'tc-mini-chart';
  _miniChartSvgEl.setAttribute('viewBox', `0 0 ${MINI_W} ${MINI_H}`);
  _miniChartSvgEl.setAttribute('preserveAspectRatio', 'none');
  _miniChartSvgEl.style.cssText = [
    'position:absolute', 'inset:0', 'z-index:1',
    'display:block', 'width:100%', 'height:100%',
    'overflow:hidden', 'opacity:.5', 'pointer-events:none',
  ].join(';');
  const applyMiniChartVisible = () => {
    if (_miniChartSvgEl) _miniChartSvgEl.style.display = portfolioState.miniChartVisible === false ? 'none' : 'block';
  };
  applyMiniChartVisible();
  const stopMiniChartSync = onStateLoaded(applyMiniChartVisible);
  if (typeof stopMiniChartSync === 'function') context.onCleanup(stopMiniChartSync);

  _balanceHeroEl = document.createElement('div');
  _balanceHeroEl.id = 'tc-balance-hero';
  _balanceHeroEl.style.cssText = [
    // height is a placeholder until the first _fitBalanceText() call sets
    // the real, content-driven value (see BALANCE_HERO_MIN_PX above). The
    // transition means a resize that does go through (a genuine, settled
    // digit-count change, after _fitBalanceText's debounce) glides rather
    // than snaps -- same easing as _balanceEl's own opacity transition.
    'position:relative', 'width:100%', `height:${BALANCE_HERO_MIN_PX}px`,
    'overflow:hidden', 'isolation:isolate',
    'transition:height 0.45s cubic-bezier(0.22,1,0.36,1)',
  ].join(';');
  _balanceHeroEl.appendChild(_miniChartSvgEl);
  _balanceHeroEl.appendChild(_balanceTextEl);

  // The bundled face may finish decoding after the first balance paint.
  // Refit once it is ready so the fallback font's metrics never leave the
  // final Bebas numerals undersized or overflowing.
  document.fonts?.load('100px "Bebas Neue"').then(() => {
    if (_balanceAmountEl) _fitBalanceText(_lastBalanceText, true);
  }).catch(() => {});
  // Custom fonts persist as data URLs in state, but document.fonts itself
  // is reset on every reload -- re-register them before the first paint,
  // and again on hydration in case portfolioState.customBalanceFonts
  // wasn't populated yet at this synchronous mount time.
  _registerAllCustomFonts();
  _applyBalanceFont();
  const stopBalanceFontSync = onStateLoaded(() => { _registerAllCustomFonts(); _applyBalanceFont(); });
  if (typeof stopBalanceFontSync === 'function') context.onCleanup(stopBalanceFontSync);

  _balanceEl.appendChild(_balanceHeroEl);
  wrap.appendChild(_balanceEl);

  if (_miniChartRO) _miniChartRO.disconnect();
  if ('ResizeObserver' in window) {
    _miniChartRO = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect?.width;
        if (!w) continue;
        if (entry.target === _miniChartSvgEl) {
          _miniChartWidth = w;
          _renderMiniChart();
        } else if (entry.target === _balanceAmountEl) {
          _balanceWidth = w;
          _fitBalanceText(_lastBalanceText, true);
        }
      }
    });
    _miniChartRO.observe(_miniChartSvgEl);
    _miniChartRO.observe(_balanceAmountEl);
  } else {
    // No ResizeObserver support — fall back to a one-off synchronous
    // measurement. Still avoids re-measuring on every render call.
    _miniChartWidth = _miniChartSvgEl.getBoundingClientRect().width || MINI_W;
    _balanceWidth = _balanceAmountEl.getBoundingClientRect().width || 0;
  }

  _balanceEl.style.opacity = _balanceVisible ? '1' : '0';
  updateBalanceDisplay();
}

/** Mount the return tiles and detail lists independently of Balance. */
export function mountPerformanceSection(bodyEl, context) {
  context.onCleanup(() => {
    _performanceCards.clear();
    _performanceEl = _athEl = _moversEl = _flowEl = null;
    _lastAthRenderKey = _lastMoversRenderKey = _lastFlowRenderKey = null;
  });
  const wrap = document.createElement('div');
  wrap.className = 'pt-bal-body';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  bodyEl.appendChild(wrap);

  // Bordered tiles, one per range — restores visual structure, but each
  // tile still shows a single figure (% or $, whichever the toggle
  // currently shows) rather than stacking both, since stacking %+$+range
  // in one box previously read as three unrelated figures rather than
  // one metric. Clicking anywhere in the row flips all tiles between %
  // and $ together, same as the invested/cash bar below.
  _performanceEl = document.createElement('div');
  _performanceEl.id = 'tc-balance-performance';
  _performanceEl.setAttribute('role', 'button');
  _performanceEl.tabIndex = 0;
  _performanceEl.style.cssText = [
    'display:grid', 'grid-template-columns:repeat(3,minmax(0,1fr))',
    'column-gap:6px',
    'width:100%', 'padding:2px 0',
    'font-family:inherit',
    'font-variant-numeric:tabular-nums', 'user-select:none',
    'cursor:pointer',
  ].join(';');

  const PERF_CARD_STYLE = [
    'display:flex', 'flex-direction:column', 'align-items:center', 'gap:2px',
    'padding:6px 4px', 'border-radius:4px',
    'border:1px solid transparent', 'background:rgba(var(--ink-rgb),.03)',
    'transition:background .12s,border-color .12s',
  ].join(';');
  const PERF_HEADER_STYLE = 'color:rgba(var(--ink-rgb),.52);font-size:.62rem;font-weight:600;letter-spacing:.06em;text-align:center;white-space:nowrap';
  // Matches the rest of the sidebar's body text (see markets/styles.css's
  // .watchlist-row-symbol/-price), not the big standalone balance figure
  // above.
  const PERF_DATA_STYLE = 'font-size:.7rem;font-weight:600;letter-spacing:.01em;text-align:center;white-space:nowrap';

  _performanceCards.clear();
  for (const option of CHANGE_RANGES) {
    const card = document.createElement('div');
    card.style.cssText = PERF_CARD_STYLE;
    const headerEl = document.createElement('div');
    headerEl.style.cssText = PERF_HEADER_STYLE;
    headerEl.textContent = option.label;
    const valueEl = document.createElement('div');
    valueEl.style.cssText = PERF_DATA_STYLE;
    card.appendChild(headerEl);
    card.appendChild(valueEl);
    _performanceEl.appendChild(card);
    _performanceCards.set(option.id, { card, valueEl, renderKey: null });
  }

  // The tiles' own DOM is stable (only text/color changes on flip, no
  // innerHTML replacement), so the listener can live directly on it
  // rather than delegating from an outer host the way the composition
  // bar's does. Click, or Enter/Space since this is a role="button".
  const performanceEl = _performanceEl;
  const flipPerformanceMode = event => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    portfolioState.performanceShowAmount = !portfolioState.performanceShowAmount;
    save();
    for (const refs of _performanceCards.values()) refs.renderKey = null;
    _renderPerformance();
  };
  performanceEl.addEventListener('click', flipPerformanceMode);
  performanceEl.addEventListener('keydown', flipPerformanceMode);
  context.onCleanup(() => {
    performanceEl.removeEventListener('click', flipPerformanceMode);
    performanceEl.removeEventListener('keydown', flipPerformanceMode);
  });

  ({ el: _moversEl } = _mountMiniList(context, 'tc-balance-movers', "TODAY'S MOVERS", 'pt-movers-rows', 'moversCollapsed'));
  _moversEl.style.display = 'none'; // shown once _refreshDailyAttribution() has something to show

  ({ el: _flowEl } = _mountMiniList(context, 'tc-balance-flow', 'PORTFOLIO CHANGE · 24H', 'pt-flow-rows', 'flowCollapsed'));
  _flowEl.style.display = 'none';

  ({ el: _athEl } = _mountMiniList(context, 'tc-balance-ath', 'ALL-TIME', 'pt-ath-rows', 'athCollapsed'));
  _athEl.style.display = 'none';

  wrap.appendChild(_performanceEl);
  wrap.appendChild(_moversEl);
  wrap.appendChild(_flowEl);
  wrap.appendChild(_athEl);


  // One shared on-demand fetch feeds both Movers and the flow split (see
  // _refreshDailyAttribution) -- refreshed on a slow timer since "what did
  // I hold 24h ago" doesn't need to be any fresher than that.
  _refreshDailyAttribution();
  context.setInterval(_refreshDailyAttribution, DAILY_ATTRIBUTION_REFRESH_MS);

  updateBalanceDisplay();
}

/**
 * Mount the invested/cash composition bar into a host element owned by
 * another sidebar section — see markets/sidebar.js's Positions section,
 * which is where this now lives (moved out of the Performance section
 * so it sits next to the positions it's summarizing). Data plumbing and
 * render logic, including the hover-driven historical snapshot below,
 * stay in this module; only the DOM location moves.
 *
 * @param {HTMLElement} hostEl
 * @param {object} [context] - registers cleanup so a stale reference
 *   isn't left behind if the host is ever remounted.
 */
export function mountCompositionBar(hostEl, context) {
  _compositionEl = hostEl;
  _lastCompositionKey = null;
  if (context?.onCleanup) {
    context.onCleanup(() => { if (_compositionEl === hostEl) _compositionEl = null; });
  }
  // The bar's own markup gets replaced wholesale on every render (see
  // _renderComposition's innerHTML write below), so this listens on the
  // stable host instead of the bar element itself, which wouldn't
  // survive a repaint. Click (or Enter/Space, since the bar is a
  // role="button") flips the persisted amount/percent mode and forces
  // an immediate repaint — composition.js reads that mode to decide
  // which figure to show.
  const flipCompositionMode = event => {
    if (!event.target.closest('.pt-composition-bar')) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    portfolioState.compositionShowAmount = !portfolioState.compositionShowAmount;
    save();
    _lastCompositionKey = null;
    _renderComposition();
  };
  hostEl.addEventListener('click', flipCompositionMode);
  hostEl.addEventListener('keydown', flipCompositionMode);
  if (context?.onCleanup) {
    context.onCleanup(() => {
      hostEl.removeEventListener('click', flipCompositionMode);
      hostEl.removeEventListener('keydown', flipCompositionMode);
    });
  }
  _renderComposition();
}

/** Show/hide the sidebar balance display. Purely cosmetic — has no effect
 *  on the main chart's layout or price tag. */
export function setBalanceVisible(on) {
  _balanceVisible = !!on;
  if (_balanceEl) _balanceEl.style.opacity = _balanceVisible ? '1' : '0';
}

/** Show/hide just the mini sparkline behind the balance figure (the
 *  figure itself and the Day/Week/Total table stay put either way).
 *  Toggled from sidebar-settings.js's Finance Visuals panel. Setting
 *  this to false doesn't stop the sparkline being computed each tick
 *  (see _renderMiniChart) — only whether it's painted — so it's back
 *  instantly, already current, the moment it's turned on again. */
export function setMiniChartVisible(value) {
  const visible = value !== false;
  portfolioState.miniChartVisible = visible;
  save();
  if (_miniChartSvgEl) _miniChartSvgEl.style.display = visible ? 'block' : 'none';
}

/** Current balance-figure tween duration (ms) — lets other features that
 *  want to "match the balance animation" (e.g. total-chart.js's forming-
 *  candle tween) read the live value instead of duplicating their own
 *  separately-configured duration. */
export function getBalanceAnimMs() {
  return _balanceAnimMs;
}

/**
 * Refresh both the balance figure (tweening toward the latest sampled
 * total) and the mini sparkline. Call whenever _history changes — total-
 * chart.js calls this from its data-sampling loop and from _render(), and
 * it runs regardless of whether the main chart card is visible.
 */
export function updateBalanceDisplay() {
  _renderMiniChart();
  _renderPerformance();
  _renderAth();
  _renderMovers();
  _renderFlow();
  if (!_hoveringHistory) {
    _renderComposition(compositionSnapshot());
  }
  if (!_balanceAmountEl) return;
  if (_history.length < 1) {
    if (_balanceAnimRAF) { cancelAnimationFrame(_balanceAnimRAF); _balanceAnimRAF = null; }
    _balanceAnimValue = null;
    _lastBalanceText = null;
    _balanceAmountEl.textContent = '—';
    return;
  }

  const last   = _history[_history.length - 1];
  const target = last.v;
  const { symbol } = compositionSnapshot();

  // First paint (or coming back from the '—' placeholder) — show it
  // directly, nothing to animate from yet.
  if (_balanceAnimValue == null) {
    _balanceAnimValue = target;
    _renderBalanceValue(target, symbol);
    return;
  }

  // No meaningful change — avoid kicking off a no-op tween.
  if (Math.abs(target - _balanceAnimValue) < 0.005) {
    _renderBalanceValue(target, symbol);
    return;
  }

  _animateBalanceTo(target, symbol);
}

function _renderComposition(composition = compositionSnapshot()) {
  if (!_compositionEl) return;
  const { up, down } = _getColors();
  const showAmount = !!portfolioState.compositionShowAmount;
  const key = [
    up, down, showAmount, composition.invested, composition.cash, composition.unknown, composition.coverage,
    ...composition.assets.map(asset => `${asset.kind}:${asset.symbol}:${asset.value}:${asset.connectionCount}`),
  ].join('|');
  if (key === _lastCompositionKey) return;
  _lastCompositionKey = key;
  _compositionEl.style.setProperty('--pt-invested-fill', _hexToRgba(up, 0.25));
  _compositionEl.style.setProperty('--pt-cash-fill', _hexToRgba(down, 0.25));
  _compositionEl.innerHTML = renderCompositionMarkup(composition, { showAmount });
}

/**
 * Repaint the composition bar + allocation donut with the holdings that
 * were live at `timestamp`, instead of the current live totals. Called by
 * total-chart.js while the user is hovering its cash/invested indicator
 * pane. `range` is that pane's own visible time span -- used (capped to
 * HOLDINGS_TIMELINE_LOOKBACK_MS) to bound the on-demand holdings-history
 * fetch so a long-lived portfolio's entire multi-month history isn't
 * pulled in for one hover.
 *
 * @param {number} timestamp
 * @param {{from: number, to: number}} range
 */
export function showHistoricalComposition(timestamp, { from: rangeFrom, to: rangeTo } = {}) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(rangeTo)) return;
  const from = Math.max(
    Number.isFinite(rangeFrom) ? rangeFrom : -Infinity,
    rangeTo - HOLDINGS_TIMELINE_LOOKBACK_MS,
  );
  _hoveringHistory = true;
  const rangeKey = `${from}|${rangeTo}`;
  if (_holdingsTimelineRangeKey !== rangeKey) {
    _holdingsTimelineRangeKey = rangeKey;
    _holdingsTimelineCache = null;
  }
  if (!_holdingsTimelineCache) {
    if (!_holdingsTimelineLoading) {
      _holdingsTimelineLoading = true;
      loadHoldingsTimeline({ from, to: rangeTo })
        .then(cache => { _holdingsTimelineCache = cache; })
        .catch(error => console.warn('[portfolio-tracker] holdings history lookup failed:', error.message))
        .finally(() => {
          _holdingsTimelineLoading = false;
          if (_hoveringHistory) _paintHistoricalSnapshot(timestamp);
        });
    }
    return;
  }
  _paintHistoricalSnapshot(timestamp);
}

/** Stop showing a hovered point-in-time snapshot and go back to live totals. */
export function clearHistoricalComposition() {
  if (!_hoveringHistory) return;
  _hoveringHistory = false;
  updateBalanceDisplay();
}

function _paintHistoricalSnapshot(timestamp) {
  if (!_hoveringHistory || !_holdingsTimelineCache) return;
  const snapshot = nearestSnapshot(_holdingsTimelineCache, timestamp);
  if (!snapshot) return;
  _renderComposition(compositionFromHoldingsSnapshot(snapshot.holdings));
}

function _lastVisibleIndexAtOrBefore(timestamp) {
  let lo = 0, hi = _history.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (_history[mid].t <= timestamp) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  while (found >= 0 && _isHidden(_history[found])) found--;
  return found;
}

function _periodChange(rangeId) {
  let lastIndex = _history.length - 1;
  while (lastIndex >= 0 && _isHidden(_history[lastIndex])) lastIndex--;
  if (lastIndex < 0) return null;
  const last = _history[lastIndex];
  const range = CHANGE_RANGES.find(option => option.id === rangeId) || CHANGE_RANGES[1];
  let baselineIndex;
  if (range.duration == null) {
    baselineIndex = 0;
    while (baselineIndex < lastIndex && _isHidden(_history[baselineIndex])) baselineIndex++;
  } else {
    baselineIndex = _lastVisibleIndexAtOrBefore(last.t - range.duration);
  }
  if (baselineIndex < 0 || baselineIndex > lastIndex) return null;
  const baseline = _history[baselineIndex].v;
  const amount = last.v - baseline;
  const percent = baseline ? (amount / Math.abs(baseline)) * 100 : null;
  return { percent, amount };
}

function _renderPerformance() {
  if (!_performanceEl) return;
  const { up, down } = _getColors();
  const { symbol } = compositionSnapshot();
  const showAmount = !!portfolioState.performanceShowAmount;
  _performanceEl.setAttribute('aria-pressed', String(showAmount));
  for (const { id, label } of CHANGE_RANGES) {
    const refs = _performanceCards.get(id);
    if (!refs) continue;
    const change = _periodChange(id);
    const available = Number.isFinite(change?.percent);
    const amountAvailable = Number.isFinite(change?.amount);
    const isUp = available ? change.percent >= 0 : (amountAvailable ? change.amount >= 0 : true);
    // No +/- sign here — the tile's background/border/text color already
    // carries the direction, so a redundant sign would just add clutter.
    const percentText = available ? `${Math.abs(change.percent).toFixed(1)}%` : '—';
    const amountText = amountAvailable
      ? `${symbol}${_deltaFmt.format(Math.abs(change.amount))}`
      : '—';
    const text = showAmount ? amountText : percentText;
    const signedPercentText = available ? `${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(1)}%` : '—';
    const signedAmountText = amountAvailable
      ? `${change.amount >= 0 ? '+' : '-'}${symbol}${_deltaFmt.format(Math.abs(change.amount))}`
      : '—';
    const baseColor = (available || amountAvailable) ? (isUp ? up : down) : '#ffffff';
    // A 20% move reaches full emphasis. Small moves remain deliberately
    // subdued while still keeping their sign and value readable.
    const intensity = available ? Math.min(1, Math.abs(change.percent) / 20) : 0;
    const valueColor = _hexToRgba(baseColor, available ? 0.55 + intensity * 0.4 : 0.28);
    const bgColor = _hexToRgba(baseColor, available ? 0.035 + intensity * 0.17 : 0.02);
    const borderColor = _hexToRgba(baseColor, available ? 0.05 + intensity * 0.13 : 0);
    const renderKey = `${text}|${valueColor}|${bgColor}|${borderColor}`;
    if (renderKey === refs.renderKey) continue;
    refs.renderKey = renderKey;
    refs.valueEl.title = `${label} portfolio change: ${signedPercentText}${signedAmountText !== '—' ? ` (${signedAmountText})` : ''} — click to show ${showAmount ? 'percentage' : 'amount'}`;
    refs.valueEl.style.color = valueColor;
    refs.valueEl.textContent = text;
    refs.card.style.background = bgColor;
    refs.card.style.borderColor = borderColor;
  }
}

/**
 * Re-render just the mini sparkline in place, without touching the tween
 * state. Used on window resize, where the data hasn't changed but the
 * SVG's on-screen pixel size has.
 */
export function refreshMiniChartLayout() {
  _renderMiniChart();
}

/**
 * Reset the tween state so the next updateBalanceDisplay() call snaps
 * straight to the new value instead of animating/flashing green or red.
 * Used when the underlying number changes for a reason other than a real
 * market move — e.g. total-chart.js clearing history on a currency switch,
 * where the jump is just a unit change, not a gain or loss.
 */
export function resetBalanceAnim() {
  if (_balanceAnimRAF) { cancelAnimationFrame(_balanceAnimRAF); _balanceAnimRAF = null; }
  clearTimeout(_balanceLayerReleaseTimer);
  _balanceLayerReleaseTimer = null;
  _setBalanceAnimationLayer(false);
  _balanceAnimValue = null;
}

// ── Centre balance figure ───────────────────────────────────────────────────

function _renderBalanceValue(v, symbol) {
  const text = `${symbol}${_balanceFmt.format(v)}`;
  if (text === _lastBalanceText) return;
  _lastBalanceText = text;
  _balanceAmountEl.textContent = text;
  _fitBalanceText(text);
}

function _fitBalanceText(text, force = false) {
  if (!_balanceAmountEl || !text || !(_balanceWidth > 0)) return;
  // Tabular digits keep every tween frame the same width. Measure a stable
  // all-eights template so font sizing changes only when the formatted number
  // gains/loses a character, rather than subtly pulsing as the value animates.
  const template = String(text).replace(/\d/g, '8');
  if (!force && template === _lastBalanceFitTemplate) return;

  // force=true is always a deliberate, one-off trigger (font change,
  // container resize, first paint) -- apply immediately, and let it
  // preempt/cancel any resize an ordinary tick was about to debounce
  // below, since the deliberate change already supersedes it.
  if (force || _lastBalanceFitTemplate === null) {
    clearTimeout(_pendingFitTimer);
    _pendingFitTimer = null;
    _lastBalanceFitTemplate = template;
    _applyBalanceFit(template);
    return;
  }

  // An ordinary balance tick that crosses a digit-count boundary (e.g.
  // $9,999.99 -> $10,000.00, or back) changes `template` and would
  // otherwise resize the figure -- and, since the hero now follows the
  // figure's own height, the box around it and everything below that too
  // -- on every single crossing. A balance hovering right at a round
  // number would visibly jiggle the whole sidebar below it. Debouncing
  // just the resize (the number itself keeps animating/ticking normally
  // in the meantime) means a brief real crossing settles once things
  // hold still, instead of snapping back and forth with every tick.
  clearTimeout(_pendingFitTimer);
  _pendingFitTimer = setTimeout(() => {
    _pendingFitTimer = null;
    _lastBalanceFitTemplate = template;
    _applyBalanceFit(template);
  }, 900);
}

// Does the actual measuring + DOM writes for a given digit template --
// split out of _fitBalanceText so that function can debounce WHEN this
// runs (see above) without duplicating what it does.
function _applyBalanceFit(template) {
  if (!_balanceMeasureCtx) {
    _balanceMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!_balanceMeasureCtx) return;
  const referencePx = 100;
  _balanceMeasureCtx.font = `400 ${referencePx}px ${_balanceFontStack()}`;
  const letterSpacing = Math.max(0, template.length - 1) * referencePx * 0.015;
  const metrics = _balanceMeasureCtx.measureText(template);
  const measured = metrics.width + letterSpacing;
  if (!(measured > 0)) return;

  // How tall THIS font actually renders per unit of font-size, read
  // straight from the canvas metrics for whichever font is currently
  // selected (built-in or imported) -- never assumed or hand-tuned per
  // typeface. A font's own ascent+descent commonly add up to MORE than
  // its nominal font-size (it's part of why "normal" line-height
  // defaults to ~1.2, not 1) -- Bebas Neue included, despite looking
  // like a tight, no-descenders face. Fully reactive: recomputed from
  // this font's real metrics every time _balanceFontStack() changes,
  // rather than a fixed pixel guess that only ever suited one font.
  const naturalRatio = (Number.isFinite(metrics.fontBoundingBoxAscent) && Number.isFinite(metrics.fontBoundingBoxDescent)
    && (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) > 0)
    ? (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / referencePx
    : 1;

  // Font size comes from width alone (how big can this text get before it
  // no longer fits the sidebar) up to a flat design ceiling -- no longer
  // clamped against any box height, because the box below is about to be
  // sized to match THIS, not the other way around.
  const widthFittedPx = (_balanceWidth * 0.96 * referencePx) / measured;
  const fittedPx = Math.max(24, Math.min(widthFittedPx, BALANCE_FONT_MAX_PX));
  _balanceAmountEl.style.fontSize = `${fittedPx.toFixed(2)}px`;
  // Sized to this font's own natural metric height at the fitted size
  // (instead of the usual line-height:1, i.e. exactly fontSize) so the
  // line box actually contains the glyphs' real ascent+descent, whatever
  // that turns out to be for whichever font is selected.
  const contentHeightPx = naturalRatio * fittedPx;
  _balanceAmountEl.style.lineHeight = `${contentHeightPx.toFixed(2)}px`;
  // The hero (sparkline + figure) follows the figure's real rendered
  // height, not a fixed guess -- this is what removes the dead gap above
  // the number for a width-constrained (long/many-digit) balance, while
  // BALANCE_HERO_MIN_PX keeps the sparkline from collapsing to nothing
  // for a very long one. The CSS transition on this element (see its
  // creation) is what makes a genuine resize glide instead of snap, on
  // top of the debouncing above.
  if (_balanceHeroEl) {
    _balanceHeroEl.style.height = `${Math.max(BALANCE_HERO_MIN_PX, contentHeightPx + BALANCE_HERO_VPAD_PX).toFixed(2)}px`;
  }
}

function _setBalanceAnimationLayer(active) {
  if (!_balanceAmountEl) return;
  // One tiny temporary layer is substantially cheaper than invalidating the
  // complete translucent sidebar on every digit change. Release it as soon as
  // the tween settles so idle GPU memory stays flat.
  _balanceAmountEl.style.willChange = active ? 'transform' : '';
  _balanceAmountEl.style.transform = active ? 'translate3d(0,0,0)' : '';
}

/** Tween the on-screen figure from its current value to `target`, easing
 *  out, with a brief colour flash (green = up, red = down) that settles
 *  back to the neutral colour once the number arrives. Re-triggering mid-
 *  flight (e.g. rapid successive updates) cancels the previous frame and
 *  continues smoothly from wherever the number currently sits. */
function _animateBalanceTo(target, symbol) {
  const start = _balanceAnimValue;
  const delta = target - start;
  const isUp  = delta > 0;

  if (_balanceAnimRAF) cancelAnimationFrame(_balanceAnimRAF);
  clearTimeout(_balanceLayerReleaseTimer);
  _balanceLayerReleaseTimer = null;

  // 0ms = animation off — snap straight to the new value, no tween/flash.
  if (_balanceAnimMs <= 0) {
    _setBalanceAnimationLayer(false);
    _balanceAnimValue = target;
    _renderBalanceValue(target, symbol);
    return;
  }

  const { up, down } = _getColors();
  _setBalanceAnimationLayer(true);
  _balanceAmountEl.style.transition = 'color 0.5s ease';
  _balanceAmountEl.style.color = _hexToRgba(isUp ? up : down, BALANCE_FLASH_ALPHA);

  const t0 = performance.now();
  const step = (now) => {
    const p      = Math.min(1, (now - t0) / _balanceAnimMs);
    const eased  = 1 - Math.pow(1 - p, 3); // easeOutCubic
    const value  = start + delta * eased;
    _balanceAnimValue = value;
    // Keep the render pass's symbol for the tween; never walk holdings in RAF.
    _renderBalanceValue(value, symbol);

    if (p < 1) {
      _balanceAnimRAF = requestAnimationFrame(step);
    } else {
      _balanceAnimRAF = null;
      _balanceLayerReleaseTimer = setTimeout(() => {
        _balanceLayerReleaseTimer = null;
        if (_balanceAmountEl) {
          _balanceAmountEl.style.color = BALANCE_COLOR_BASE;
          _setBalanceAnimationLayer(false);
        }
      }, 80);
    }
  };
  _balanceAnimRAF = requestAnimationFrame(step);
}

// ── Mini sparkline ───────────────────────────────────────────────────────────

// This widget is a quick-glance sparkline, not a long-term chart — it only
// ever plots the tail end of the shared history array, regardless of how
// far back _history itself goes. Trimmed to the most recent points before
// rendering. The sidebar sparkline is only ~56px wide, and at this point
// count path complexity is already low, so no further bucket-averaging is
// needed — raise this if it ever needs to show a much longer recent window.
const MINI_MAX_POINTS = 50;

/**
 * Same exponential-moving-average method and slider mapping as the main
 * chart's own smoothing, but operating over a
 * plain flat array rather than a visible-indices list — the mini chart
 * doesn't have a concept of hidden ranges beyond the initial filter, so it
 * doesn't need that indirection.
 */
function _smoothArraySimple(vals, level) {
  if (level <= 0 || vals.length === 0) return vals.slice();
  const alpha = smoothingAlpha(level);
  const out  = vals.slice();
  let ema = vals[0];
  for (let i = 1; i < vals.length; i++) {
    ema = alpha * vals[i] + (1 - alpha) * ema;
    out[i] = ema;
  }
  return out;
}

function _renderMiniChart() {
  if (!_miniChartSvgEl) return;

  // Walk backward from the live edge and stop once we've collected
  // MINI_MAX_POINTS visible points, instead of filtering the ENTIRE
  // _history array just to throw away everything but the tail (the old
  // `_history.filter(...).slice(-MINI_MAX_POINTS)` did the filter first,
  // over the whole array, every time). This function runs on every
  // portfolio tick via updateBalanceDisplay() — called from
  // total-chart.js's _sample() unconditionally, whether or not the chart
  // panel is even mounted — so its cost was scaling with total app
  // lifetime (hours → hundreds/thousands of points, weeks of live ticking
  // → hundreds of thousands), not with the ~50 points actually drawn.
  // Same safety property as the old filter: a pathological run of hidden
  // points right at the live edge just walks further back, same as
  // filter() would have scanned through them too — this only removes the
  // wasted scanning of everything *before* the visible tail.
  const recentPts = [];
  for (let i = _history.length - 1; i >= 0 && recentPts.length < MINI_MAX_POINTS; i--) {
    const p = _history[i];
    if (!_isHidden(p)) recentPts.push(p);
  }
  recentPts.reverse();

  if (recentPts.length < 2) {
    if (_lastMiniChartKey !== 'empty') {
      _lastMiniChartKey = 'empty';
      _miniChartSvgEl.innerHTML = '';
    }
    return;
  }

  // Draw in the SVG's actual on-screen pixel size rather than a small fixed
  // viewBox stretched to fit via preserveAspectRatio="none" — non-uniform
  // scaling like that skews the stroke width unevenly (thin one way, thick
  // the other), which is what made the line look distorted. Use the width
  // tracked by the ResizeObserver (see initBalanceWidget) rather than
  // measuring here directly — this function runs on every render pass,
  // including once per animation frame during the fullscreen player's
  // drag/settle, and a synchronous getBoundingClientRect() read on that
  // hot path was forcing a layout reflow whenever it landed after a
  // pending style write elsewhere on the page.
  const w = Math.max(20, Math.round(_miniChartWidth) || MINI_W);
  const h = MINI_H;
  const isUp  = recentPts[recentPts.length - 1].v >= recentPts[0].v;
  const color = isUp ? _getColors().up : _getColors().down;
  const renderKey = `${w}|${_miniSmoothingLvl}|${color}|${recentPts.map(point => `${point.t}:${point.v}`).join(',')}`;
  if (renderKey === _lastMiniChartKey) return;
  _lastMiniChartKey = renderKey;
  _miniChartSvgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

  let vals = recentPts.map(p => p.v);
  if (_miniSmoothingLvl > 0) vals = _smoothArraySimple(vals, _miniSmoothingLvl);

  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = (max - min) || 1;

  const iw = w - MINI_PAD * 2;
  const ih = h - MINI_PAD * 2;
  const xOf = i => MINI_PAD + (vals.length > 1 ? (i / (vals.length - 1)) * iw : 0);
  const yOf = v => MINI_PAD + ih - ((v - min) / range) * ih;

  const pts      = vals.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
  const linePath = 'M ' + pts.join(' L ');
  const areaPath = `${linePath} L ${xOf(vals.length - 1).toFixed(1)},${(h - MINI_PAD).toFixed(1)} `
                 + `L ${xOf(0).toFixed(1)},${(h - MINI_PAD).toFixed(1)} Z`;

  // Direction is read off the true endpoints of the recent (not full-history)
  // series, and off the raw points rather than the downsampled/averaged
  // buckets — a bucket average can sit slightly off the raw first/last
  // value, which could flip up/down right at the margin.
  _miniChartSvgEl.innerHTML = `
    <path d="${areaPath}" fill="${color}" fill-opacity="0.12" stroke="none"/>
  `;
}

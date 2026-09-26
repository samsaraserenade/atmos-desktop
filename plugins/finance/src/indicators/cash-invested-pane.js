import { areaPath, clipToDomain, downsampleSeries } from '../chart-service.js';
/**
 * js/plugins/portfolio-tracker/src/indicators/cash-invested-pane.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Portfolio-specific indicator: cash vs invested ratio, rendered as a real
 * secondary pane inside the shared charting engine (chart-next.js's
 * `options.panes` contract) -- not a plugin-local <div> bolted under the
 * chart. This is the "portfolio specific indicators" folder: a seam between
 * the shared, portfolio-agnostic charting service (which only knows about
 * generic panes -- it "does not fetch data, know about portfolios, or own
 * a panel") and this plugin's own cash/invested concept. A future
 * portfolio-only indicator belongs alongside this file, not inside the
 * shared service.
 *
 * The engine calls render() with the SAME xOfTime/domain the price plot
 * itself just used for that frame, so this pane's x-axis is pixel-perfect
 * in sync with the price chart above it on every pan/zoom/resize -- no
 * separate range-window bookkeeping, unlike the old plugin-local pane.
 *
 * The actual ratio math (filtering/clamping raw history points, nearest-
 * sample lookup) stays in ../ratio-history-chart.js as plain, chart-
 * agnostic utilities; this file only knows the shared engine's pane shape.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { buildRatioSeries, nearestSampleTime } from '../ratio-history-chart.js';

export const CASH_INVESTED_PANE_ID = 'cash-invested';
export const CASH_INVESTED_PANE_HEIGHT = 56;
export const CASH_INVESTED_PANE_MIN_HEIGHT = 30;
export const CASH_INVESTED_PANE_MAX_HEIGHT = 200;

// A long-lived portfolio's full ratio history can carry far more samples
// than a ~600px pane can usefully draw. Downsample AFTER clipping to the
// visible domain, so resolution stays high for whatever's actually on
// screen instead of being spent on off-screen history.
const MAX_VISIBLE_POINTS = 400;

// Prepared snapshots are immutable and shared by rendering and pointer lookup.
const preparedRatioSeries = new WeakSet();
export function prepareCashInvestedData(data) {
  const series = buildRatioSeries(data);
  for (const point of series) Object.freeze(point);
  Object.freeze(series);
  preparedRatioSeries.add(series);
  return series;
}
function ratioSeries(data) {
  return preparedRatioSeries.has(data) ? data : buildRatioSeries(data);
}
/**
 * The engine's pane render() contract:
 * {data, xOfTime, width, height, domain, textColor, gridColor} -> markup
 *
 * `data` is whatever was last passed to chart.setPaneData(id, points) --
 * here, the raw {t, investedRatio, cashRatio} points from the VPS history.
 */
export function renderCashInvestedPane({ data, xOfTime, width, height = CASH_INVESTED_PANE_HEIGHT, domain, investedColor = '#34d399', cashColor = '#f87171' }) {
  const clipped = downsampleSeries(clipToDomain(ratioSeries(data), domain), MAX_VISIBLE_POINTS);
  if (clipped.length < 2) {
    return `<text x="${(width / 2).toFixed(1)}" y="${(height / 2).toFixed(1)}"
      text-anchor="middle" dominant-baseline="middle" fill="rgba(var(--ink-rgb),.34)" font-size=".62rem"
      font-family="var(--app-font-family, 'Segoe UI', Roboto, sans-serif)">Not enough history yet</text>`;
  }
  const xs = clipped.map(point => xOfTime(point.t));
  const investedTopYs = clipped.map(point => height - height * point.investedRatio);
  const baselineYs = xs.map(() => height);
  const cashTopYs = clipped.map((point, i) => Math.max(0, investedTopYs[i] - height * point.cashRatio));
  const investedArea = areaPath(xs, investedTopYs, baselineYs);
  const cashArea = areaPath(xs, cashTopYs, investedTopYs);
  return `<g class="pt-cash-invested-pane">
    <path d="${investedArea}" fill="${investedColor}" fill-opacity="0.32" stroke="${investedColor}" stroke-opacity="0.55" stroke-width="1"/>
    <path d="${cashArea}" fill="${cashColor}" fill-opacity="0.32" stroke="${cashColor}" stroke-opacity="0.55" stroke-width="1"/>
  </g>`;
}

/**
 * The `options.panes[]` entry total-chart.js hands to createTimeSeriesChart().
 *
 * WHICH panes exist is structural -- fixed at chart-creation time, per the
 * engine's own design -- but two things about this one still need to stay
 * live after that:
 *
 *  - Colors must track the price-color service the same way the price
 *    chart itself does (total-chart.js's presentationOptions() re-reads
 *    getPriceColors() on every price-color change and pushes it into the
 *    chart via chart.setOptions(), which always re-renders). Since a
 *    pane's `render` is just a function reference the engine calls fresh
 *    on every render(), wrapping it in a closure that re-reads colors via
 *    `getColors` each time gets the same "always current" behavior
 *    without any engine support for pane-specific settings.
 *  - Height is user-resizable (the engine's `resizable`/`minHeight`/
 *    `maxHeight` pane-spec fields, and its own drag handle + live
 *    chart.setPaneHeight()/getPaneHeight() API and 'paneResize' event --
 *    see chart-next.js). `initialHeight` seeds it from whatever
 *    total-chart.js last persisted (portfolioState.cashInvestedPaneHeight);
 *    total-chart.js listens for the engine's 'paneResize' event to persist
 *    a live drag, the same way it already does for hiddenRanges.
 *
 * @param {() => {up?: string, down?: string}|null|undefined} [getColors]
 *   Called on every render; pass total-chart.js's `() => getPriceColors?.()`.
 *   Falls through to renderCashInvestedPane()'s own defaults when this is
 *   omitted or returns nothing.
 * @param {number} [initialHeight] A previously-persisted height in px;
 *   falls back to CASH_INVESTED_PANE_HEIGHT when omitted or invalid.
 */
export function createCashInvestedPane(getColors, initialHeight) {
  const height = Number.isFinite(initialHeight) && initialHeight > 0
    ? Math.round(initialHeight) : CASH_INVESTED_PANE_HEIGHT;
  return {
    id: CASH_INVESTED_PANE_ID,
    height,
    minHeight: CASH_INVESTED_PANE_MIN_HEIGHT,
    maxHeight: CASH_INVESTED_PANE_MAX_HEIGHT,
    resizable: true,
    hover: true,
    render(ctx) {
      const colors = (typeof getColors === 'function' && getColors()) || {};
      return renderCashInvestedPane({ ...ctx, investedColor: colors.up, cashColor: colors.down });
    },
  };
}

/**
 * Point-in-time hover support for the pane: given a raw timestamp (from the
 * chart's own chart.coordinateToTime(x) -- the pane shares the price
 * plot's coordinate space, so no pane-local x<->time mapping is needed),
 * resolve it to the nearest actual ratio sample so a caller can look up
 * "what was held at that moment" via holdings-timeline.js.
 */
export function nearestCashInvestedSampleTime(data, targetTime) {
  const series = ratioSeries(data);
  return nearestSampleTime(series, targetTime);
}

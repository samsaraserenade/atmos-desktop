import { nearestSampleTime } from './chart-service.js';
export { nearestSampleTime } from './chart-service.js';
/**
 * js/plugins/portfolio-tracker/src/ratio-history-chart.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure SVG renderer for the invested/cash ratio over time — a thin stacked-
 * area strip beneath the sidebar's allocation donut, showing how the split
 * between invested assets and cash has moved. Kept DOM-free, so it stays
 * independently testable and balance.js only has to hand it points + a size
 * and splice the markup in.
 *
 * Also exports the x<->timestamp mapping it uses internally, so a caller
 * can hit-test a pointer position back to "which sample was this" without
 * duplicating the same math (see balance.js's hover-scrub wiring, which
 * uses this to look up what was actually held at that point in time via
 * ./holdings-timeline.js).
 * ─────────────────────────────────────────────────────────────────────────────
 */

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Filter + sort raw remote-history points (registry.js's
 * getRemoteTotalHistory(), itself sourced from remote.js's loadHistory())
 * down to the {t, investedRatio, cashRatio} triples this renderer needs,
 * dropping anything from a backend too old to send ratios yet.
 */
export function buildRatioSeries(points) {
  return (Array.isArray(points) ? points : [])
    .filter(point => Number.isFinite(point?.t)
      && Number.isFinite(point?.investedRatio)
      && Number.isFinite(point?.cashRatio))
    .map(point => ({
      t: point.t,
      investedRatio: clamp01(point.investedRatio),
      cashRatio: clamp01(point.cashRatio),
    }))
    .sort((a, b) => a.t - b.t);
}


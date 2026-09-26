import { areaPath, nearestSampleTime } from './chart-service.js';
export { nearestSampleTime } from './chart-service.js';
/**
 * js/plugins/portfolio-tracker/src/ratio-history-chart.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure SVG renderer for the invested/cash ratio over time — a thin stacked-
 * area strip beneath the sidebar's allocation donut, showing how the split
 * between invested assets and cash has moved. Kept DOM-free like
 * allocation-chart.js, so it stays independently testable and balance.js
 * only has to hand it points + a size and splice the markup in.
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

/**
 * @param {{points: Array, W: number, H: number, investedColor?: string, cashColor?: string}} options
 * @returns {{markup: string, series: Array<{t:number, investedRatio:number, cashRatio:number}>}}
 */
export function renderRatioHistorySVG({ points, W, H, investedColor = '#34d399', cashColor = '#f87171' }) {
  const series = buildRatioSeries(points);
  if (series.length < 2) {
    return {
      series,
      markup: `<text x="${(W / 2).toFixed(1)}" y="${(H / 2).toFixed(1)}"
        text-anchor="middle" dominant-baseline="middle" fill="rgba(var(--ink-rgb),.34)" font-size=".62rem"
        font-family="var(--app-font-family, 'Segoe UI', Roboto, sans-serif)">Not enough history yet</text>`,
    };
  }

  const t0 = series[0].t, t1 = series.at(-1).t, span = Math.max(1, t1 - t0);
  const xs = series.map(point => ((point.t - t0) / span) * W);
  const investedTopYs = series.map(point => H - H * point.investedRatio);
  const baselineYs = xs.map(() => H);
  const cashTopYs = series.map((point, i) => Math.max(0, investedTopYs[i] - H * point.cashRatio));

  const investedArea = areaPath(xs, investedTopYs, baselineYs);
  const cashArea = areaPath(xs, cashTopYs, investedTopYs);

  return {
    series,
    markup: `<g class="pt-ratio-history-chart">
      <path d="${investedArea}" fill="${investedColor}" fill-opacity="0.32" stroke="${investedColor}" stroke-opacity="0.55" stroke-width="1"/>
      <path d="${cashArea}" fill="${cashColor}" fill-opacity="0.32" stroke="${cashColor}" stroke-opacity="0.55" stroke-width="1"/>
    </g>`,
  };
}

/**
 * Nearest-sample lookup by raw target timestamp (not by pixel position).
 * Shared by timestampForX() below (pane-local x/W mapping) and by any
 * caller that already has a real timestamp from elsewhere — e.g. the
 * chart engine's own chart.coordinateToTime(x), which is what the
 * chart-engine cash/invested pane (src/indicators/cash-invested-pane.js)
 * uses now that the pane shares the price plot's real coordinate space
 * instead of computing its own local x<->time mapping.
 */
export function timestampForX({ series, W, x }) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const t0 = series[0].t, t1 = series.at(-1).t, span = Math.max(1, t1 - t0);
  const ratio = clamp01(x / Math.max(1, W));
  return nearestSampleTime(series, t0 + ratio * span);
}

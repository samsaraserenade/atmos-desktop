// Utilities for time-sorted series. Input arrays are not mutated.
export function areaPath(xs, topYs, bottomYs) {
  if (!xs.length) return '';
  const forward = xs.map((x, i) => `L ${x.toFixed(1)},${topYs[i].toFixed(1)}`).join(' ');
  const back = xs.map((x, i) => `L ${x.toFixed(1)},${bottomYs[i].toFixed(1)}`).reverse().join(' ');
  return `M ${xs[0].toFixed(1)},${bottomYs[0].toFixed(1)} ${forward} ${back} Z`;
}

export function nearestSampleTime(series, target) {
  if (!Array.isArray(series) || !series.length || !Number.isFinite(target)) return null;
  if (series.length === 1) return series[0].t;
  // Nearest sample, not "last at-or-before" — this drives a hover readout,
  // not a strictly-causal lookup, so snapping to whichever sample is
  // visually closest to the pointer feels more accurate than always
  // rounding down to the last confirmed one.
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < target) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(series[lo - 1].t - target) <= Math.abs(series[lo].t - target)) lo -= 1;
  return series[lo].t;
}

export function clipToDomain(series, domain) {
  if (!domain || !Number.isFinite(domain.from) || !Number.isFinite(domain.to) || !series.length) return series;
  let lo = 0, hi = series.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (series[mid].t < domain.from) lo = mid + 1; else hi = mid; }
  const start = lo;
  lo = 0; hi = series.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (series[mid].t <= domain.to) lo = mid + 1; else hi = mid; }
  const end = lo;
  // Keep one extra sample on each side so the area doesn't cut off mid-edge.
  return series.slice(Math.max(0, start - 1), Math.min(series.length, end + 1));
}

export function downsampleSeries(series, maxPoints) {
  if (series.length <= maxPoints) return series;
  const stride = Math.ceil(series.length / maxPoints);
  const kept = series.filter((_, index) => index % stride === 0);
  const last = series.at(-1);
  if (kept.at(-1) !== last) kept.push(last);
  return kept;
}


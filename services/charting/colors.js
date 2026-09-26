/**
 * Small, generic color helpers for charts -- nothing here is finance- or
 * candle-specific, just plain series math shared by every consumer of the
 * charting service.
 */

/**
 * Picks an "up" or "down" color for a series based on whether its latest
 * value sits below its first value -- the same up/down convention
 * candlesticks and price tickers already use, generalized to a plain line.
 *
 * Takes the raw points array plus a `valueOf` extractor (rather than an
 * already-mapped array of numbers) so callers don't have to `.map()`/
 * `.filter()` an entire series -- sometimes tens of thousands of points --
 * just to compare its first and last value. Only those two points are ever
 * read.
 *
 * Fewer than two finite values (or fewer than two points at all) falls
 * back to `up`, since there's no trend to measure yet -- matches every
 * call site this replaced.
 */
export function lineColorForTrend(points, { up, down }, valueOf = point => point.value) {
  if (!Array.isArray(points) || points.length < 2) return up;
  const first = Number(valueOf(points[0]));
  const last = Number(valueOf(points.at(-1)));
  if (!Number.isFinite(first) || !Number.isFinite(last)) return up;
  return last < first ? down : up;
}

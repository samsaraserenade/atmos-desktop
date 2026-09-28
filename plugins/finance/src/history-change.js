/**
 * Changes to the VPS history, so the engine can send views what changed
 * rather than the whole history (src/host/mirror.js, src/registry.js).
 *
 * A change is { from, points }: "every point at or after `from` is
 * replaced by `points`". New samples are a change whose `from` is past the
 * last point, which a view can append to a chart as they are.
 *
 * Histories are arrays of { t, ... } sorted by t, one point per t.
 */

/** Index of the first point at or after `t`. */
export function indexAtOrAfter(points, t) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A new array: `points` with the change applied (`points` is not touched). */
export function applyHistoryChange(points, change) {
  return points.slice(0, indexAtOrAfter(points, change.from)).concat(change.points);
}

/** Same fields, same values. History points hold only numbers, strings and null. */
export function samePoint(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.is(a[key], b[key]));
}

/**
 * The change from `points` to "the points before `from`, then `fresh`"
 * (`fresh` sorted, all at or after `from`), starting where they first
 * differ. null when nothing differs.
 */
export function diffHistoryTail(points, from, fresh) {
  const start = indexAtOrAfter(points, from);
  let same = 0;
  while (same < fresh.length && start + same < points.length && samePoint(points[start + same], fresh[same])) same++;
  if (same === fresh.length && start + same === points.length) return null;
  const firstChanged = Math.min(points[start + same]?.t ?? Infinity, fresh[same]?.t ?? Infinity);
  return { from: firstChanged, points: fresh.slice(same) };
}

/** One change with the effect of `first` and then `second`. */
export function composeHistoryChanges(first, second) {
  const kept = second.from > first.from ? first.points.filter(point => point.t < second.from) : [];
  return { from: Math.min(first.from, second.from), points: kept.concat(second.points) };
}

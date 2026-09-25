/** Pagination state belongs to the room view, independently of its DOM. */
export function createTimelineController({ pageSize, count, paginate, prepend, nearTop, needsFill }) {
  let windowSize = pageSize;
  let loading = false;
  let reachedStart = false;
  let disposed = false;
  async function load({ requireNearTop = true } = {}) {
    if (disposed || loading || reachedStart || (requireNearTop && !nearTop())) return;
    const before = count();
    loading = true;
    try {
      if (windowSize >= before) {
        const ok = await paginate(pageSize);
        if (disposed) return;
        if (!ok) return;
        if (count() === before) { reachedStart = true; return; }
      }
      windowSize = Math.min(windowSize + pageSize, count());
      prepend(windowSize);
    } finally {
      loading = false;
    }
    fill();
  }
  function fill() {
    if (!disposed && !loading && !reachedStart && needsFill()) void load({ requireNearTop: false });
  }
  return {
    get windowSize() { return windowSize; },
    grow(amount) { windowSize += amount; },
    load,
    fill,
    dispose() { disposed = true; },
  };
}

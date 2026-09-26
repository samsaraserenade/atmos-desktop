// Effectively unbounded at the current sampling rate; this is a shared sanity
// ceiling for both aggregate and per-connector histories, not a render limit.
export const MAX_HISTORY_POINTS = 10_000_000;

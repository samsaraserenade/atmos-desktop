'use strict';

// When a candle opens and closes, the way the exchanges draw them (all UTC):
// monthly ones (30 days stands for a month, 90 a quarter, 180 a half year,
// 365 a year) on the first of the month, weekly ones on Monday, Binance's
// 3-day ones a day after the epoch's, everything else a fixed length from
// the epoch. The charting service's candlesticks.js does the same, so live
// candles built here line up with the ones a chart merges.

const DAY_MS = 86_400_000;
const CALENDAR_MONTHS = Object.freeze({ [30 * DAY_MS]: 1, [90 * DAY_MS]: 3, [180 * DAY_MS]: 6, [365 * DAY_MS]: 12 });

function anchorMs(intervalMs) {
  if (intervalMs % (7 * DAY_MS) === 0) return 4 * DAY_MS; // 1970-01-05, a Monday
  if (intervalMs === 3 * DAY_MS) return DAY_MS;
  return 0;
}

function bucketStart(time, intervalMs) {
  const months = CALENDAR_MONTHS[intervalMs];
  if (months) {
    const date = new Date(time);
    const month = date.getUTCMonth();
    return Date.UTC(date.getUTCFullYear(), month - (month % months), 1);
  }
  const anchor = anchorMs(intervalMs);
  return Math.floor((time - anchor) / intervalMs) * intervalMs + anchor;
}

function bucketEnd(start, intervalMs) {
  const months = CALENDAR_MONTHS[intervalMs];
  if (!months) return start + intervalMs;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

module.exports = { CALENDAR_MONTHS, DAY_MS, bucketStart, bucketEnd };

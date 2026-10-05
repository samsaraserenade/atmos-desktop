'use strict';

// TradingView's timeframes: calendar-aligned buckets (months, quarters,
// years, Monday weeks, Binance's 3-day candles), exchange candles merged
// into longer ones, and the range Ctrl+click on a timeframe shows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const candlesticks = () => vm.runInNewContext(read('candlesticks.js').replace(/\bexport\s+/g, '')
  + '\n({ bucketStart, bucketEnd, bucketHistory, mergeCandles, appendCandleSample, CALENDAR_MONTHS })');
const load = async name => import('data:text/javascript;base64,' + Buffer.from(read(name)).toString('base64'));

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const utc = text => Date.parse(`${text}Z`);

test('every TradingView timeframe is a button, in order, with Auto first', async () => {
  const { CHART_INTERVALS, chartControlMarkup, intervalRangeKey } = await load('toolbar.js');
  assert.deepEqual(CHART_INTERVALS.map(item => item.label), ['Auto', '1m', '3m', '5m', '10m', '15m', '30m', '1H', '2H', '4H', '6H', '8H', '12H',
    '1D', '2D', '3D', '5D', '1W', '2W', '1M', '3M', '6M', '1Y']);
  assert.equal(new Set(CHART_INTERVALS.map(item => item.value)).size, CHART_INTERVALS.length);
  assert.equal(CHART_INTERVALS.find(item => item.value === '8h').ms, 8 * HOUR);
  assert.equal(CHART_INTERVALS.find(item => item.value === '1y').ms, 365 * DAY);
  const markup = chartControlMarkup('timeframe');
  assert.match(markup, /title="1 hour candles · Ctrl\+click: show the last 1 hour"[^>]*data-interval="1h">1H</);
  assert.match(markup, /title="Automatic candles · Ctrl\+click: show everything"/);
  assert.equal(intervalRangeKey(CHART_INTERVALS[0]), 'all');
  assert.equal(intervalRangeKey(CHART_INTERVALS.find(item => item.value === '1w')), `last:${7 * DAY}`);
});

test('fixed timeframes start on the epoch; weeks on Monday; 3 days where Binance starts them', () => {
  const { bucketStart, bucketEnd } = candlesticks();
  const t = utc('2026-10-01T13:47:12'); // a Thursday
  assert.equal(bucketStart(t, 10 * MINUTE), utc('2026-10-01T13:40:00'));
  assert.equal(bucketStart(t, 8 * HOUR), utc('2026-10-01T08:00:00'));
  assert.equal(bucketStart(t, 12 * HOUR), utc('2026-10-01T12:00:00'));
  assert.equal(bucketStart(t, DAY), utc('2026-10-01T00:00:00'));
  assert.equal(bucketStart(t, 7 * DAY), utc('2026-09-28T00:00:00')); // Monday
  assert.equal(new Date(bucketStart(t, 14 * DAY)).getUTCDay(), 1);
  assert.equal(bucketEnd(bucketStart(t, 7 * DAY), 7 * DAY), utc('2026-10-05T00:00:00'));
  // Binance's 3-day candles (checked against its API): 26 Sep, 29 Sep, 2 Oct 2026.
  assert.equal(bucketStart(utc('2026-09-28T05:00:00'), 3 * DAY), 1790380800000);
  assert.equal(bucketStart(utc('2026-09-29T00:00:00'), 3 * DAY), 1790640000000);
  // A start is its own bucket's start.
  for (const ms of [MINUTE, 3 * MINUTE, 2 * HOUR, 6 * HOUR, 2 * DAY, 3 * DAY, 5 * DAY, 7 * DAY, 14 * DAY]) {
    const start = bucketStart(t, ms);
    assert.equal(bucketStart(start, ms), start, String(ms));
    assert.equal(bucketStart(bucketEnd(start, ms) - 1, ms), start, String(ms));
  }
});

test('1M, 3M, 6M and 1Y follow the calendar', () => {
  const { bucketStart, bucketEnd } = candlesticks();
  const t = utc('2026-08-17T09:00:00');
  assert.equal(bucketStart(t, 30 * DAY), utc('2026-08-01T00:00:00'));
  assert.equal(bucketEnd(utc('2026-08-01T00:00:00'), 30 * DAY), utc('2026-09-01T00:00:00'));
  assert.equal(bucketEnd(utc('2026-02-01T00:00:00'), 30 * DAY), utc('2026-03-01T00:00:00'));
  assert.equal(bucketStart(t, 90 * DAY), utc('2026-07-01T00:00:00'));
  assert.equal(bucketEnd(utc('2026-10-01T00:00:00'), 90 * DAY), utc('2027-01-01T00:00:00'));
  assert.equal(bucketStart(t, 180 * DAY), utc('2026-07-01T00:00:00'));
  assert.equal(bucketStart(utc('2026-03-31T23:59:59'), 180 * DAY), utc('2026-01-01T00:00:00'));
  assert.equal(bucketStart(t, 365 * DAY), utc('2026-01-01T00:00:00'));
  assert.equal(bucketEnd(utc('2026-01-01T00:00:00'), 365 * DAY), utc('2027-01-01T00:00:00'));
});

test('samples bucket into calendar candles, built whole or one sample at a time', () => {
  const { bucketHistory, appendCandleSample } = candlesticks();
  const points = [['2026-01-30', 10], ['2026-01-31', 12], ['2026-02-01', 11], ['2026-02-28', 9], ['2026-03-02', 14]]
    .map(([day, v]) => ({ t: utc(`${day}T12:00:00`), v }));
  const months = JSON.parse(JSON.stringify(bucketHistory(points, 30 * DAY)));
  assert.deepEqual(months, [
    { t0: utc('2026-01-01T00:00:00'), t1: utc('2026-02-01T00:00:00'), o: 10, h: 12, l: 10, c: 12 },
    { t0: utc('2026-02-01T00:00:00'), t1: utc('2026-03-01T00:00:00'), o: 11, h: 11, l: 9, c: 9 },
    { t0: utc('2026-03-01T00:00:00'), t1: utc('2026-04-01T00:00:00'), o: 14, h: 14, l: 14, c: 14 },
  ]);
  const february = appendCandleSample(bucketHistory([points[2]], 30 * DAY)[0], points[3], 30 * DAY);
  assert.deepEqual(JSON.parse(JSON.stringify(february)), months[1]);
});

test('exchange candles merge into longer ones: first open, extremes, last close, summed volume', () => {
  const { mergeCandles } = candlesticks();
  const hourly = Array.from({ length: 10 }, (_, index) => ({
    t0: index * HOUR, t1: (index + 1) * HOUR, o: 100 + index, h: 110 + index, l: 90 - index, c: 101 + index, volume: 2, exchange: 'binance',
  }));
  const merged = mergeCandles(hourly, 4 * HOUR);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [
    { exchange: 'binance', t0: 0, t1: 4 * HOUR, o: 100, h: 113, l: 87, c: 104, volume: 8 },
    { exchange: 'binance', t0: 4 * HOUR, t1: 8 * HOUR, o: 104, h: 117, l: 83, c: 108, volume: 8 },
    { exchange: 'binance', t0: 8 * HOUR, t1: 12 * HOUR, o: 108, h: 119, l: 81, c: 110, volume: 4 },
  ]);
  // Daily candles into calendar months and Monday weeks.
  const days = Array.from({ length: 40 }, (_, index) => {
    const t0 = utc('2026-01-20T00:00:00') + index * DAY;
    return { t0, t1: t0 + DAY, o: index, h: index + 1, l: index - 1, c: index + 0.5 };
  });
  const months = mergeCandles(days, 30 * DAY);
  assert.deepEqual([...months.map(candle => new Date(candle.t0).toISOString().slice(0, 10))], ['2026-01-01', '2026-02-01']);
  assert.equal(months[0].o, 0);
  assert.equal(months[0].c, 11.5); // 31 January
  assert.equal(months[1].o, 12);
  const weeks = mergeCandles(days, 7 * DAY);
  assert.ok(weeks.every(candle => new Date(candle.t0).getUTCDay() === 1));
  assert.deepEqual(hourly[0], { t0: 0, t1: HOUR, o: 100, h: 110, l: 90, c: 101, volume: 2, exchange: 'binance' }, 'inputs are untouched');
});

test('Ctrl+click range keys show that much time up to the newest point; old range keys still read', async () => {
  const { rangeStartTime } = await load('viewport.js');
  const last = utc('2026-10-01T00:00:00');
  assert.equal(rangeStartTime(`last:${HOUR}`, 0, last), last - HOUR);
  assert.equal(rangeStartTime(`last:${365 * DAY}`, 0, last), last - 365 * DAY);
  assert.equal(rangeStartTime('all', 5, last), 5);
  assert.equal(rangeStartTime('1w', 0, last), last - 7 * DAY);
  assert.equal(rangeStartTime('1m', 0, last), last - 30 * DAY);
  assert.equal(rangeStartTime('ytd', 0, last), new Date(new Date(last).getFullYear(), 0, 1).getTime());
  assert.equal(rangeStartTime('last:abc', 7, last), 7);
});

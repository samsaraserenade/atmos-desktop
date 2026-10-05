'use strict';

// TradingView's timeframes: which candles each exchange is asked for, the
// calendar alignment of weekly and monthly candles, and live candles for
// the intervals a chart subscribes to.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MarketDataService } = require('../main.cjs');
const { CandleEngine } = require('../candle-engine');
const { getMarketHistory, fetchIntervalFor, resolveInterval } = require('../history');
const { parseIntervals } = require('../subscription-manager');
const { bucketStart, bucketEnd } = require('../bucket-time');

class FakeWebSocket { addEventListener() {} close() {} send() {} }
const quiet = { warn() {}, info() {}, log() {} };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const DAY = 86_400_000;
const utc = text => Date.parse(`${text}Z`);

test('each exchange is asked for the timeframe, or the longest it has that fits into it evenly', () => {
  const table = {
    '3m': ['3m', '3m', '1m', '1m'],
    '10m': ['5m', '5m', '5m', '5m'],
    '8h': ['8h', '4h', '1h', '4h'],
    '12h': ['12h', '12h', '6h', '4h'],
    '2d': ['1d', '1d', '1d', '1d'],
    '3d': ['3d', '1d', '1d', '1d'],
    '1w': ['1w', '1w', '1d', '1d'],
    '2w': ['1w', '1w', '1d', '1d'],
    '1mo': ['1mo', '1mo', '1d', '1d'],
    '3mo': ['1mo', '1mo', '1d', '1d'],
    '1y': ['1mo', '1mo', '1d', '1d'],
  };
  for (const [interval, expected] of Object.entries(table)) {
    assert.deepEqual(['binance', 'bybit', 'coinbase', 'kraken'].map(exchange => fetchIntervalFor(exchange, interval)), expected, interval);
  }
  assert.equal(fetchIntervalFor('binance', 'nonsense'), null);
  assert.equal(resolveInterval({ intervalMs: 30 * DAY }), '1mo');
  assert.equal(resolveInterval({ intervalMs: 14 * DAY }), '2w');
  // A chart's custom length: the longest one that fits into it.
  assert.equal(resolveInterval({ interval: 'custom', intervalMs: 45 * 60_000 }), '15m');
  assert.equal(resolveInterval({ intervalMs: 20 * 60_000 }), '10m');
  assert.equal(fetchIntervalFor('binance', resolveInterval({ intervalMs: 20 * 60_000 })), '5m');
  assert.equal(resolveInterval({ intervalMs: 7 * 60_000 }), '1m');
  assert.equal(resolveInterval({ intervalMs: 30_000 }), '5m');
  assert.equal(resolveInterval({}), '5m');
});

test('weekly and monthly candles open where the exchanges open them', () => {
  // Binance's weekly candle (checked against its API) opened Monday 28 Sep 2026.
  assert.equal(bucketStart(utc('2026-10-01T10:00:00'), 7 * DAY), 1790553600000);
  assert.equal(bucketStart(utc('2026-10-01T10:00:00'), 30 * DAY), utc('2026-10-01T00:00:00'));
  assert.equal(bucketEnd(utc('2026-12-01T00:00:00'), 30 * DAY), utc('2027-01-01T00:00:00'));
  assert.equal(bucketStart(utc('2026-11-15T00:00:00'), 90 * DAY), utc('2026-10-01T00:00:00'));
});

test('history for 2W comes as Binance weeks; 1Y as months, ending on the calendar', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(new URL(String(url))); return json(200, [[utc('2026-02-01T00:00:00'), '1', '2', '0.5', '1.5', '3']]); };
  const weeks = await getMarketHistory('BTCUSDT', { exchange: 'binance', interval: '2w' }, fetchImpl);
  assert.equal(urls[0].searchParams.get('interval'), '1w');
  assert.deepEqual([weeks.interval, weeks.intervalMs, weeks.requestedInterval], ['1w', 7 * DAY, '2w']);
  const years = await getMarketHistory('BTCUSDT', { exchange: 'bybit', intervalMs: 365 * DAY }, async url => {
    urls.push(new URL(String(url)));
    return json(200, { retCode: 0, result: { list: [[String(utc('2026-02-01T00:00:00')), '1', '2', '0.5', '1.5', '3']] } });
  });
  assert.equal(urls[1].searchParams.get('interval'), 'M');
  assert.equal(years.interval, '1mo');
  assert.equal(years.candles[0].end, utc('2026-03-01T00:00:00'), 'February ends on 1 March');
});

test('the service tries exchanges that can serve the timeframe at all', async t => {
  const urls = [];
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket, logger: quiet,
    fetchImpl: async url => { urls.push(String(url)); return json(200, [[0, '1', '2', '0.5', '1.5', '3']]); },
  });
  t.after(() => service.close());
  const history = await service.getHistory('BTCUSDT', { interval: '10m', exchanges: ['coinbase'] });
  assert.equal(history.exchange, 'coinbase');
  assert.equal(history.intervalMs, 300_000);
  assert.match(urls[0], /granularity=300/);
});

test('subscribing to a weekly or monthly chart builds those candles live, aligned to the calendar', async t => {
  const urls = [];
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket, logger: quiet, candleThrottleMs: 0,
    fetchImpl: async url => { urls.push(String(url)); return json(200, []); },
  });
  t.after(() => service.close());
  const events = [];
  const handle = service.subscribe('chart', 'BTCUSDT', { candles: true, intervals: [7 * DAY, 30 * DAY], exchanges: ['binance'] }, envelope => events.push(envelope.payload));
  assert.ok(service.candleEngine.intervals.includes(7 * DAY) && service.candleEngine.intervals.includes(30 * DAY));
  service.ingest({ type: 'trade', data: { symbol: 'BTCUSDT', price: 100, quantity: 1, side: 'buy', timestamp: utc('2026-10-01T10:00:00'), tradeId: 1, exchange: 'binance' } });
  const weekly = events.find(item => item.intervalMs === 7 * DAY);
  const monthly = events.find(item => item.intervalMs === 30 * DAY);
  assert.deepEqual([weekly.start, weekly.end, weekly.interval], [utc('2026-09-28T00:00:00'), utc('2026-10-05T00:00:00'), '1w']);
  assert.deepEqual([monthly.start, monthly.end, monthly.interval], [utc('2026-10-01T00:00:00'), utc('2026-11-01T00:00:00'), '1mo']);
  await wait(20);
  // Backfill asks Binance for exactly these candles, never shorter ones.
  assert.ok(urls.some(url => /interval=1w/.test(url)) && urls.some(url => /interval=1M/.test(url)), urls.join('\n'));
  handle.unsubscribe();
  // An interval no exchange serves isn't built.
  service.subscribe('chart-2', 'BTCUSDT', { candles: true, intervals: [7_777], exchanges: ['binance'] }).unsubscribe();
  assert.equal(service.candleEngine.intervals.includes(7_777), false);
});

test('interval names include weeks, calendar months and years', () => {
  assert.deepEqual([...parseIntervals(['1w', '2w', '1mo', '3MO', '1y', '1M'])], [7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY, 60_000]);
  const engine = new CandleEngine({ intervals: [60_000] });
  assert.equal(engine.addInterval(7 * DAY), true);
  assert.equal(engine.addInterval(7 * DAY), false);
  assert.deepEqual(engine.intervals, [60_000, 7 * DAY]);
});

test('custom lengths are cached apart, and `exact` refuses one with no name of its own', async t => {
  const urls = [];
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket, logger: quiet,
    fetchImpl: async url => { urls.push(new URL(String(url))); return json(200, [[0, '1', '2', '0.5', '1.5', '3']]); },
  });
  t.after(() => service.close());
  const first = await service.getHistory('BTCUSDT', { interval: 'custom', intervalMs: 45 * 60_000, exchanges: ['binance'] });
  const second = await service.getHistory('BTCUSDT', { interval: 'custom', intervalMs: 20 * 60_000, exchanges: ['binance'] });
  assert.deepEqual([first.interval, second.interval], ['15m', '5m']);
  assert.deepEqual(urls.map(url => url.searchParams.get('interval')), ['15m', '5m']);
  assert.equal(first.requestedIntervalMs, 45 * 60_000);
  await assert.rejects(getMarketHistory('BTCUSDT', { exchange: 'binance', intervalMs: 45 * 60_000, exact: true }, async () => json(200, [])), /unavailable for binance at 2700000 ms/);
  const exact = await getMarketHistory('BTCUSDT', { exchange: 'binance', intervalMs: 15 * 60_000, exact: true }, async () => json(200, []));
  assert.equal(exact.interval, '15m');
});

test('Coinbase pages back through daily candles for a long timeframe, and only then', async () => {
  const now = utc('2026-10-04T12:00:00');
  const calls = [];
  const fetchImpl = async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const end = Date.parse(parsed.searchParams.get('end') || new Date(now).toISOString());
    // A day per row, newest first, 300 per page, nothing before 2024.
    const rows = [];
    for (let time = end - DAY; rows.length < 300 && time >= utc('2024-01-01T00:00:00'); time -= DAY) rows.push([time / 1000, 1, 2, 1.5, 1.6, 10]);
    return json(200, rows);
  };
  const history = await getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '1mo', limit: 1000, now }, fetchImpl);
  assert.equal(history.interval, '1d');
  assert.ok(calls.length >= 3 && calls.length <= 4, `${calls.length} pages`);
  assert.ok(calls.every(url => url.searchParams.get('granularity') === '86400' && url.searchParams.get('start') && url.searchParams.get('end')));
  for (let index = 1; index < calls.length; index += 1) assert.equal(calls[index].searchParams.get('end'), calls[index - 1].searchParams.get('start'), 'pages meet');
  assert.ok(history.candles.length > 600, `${history.candles.length} daily candles`);
  assert.equal(new Set(history.candles.map(candle => candle.start)).size, history.candles.length, 'no candle twice');
  for (let index = 1; index < history.candles.length; index += 1) assert.ok(history.candles[index].start > history.candles[index - 1].start);
  // Its own timeframe: one request, as before.
  calls.length = 0;
  await getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '1d', limit: 1000, now }, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('start'), null);
});

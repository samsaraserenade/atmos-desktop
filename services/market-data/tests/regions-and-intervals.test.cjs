'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MarketDataService } = require('../main.cjs');
const { ReliableWebSocket } = require('../websocket-manager');
const { getMarketHistory } = require('../history');
const { parseIntervals } = require('../subscription-manager');

class FakeWebSocket { addEventListener() {} close() {} send() {} }
const quiet = { warn() {}, info() {}, log() {} };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let tradeId = 0;
const trade = (price, timestamp, exchange = 'binance') => ({
  type: 'trade',
  data: { symbol: 'BTCUSDT', price, quantity: 1, side: 'buy', timestamp, tradeId: ++tradeId, exchange },
});

test('intervals accept names and milliseconds and reject nonsense', () => {
  assert.deepEqual([...parseIntervals(['5m', '1h', 86_400_000])], [300_000, 3_600_000, 86_400_000]);
  assert.equal(parseIntervals(undefined), null);
  assert.throws(() => parseIntervals(['soon']), /no valid interval/);
  assert.throws(() => parseIntervals('5m'), /must be an array/);
});

test('a candle subscription receives only its intervals and no trades', t => {
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket, fetchImpl: null, logger: quiet, candleThrottleMs: 0 });
  t.after(() => service.close());
  const events = [];
  const handle = service.subscribe('chart', 'BTCUSDT', { candles: true, intervals: ['5m'], exchanges: ['binance'] }, envelope => events.push(envelope));
  assert.deepEqual(handle.intervals, [300_000]);
  service.ingest(trade(100, 1_000));
  service.ingest(trade(101, 2_000));
  assert.ok(events.length > 0);
  assert.ok(events.every(item => item.event === 'market-data:candle' && item.payload.intervalMs === 300_000));
  handle.unsubscribe();
});

test('forming candle updates are coalesced; closed candles go out at once', async t => {
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket, fetchImpl: null, logger: quiet, candleThrottleMs: 40 });
  t.after(() => service.close());
  const events = [];
  const handle = service.subscribe('chart', 'BTCUSDT', { candles: true, intervals: ['1m'], exchanges: ['binance'] }, envelope => events.push(envelope.payload));
  for (let index = 0; index < 50; index += 1) service.ingest(trade(100 + index, 1_000 + index));
  assert.equal(events.length, 1, 'the first update is sent at once, the rest wait');
  await wait(60);
  assert.equal(events.length, 2, 'one trailing update carries the newest state');
  assert.equal(events[1].close, 149);

  service.ingest(trade(200, 2_000)); // queued: sent < 40 ms ago? no, so immediate
  service.ingest(trade(201, 2_001)); // queued behind it
  service.ingest(trade(300, 61_000)); // opens the next bar: closes the previous one
  const closed = events.find(item => item.closed);
  assert.ok(closed, 'the closed bar is not delayed');
  assert.equal(closed.close, 201);
  await wait(60);
  assert.equal(events.at(-1).close, 300);
  assert.equal(events.filter(item => !item.closed && item.start === 0 && item.close === 201).length, 0, 'the pending update for the closed bar was dropped');
  handle.unsubscribe();
});

test('unsubscribing cancels pending throttled updates', async t => {
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket, fetchImpl: null, logger: quiet, candleThrottleMs: 30 });
  t.after(() => service.close());
  const events = [];
  const handle = service.subscribe('chart', 'BTCUSDT', { candles: true, intervals: ['1m'], exchanges: ['binance'] }, envelope => events.push(envelope));
  service.ingest(trade(100, 1_000));
  service.ingest(trade(101, 1_001));
  handle.unsubscribe();
  await wait(50);
  assert.equal(events.length, 1);
});

test('candle backfill fetches only the subscribed intervals', async t => {
  const urls = [];
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket, logger: quiet,
    fetchImpl: async url => { urls.push(String(url)); return json(200, [[0, '1', '2', '0.5', '1.5', '3']]); },
  });
  t.after(() => service.close());
  const handle = service.subscribe('chart', 'BTCUSDT', { candles: true, intervals: ['15m'], exchanges: ['binance'] });
  await wait(20);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /interval=15m/);
  handle.unsubscribe();
});

test('history falls back past exchanges that refuse the region and marks them unavailable', async t => {
  const urls = [];
  const statuses = [];
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket, logger: quiet,
    fetchImpl: async url => {
      const href = String(url);
      urls.push(href);
      if (href.includes('binance')) return json(451, { msg: 'Service unavailable from a restricted location' });
      if (href.includes('bybit')) return json(403, {});
      return json(200, [[600, '1', '3', '0.5', '2', '10'], [300, '0.9', '1.1', '0.8', '1', '5']]);
    },
  });
  t.after(() => service.close());
  service.on('market-data:connection-status', status => statuses.push(status));
  const history = await service.getHistory('BTCUSDT', { interval: '5m', exchanges: ['binance', 'bybit', 'kraken', 'coinbase'] });
  assert.equal(history.exchange, 'coinbase');
  assert.deepEqual(history.candles.map(bar => bar.close), [1, 2]);
  assert.equal(service.websockets.isBlocked('binance'), true);
  assert.equal(service.websockets.isBlocked('bybit'), true);
  assert.ok(statuses.some(status => status.exchange === 'binance' && status.status === 'unavailable'));
  assert.match(service.getStatus().providers.binance.reason, /region/);

  // Next request skips the blocked exchanges without asking them again.
  urls.length = 0;
  await service.getHistory('BTCUSDT', { interval: '1h', exchanges: ['binance', 'bybit', 'coinbase'] });
  assert.ok(urls.every(url => url.includes('coinbase')));
});

test('a named exchange is not substituted', async t => {
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket, logger: quiet, fetchImpl: async () => json(451, {}) });
  t.after(() => service.close());
  await assert.rejects(service.getHistory('BTCUSDT', { exchange: 'binance' }), /451/);
});

test('a socket that never opens triggers a region probe; 451 blocks, 200 does not', async t => {
  let status = 451;
  const probes = [];
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket, logger: quiet, fetchImpl: async url => { probes.push(String(url)); return json(status, {}); } });
  t.after(() => service.close());
  status = 200;
  assert.equal(await service._checkRegion('bybit'), false);
  assert.equal(service.websockets.isBlocked('bybit'), false);
  assert.equal(await service._checkRegion('bybit'), false, 'probes are spaced out');
  assert.equal(probes.length, 1);
  status = 451;
  service.websockets.emit('connect-failed', { exchange: 'binance' });
  await wait(5);
  assert.match(probes.at(-1), /fapi\.binance\.com/);
  assert.equal(service.websockets.isBlocked('binance'), true);
  assert.equal(await service._checkRegion('kraken'), false, 'exchanges without a probe are never blocked');
});

test('ReliableWebSocket reports a failed handshake and stays down while blocked', async () => {
  const sockets = [];
  class Socket {
    constructor() { this.listeners = {}; sockets.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() {}
  }
  const socket = new ReliableWebSocket({ id: 'x', url: () => 'wss://x', WebSocketImpl: Socket, backoff: { initial: 5, maximum: 5, jitter: 0 } });
  const failed = [];
  socket.on('connect-failed', details => failed.push(details));
  socket.start();
  sockets[0].listeners.close({ code: 1006 });
  assert.deepEqual(failed, [{ code: 1006 }]);
  socket.block('unavailable in this region (HTTP 451)', 20);
  assert.equal(socket.getHealth().status, 'unavailable');
  await wait(10);
  assert.equal(sockets.length, 1, 'no reconnect while blocked');
  await wait(20);
  assert.equal(sockets.length, 2, 'retries after the block expires');
  socket.stop();
});

test('Kraken history uses its pair names and minute intervals', async () => {
  let requested;
  const result = await getMarketHistory('BTCUSDT', { exchange: 'kraken', interval: '4h', limit: 5 }, async url => {
    requested = new URL(String(url));
    return json(200, { error: [], result: { XBTUSDT: [[14_400, '10', '12', '9', '11', '10.5', '7', 3], [0, '8', '10', '7', '10', '9', '4', 2]], last: 14_400 } });
  });
  assert.equal(requested.hostname, 'api.kraken.com');
  assert.equal(requested.searchParams.get('pair'), 'XBTUSDT');
  assert.equal(requested.searchParams.get('interval'), '240');
  assert.deepEqual(result.candles.map(bar => [bar.start, bar.open, bar.close, bar.volume]), [[0, 8, 10, 4], [14_400_000, 10, 11, 7]]);
  await assert.rejects(getMarketHistory('BTCUSDT', { exchange: 'kraken', interval: '3m' }, async () => json(200, {})), /unavailable for kraken/);
});

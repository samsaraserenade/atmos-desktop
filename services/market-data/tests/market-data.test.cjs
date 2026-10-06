'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const { normalize, normalizeTrade } = require('../normalizer');
const { CandleEngine } = require('../candle-engine');
const { SubscriptionManager } = require('../subscription-manager');
const { MarketState } = require('../market-state');
const { getMarketHistory, resolveInterval } = require('../history');
const { BinanceAdapter } = require('../exchanges/binance');
const { BybitAdapter } = require('../exchanges/bybit');
const { KrakenAdapter } = require('../exchanges/kraken');
const { CoinbaseAdapter, toCoinbase } = require('../exchanges/coinbase');
const activate = require('../main.cjs');
const { MarketDataService } = activate;

class FakeWebSocket { addEventListener() {} close() {} send() {} }

test('service declares CoreV2 discovery and its files', () => {
  const extension = JSON.parse(fs.readFileSync(path.join(root, 'extension.json')));
  const service = extension.contract;
  assert.equal(extension.apiVersion, 2);
  assert.equal(extension.requires['extensions.manifest'], 1);
  assert.match(extension.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(service.events, [...activate.EVENT_NAMES]);
  for (const file of ['main.cjs', 'websocket-manager.js', 'normalizer.js', 'market-state.js', 'history.js', 'candle-engine.js', 'subscription-manager.js', 'exchanges/binance.js', 'exchanges/bybit.js', 'exchanges/kraken.js', 'exchanges/coinbase.js']) {
    assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
  }
});

test('historical candles default to five minutes and normalize provider rows', async () => {
  let requestedUrl;
  const result = await getMarketHistory('btc/usdt', { limit: 2 }, async url => {
    requestedUrl = String(url);
    return { ok: true, json: async () => [[300_000, '100', '110', '90', '105', '12'], [0, '80', '101', '70', '100', '8']] };
  });
  assert.match(requestedUrl, /interval=5m/);
  assert.equal(resolveInterval({ intervalMs: 300_000 }), '5m');
  assert.equal(result.intervalMs, 300_000);
  assert.deepEqual(result.candles.map(item => item.close), [100, 105]);
});

test('service coalesces and briefly caches identical history requests', async t => {
  let requests = 0;
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, json: async () => [[0, '80', '101', '70', '100', '8'], [300_000, '100', '110', '90', '105', '12']] };
    },
  });
  t.after(() => service.close());
  const [first, second] = await Promise.all([
    service.getHistory('BTCUSDT', { interval: '5m', limit: 1_000 }),
    service.getHistory('BTCUSDT', { interval: '5m', limit: 1_000 }),
  ]);
  const third = await service.getHistory('BTCUSDT', { interval: '5m', limit: 1_000 });
  assert.equal(requests, 1);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('normalizer removes provider-specific trade shapes and accepts only trades', () => {
  assert.deepEqual(normalizeTrade({ symbol: 'btc/usdt', price: '100000', quantity: '0.5', side: 'BUY', timestamp: '123', exchange: 'Binance' }), {
    symbol: 'BTCUSDT', price: 100000, quantity: 0.5, side: 'buy', aggressor: 'buyer', exchange: 'binance', timestamp: 123, tradeId: undefined,
  });
  assert.throws(() => normalizeTrade({ symbol: 'BTCUSDT', price: 0, quantity: 1, side: 'buy', exchange: 'x' }), /positive/);
  assert.throws(() => normalize('orderbook', {}), /unsupported market event type/);
});

test('candle engine computes OHLC, side volume and delta', () => {
  const candles = new CandleEngine({ intervals: [60_000] });
  candles.ingest({ symbol: 'BTCUSDT', price: 100, quantity: 2, side: 'buy', exchange: 'binance', timestamp: 1_000 });
  candles.ingest({ symbol: 'BTCUSDT', price: 90, quantity: 0.5, side: 'sell', exchange: 'binance', timestamp: 2_000 });
  const candle = candles.get('BTCUSDT', 60_000, 'binance');
  assert.equal(candle.interval, '1m');
  assert.deepEqual(
    [candle.open, candle.high, candle.low, candle.close, candle.volume, candle.tradeCount, candle.buyVolume, candle.sellVolume, candle.delta, candle.closed],
    [100, 100, 90, 90, 2.5, 2, 2, 0.5, 1.5, false],
  );
  const next = candles.ingest({ symbol: 'BTCUSDT', price: 95, quantity: 1, side: 'buy', exchange: 'binance', timestamp: 61_000 });
  assert.equal(next.closed.length, 1);
  assert.equal(next.closed[0].close, 90);
  // R49: the first candle since watching began is seen only in part; the
  // next from its start; a dropped feed makes what's forming partial.
  assert.equal(next.closed[0].partial, true);
  assert.equal(candles.get('BTCUSDT', 60_000, 'binance').partial, undefined);
  candles.markPartial('binance');
  assert.equal(candles.get('BTCUSDT', 60_000, 'binance').partial, true);
});

test('market state produces scope-aware, versioned snapshots with freshness', () => {
  let now = 10_000;
  const state = new MarketState({ staleAfterMs: 1_000, retentionMs: 2_000, now: () => now });
  state.commitConnection({ exchange: 'binance', status: 'connected', timestamp: now });
  state.commitConnection({ exchange: 'kraken', status: 'connected', timestamp: now });
  state.commitTrade({ symbol: 'BTCUSDT', exchange: 'binance', price: 100, quantity: 2, side: 'buy', timestamp: 9_900 }, [
    { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 0, end: 60_000, firstTradeAt: 9_900, lastTradeAt: 9_900, open: 100, high: 100, low: 100, close: 100, volume: 2, tradeCount: 1, buyVolume: 2, sellVolume: 0, delta: 2, closed: false },
  ]);
  state.commitTrade({ symbol: 'BTCUSDT', exchange: 'kraken', price: 101, quantity: 1, side: 'sell', timestamp: 9_950 }, [
    { symbol: 'BTCUSDT', exchange: 'kraken', interval: '1m', intervalMs: 60_000, start: 0, end: 60_000, firstTradeAt: 9_950, lastTradeAt: 9_950, open: 101, high: 101, low: 101, close: 101, volume: 1, tradeCount: 1, buyVolume: 0, sellVolume: 1, delta: -1, closed: false },
  ]);

  const binanceOnly = state.getSnapshot('BTCUSDT', { exchanges: ['binance'] });
  assert.equal(binanceOnly.price.value, 100);
  assert.deepEqual(binanceOnly.scope.exchanges, ['binance']);

  const aggregate = state.getSnapshot('BTCUSDT', { exchanges: ['binance', 'kraken'] });
  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.price.value, 101);
  assert.equal(aggregate.candles['1m'].open, 100);
  assert.equal(aggregate.candles['1m'].close, 101);
  assert.equal(aggregate.candles['1m'].volume, 3);
  assert.equal(aggregate.candles['1m'].delta, 1);
  assert.equal(aggregate.status, 'live');
  assert.equal(aggregate.orderbooks, undefined, 'order books are not part of this release');
  assert.equal(aggregate.analytics, undefined, 'analytics are not part of this release');
  now += 1_001;
  assert.equal(state.getSnapshot('BTCUSDT').status, 'stale');
});

test('market state combines a live forming candle with its closed-bar history', () => {
  const state = new MarketState({ now: () => 1_000_000 });

  // Historical backfill lands before any live trade: the snapshot should
  // already expose it as the current bar (closed=true), tail-first.
  state.seedCandleHistory('BTCUSDT', 'binance', 60_000, [
    { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 0, end: 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, closed: true },
    { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 60_000, end: 120_000, open: 1.5, high: 1.6, low: 1.4, close: 1.5, volume: 8, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, closed: true },
  ]);
  let candle = state.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'];
  assert.equal(candle.start, 60_000);
  assert.equal(candle.closed, true);
  assert.deepEqual(candle.history.map(bar => bar.start), [0]);

  // A live trade closes the bar at 120_000 and opens one at 180_000.
  const closedLiveCandle = { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 120_000, end: 180_000, firstTradeAt: 121_000, lastTradeAt: 121_000, open: 1.5, high: 1.7, low: 1.4, close: 1.6, volume: 5, tradeCount: 1, buyVolume: 5, sellVolume: 0, delta: 5, closed: true };
  const formingCandle = { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 180_000, end: 240_000, firstTradeAt: 181_000, lastTradeAt: 181_000, open: 2, high: 2, low: 2, close: 2, volume: 1, tradeCount: 1, buyVolume: 1, sellVolume: 0, delta: 1, closed: false };
  state.commitTrade(
    { symbol: 'BTCUSDT', exchange: 'binance', price: 2, quantity: 1, side: 'buy', timestamp: 181_000 },
    [formingCandle],
    [closedLiveCandle],
  );

  candle = state.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'];
  assert.equal(candle.start, 180_000);
  assert.equal(candle.closed, false, 'the live forming candle stays the current bar');
  const series = [...candle.history, candle];
  assert.deepEqual(series.map(bar => bar.start), [0, 60_000, 120_000, 180_000], 'history + current bar is one gapless, ascending series');
  assert.deepEqual(series.map(bar => bar.close), [1.5, 1.5, 1.6, 2]);

  // A REST backfill landing later must never overwrite the bar this process
  // already built live from its own trades.
  state.seedCandleHistory('BTCUSDT', 'binance', 60_000, [
    { symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start: 120_000, end: 180_000, open: 999, high: 999, low: 999, close: 999, volume: 0, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, closed: true },
  ]);
  candle = state.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'];
  assert.equal(candle.history.find(bar => bar.start === 120_000).close, 1.6, 'live-built bar wins over a later REST backfill for the same start');
});

test('subscriptions return an immediate scope-aware snapshot', t => {
  const service = new MarketDataService({ WebSocketImpl: FakeWebSocket });
  t.after(() => service.close());
  const subscription = service.subscribe('test-consumer', 'btcusdt', { trades: true, exchanges: ['binance'] });
  assert.equal(subscription.snapshot.symbol, 'BTCUSDT');
  assert.deepEqual(subscription.snapshot.scope.exchanges, ['binance']);
  assert.equal(subscription.snapshot.status, 'empty');
  subscription.unsubscribe();
});

test('subscribing for candles backfills history from REST and merges it into the live snapshot', async t => {
  const service = new MarketDataService({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: true, json: async () => [[0, '100', '110', '90', '105', '12'], [60_000, '105', '108', '100', '106', '9']] }),
  });
  t.after(() => service.close());

  const historyEvents = [];
  const onHistory = payload => historyEvents.push(payload);
  service.on('market-data:candle-history', onHistory);
  const subscription = service.subscribe('candle-consumer', 'btcusdt', { candles: true, exchanges: ['binance'] });
  assert.equal(subscription.snapshot.candlesByExchange.binance, undefined, 'no live trade has landed yet, so the synchronous snapshot has nothing to merge in from');

  // Backfill runs per candle interval the engine tracks -- wait for all of
  // them rather than racing on the first.
  while (historyEvents.length < service.candleEngine.intervals.length) await new Promise(resolve => setTimeout(resolve, 5));
  service.off('market-data:candle-history', onHistory);
  assert.ok(historyEvents.every(event => event.symbol === 'BTCUSDT' && event.exchange === 'binance'));

  const snapshot = service.getSnapshot('BTCUSDT', { exchanges: ['binance'] });
  const candle = snapshot.candlesByExchange.binance['1m'];
  assert.equal(candle.closed, true, 'pure backfill before any live trade surfaces as the current (closed) bar');
  assert.deepEqual([...candle.history, candle].map(bar => bar.close), [105, 106]);

  // A second subscription for the same symbol/exchange/interval must not
  // re-fetch -- getHistory's own cache plus the seeded-tracking set dedupe it.
  const secondEvent = new Promise(resolve => { service.once('market-data:candle-history', resolve); setTimeout(() => resolve(null), 50); });
  service.subscribe('candle-consumer-2', 'btcusdt', { candles: true, exchanges: ['binance'] });
  assert.equal(await secondEvent, null, 'already-seeded symbol/exchange/interval does not re-fetch');

  subscription.unsubscribe();
  service.unsubscribe('candle-consumer-2');
});

test('subscription manager shares the upstream trade feed and ignores unknown feeds', () => {
  const providers = [{ id: 'one', supports: feed => feed === 'trades' }, { id: 'two', supports: feed => feed === 'trades' }];
  const manager = new SubscriptionManager({ providers });
  const a = manager.subscribe('a', 'btcusdt', { candles: true, orderbook: true, liquidations: true });
  manager.subscribe('b', 'BTC-USDT', { trades: true });
  assert.deepEqual(a.feeds, ['candles']);
  const requirements = manager.requirements();
  assert.deepEqual([...requirements.get('one').get('BTCUSDT')], ['trades']);
  assert.deepEqual([...requirements.get('two').get('BTCUSDT')], ['trades']);
  assert.equal(manager.status().consumers, 2);
  assert.equal(manager.matches('b', 'market-data:candle', { symbol: 'BTCUSDT', exchange: 'one' }), false);
  assert.equal(manager.matches('a', 'market-data:candle', { symbol: 'BTCUSDT', exchange: 'one' }), true);
  manager.unsubscribe('a');
  assert.deepEqual([...manager.requirements().get('one').get('BTCUSDT')], ['trades']);
});

test('exchange adapters translate trade payloads at their boundary and stream trades only', () => {
  const collect = adapter => {
    const events = [];
    adapter.on('event', event => events.push(event));
    return events;
  };
  const binance = new BinanceAdapter({ WebSocketImpl: class {} });
  const binanceEvents = collect(binance);
  binance._message(JSON.stringify({ data: { e: 'aggTrade', s: 'BTCUSDT', p: '100', q: '2', m: false, T: 10, a: 1 } }));
  assert.deepEqual(binanceEvents[0].data, { symbol: 'BTCUSDT', price: '100', quantity: '2', side: 'buy', timestamp: 10, tradeId: 1, exchange: 'binance' });
  binance.subscriptions = new Map([['BTCUSDT', new Set(['trades'])]]);
  assert.equal(binance._url(), 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade');

  const bybit = new BybitAdapter({ WebSocketImpl: class {} });
  const bybitEvents = collect(bybit);
  bybit._message(JSON.stringify({ topic: 'publicTrade.BTCUSDT', data: [{ s: 'BTCUSDT', p: '99', v: '1', S: 'Sell', T: 12, i: 'x' }] }));
  bybit._message(JSON.stringify({ topic: 'orderbook.50.BTCUSDT', type: 'delta', ts: 12, data: { s: 'BTCUSDT', b: [], a: [], u: 1 } }));
  assert.equal(bybitEvents.length, 1);
  assert.equal(bybitEvents[0].data.side, 'sell');

  const kraken = new KrakenAdapter({ WebSocketImpl: class {} });
  const krakenEvents = collect(kraken);
  kraken._message(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USDT', side: 'sell', qty: 3, price: 101, trade_id: 2, timestamp: '2026-01-01T00:00:00.000Z' }] }));
  assert.equal(krakenEvents[0].data.symbol, 'BTCUSDT');
  assert.equal(require('../exchanges/kraken').toKraken('BTCUSDT'), 'BTC/USDT');
  for (const adapter of [binance, bybit, kraken]) {
    assert.equal(adapter.supports('trades'), true);
    assert.equal(adapter.supports('orderbook'), false);
    assert.equal(adapter.supports('liquidations'), false);
  }
});

test('Core activation exposes only scoped handlers and market-data capability', async () => {
  const handlers = new Map();
  let capability;
  let shutdown;
  const service = await activate({
    root,
    app: { once: (name, fn) => { assert.equal(name, 'before-quit'); shutdown = fn; } },
    handle: (name, handler) => handlers.set(name, handler),
    provide: (name, value) => { assert.equal(name, 'market-data'); capability = value; },
    send() {},
  });
  assert.deepEqual([...handlers.keys()].sort(), ['history', 'providers', 'snapshot', 'status', 'subscribe', 'unsubscribe']);
  assert.equal(capability.apiVersion, 2);
  assert.deepEqual([...capability.events], ['market-data:trade', 'market-data:candle', 'market-data:candle-history', 'market-data:connection-status']);
  assert.equal(typeof capability.subscribe, 'function');
  assert.equal(typeof capability.getHistory, 'function');
  assert.deepEqual(capability.getProviders().map(provider => provider.id), ['binance', 'bybit', 'kraken', 'coinbase']);
  assert.ok(capability.getProviders().every(provider => provider.feeds.join() === 'trades'));
  assert.equal(service.getStatus().running, true);
  let trades = 0;
  let eventRevision;
  service.on('market-data:trade', event => {
    trades += 1;
    eventRevision = event.revision;
    assert.ok(service.getSnapshot('BTCUSDT').revision >= event.revision, 'event must be emitted after its state commit');
  });
  const repeatedTrade = { type: 'trade', data: { symbol: 'BTCUSDT', price: 100, quantity: 1, side: 'buy', exchange: 'binance', timestamp: 1, tradeId: 'same' } };
  service.ingest(repeatedTrade);
  service.ingest(repeatedTrade);
  assert.equal(trades, 1, 'reconnect duplicates must not inflate candles');
  const snapshot = service.getSnapshot('BTCUSDT', { exchanges: ['binance'] });
  assert.equal(snapshot.latestTrade.price, 100);
  assert.equal(snapshot.revision, eventRevision);
  assert.equal(snapshot.candlesByExchange.binance['1m'].volume, 1);
  shutdown();
  assert.equal(service.getStatus().running, false);
});

test('Coinbase serves dollar symbols from its USD books and reports the aggressor side', () => {
  assert.equal(toCoinbase('BTCUSDT'), 'BTC-USD');
  assert.equal(toCoinbase('ETHUSDC'), 'ETH-USD');
  assert.equal(toCoinbase('SOLEUR'), 'SOL-EUR');
  assert.equal(toCoinbase('ETHBTC'), 'ETH-BTC');

  const sent = [];
  const coinbase = new CoinbaseAdapter({ WebSocketImpl: class {} });
  coinbase.socket.send = payload => { sent.push(payload); return true; };
  coinbase.socket.restart = () => {};
  coinbase.setSubscriptions(new Map([['BTCUSDT', new Set(['trades'])], ['BTCUSDC', new Set(['trades'])]]));
  coinbase._subscribe();
  assert.deepEqual(sent, [{ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches', 'heartbeat'] }]);

  const events = [];
  coinbase.on('event', event => events.push(event.data));
  coinbase._message(JSON.stringify({ type: 'last_match', trade_id: 1, product_id: 'BTC-USD', price: '99', size: '1', side: 'buy', time: '2026-01-01T00:00:00Z' }));
  coinbase._message(JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD' }));
  coinbase._message(JSON.stringify({ type: 'match', trade_id: 2, product_id: 'BTC-USD', price: '100', size: '0.5', side: 'sell', time: '2026-01-01T00:00:01Z' }));
  assert.deepEqual(events.map(event => event.symbol).sort(), ['BTCUSDC', 'BTCUSDT'], 'one trade per requested symbol; last_match and heartbeats are skipped');
  assert.equal(events[0].side, 'buy', 'a resting sell was hit by a buyer');
  assert.equal(events[0].timestamp, Date.parse('2026-01-01T00:00:01Z'));
  assert.equal(events[0].exchange, 'coinbase');
});

test('Coinbase history uses its granularity, converts seconds and reorders fields', async () => {
  let requestedUrl;
  const result = await getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '1h', limit: 2 }, async url => {
    requestedUrl = String(url);
    // newest first: [time (s), low, high, open, close, volume]
    return { ok: true, json: async () => [[7200, 95, 120, 100, 110, 3], [3600, 90, 105, 98, 100, 2], [0, 80, 99, 85, 98, 1]] };
  });
  assert.equal(requestedUrl, 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600');
  assert.deepEqual(result.candles.map(bar => [bar.start, bar.open, bar.high, bar.low, bar.close, bar.volume]), [
    [3_600_000, 98, 105, 90, 100, 2],
    [7_200_000, 100, 120, 95, 110, 3],
  ]);
  // No 4h at Coinbase: hourly candles, for the chart to merge; or none when the caller needs 4h itself.
  let fallback;
  const hourly = await getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '4h' }, async url => { fallback = new URL(String(url)); return { ok: true, json: async () => [] }; });
  assert.equal(fallback.searchParams.get('granularity'), '3600');
  assert.deepEqual([hourly.interval, hourly.intervalMs, hourly.requestedInterval, hourly.requestedIntervalMs], ['1h', 3_600_000, '4h', 14_400_000]);
  await assert.rejects(() => getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '4h', exact: true }, async () => ({ ok: true, json: async () => [] })), /unavailable for coinbase at 4h/);
});

test('a frame\'s subscription: unsubscribing drops its destroyed listener, a closed frame ends it', async () => {
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  let shutdown;
  // No sockets to the exchanges from a test: the service sees no WebSocket.
  const savedWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  await activate({
    root,
    app: { once: (_name, fn) => { shutdown = fn; } },
    handle: (name, handler) => handlers.set(name, handler),
    provide() {},
    send() {},
  });
  try {
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
    const subscribe = id => handlers.get('subscribe')({ sender }, { symbol: 'BTCUSDT', subscriptionId: id });
    for (let i = 0; i < 5; i += 1) {
      await subscribe('chart');
      assert.equal(await handlers.get('unsubscribe')({ sender }, 'chart'), true);
    }
    assert.equal(sender.listenerCount('destroyed'), 0, 'unsubscribing removes the listener');
    assert.equal(await handlers.get('unsubscribe')({ sender }, 'chart'), false);
    // The same id again is refused, without a second listener.
    await subscribe('a');
    await assert.rejects(async () => subscribe('a'), /already subscribed/);
    assert.equal(sender.listenerCount('destroyed'), 1);
    sender.emit('destroyed');
    assert.equal(sender.listenerCount('destroyed'), 0);
    assert.equal(await handlers.get('unsubscribe')({ sender }, 'a'), false, 'a closed frame\'s subscription is gone');
  } finally {
    shutdown();
    globalThis.WebSocket = savedWebSocket;
  }
});

test('R17: a frame that goes ends its own subscriptions, not other frames\' (their calls all come through the Atmos page)', async () => {
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  let shutdown;
  const savedWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  await activate({
    root,
    app: { once: (_name, fn) => { shutdown = fn; } },
    handle: (name, handler) => handlers.set(name, handler),
    provide() {},
    send() {},
  });
  try {
    const page = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false });
    const frame = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    const one = frame('f1');
    const two = frame('f2');
    const call = (name, callerFrame, ...args) => handlers.get(name)({ sender: page, callerFrame }, ...args);
    await call('subscribe', one, { symbol: 'BTCUSDT', subscriptionId: 'chart-1' });
    await call('subscribe', two, { symbol: 'BTCUSDT', subscriptionId: 'chart-2' });
    assert.equal(page.listenerCount('destroyed'), 0, 'watched through the frame, not the page');
    one.emit('destroyed');
    assert.equal(await call('unsubscribe', one, 'chart-1'), false, 'the closed frame\'s is gone');
    assert.equal(await call('unsubscribe', two, 'chart-2'), true, 'the other frame\'s stays');
  } finally {
    shutdown();
    globalThis.WebSocket = savedWebSocket;
  }
});

test('R18: a history provider whose answer stalls gives way to the next, and closing stops it', { timeout: 5_000 }, async t => {
  const { MarketDataService } = activate;
  const asked = [];
  const stall = () => new Promise(() => {});
  const fetchImpl = async url => {
    const host = new URL(String(url)).hostname;
    asked.push(host);
    // Binance answers, then never sends its body; Bybit answers in full.
    if (host.includes('binance')) return { ok: true, status: 200, json: stall };
    return { ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: [[String(Date.now() - 3_600_000), '1', '2', '0.5', '1.5', '10']] } }) };
  };
  const warned = [];
  const service = new MarketDataService({ WebSocketImpl: undefined, fetchImpl, logger: { warn: (...args) => warned.push(args.join(' ')), error() {}, log() {} }, historyTimeoutMs: 50 });
  const awake = setInterval(() => {}, 1_000); // the service's timers don't keep a process up
  t.after(() => { clearInterval(awake); service.close(); }); // even if the test times out
  try {
    const started = Date.now();
    const history = await service.getHistory('BTCUSDT', { interval: '1h', limit: 2 });
    assert.equal(history.exchange, 'bybit');
    assert.ok(Date.now() - started < 2_000, 'within the deadline, not waiting on Binance');
    assert.deepEqual(asked, ['fapi.binance.com', 'api.bybit.com']);
    // Shutting down ends a request that's still waiting.
    const waiting = service.getHistory('ETHUSDT', { exchange: 'binance', interval: '1h', limit: 2 });
    const settled = waiting.then(() => 'answered', error => error.message);
    // And one going through the exchanges in turn: none tried after closing.
    const falling = service.getHistory('SOLUSDT', { interval: '1h', limit: 2 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    const askedBefore = asked.length;
    warned.length = 0;
    service.close();
    assert.match(await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('still waiting'), 30))]), /stopped/);
    await falling;
    assert.equal(asked.length, askedBefore, 'no exchange asked after closing');
    assert.equal(warned.filter(line => /trying the next/.test(line)).length, 0);
  } finally {
    clearInterval(awake);
    service.close();
  }
});

test('R48: history holds only the candles before the current one (exchanges send the forming one too)', () => {
  const now = 150_000;
  const state = new MarketState({ now: () => now });
  const bar = (start, close) => ({ symbol: 'BTCUSDT', exchange: 'kraken', interval: '1m', intervalMs: 60_000, start, end: start + 60_000, open: 1, high: 2, low: 0.5, close, volume: 10, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, closed: true });
  // Kraken's answer ends with the candle still forming (120_000 to 180_000).
  state.seedCandleHistory('BTCUSDT', 'kraken', 60_000, [bar(0, 1), bar(60_000, 2), bar(120_000, 3)]);
  let candle = state.getSnapshot('BTCUSDT', { exchanges: ['kraken'] }).candlesByExchange.kraken['1m'];
  assert.equal(candle.start, 60_000, 'the last finished candle, not the forming one taken for finished');
  const forming = { ...bar(120_000, 4), firstTradeAt: 130_000, lastTradeAt: 130_000, tradeCount: 1, volume: 1, closed: false };
  state.commitTrade({ symbol: 'BTCUSDT', exchange: 'kraken', price: 4, quantity: 1, side: 'buy', timestamp: 130_000 }, [forming], []);
  candle = state.getSnapshot('BTCUSDT', { exchanges: ['kraken'] }).candlesByExchange.kraken['1m'];
  assert.deepEqual([...candle.history, candle].map(item => item.start), [0, 60_000, 120_000], 'each time once');
});

test('R49: a candle seen from partway through its period becomes the exchange\'s once it closes', { timeout: 5_000 }, async () => {
  const minute = 60_000;
  const base = Math.floor(Date.now() / minute) * minute - 5 * minute;
  const asked = [];
  const fetchImpl = async url => {
    asked.push(String(url));
    // The exchange's candle for `base`, all of it; and the next, as seen here.
    return { ok: true, status: 200, json: async () => [[base, '90', '200', '50', '100', '100'], [base + minute, '101', '103', '99', '102', '3']] };
  };
  const service = new MarketDataService({ WebSocketImpl: undefined, fetchImpl, logger: { warn() {}, error() {}, log() {} }, candleIntervals: [minute], reconcileDelayMs: 1 });
  const awake = setInterval(() => {}, 1_000);
  try {
    let id = 0;
    const trade = (at, price, quantity = 1) => service.ingest({ type: 'trade', data: { symbol: 'BTCUSDT', exchange: 'binance', price: String(price), quantity: String(quantity), side: 'buy', timestamp: String(at), tradeId: ++id } });
    trade(base + 50_000, 100);           // watching began 50 s into the candle
    trade(base + minute + 1_000, 101);   // closes it; this one is seen from its start
    trade(base + minute + 30_000, 103, 2);
    trade(base + 2 * minute + 1_000, 102); // closes that one too
    await new Promise(resolve => setTimeout(resolve, 100));
    const candle = service.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'];
    const at = start => candle.history.find(item => item.start === start);
    assert.deepEqual([at(base).volume, at(base).high, at(base).low], [100, 200, 50], "the exchange's candle, not the 50 s of it seen here");
    assert.equal(at(base + minute).volume, 3, 'one seen whole is kept as built');
    assert.equal(asked.length, 1, 'asked once, for the one seen in part');
  } finally {
    clearInterval(awake);
    service.close();
  }
});

test("R17: one page's frames can't share a subscription id (events are told apart by it)", async () => {
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  let shutdown;
  const savedWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  await activate({ root, app: { once: (_name, fn) => { shutdown = fn; } }, handle: (name, handler) => handlers.set(name, handler), provide() {}, send() {} });
  try {
    const page = Object.assign(new EventEmitter(), { id: 4, isDestroyed: () => false });
    const frame = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    const one = frame('f1');
    const two = frame('f2');
    const call = (name, callerFrame, ...args) => handlers.get(name)({ sender: page, callerFrame }, ...args);
    await call('subscribe', one, { symbol: 'BTCUSDT', subscriptionId: 'chart' });
    await assert.rejects(async () => call('subscribe', two, { symbol: 'ETHUSDT', subscriptionId: 'chart' }), /already subscribed/);
    one.emit('destroyed');
    await call('subscribe', two, { symbol: 'ETHUSDT', subscriptionId: 'chart' }); // free again
    assert.equal(await call('unsubscribe', two, 'chart'), true);
  } finally {
    shutdown();
    globalThis.WebSocket = savedWebSocket;
  }
});

test('R48: a candle closing after newer ones were filled in takes its own place; a clock a little ahead still sees the forming one', () => {
  let now = 400_000;
  const state = new MarketState({ now: () => now });
  const bar = (start, close, extra = {}) => ({ symbol: 'BTCUSDT', exchange: 'binance', interval: '1m', intervalMs: 60_000, start, end: start + 60_000, open: 1, high: 2, low: 0.5, close, volume: 10, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, closed: true, ...extra });
  // A quiet pair: history filled in up to 300_000 while 120_000 was still forming here.
  state.seedCandleHistory('BTCUSDT', 'binance', 60_000, [bar(60_000, 1), bar(180_000, 3), bar(240_000, 4)]);
  state.commitTrade({ symbol: 'BTCUSDT', exchange: 'binance', price: 2, quantity: 1, side: 'buy', timestamp: 345_000 }, [bar(300_000, 5, { closed: false })], [bar(120_000, 2, { volume: 7 })]);
  const candle = state.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'];
  assert.deepEqual([...candle.history, candle].map(item => item.start), [60_000, 120_000, 180_000, 240_000, 300_000], 'each time once, in order');
  // Exchange candle 360_000-420_000 is still forming; this clock is 3 s ahead.
  now = 423_000;
  state.seedCandleHistory('BTCUSDT', 'binance', 60_000, [bar(360_000, 6)]);
  assert.equal(state.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'].history.some(item => item.start === 360_000), false);
});

test('R49: a candle closed long after it began is still asked for, a restarted feed is a gap, and a failed ask is tried again', { timeout: 5_000 }, async t => {
  const minute = 60_000;
  const base = Math.floor(Date.now() / minute) * minute - 10 * minute;
  const asked = [];
  let fail = 1;
  const fetchImpl = async url => {
    asked.push(new URL(String(url)));
    if (fail-- > 0) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [[base, '90', '200', '50', '100', '100']] };
  };
  const service = new MarketDataService({ WebSocketImpl: undefined, fetchImpl, logger: { warn() {}, error() {}, log() {} }, candleIntervals: [minute], reconcileDelayMs: 1 });
  const awake = setInterval(() => {}, 1_000);
  t.after(() => { clearInterval(awake); service.close(); });
  let id = 0;
  const trade = (at, price) => service.ingest({ type: 'trade', data: { symbol: 'BTCUSDT', exchange: 'binance', price: String(price), quantity: '1', side: 'buy', timestamp: String(at), tradeId: ++id } });
  trade(base + 50_000, 100);
  trade(base + 8 * minute, 101); // the laptop slept: it closes 8 minutes on
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(asked.length >= 2, 'asked again after a failure');
  assert.ok(Number(asked.at(-1).searchParams.get('limit')) >= 10, 'far enough back to reach it');
  const history = service.getSnapshot('BTCUSDT', { exchanges: ['binance'] }).candlesByExchange.binance['1m'].history;
  assert.equal(history.find(item => item.start === base).volume, 100);
  // The socket restarting (a subscription changed): what's forming missed trades.
  service.websockets.emit('status', { exchange: 'binance', status: 'connecting' });
  assert.equal(service.candleEngine.get('BTCUSDT', minute, 'binance').partial, true);
});

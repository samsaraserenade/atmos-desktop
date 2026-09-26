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
  const service = JSON.parse(fs.readFileSync(path.join(root, 'service.json')));
  assert.equal(extension.apiVersion, 2);
  assert.equal(extension.requires['extensions.manifest'], 1);
  assert.equal(service.id, 'market-data');
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
  await assert.rejects(() => getMarketHistory('BTCUSDT', { exchange: 'coinbase', interval: '4h' }, async () => ({ ok: true, json: async () => [] })), /unavailable for coinbase/);
});

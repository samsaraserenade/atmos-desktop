'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { normalize, symbol: normalizeSymbol } = require('./normalizer');
const { WebSocketManager } = require('./websocket-manager');
const { BinanceAdapter } = require('./exchanges/binance');
const { BybitAdapter } = require('./exchanges/bybit');
const { KrakenAdapter } = require('./exchanges/kraken');
const { CoinbaseAdapter } = require('./exchanges/coinbase');
const { SubscriptionManager } = require('./subscription-manager');
const { CandleEngine } = require('./candle-engine');
const { MarketState } = require('./market-state');
const { getMarketHistory, resolveInterval, supportsInterval, isRegionBlock, HISTORY_EXCHANGES, REGION_PROBES } = require('./history');

const EVENT_NAMES = Object.freeze([
  'market-data:trade', 'market-data:candle', 'market-data:candle-history', 'market-data:connection-status',
]);
const DEFAULT_CANDLE_INTERVALS = Object.freeze([60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000]);
const REGION_RETRY_MS = 3_600_000;
const REGION_PROBE_SPACING_MS = 600_000;

class MarketDataService extends EventEmitter {
  constructor({
    WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, logger = console,
    candleIntervals = DEFAULT_CANDLE_INTERVALS, staleAfterMs = 45_000, stateRetentionMs = 300_000,
    candleThrottleMs = 250,
  } = {}) {
    super();
    // Forming-candle updates to each subscriber are coalesced to at most one
    // per exchange and interval every candleThrottleMs (4/s by default).
    // Closed candles and trades are never delayed.
    this.candleThrottleMs = candleThrottleMs;
    this.regionProbedAt = new Map();
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.historyCache = new Map();
    this.historyRequests = new Map();
    this.candleHistorySeeded = new Set();
    this.candleHistoryBackfillLimit = 1_000;
    this.candleEngine = new CandleEngine({ intervals: candleIntervals });
    this.marketState = new MarketState({ staleAfterMs, retentionMs: stateRetentionMs });
    this.seenTradeIds = new Map();
    this.tradeDeduplicationLimit = 10_000;
    this.websockets = new WebSocketManager();
    this.providers = [
      this.websockets.add(new BinanceAdapter({ WebSocketImpl })),
      this.websockets.add(new BybitAdapter({ WebSocketImpl })),
      this.websockets.add(new KrakenAdapter({ WebSocketImpl })),
      this.websockets.add(new CoinbaseAdapter({ WebSocketImpl })),
    ];
    this.subscriptions = new SubscriptionManager({ providers: this.providers });
    this.closed = false;
    this._wire();
    this.pruneTimer = setInterval(() => this._evict(this.marketState.prune()), 60_000);
    this.pruneTimer.unref?.();
  }

  _wire() {
    this.subscriptions.on('change', requirements => {
      this.websockets.update(requirements);
      const active = new Set();
      for (const symbols of requirements.values()) for (const symbol of symbols.keys()) active.add(symbol);
      this._evict(this.marketState.setActiveSymbols(active));
    });
    this.websockets.on('event', event => this._ingest(event));
    this.websockets.on('status', status => {
      const commit = this.marketState.commitConnection(status);
      this._publish('market-data:connection-status', Object.freeze({ ...status, ...commit }));
    });
    this.websockets.on('error', ({ exchange, error }) => this.logger.warn(`[market-data] ${exchange}:`, error.message));
    this.websockets.on('connect-failed', ({ exchange }) => { this._checkRegion(exchange); });
  }

  // A socket that never opens may be a region block (Binance futures and
  // Bybit refuse the US, among others). The WebSocket API doesn't expose the
  // handshake's HTTP status, so ask the exchange's REST API once in a while;
  // a 451 or 403 there marks the exchange unavailable for an hour instead of
  // reconnecting forever. The other exchanges keep streaming.
  async _checkRegion(exchange) {
    const url = REGION_PROBES[exchange];
    if (!url || this.closed || this.websockets.isBlocked(exchange) || typeof this.fetchImpl !== 'function') return false;
    const last = this.regionProbedAt.get(exchange) || 0;
    if (Date.now() - last < REGION_PROBE_SPACING_MS) return false;
    this.regionProbedAt.set(exchange, Date.now());
    try {
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (isRegionBlock(response?.status)) { this._block(exchange, response.status); return true; }
    } catch { /* offline or DNS: an ordinary outage, keep reconnecting */ }
    return false;
  }

  _block(exchange, status) {
    if (this.closed || this.websockets.isBlocked(exchange)) return;
    this.logger.warn(`[market-data] ${exchange} refuses this region (HTTP ${status}); using the other exchanges`);
    this.websockets.block(exchange, `unavailable in this region (HTTP ${status})`, REGION_RETRY_MS);
  }

  _ingest(event) {
    try {
      if (event.type !== 'trade') return;
      const trade = normalize('trade', event.data);
      if (this._isDuplicateTrade(trade)) return;
      const candleResult = this.candleEngine.ingest(trade);
      const commit = this.marketState.commitTrade(trade, candleResult.updates, candleResult.closed);
      this._publish('market-data:trade', Object.freeze({ ...trade, ...commit }));
      for (const candle of [...candleResult.closed, ...candleResult.updates]) this._publish('market-data:candle', Object.freeze({ ...candle, ...commit }));
    } catch (error) {
      this.logger.warn(`[market-data] dropped invalid ${event.type || 'unknown'} event:`, error.message);
    }
  }

  _isDuplicateTrade(trade) {
    if (trade.tradeId === undefined) return false;
    const stream = `${trade.exchange}:${trade.symbol}`;
    let ids = this.seenTradeIds.get(stream);
    if (!ids) { ids = new Map(); this.seenTradeIds.set(stream, ids); }
    if (ids.has(trade.tradeId)) return true;
    ids.set(trade.tradeId, true);
    if (ids.size > this.tradeDeduplicationLimit) ids.delete(ids.keys().next().value);
    return false;
  }

  _publish(eventName, payload) { this.emit(eventName, payload); }
  ingest(event) { this._ingest(event); }

  _evict(symbols = []) {
    for (const symbol of symbols) {
      this.candleEngine.clear(symbol);
      for (const key of this.seenTradeIds.keys()) if (key.endsWith(`:${symbol}`)) this.seenTradeIds.delete(key);
      for (const key of this.candleHistorySeeded) if (key.startsWith(`${symbol}|`)) this.candleHistorySeeded.delete(key);
    }
  }

  // Combines market data and historical data: a subscription asking for
  // candles gets its backing bars backfilled from REST history the first
  // time this process sees that symbol/exchange/interval, so a chart can
  // render a full window immediately instead of waiting for enough live
  // trades to accumulate. Runs in the background -- it never blocks
  // subscribe() -- and merges into MarketState via seedCandleHistory, so
  // every snapshot from then on (and the market-data:candle-history event)
  // carries the combined series.
  _ensureCandleHistory(symbol, exchanges, intervals = null) {
    for (const exchange of exchanges) {
      if (this.websockets.isBlocked(exchange)) continue;
      for (const intervalMs of this.candleEngine.intervals) {
        if (intervals && !intervals.includes(intervalMs)) continue;
        const key = `${symbol}|${exchange}|${intervalMs}`;
        if (this.candleHistorySeeded.has(key)) continue;
        this.candleHistorySeeded.add(key);
        this.getHistory(symbol, { exchange, intervalMs, limit: this.candleHistoryBackfillLimit })
          .then(result => {
            const candles = result.candles.map(candle => ({
              symbol, exchange, interval: result.interval, intervalMs: result.intervalMs,
              start: candle.start, end: candle.end,
              open: candle.open, high: candle.high, low: candle.low, close: candle.close,
              volume: candle.volume, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0,
              closed: true,
            }));
            const commit = this.marketState.seedCandleHistory(symbol, exchange, intervalMs, candles);
            if (commit) this._publish('market-data:candle-history', Object.freeze({ symbol, exchange, interval: result.interval, intervalMs: result.intervalMs, ...commit }));
          })
          .catch(error => {
            // An exchange history.js simply can't serve (e.g. Kraken today)
            // fails the same way every time -- retrying would just spam the
            // same request. A transient network/API failure should get
            // another chance on the next subscribe, so only those unseed.
            if (isRegionBlock(error.status)) this._block(exchange, error.status);
            else if (!/unavailable for/.test(error.message)) this.candleHistorySeeded.delete(key);
            this.logger.warn(`[market-data] historical backfill failed for ${exchange}:${symbol}@${intervalMs}ms:`, error.message);
          });
      }
    }
  }

  subscribe(consumerId, symbol, options = {}, listener) {
    const descriptor = this.subscriptions.subscribe(consumerId, symbol, options);
    if (descriptor.feeds.includes('candles')) this._ensureCandleHistory(descriptor.symbol, descriptor.exchanges, descriptor.intervals);
    const forwards = [];
    const throttle = typeof listener === 'function' ? this._candleThrottle(listener) : null;
    if (throttle) {
      for (const eventName of EVENT_NAMES) {
        const forward = payload => { if (this.subscriptions.matches(consumerId, eventName, payload)) throttle.forward(eventName, payload); };
        this.on(eventName, forward);
        forwards.push([eventName, forward]);
      }
    }
    let active = true;
    return Object.freeze({ ...descriptor, snapshot: this.getSnapshot(symbol, { exchanges: descriptor.exchanges }), unsubscribe: () => {
      if (!active) return false;
      active = false;
      for (const [eventName, forward] of forwards) this.off(eventName, forward);
      throttle?.cancel();
      return this.subscriptions.unsubscribe(consumerId);
    } });
  }

  // Per subscriber: the first forming update for an exchange/interval goes
  // out at once, later ones within candleThrottleMs are coalesced into the
  // newest. A closed candle is sent immediately and replaces any pending
  // update for the same bar.
  _candleThrottle(listener) {
    const pending = new Map();
    const lastSent = new Map();
    const throttleMs = this.candleThrottleMs;
    const send = (key, envelope) => { lastSent.set(key, Date.now()); listener(envelope); };
    return {
      forward: (eventName, payload) => {
        const envelope = { event: eventName, payload };
        if (eventName !== 'market-data:candle' || !(throttleMs > 0)) { listener(envelope); return; }
        const key = `${payload.exchange}|${payload.intervalMs}`;
        const waiting = pending.get(key);
        if (payload.closed) {
          if (waiting && waiting.envelope.payload.start <= payload.start) { clearTimeout(waiting.timer); pending.delete(key); }
          listener(envelope);
          return;
        }
        if (waiting) { waiting.envelope = envelope; return; }
        const wait = throttleMs - (Date.now() - (lastSent.get(key) || 0));
        if (wait <= 0) { send(key, envelope); return; }
        const entry = { envelope, timer: null };
        entry.timer = setTimeout(() => { pending.delete(key); send(key, entry.envelope); }, wait);
        entry.timer.unref?.();
        pending.set(key, entry);
      },
      cancel: () => { for (const entry of pending.values()) clearTimeout(entry.timer); pending.clear(); },
    };
  }

  unsubscribe(consumerId) { return this.subscriptions.unsubscribe(consumerId); }
  getStatus() { return { running: !this.closed, revision: this.marketState.revision, providers: this.websockets.status(), subscriptions: this.subscriptions.status() }; }
  getProviders() { return this.providers.map(provider => ({ id: provider.id, feeds: ['trades'].filter(feed => provider.supports(feed)) })); }
  getSnapshot(symbol, options = {}) {
    const normalized = normalizeSymbol(symbol);
    const exchanges = options.exchanges || (options.exchange ? [options.exchange] : undefined);
    if (exchanges !== undefined && !Array.isArray(exchanges)) throw new TypeError('snapshot exchanges must be an array');
    this._evict(this.marketState.prune());
    return this.marketState.getSnapshot(normalized, { exchanges: exchanges?.map(exchange => String(exchange).toLowerCase()) });
  }
  getHistory(symbol, options = {}) {
    const normalized = normalizeSymbol(symbol);
    const key = JSON.stringify([normalized, options.exchange || options.exchanges || [], options.interval || options.intervalMs || '5m', Number(options.limit) || 500]);
    const cached = this.historyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (this.historyRequests.has(key)) return this.historyRequests.get(key);
    const request = this._fetchHistory(normalized, options).then(value => {
      const ttl = Math.max(10_000, Math.min(60_000, value.intervalMs / 4));
      this.historyCache.delete(key);
      this.historyCache.set(key, { value, expiresAt: Date.now() + ttl });
      while (this.historyCache.size > 64) this.historyCache.delete(this.historyCache.keys().next().value);
      return value;
    }).finally(() => this.historyRequests.delete(key));
    this.historyRequests.set(key, request);
    return request;
  }
  // Named exchange: that one only. Otherwise the requested exchanges in
  // HISTORY_EXCHANGES order, skipping any blocked in this region or without
  // the interval, trying the next when one fails (a region block, or a pair
  // it doesn't list).
  async _fetchHistory(symbol, options) {
    if (options.exchange) return getMarketHistory(symbol, options, this.fetchImpl);
    const interval = resolveInterval(options);
    const requested = Array.isArray(options.exchanges) ? options.exchanges.map(value => String(value).toLowerCase()) : HISTORY_EXCHANGES;
    const candidates = HISTORY_EXCHANGES.filter(id => requested.includes(id) && supportsInterval(id, interval));
    const open = candidates.filter(id => !this.websockets.isBlocked(id));
    const order = open.length ? open : candidates;
    if (!order.length) throw new Error(`Historical candles are unavailable for ${requested.join(', ') || 'these exchanges'} at ${interval}.`);
    let lastError;
    for (const exchange of order) {
      try {
        return await getMarketHistory(symbol, { ...options, exchange }, this.fetchImpl);
      } catch (error) {
        lastError = error;
        if (isRegionBlock(error.status)) this._block(exchange, error.status);
        this.logger.warn(`[market-data] history from ${exchange} failed, trying the next exchange:`, error.message);
      }
    }
    throw lastError;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pruneTimer);
    this.subscriptions.close();
    this.websockets.close();
    this.seenTradeIds.clear();
    this.historyCache.clear();
    this.historyRequests.clear();
    this.marketState.clear();
    this.removeAllListeners();
  }
}

async function activate(context) {
  const service = new MarketDataService();
  const rendererSubscriptions = new Map();

  context.handle('subscribe', (event, request = {}) => {
    const requestedId = typeof request.subscriptionId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(request.subscriptionId) ? request.subscriptionId : randomUUID();
    const consumerId = `renderer-${event.sender.id}:${requestedId}`;
    const handle = service.subscribe(consumerId, request.symbol, request.options, envelope => {
      if (!event.sender.isDestroyed?.()) context.send(event.sender, 'event', { subscriptionId: requestedId, ...envelope });
    });
    rendererSubscriptions.set(consumerId, handle);
    event.sender.once?.('destroyed', () => { rendererSubscriptions.get(consumerId)?.unsubscribe(); rendererSubscriptions.delete(consumerId); });
    return { symbol: handle.symbol, feeds: handle.feeds, exchanges: handle.exchanges, snapshot: handle.snapshot };
  });
  context.handle('unsubscribe', (event, subscriptionId) => {
    const consumerId = `renderer-${event.sender.id}:${subscriptionId}`;
    const removed = rendererSubscriptions.get(consumerId)?.unsubscribe() || false;
    rendererSubscriptions.delete(consumerId);
    return removed;
  });
  context.handle('status', () => service.getStatus());
  context.handle('snapshot', (_event, request = {}) => service.getSnapshot(request.symbol, request.options));
  context.handle('history', (_event, request = {}) => service.getHistory(request.symbol, request.options));
  context.handle('providers', () => service.getProviders());

  const capability = Object.freeze({
    apiVersion: 2,
    events: EVENT_NAMES,
    subscribe: (symbol, options, listener, consumerId = `main-${randomUUID()}`) => service.subscribe(consumerId, symbol, options, listener),
    getStatus: () => service.getStatus(),
    getSnapshot: (symbol, options) => service.getSnapshot(symbol, options),
    getHistory: (symbol, options) => service.getHistory(symbol, options),
    getProviders: () => service.getProviders(),
    on: (event, listener) => { const name = event.startsWith('market-data:') ? event : `market-data:${event}`; service.on(name, listener); return () => service.off(name, listener); },
  });
  context.provide('market-data', capability);

  context.app?.once?.('before-quit', () => service.close());
  return service;
}

module.exports = activate;
module.exports.activate = activate;
module.exports.MarketDataService = MarketDataService;
module.exports.EVENT_NAMES = EVENT_NAMES;

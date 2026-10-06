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
const { getMarketHistory, resolveInterval, fetchIntervalFor, isRegionBlock, INTERVALS, HISTORY_EXCHANGES, REGION_PROBES } = require('./history');

const EVENT_NAMES = Object.freeze([
  'market-data:trade', 'market-data:candle', 'market-data:candle-history', 'market-data:connection-status',
]);
const DEFAULT_CANDLE_INTERVALS = Object.freeze([60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000]);
const REGION_RETRY_MS = 3_600_000;
const REGION_PROBE_SPACING_MS = 600_000;
// A history provider (or region probe) that hasn't answered in full by then
// gives way to the next: a stalled one would otherwise hold up every request
// waiting on it.
const HISTORY_TIMEOUT_MS = 15_000;

class MarketDataService extends EventEmitter {
  constructor({
    WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, logger = console,
    candleIntervals = DEFAULT_CANDLE_INTERVALS, staleAfterMs = 45_000, stateRetentionMs = 300_000,
    candleThrottleMs = 250, historyTimeoutMs = HISTORY_TIMEOUT_MS, reconcileDelayMs = 10_000,
  } = {}) {
    super();
    // Forming-candle updates to each subscriber are coalesced to at most one
    // per exchange and interval every candleThrottleMs (4/s by default).
    // Closed candles and trades are never delayed.
    this.candleThrottleMs = candleThrottleMs;
    this.regionProbedAt = new Map();
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.historyTimeoutMs = historyTimeoutMs;
    this.reconcileDelayMs = reconcileDelayMs;
    this.reconcileTimers = new Set();
    this.requestsInFlight = new Set(); // AbortControllers, ended by close()
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
      // Trades missed while it's down or (re)connecting (a subscription
      // change restarts it): what's forming is seen in part. Not 'stale': a
      // quiet market, on a feed still open.
      if (['connecting', 'reconnecting', 'idle', 'unavailable'].includes(status.status)) this.candleEngine.markPartial(status.exchange);
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
    const deadline = this._deadline();
    try {
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: deadline.signal });
      if (isRegionBlock(response?.status)) { this._block(exchange, response.status); return true; }
    } catch { /* offline, DNS or no answer: an ordinary outage, keep reconnecting */ }
    finally { deadline.done(); }
    return false;
  }

  /** A signal that aborts after historyTimeoutMs, or when the service closes; done() when finished. */
  _deadline() {
    const controller = new AbortController();
    if (this.closed) controller.abort(new Error('Market Data stopped'));
    const timer = setTimeout(() => controller.abort(new Error(`no answer in ${Math.round(this.historyTimeoutMs / 1000)} s`)), this.historyTimeoutMs);
    timer.unref?.();
    this.requestsInFlight.add(controller);
    return { signal: controller.signal, done: () => { clearTimeout(timer); this.requestsInFlight.delete(controller); } };
  }

  /** getMarketHistory() from one exchange, within the deadline. */
  async _historyFrom(symbol, options) {
    const deadline = this._deadline();
    try { return await getMarketHistory(symbol, options, this.fetchImpl, deadline.signal); }
    finally { deadline.done(); }
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
      for (const candle of candleResult.closed) if (candle.partial) this._reconcile(candle);
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
        this.getHistory(symbol, { exchange, intervalMs, exact: true, limit: this.candleHistoryBackfillLimit })
          .then(result => this._seedHistory(symbol, exchange, intervalMs, result))
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

  _seedHistory(symbol, exchange, intervalMs, result) {
    const candles = result.candles.map(candle => ({
      symbol, exchange, interval: result.interval, intervalMs: result.intervalMs,
      start: candle.start, end: candle.end,
      open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      volume: candle.volume, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0,
      closed: true,
    }));
    const commit = this.marketState.seedCandleHistory(symbol, exchange, intervalMs, candles);
    if (commit) this._publish('market-data:candle-history', Object.freeze({ symbol, exchange, interval: result.interval, intervalMs: result.intervalMs, ...commit }));
  }

  // A candle that closed seen only in part (watching began partway through
  // it, or the feed dropped): the exchange's own is whole, and replaces it
  // in history (seedCandleHistory). Asked a moment after it closes, far
  // enough back to reach it however long ago it began (a quiet pair, a
  // computer that slept), and again twice if that fails.
  _reconcile(candle, attempt = 0) {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(timer);
      const limit = Math.max(5, Math.min(1_000, Math.ceil((Date.now() - candle.start) / candle.intervalMs) + 2));
      this.getHistory(candle.symbol, { exchange: candle.exchange, intervalMs: candle.intervalMs, exact: true, limit })
        .then(result => this._seedHistory(candle.symbol, candle.exchange, candle.intervalMs, result))
        .catch(error => {
          if (this.closed || /unavailable for/.test(error.message)) return;
          if (attempt < 2) { this._reconcile(candle, attempt + 1); return; }
          this.logger.warn(`[market-data] couldn't read ${candle.exchange}'s ${candle.interval} candle for ${candle.symbol}:`, error.message);
        });
    }, this.reconcileDelayMs * 3 ** attempt);
    timer.unref?.();
    this.reconcileTimers.add(timer);
  }

  subscribe(consumerId, symbol, options = {}, listener) {
    const descriptor = this.subscriptions.subscribe(consumerId, symbol, options);
    // An interval the engine doesn't build yet (8h, 1W, 1M...) is added
    // when a chart asks for it: any one getHistory() can fetch, no others.
    for (const intervalMs of descriptor.intervals || []) {
      if (Object.values(INTERVALS).some(item => item.ms === intervalMs && HISTORY_EXCHANGES.some(id => item[id]))) this.candleEngine.addInterval(intervalMs);
    }
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
    // By what will be fetched: every custom length is interval 'custom'.
    const key = JSON.stringify([normalized, options.exchange || options.exchanges || [], resolveInterval(options), Number(options.intervalMs) || null, Number(options.limit) || 500, options.exact === true]);
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
    if (options.exchange) return this._historyFrom(symbol, options);
    const interval = resolveInterval(options);
    const requested = Array.isArray(options.exchanges) ? options.exchanges.map(value => String(value).toLowerCase()) : HISTORY_EXCHANGES;
    // Exchanges that serve the interval, or a shorter one that fits into it evenly.
    const candidates = HISTORY_EXCHANGES.filter(id => requested.includes(id) && fetchIntervalFor(id, interval));
    const open = candidates.filter(id => !this.websockets.isBlocked(id));
    const order = open.length ? open : candidates;
    if (!order.length) throw new Error(`Historical candles are unavailable for ${requested.join(', ') || 'these exchanges'} at ${interval}.`);
    let lastError;
    for (const exchange of order) {
      try {
        return await this._historyFrom(symbol, { ...options, exchange });
      } catch (error) {
        if (this.closed) throw error; // stopped: not the next exchange either
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
    for (const controller of this.requestsInFlight) controller.abort(new Error('Market Data stopped'));
    this.requestsInFlight.clear();
    for (const timer of this.reconcileTimers) clearTimeout(timer);
    this.reconcileTimers.clear();
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
  const rendererSubscriptions = new Map(); // consumerId -> { handle, sender, onDestroyed }

  /** Ends a frame's subscription and drops its `destroyed` listener; false if there was none. */
  function endRendererSubscription(consumerId) {
    const entry = rendererSubscriptions.get(consumerId);
    if (!entry) return false;
    rendererSubscriptions.delete(consumerId);
    entry.sender.removeListener?.('destroyed', entry.onDestroyed);
    return entry.handle.unsubscribe() || false;
  }

  // A frame's subscription is its own: calls all come through the Atmos
  // page (event.sender), and Core names the frame (event.callerFrame; an
  // older Atmos names none, and the page stands in, as it did).
  const consumerIdOf = (event, subscriptionId) => `renderer-${event.sender.id}:${event.callerFrame?.id ?? ''}:${subscriptionId}`;

  context.handle('subscribe', (event, request = {}) => {
    const requestedId = typeof request.subscriptionId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(request.subscriptionId) ? request.subscriptionId : randomUUID();
    const consumerId = consumerIdOf(event, requestedId);
    // Events are told apart by the id alone (they reach every frame of the
    // page): one another frame of this page holds is refused, as before.
    const taken = `renderer-${event.sender.id}:`;
    for (const other of rendererSubscriptions.keys()) {
      if (other !== consumerId && other.startsWith(taken) && other.endsWith(`:${requestedId}`)) throw new Error(`already subscribed: ${requestedId}`);
    }
    const handle = service.subscribe(consumerId, request.symbol, request.options, envelope => {
      if (!event.sender.isDestroyed?.()) context.send(event.sender, 'event', { subscriptionId: requestedId, ...envelope });
    });
    // A frame that goes without unsubscribing: its subscription goes too.
    // The listener is removed when it unsubscribes, so a frame that
    // subscribes and unsubscribes again and again doesn't pile them up.
    const sender = event.callerFrame || event.sender;
    const onDestroyed = () => endRendererSubscription(consumerId);
    sender.once?.('destroyed', onDestroyed);
    rendererSubscriptions.set(consumerId, { handle, sender, onDestroyed });
    return { symbol: handle.symbol, feeds: handle.feeds, exchanges: handle.exchanges, snapshot: handle.snapshot };
  });
  context.handle('unsubscribe', (event, subscriptionId) => endRendererSubscription(consumerIdOf(event, subscriptionId)));
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

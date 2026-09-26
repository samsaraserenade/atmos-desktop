'use strict';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function latest(values, timestamp = value => value?.timestamp || 0) {
  return values.filter(Boolean).sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
}

function aggregateCandles(candles) {
  const grouped = new Map();
  for (const candle of candles) {
    if (!grouped.has(candle.intervalMs)) grouped.set(candle.intervalMs, []);
    grouped.get(candle.intervalMs).push(candle);
  }
  const result = {};
  for (const values of grouped.values()) {
    const start = Math.max(...values.map(value => value.start));
    const current = values.filter(value => value.start === start);
    const first = current.reduce((earliest, value) => (value.firstTradeAt || value.start) < (earliest.firstTradeAt || earliest.start) ? value : earliest);
    const last = current.reduce((latestValue, value) => (value.lastTradeAt || value.start) > (latestValue.lastTradeAt || latestValue.start) ? value : latestValue);
    const buyVolume = current.reduce((sum, value) => sum + value.buyVolume, 0);
    const sellVolume = current.reduce((sum, value) => sum + value.sellVolume, 0);
    const candle = {
      symbol: current[0].symbol,
      interval: current[0].interval,
      intervalMs: current[0].intervalMs,
      start,
      end: Math.max(...current.map(value => value.end)),
      open: first.open,
      high: Math.max(...current.map(value => value.high)),
      low: Math.min(...current.map(value => value.low)),
      close: last.close,
      volume: current.reduce((sum, value) => sum + value.volume, 0),
      tradeCount: current.reduce((sum, value) => sum + value.tradeCount, 0),
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
      closed: false,
    };
    result[candle.interval] = candle;
  }
  return result;
}

class MarketState {
  constructor({ staleAfterMs = 45_000, retentionMs = 300_000, candleHistoryLimit = 1_500, now = Date.now } = {}) {
    this.staleAfterMs = staleAfterMs;
    this.retentionMs = retentionMs;
    this.candleHistoryLimit = candleHistoryLimit;
    this.now = now;
    this.revision = 0;
    this.symbols = new Map();
    this.providers = new Map();
    this.activeSymbols = new Set();
    this.inactiveSince = new Map();
  }

  _exchange(symbol, exchange) {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = { symbol, revision: 0, updatedAt: 0, exchanges: new Map() };
      this.symbols.set(symbol, state);
    }
    let provider = state.exchanges.get(exchange);
    if (!provider) {
      provider = { exchange, updatedAt: 0, candles: new Map(), candleHistory: new Map() };
      state.exchanges.set(exchange, provider);
    }
    return { state, provider };
  }

  _commit(state, provider, timestamp) {
    const receivedAt = this.now();
    provider.updatedAt = Math.max(provider.updatedAt, timestamp || 0, receivedAt);
    state.updatedAt = Math.max(state.updatedAt, provider.updatedAt);
    state.revision = ++this.revision;
    return { revision: state.revision, receivedAt };
  }

  commitTrade(trade, candles = [], closedCandles = []) {
    const { state, provider } = this._exchange(trade.symbol, trade.exchange);
    if (!provider.latestTrade || trade.timestamp >= provider.latestTrade.timestamp) provider.latestTrade = trade;
    for (const candle of candles) provider.candles.set(candle.intervalMs, candle);
    for (const candle of closedCandles) this._appendCandleHistory(provider, candle.intervalMs, candle);
    const commit = this._commit(state, provider, trade.timestamp);
    provider.tradeReceivedAt = commit.receivedAt;
    return commit;
  }

  // Live-derived closed candles are authoritative: they were built trade by
  // trade from this process's own feed, so they never get overwritten by a
  // later historical backfill for the same bar (see seedCandleHistory).
  _appendCandleHistory(provider, intervalMs, candle) {
    const list = provider.candleHistory.get(intervalMs) || [];
    if (list.length && list[list.length - 1].start === candle.start) list[list.length - 1] = candle;
    else list.push(candle);
    if (list.length > this.candleHistoryLimit) list.splice(0, list.length - this.candleHistoryLimit);
    provider.candleHistory.set(intervalMs, list);
  }

  // Backfills the bars a fresh subscription hasn't lived through yet from a
  // REST history fetch (see history.js / MarketDataService#_ensureCandleHistory).
  // Never clobbers a bar this process has already built live -- REST candles
  // can lag or aggregate slightly differently than our own trade-by-trade feed.
  seedCandleHistory(symbol, exchange, intervalMs, candles = []) {
    if (!candles.length) return null;
    const { state, provider } = this._exchange(symbol, exchange);
    const existing = provider.candleHistory.get(intervalMs) || [];
    const byStart = new Map(existing.map(candle => [candle.start, candle]));
    let added = false;
    for (const candle of candles) {
      if (byStart.has(candle.start)) continue;
      byStart.set(candle.start, candle);
      added = true;
    }
    if (!added) return null;
    const merged = [...byStart.values()].sort((a, b) => a.start - b.start);
    provider.candleHistory.set(intervalMs, merged.length > this.candleHistoryLimit ? merged.slice(merged.length - this.candleHistoryLimit) : merged);
    return this._commit(state, provider, provider.updatedAt);
  }

  // Reunites a provider's live "current bar" with its closed-bar backfill
  // into one continuous, gap-checked series: `history` is every bar
  // strictly before the returned candle, so [...candle.history, candle] is
  // always the full ascending series with no duplicate or missing bar.
  _candlesForProvider(value) {
    const result = {};
    const intervals = new Set([...value.candles.keys(), ...value.candleHistory.keys()]);
    for (const intervalMs of intervals) {
      const history = value.candleHistory.get(intervalMs) || [];
      const forming = value.candles.get(intervalMs);
      const latestCandle = forming || history[history.length - 1];
      if (!latestCandle) continue;
      const priorHistory = forming ? history : history.slice(0, -1);
      result[latestCandle.interval] = { ...clone(latestCandle), history: clone(priorHistory) };
    }
    return result;
  }

  commitConnection(status) {
    const receivedAt = this.now();
    this.providers.set(status.exchange, { ...status, receivedAt });
    return { revision: ++this.revision, receivedAt };
  }

  setActiveSymbols(symbols) {
    const next = new Set(symbols);
    const now = this.now();
    for (const symbol of this.activeSymbols) if (!next.has(symbol) && !this.inactiveSince.has(symbol)) this.inactiveSince.set(symbol, now);
    for (const symbol of next) this.inactiveSince.delete(symbol);
    this.activeSymbols = next;
    return this.prune();
  }

  prune() {
    const now = this.now();
    const evicted = [];
    for (const [symbol, since] of this.inactiveSince) {
      if (now - since < this.retentionMs) continue;
      this.symbols.delete(symbol);
      this.inactiveSince.delete(symbol);
      evicted.push(symbol);
    }
    return evicted;
  }

  getSnapshot(symbol, { exchanges } = {}) {
    const state = this.symbols.get(symbol);
    const selected = exchanges == null
      ? [...new Set([...this.providers.keys(), ...(state ? state.exchanges.keys() : [])])]
      : [...new Set(exchanges)];
    const exchangeStates = selected.map(exchange => [exchange, state?.exchanges.get(exchange)]);
    const available = exchangeStates.filter(([, value]) => value);
    const trades = Object.fromEntries(available.filter(([, value]) => value.latestTrade).map(([exchange, value]) => [exchange, clone(value.latestTrade)]));
    const candlesByExchange = Object.fromEntries(available.map(([exchange, value]) => [exchange, this._candlesForProvider(value)]));
    const latestTrade = latest(Object.values(trades));
    const asOf = state?.updatedAt || 0;
    const ageMs = asOf ? Math.max(0, this.now() - asOf) : null;
    const providerStates = Object.fromEntries(selected.map(exchange => [exchange, clone(this.providers.get(exchange)) || { exchange, status: 'idle' }]));
    const providerStatuses = Object.values(providerStates).map(provider => provider.status);
    const staleExchangeCount = available.filter(([, value]) => this.now() - value.updatedAt > this.staleAfterMs).length;
    const freshness = Object.fromEntries(available.map(([exchange, value]) => [exchange, {
      updatedAt: value.updatedAt || null,
      tradeAt: value.latestTrade?.timestamp || null,
      tradeReceivedAt: value.tradeReceivedAt || null,
    }]));
    let status = 'live';
    if (!available.length) status = 'empty';
    else if (ageMs > this.staleAfterMs || staleExchangeCount === available.length || providerStatuses.every(providerStatus => providerStatus !== 'connected')) status = 'stale';
    else if (available.length < selected.length || staleExchangeCount > 0 || providerStatuses.some(providerStatus => providerStatus !== 'connected')) status = 'partial';
    return Object.freeze({
      schemaVersion: 2,
      revision: Math.max(state?.revision || 0, this.revision),
      symbol,
      scope: { exchanges: selected },
      asOf: asOf || null,
      ageMs,
      status,
      price: latestTrade ? { value: latestTrade.price, exchange: latestTrade.exchange, timestamp: latestTrade.timestamp } : null,
      latestTrade,
      tradesByExchange: trades,
      candles: aggregateCandles(available.flatMap(([, value]) => [...value.candles.values()])),
      candlesByExchange,
      providers: providerStates,
      freshness,
    });
  }

  clear() { this.symbols.clear(); this.providers.clear(); this.activeSymbols.clear(); this.inactiveSince.clear(); }
}

module.exports = { MarketState, aggregateCandles };

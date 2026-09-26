'use strict';

const { EventEmitter } = require('node:events');
const { symbol: normalizeSymbol } = require('./normalizer');

// Consumer-facing feeds. Candles are built from trades, so both need only
// the upstream trade stream.
const FEEDS = new Set(['trades', 'candles']);
const UNIT_MS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

// `intervals` limits which candle intervals a subscriber receives: '5m',
// '1h', or milliseconds. Left out, every interval the engine builds is sent.
function parseIntervals(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new TypeError('intervals must be an array');
  const result = new Set();
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item) && item > 0) { result.add(item); continue; }
    const match = /^(\d+)(s|m|h|d)$/i.exec(String(item).trim());
    if (match && Number(match[1]) > 0) result.add(Number(match[1]) * UNIT_MS[match[2].toLowerCase()]);
  }
  if (!result.size) throw new TypeError('intervals has no valid interval');
  return result;
}

class SubscriptionManager extends EventEmitter {
  constructor({ providers = [] } = {}) {
    super();
    this.providers = new Map(providers.map(provider => [provider.id, provider]));
    this.consumers = new Map();
  }

  subscribe(consumerId, marketSymbol, options = {}) {
    if (typeof consumerId !== 'string' || !consumerId) throw new TypeError('consumerId must be a non-empty string');
    if (this.consumers.has(consumerId)) throw new Error(`consumer already subscribed: ${consumerId}`);
    const symbol = normalizeSymbol(marketSymbol);
    const feeds = new Set([...FEEDS].filter(feed => options[feed] === true));
    if (!feeds.size) feeds.add('trades');
    const requestedExchanges = options.exchanges == null ? [...this.providers.keys()] : options.exchanges;
    if (!Array.isArray(requestedExchanges)) throw new TypeError('exchanges must be an array');
    const exchanges = new Set(requestedExchanges.filter(id => this.providers.has(id)));
    if (!exchanges.size) throw new Error('no supported exchanges selected');
    const intervals = feeds.has('candles') ? parseIntervals(options.intervals) : null;
    const record = Object.freeze({ consumerId, symbol, feeds, exchanges, intervals });
    this.consumers.set(consumerId, record);
    this._changed();
    return { consumerId, symbol, feeds: [...feeds], exchanges: [...exchanges], intervals: intervals ? [...intervals] : null };
  }

  unsubscribe(consumerId) {
    const removed = this.consumers.delete(consumerId);
    if (removed) this._changed();
    return removed;
  }

  matches(consumerId, eventName, payload) {
    const record = this.consumers.get(consumerId);
    if (!record) return false;
    if (payload?.symbol && payload.symbol !== record.symbol) return false;
    if (payload?.exchange && payload.exchange !== 'aggregate' && !record.exchanges.has(payload.exchange)) return false;
    if (eventName === 'market-data:trade') return record.feeds.has('trades');
    if (eventName === 'market-data:candle' || eventName === 'market-data:candle-history') {
      return record.feeds.has('candles') && (!record.intervals || record.intervals.has(payload?.intervalMs));
    }
    return eventName === 'market-data:connection-status';
  }

  requirements() {
    const result = new Map([...this.providers.keys()].map(id => [id, new Map()]));
    for (const record of this.consumers.values()) {
      for (const exchange of record.exchanges) {
        const symbols = result.get(exchange);
        if (!symbols.has(record.symbol)) symbols.set(record.symbol, new Set());
        if (this.providers.get(exchange).supports('trades')) symbols.get(record.symbol).add('trades');
      }
    }
    return result;
  }

  status() {
    const shared = {};
    for (const [exchange, symbols] of this.requirements()) {
      shared[exchange] = Object.fromEntries([...symbols].map(([symbol, feeds]) => [symbol, [...feeds]]));
    }
    return { consumers: this.consumers.size, shared };
  }

  close() { this.consumers.clear(); this._changed(); }
  _changed() { this.emit('change', this.requirements()); }
}

module.exports = { SubscriptionManager, FEEDS, parseIntervals };

'use strict';

const { EventEmitter } = require('node:events');

function formatInterval(intervalMs) {
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

class CandleEngine extends EventEmitter {
  constructor({ intervals = [60_000] } = {}) {
    super();
    this.intervals = [...new Set(intervals)].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    this.candles = new Map();
  }

  _key(symbol, exchange, intervalMs) { return `${exchange}:${symbol}:${intervalMs}`; }

  ingest(trade) {
    const updates = [];
    const closed = [];
    for (const intervalMs of this.intervals) {
      const start = Math.floor(trade.timestamp / intervalMs) * intervalMs;
      const key = this._key(trade.symbol, trade.exchange, intervalMs);
      let candle = this.candles.get(key);
      if (candle && start > candle.start) {
        const completed = Object.freeze({ ...candle, closed: true });
        closed.push(completed);
        this.emit('candle', completed);
        candle = null;
      }
      if (candle && start < candle.start) {
        this.emit('late-trade', trade);
        continue;
      }
      if (!candle) {
        candle = {
          symbol: trade.symbol, exchange: trade.exchange, interval: formatInterval(intervalMs), intervalMs, start, end: start + intervalMs,
          firstTradeAt: trade.timestamp, lastTradeAt: trade.timestamp,
          open: trade.price, high: trade.price, low: trade.price, close: trade.price,
          volume: 0, tradeCount: 0, buyVolume: 0, sellVolume: 0, delta: 0,
        };
        this.candles.set(key, candle);
      }
      candle.high = Math.max(candle.high, trade.price);
      candle.low = Math.min(candle.low, trade.price);
      if (trade.timestamp < candle.firstTradeAt) {
        candle.firstTradeAt = trade.timestamp;
        candle.open = trade.price;
      }
      if (trade.timestamp >= candle.lastTradeAt) {
        candle.lastTradeAt = trade.timestamp;
        candle.close = trade.price;
      }
      candle.volume += trade.quantity;
      candle.tradeCount += 1;
      if (trade.side === 'buy') candle.buyVolume += trade.quantity;
      else candle.sellVolume += trade.quantity;
      candle.delta = candle.buyVolume - candle.sellVolume;
      const update = Object.freeze({ ...candle, closed: false });
      updates.push(update);
      this.emit('candle', update);
    }
    return { updates, closed };
  }

  get(symbol, intervalMs = this.intervals[0], exchange) {
    const candle = this.candles.get(this._key(symbol, exchange, intervalMs));
    return candle ? { ...candle, closed: false } : null;
  }

  clear(symbol) {
    for (const key of this.candles.keys()) if (key.includes(`:${symbol}:`)) this.candles.delete(key);
  }
}

module.exports = { CandleEngine, formatInterval };

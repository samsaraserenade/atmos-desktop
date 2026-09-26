'use strict';

const { EventEmitter } = require('node:events');
const { ReliableWebSocket } = require('../websocket-manager');

// Coinbase Exchange spot. Its dollar books are USD, so USDT and USDC symbols
// are served from the USD product (BTCUSDT -> BTC-USD): close to, but not
// exactly, the stablecoin price. Events keep the symbol that was asked for.
const QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'BTC', 'ETH'];
const USD_QUOTES = new Set(['USDT', 'USDC', 'USD']);

function toCoinbase(symbol) {
  const quote = QUOTES.find(item => symbol.endsWith(item) && symbol.length > item.length);
  if (!quote) return symbol;
  return `${symbol.slice(0, -quote.length)}-${USD_QUOTES.has(quote) ? 'USD' : quote}`;
}

class CoinbaseAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = 'coinbase';
    this.subscriptions = new Map();
    this.symbolsByProduct = new Map();
    // Coinbase has no application-level ping; the heartbeat channel sends a
    // message every second per product, which keeps quiet markets from
    // looking stale.
    this.socket = new ReliableWebSocket({ id: this.id, WebSocketImpl: options.WebSocketImpl, url: () => 'wss://ws-feed.exchange.coinbase.com', heartbeatMs: 20_000, staleMs: options.staleMs || 45_000, heartbeat: () => {} });
    this.socket.on('open', () => this._subscribe());
    this.socket.on('message', value => this._message(value));
    this.socket.on('status', value => this.emit('status', value));
    this.socket.on('socket-error', error => this.emit('error', error));
  }
  supports(feed) { return feed === 'trades'; }
  setSubscriptions(subscriptions) {
    const next = new Map([...subscriptions].map(([symbol, feeds]) => [symbol, new Set([...feeds].filter(feed => this.supports(feed)))]).filter(([, feeds]) => feeds.size));
    const changed = JSON.stringify([...next].map(([s, f]) => [s, [...f].sort()])) !== JSON.stringify([...this.subscriptions].map(([s, f]) => [s, [...f].sort()]));
    this.subscriptions = next;
    this.symbolsByProduct = new Map();
    for (const symbol of next.keys()) {
      const product = toCoinbase(symbol);
      if (!this.symbolsByProduct.has(product)) this.symbolsByProduct.set(product, new Set());
      this.symbolsByProduct.get(product).add(symbol);
    }
    if (!next.size) this.socket.stop();
    else if (changed) this.socket.restart();
  }
  _subscribe() {
    const productIds = [...this.symbolsByProduct.keys()];
    if (productIds.length) this.socket.send({ type: 'subscribe', product_ids: productIds, channels: ['matches', 'heartbeat'] });
  }
  _message(value) {
    try {
      const message = JSON.parse(value);
      // Skip `last_match` (the previous trade, sent once on subscribe): it can
      // be old on a quiet market and would open a stale candle.
      if (message.type !== 'match') return;
      // `side` is the resting (maker) order's side; the aggressor is the opposite.
      const side = String(message.side).toLowerCase() === 'buy' ? 'sell' : 'buy';
      for (const symbol of this.symbolsByProduct.get(message.product_id) || []) {
        this.emit('event', { type: 'trade', data: { symbol, price: message.price, quantity: message.size, side, timestamp: Date.parse(message.time), tradeId: message.trade_id, exchange: this.id } });
      }
    } catch (error) { this.emit('error', error); }
  }
  getHealth() { return { ...this.socket.getHealth(), subscriptions: this.subscriptions.size, rateLimitAware: true }; }
  close() { this.socket.stop(); }
}

module.exports = { CoinbaseAdapter, toCoinbase };

'use strict';

const { EventEmitter } = require('node:events');
const { ReliableWebSocket } = require('../websocket-manager');

const QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'BTC', 'ETH'];
function toKraken(symbol) {
  const quote = QUOTES.find(item => symbol.endsWith(item));
  if (!quote) return symbol;
  const base = symbol.slice(0, -quote.length);
  return `${base}/${quote}`;
}
function fromKraken(symbol) { return String(symbol).replace('/', '').replace(/^XBT/, 'BTC'); }

class KrakenAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = 'kraken';
    this.subscriptions = new Map();
    this.socket = new ReliableWebSocket({ id: this.id, WebSocketImpl: options.WebSocketImpl, url: () => 'wss://ws.kraken.com/v2', heartbeatMs: 20_000, staleMs: options.staleMs || 45_000, heartbeat: socket => socket.send({ method: 'ping', req_id: Date.now() }) });
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
    if (!next.size) this.socket.stop();
    else if (changed) this.socket.restart();
  }
  _subscribe() {
    const trades = [...this.subscriptions.keys()].map(toKraken);
    if (trades.length) this.socket.send({ method: 'subscribe', params: { channel: 'trade', symbol: trades, snapshot: false } });
  }
  _message(value) {
    try {
      const message = JSON.parse(value);
      if (message.channel === 'trade') for (const trade of message.data || []) this.emit('event', { type: 'trade', data: { symbol: fromKraken(trade.symbol), price: trade.price, quantity: trade.qty, side: trade.side, timestamp: Date.parse(trade.timestamp), tradeId: trade.trade_id, exchange: this.id } });
    } catch (error) { this.emit('error', error); }
  }
  getHealth() { return { ...this.socket.getHealth(), subscriptions: this.subscriptions.size, rateLimitAware: true }; }
  close() { this.socket.stop(); }
}

module.exports = { KrakenAdapter, toKraken, fromKraken };

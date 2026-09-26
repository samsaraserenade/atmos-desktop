'use strict';

const { EventEmitter } = require('node:events');
const { ReliableWebSocket } = require('../websocket-manager');

class BybitAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = 'bybit';
    this.subscriptions = new Map();
    this.socket = new ReliableWebSocket({ id: this.id, WebSocketImpl: options.WebSocketImpl, url: () => 'wss://stream.bybit.com/v5/public/linear', heartbeatMs: 20_000, staleMs: options.staleMs || 45_000 });
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
    const args = [...this.subscriptions.keys()].map(symbol => `publicTrade.${symbol}`);
    for (let index = 0; index < args.length; index += 10) this.socket.send({ op: 'subscribe', args: args.slice(index, index + 10), req_id: `atmos-${index / 10}` });
  }
  _message(value) {
    try {
      const message = JSON.parse(value);
      if (!message.topic || !message.data) return;
      if (message.topic.startsWith('publicTrade.')) for (const trade of message.data) this.emit('event', { type: 'trade', data: { symbol: trade.s, price: trade.p, quantity: trade.v, side: String(trade.S).toLowerCase(), timestamp: trade.T, tradeId: trade.i, exchange: this.id } });
    } catch (error) { this.emit('error', error); }
  }
  getHealth() { return { ...this.socket.getHealth(), subscriptions: this.subscriptions.size, rateLimitAware: true }; }
  close() { this.socket.stop(); }
}

module.exports = { BybitAdapter };

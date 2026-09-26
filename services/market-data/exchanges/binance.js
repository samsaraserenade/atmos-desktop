'use strict';

const { EventEmitter } = require('node:events');
const { ReliableWebSocket } = require('../websocket-manager');

class BinanceAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = 'binance';
    this.subscriptions = new Map();
    this.socket = new ReliableWebSocket({
      id: this.id,
      WebSocketImpl: options.WebSocketImpl,
      url: () => this._url(),
      heartbeatMs: 120_000,
      staleMs: options.staleMs || 180_000,
      heartbeat: () => {},
    });
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
  _url() {
    const streams = [...this.subscriptions.keys()].map(symbol => `${symbol.toLowerCase()}@aggTrade`);
    return `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;
  }
  _message(value) {
    try {
      const envelope = JSON.parse(value);
      const data = envelope.data || envelope;
      if (data.e === 'aggTrade') this.emit('event', { type: 'trade', data: { symbol: data.s, price: data.p, quantity: data.q, side: data.m ? 'sell' : 'buy', timestamp: data.T || data.E, tradeId: data.a, exchange: this.id } });
    } catch (error) { this.emit('error', error); }
  }
  getHealth() { return { ...this.socket.getHealth(), subscriptions: this.subscriptions.size, rateLimitAware: true }; }
  close() { this.socket.stop(); }
}

module.exports = { BinanceAdapter };

'use strict';

const { EventEmitter } = require('node:events');

class ReliableWebSocket extends EventEmitter {
  constructor({ id, url, WebSocketImpl = globalThis.WebSocket, heartbeatMs = 20_000, staleMs = 45_000, backoff = {}, heartbeat } = {}) {
    super();
    if (!id || typeof url !== 'function') throw new TypeError('ReliableWebSocket requires id and url()');
    this.id = id;
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.backoff = { initial: 1_000, maximum: 30_000, factor: 2, jitter: 0.2, ...backoff };
    this.heartbeat = heartbeat;
    this.socket = null;
    this.enabled = false;
    this.attempt = 0;
    this.lastMessageAt = 0;
    this.reconnectTimer = null;
    this.monitorTimer = null;
    this.generation = 0;
    this.status = 'idle';
    this.blocked = null;
    this.unblockTimer = null;
  }

  // Stops connecting for a while (e.g. the exchange refuses this region).
  // Subscriptions are kept, so the feed resumes by itself after retryAfterMs.
  block(reason, retryAfterMs = 3_600_000) {
    this.blocked = String(reason || 'unavailable');
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.monitorTimer);
    clearTimeout(this.unblockTimer);
    this.reconnectTimer = null;
    this.monitorTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close?.(1000, 'blocked');
    this._setStatus('unavailable', { reason: this.blocked, retryInMs: retryAfterMs });
    this.unblockTimer = setTimeout(() => this.unblock(), retryAfterMs);
    this.unblockTimer.unref?.();
  }

  unblock() {
    if (!this.blocked) return;
    clearTimeout(this.unblockTimer);
    this.unblockTimer = null;
    this.blocked = null;
    this.attempt = 0;
    if (this.enabled) this._connect();
    else this._setStatus('idle');
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._connect();
  }

  restart() {
    if (!this.enabled) return this.start();
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.socket?.close?.(1000, 'subscription change');
    this.socket = null;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.enabled = false;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.monitorTimer);
    this.reconnectTimer = null;
    this.monitorTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close?.(1000, 'service idle');
    this._setStatus(this.blocked ? 'unavailable' : 'idle', this.blocked ? { reason: this.blocked } : {});
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  }

  getHealth() {
    return { exchange: this.id, status: this.status, attempt: this.attempt, lastMessageAt: this.lastMessageAt || null, stale: this.status === 'stale', ...(this.blocked ? { reason: this.blocked } : {}) };
  }

  _connect() {
    if (!this.enabled || this.socket || this.blocked) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this._setStatus('unavailable', { reason: 'WebSocket is unavailable in this runtime' });
      return;
    }
    const generation = ++this.generation;
    this._setStatus(this.attempt ? 'reconnecting' : 'connecting');
    let socket;
    try { socket = new this.WebSocketImpl(this.url()); }
    catch (error) { this._scheduleReconnect(error); return; }
    this.socket = socket;
    let opened = false;

    socket.addEventListener('open', () => {
      if (generation !== this.generation) return;
      opened = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this._setStatus('connected');
      this.emit('open');
      clearInterval(this.monitorTimer);
      this.monitorTimer = setInterval(() => this._monitor(), Math.min(this.heartbeatMs, this.staleMs));
      this.monitorTimer.unref?.();
    });
    socket.addEventListener('message', event => {
      if (generation !== this.generation) return;
      this.lastMessageAt = Date.now();
      if (this.status === 'stale') this._setStatus('connected');
      this.emit('message', typeof event.data === 'string' ? event.data : event.data?.toString?.() ?? event.data);
    });
    socket.addEventListener('error', event => this.emit('socket-error', event.error || new Error(`${this.id} websocket error`)));
    socket.addEventListener('close', event => {
      if (generation !== this.generation) return;
      this.socket = null;
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
      // A handshake refused outright (HTTP 451/403 from a region block looks
      // like this) never opens. The WebSocket API hides the HTTP status, so
      // the service checks over REST (see MarketDataService#_checkRegion).
      if (!opened) this.emit('connect-failed', { code: event.code });
      if (this.enabled) this._scheduleReconnect(new Error(`socket closed (${event.code || 'unknown'})`));
    });
  }

  _monitor() {
    if (!this.enabled || !this.socket) return;
    const age = Date.now() - this.lastMessageAt;
    if (age >= this.staleMs) {
      this._setStatus('stale', { ageMs: age });
      this.socket.close?.(4000, 'stale feed');
      return;
    }
    try { this.heartbeat ? this.heartbeat(this) : this.send({ op: 'ping' }); }
    catch (error) { this.emit('socket-error', error); }
  }

  _scheduleReconnect(error) {
    if (!this.enabled || this.reconnectTimer || this.blocked) return;
    this.socket = null;
    const base = Math.min(this.backoff.maximum, this.backoff.initial * this.backoff.factor ** this.attempt++);
    const variance = base * this.backoff.jitter;
    const delayMs = Math.round(base - variance + Math.random() * variance * 2);
    this._setStatus('reconnecting', { reason: error?.message, retryInMs: delayMs });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, delayMs);
    this.reconnectTimer.unref?.();
  }

  _setStatus(status, details = {}) {
    if (status === this.status && !Object.keys(details).length) return;
    this.status = status;
    this.emit('status', Object.freeze({ ...this.getHealth(), ...details, timestamp: Date.now() }));
  }
}

class WebSocketManager extends EventEmitter {
  constructor() { super(); this.connectors = new Map(); }
  add(connector) {
    if (!connector?.id || this.connectors.has(connector.id)) throw new Error(`duplicate or invalid exchange connector: ${connector?.id}`);
    this.connectors.set(connector.id, connector);
    connector.on('event', event => this.emit('event', event));
    connector.on('status', status => this.emit('status', status));
    connector.on('error', error => this.emit('error', { exchange: connector.id, error }));
    connector.socket?.on?.('connect-failed', details => this.emit('connect-failed', { exchange: connector.id, ...details }));
    return connector;
  }
  block(id, reason, retryAfterMs) { this.connectors.get(id)?.socket?.block(reason, retryAfterMs); }
  isBlocked(id) { return Boolean(this.connectors.get(id)?.socket?.blocked); }
  update(requirements) {
    for (const connector of this.connectors.values()) connector.setSubscriptions(requirements.get(connector.id) || new Map());
  }
  status() { return Object.fromEntries([...this.connectors].map(([id, connector]) => [id, connector.getHealth()])); }
  close() {
    for (const connector of this.connectors.values()) {
      clearTimeout(connector.socket?.unblockTimer);
      connector.close();
    }
  }
}

module.exports = { ReliableWebSocket, WebSocketManager };

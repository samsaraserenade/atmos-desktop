'use strict';

const SIDES = new Set(['buy', 'sell']);

function symbol(value) {
  if (typeof value !== 'string') throw new TypeError('market symbol must be a string');
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) throw new TypeError('market symbol cannot be empty');
  return normalized;
}

function number(value, field, { positive = false, nonNegative = false } = {}) {
  const result = Number(value);
  if (!Number.isFinite(result) || (positive && result <= 0) || (nonNegative && result < 0)) {
    throw new TypeError(`${field} must be a finite ${positive ? 'positive ' : nonNegative ? 'non-negative ' : ''}number`);
  }
  return result;
}

function timestamp(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? Math.trunc(result) : Date.now();
}

function side(value) {
  const result = String(value || '').toLowerCase();
  if (!SIDES.has(result)) throw new TypeError(`unsupported market side: ${value}`);
  return result;
}

function exchange(value) {
  const result = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) throw new TypeError('invalid exchange id');
  return result;
}

function normalizeTrade(raw) {
  const direction = side(raw.side);
  return Object.freeze({
    symbol: symbol(raw.symbol),
    price: number(raw.price, 'price', { positive: true }),
    quantity: number(raw.quantity, 'quantity', { positive: true }),
    side: direction,
    aggressor: direction === 'buy' ? 'buyer' : 'seller',
    exchange: exchange(raw.exchange),
    timestamp: timestamp(raw.timestamp),
    tradeId: raw.tradeId == null ? undefined : String(raw.tradeId),
  });
}

function normalize(type, raw) {
  if (type === 'trade') return normalizeTrade(raw);
  throw new TypeError(`unsupported market event type: ${type}`);
}

module.exports = { normalize, normalizeTrade, symbol };

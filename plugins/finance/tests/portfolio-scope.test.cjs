'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let source = fs.readFileSync(`${__dirname}/../src/portfolio-scope.js`, 'utf8')
  .replace("import { portfolioState } from '../persist.js';", '')
  .replace(/\bexport\s+/g, '');
const context = vm.createContext({ portfolioState: { excludedHoldings: {}, excludedSources: {}, excludedGroups: {} } });
vm.runInContext(source, context);

const holding = { id: 'wallet-a:token:usdc', value: 25 };
assert.equal(context.holdingScopeKey('solana-wallet', holding), 'solana-wallet|wallet-a:token:usdc');
assert.equal(context.isHoldingIncluded('solana-wallet', holding), true);
context.setHoldingIncluded('solana-wallet', holding, false);
assert.equal(context.isHoldingIncluded('solana-wallet', holding), false);
const scoped = context.scopedPortfolioData({ value: 100, spot: 100, perp: 0, holdings: [holding, { id: 'other', value: 75 }] }, 'solana-wallet');
assert.equal(scoped.value, 75);
assert.equal(scoped.holdings.length, 1);
assert.equal(scoped.spot, null);
context.setHoldingIncluded('solana-wallet', holding, true);
assert.equal(context.isHoldingIncluded('solana-wallet', holding), true);
const position = { id: 'BTC Perp:invested', value: 20, meta: { instrument: 'perp' } };
const earn = { id: 'USDC Earn:cash', value: 40, meta: { instrument: 'perp-cash', account: 'earn' } };
assert.equal(context.holdingScopeGroup('hyperliquid-wallet', position), 'perp');
assert.equal(context.holdingScopeGroup('hyperliquid-wallet', earn), 'earn');
context.setHoldingIncluded('hyperliquid-wallet', position, false);
assert.equal(context.isHoldingIncluded('hyperliquid-wallet', position), true, 'positions cannot be excluded independently');
assert.equal(context.excludedHoldingKeys().some(key => key.startsWith('hyperliquid-wallet|')), false, 'legacy Hyperliquid item keys are not sent');
context.setGroupIncluded('hyperliquid-wallet', 'perp', false);
assert.equal(context.isHoldingIncluded('hyperliquid-wallet', position), false);
assert.equal(context.isHoldingIncluded('hyperliquid-wallet', earn), true);
console.log('Passed: portfolio scope keeps reversible stable holding exclusions');

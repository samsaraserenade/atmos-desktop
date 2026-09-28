'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = file => fs.readFileSync(`${__dirname}/../src/${file}`, 'utf8')
  .replace(/^import .*?;\r?\n/gm, '')
  .replace(/\bexport\s+/g, '');
let source = script('legacy-holdings.js') + script('portfolio-scope.js');
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
assert.equal(context.excludedHoldingKeys().includes('hyperliquid-wallet|BTC Perp:invested'), true, 'a saved key is sent; the server ignores it for a grouped holding');
context.setGroupIncluded('hyperliquid-wallet', 'perp', false);
assert.equal(context.isHoldingIncluded('hyperliquid-wallet', position), false);
assert.equal(context.isHoldingIncluded('hyperliquid-wallet', earn), true);
// Groups are the connector's: any source, any group id.
const margin = { id: 'USDT:cash', value: 50, meta: { instrument: 'perp-cash', group: 'futures' } };
assert.equal(context.holdingScopeGroup('exchange:main', margin), 'futures');
context.setGroupIncluded('exchange:main', 'futures', false);
assert.equal(context.isHoldingIncluded('exchange:main', margin), false);
assert.equal(context.holdingScopeGroup('solana-wallet', { meta: { instrument: 'perp' } }), null, 'only an old server\'s Hyperliquid rows are grouped without meta.group');
assert.equal(context.holdingScopeGroup('hyperliquid-wallet', { meta: { instrument: 'spot' } }), null);
console.log('Passed: portfolio scope keeps reversible stable holding exclusions');

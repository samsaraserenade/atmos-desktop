'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let source = fs.readFileSync(`${__dirname}/../src/allocation-breakdown.js`, 'utf8')
  .replace("import { isPerpHolding } from './portfolio-sections.js';", '')
  .replace("import { isHoldingIncluded } from './portfolio-scope.js';", '')
  .replace(/\bexport\s+/g, '');
const context = vm.createContext({
  isPerpHolding: holding => ['perp', 'perp-cash'].includes(holding?.meta?.instrument),
  isHoldingIncluded: () => true,
});
vm.runInContext(source, context);

const portfolios = new Map([
  ['solana-wallet', { label: 'SOL', currency: 'USD', holdings: [
    { symbol: 'BTC', value: 1500, kind: 'invested', meta: { walletAddress: 'WalletOne', chain: 'Solana' } },
    { symbol: 'USDC', value: 500, kind: 'cash', meta: { walletAddress: 'WalletOne', chain: 'Solana' } },
  ] }],
  ['hyperliquid-wallet', { label: 'HL', currency: 'USD', holdings: [
    { symbol: 'BTC Perp', value: 200, kind: 'invested', meta: { instrument: 'perp', side: 'short', positionValue: 1000, dapp: 'Hyperliquid' } },
    { symbol: 'USDC', value: 170, kind: 'cash', meta: { instrument: 'perp-cash', dapp: 'Hyperliquid' } },
    { symbol: 'USDC Earn', value: 170, kind: 'cash', meta: { instrument: 'perp-cash', account: 'earn', dapp: 'Hyperliquid' } },
  ] }],
]);

const capital = context.buildAllocationBreakdown(portfolios, { book: 'all', dimension: 'dapp' });
assert.equal(capital.total, 2540);
assert.equal(capital.entries.find(item => item.label === 'Hyperliquid').value, 540);
const perpAccounting = context.buildAllocationBreakdown(portfolios, { book: 'perp', dimension: 'accounting' });
assert.equal(perpAccounting.entries.find(item => item.label === 'Stablecoin').value, 340);
assert.equal(perpAccounting.entries.find(item => item.label === 'Invested').value, 200);
assert.equal(context.holdingDimensions('hyperliquid-wallet', 'HL', portfolios.get('hyperliquid-wallet').holdings[2]).protocol, 'Lending');

const exposure = context.buildNetExposure(portfolios);
assert.equal(exposure.entries.find(item => item.label === 'BTC').value, 500, 'spot BTC and a BTC short must net together');
assert.equal(exposure.entries.some(item => item.label === 'USDC'), false, 'stablecoins and perp collateral belong to capital, not directional exposure');
portfolios.get('hyperliquid-wallet').holdings[0].value = 0;
assert.equal(context.buildNetExposure(portfolios).entries.find(item => item.label === 'BTC').value, 500, 'zero-equity open perps retain notional exposure');
console.log('Passed: capital location stays separate from signed net exposure');

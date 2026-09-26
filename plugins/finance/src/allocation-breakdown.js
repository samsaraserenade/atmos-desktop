import { isPerpHolding } from './portfolio-sections.js';
import { isHoldingIncluded } from './portfolio-scope.js';

export const ALLOCATION_DIMENSIONS = Object.freeze([
  { id: 'dapp', label: 'dApp' },
  { id: 'protocol', label: 'Protocol Type' },
  { id: 'exchange', label: 'Exchange' },
  { id: 'chain', label: 'Chain' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'accounting', label: 'Stable / Invested' },
]);

const SOURCE_PROFILES = Object.freeze({
  'binance-spot': { dapp: 'Binance', protocol: 'Exchange', exchange: 'Binance', chain: 'Exchange' },
  'hyperliquid-wallet': { dapp: 'Hyperliquid', protocol: 'Perpetuals', exchange: 'Hyperliquid', chain: 'Hyperliquid L1' },
  'solana-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Solana' },
  'cardano-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Cardano' },
  'bsc-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'BNB Chain' },
  'arbitrum-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Arbitrum' },
  'aptos-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Aptos' },
  'inj-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Injective' },
  'monero-wallet': { dapp: 'Wallet', protocol: 'Wallet', exchange: 'Self-custody', chain: 'Monero' },
});

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'PYUSD', 'GUSD', 'FRAX', 'LUSD', 'USDD', 'EURC', 'EURT', 'USDHL']);

function cleanSymbol(symbol) {
  return String(symbol || '').replace(/\s+(Earn|Perp|\(staked\))$/i, '').toUpperCase();
}

export function holdingDimensions(sourceId, sourceLabel, holding) {
  const meta = holding?.meta || {};
  const profile = SOURCE_PROFILES[sourceId] || {};
  const symbol = String(holding?.symbol || 'Asset');
  const earn = meta.account === 'earn' || /\sEarn$/i.test(symbol);
  const staked = meta.protocolType === 'Staking' || /staked/i.test(symbol);
  const perp = isPerpHolding(holding, sourceId);
  const stable = holding?.kind === 'cash' || STABLES.has(cleanSymbol(symbol));
  const wallet = String(meta.walletAddress || '').trim();
  return {
    book: perp ? 'perp' : 'spot',
    dapp: String(meta.dapp || profile.dapp || sourceLabel || sourceId || 'Other'),
    protocol: String(meta.protocolType || (earn ? 'Lending' : staked ? 'Staking' : perp ? 'Perpetuals' : sourceId === 'hyperliquid-wallet' ? 'Exchange' : profile.protocol || 'Wallet')),
    exchange: String(meta.exchange || profile.exchange || 'Self-custody'),
    chain: String(meta.chain || profile.chain || 'Other'),
    wallet: wallet || (profile.exchange && profile.exchange !== 'Self-custody' ? `${profile.exchange} account` : 'Unspecified wallet'),
    accounting: stable ? 'Stablecoin' : 'Invested',
  };
}

export function buildAllocationBreakdown(portfolios, {
  book = 'all', dimension = 'dapp', convert = value => value, maxEntries = 8,
} = {}) {
  const grouped = new Map();
  let total = 0;
  for (const [sourceId, data] of portfolios || []) {
    if (!data || !Array.isArray(data.holdings)) continue;
    for (const holding of data.holdings) {
      if (!isHoldingIncluded(sourceId, holding)) continue;
      const rawValue = Number(holding?.value);
      if (!(rawValue > 0)) continue;
      const dimensions = holdingDimensions(sourceId, data.label, holding);
      if (book !== 'all' && dimensions.book !== book) continue;
      const value = Math.max(0, Number(convert(rawValue, holding.currency || data.currency || 'USD')) || 0);
      if (!(value > 0)) continue;
      const label = dimensions[dimension] || 'Other';
      grouped.set(label, (grouped.get(label) || 0) + value);
      total += value;
    }
  }
  let entries = [...grouped].map(([label, value]) => ({ id: label, label, value }))
    .sort((a, b) => b.value - a.value);
  if (entries.length > maxEntries) {
    const leading = entries.slice(0, maxEntries - 1);
    const rest = entries.slice(maxEntries - 1);
    entries = [...leading, { id: '__other', label: 'Other', value: rest.reduce((sum, item) => sum + item.value, 0), groupedCount: rest.length }];
  }
  return {
    book,
    dimension,
    total,
    entries: entries.map(entry => ({ ...entry, share: total ? entry.value / total : 0 })),
  };
}

/**
 * Economic delta, not capital-at-risk: spot is positive exposure; a perp's
 * signed notional is positive for a long and negative for a short. Perp
 * collateral and Earn are capital locations, not directional coin exposure,
 * so they are deliberately absent here.
 */
export function buildNetExposure(portfolios, { convert = value => value, maxEntries = 10 } = {}) {
  const grouped = new Map();
  for (const [sourceId, data] of portfolios || []) {
    if (!data || !Array.isArray(data.holdings)) continue;
    for (const holding of data.holdings) {
      if (!isHoldingIncluded(sourceId, holding)) continue;
      const rawValue = Number(holding?.value);
      const meta = holding?.meta || {};
      const perp = meta.instrument === 'perp';
      if (!(rawValue > 0) && !(perp && Number(meta.positionValue) > 0)) continue;
      if (isPerpHolding(holding, sourceId) && !perp) continue;
      // Stablecoin/cash concentration belongs to the Capital lens. Keeping
      // it out here prevents collateral from dwarfing the signed BTC/ETH/etc.
      // positions this glanceable directional view exists to show.
      if (!perp && (holding?.kind === 'cash' || STABLES.has(cleanSymbol(holding.symbol)))) continue;
      const symbol = cleanSymbol(holding.symbol);
      if (!symbol) continue;
      const exposureValue = perp && Number.isFinite(Number(meta.positionValue))
        ? Math.abs(Number(meta.positionValue))
        : rawValue;
      const converted = Math.max(0, Number(convert(exposureValue, holding.currency || data.currency || 'USD')) || 0);
      if (!(converted > 0)) continue;
      const signed = perp && meta.side === 'short' ? -converted : converted;
      grouped.set(symbol, (grouped.get(symbol) || 0) + signed);
    }
  }
  let entries = [...grouped].map(([label, value]) => ({ id: label, label, value }))
    .filter(entry => Math.abs(entry.value) >= 0.005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (entries.length > maxEntries) entries = entries.slice(0, maxEntries);
  const gross = entries.reduce((sum, entry) => sum + Math.abs(entry.value), 0);
  const net = entries.reduce((sum, entry) => sum + entry.value, 0);
  return { gross, net, entries: entries.map(entry => ({ ...entry, share: gross ? Math.abs(entry.value) / gross : 0 })) };
}

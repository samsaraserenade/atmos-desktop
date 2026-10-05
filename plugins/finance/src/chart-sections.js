/**
 * What a portfolio chart shows: 'total', 'spot', 'perp', or one coin you
 * hold ('coin:SOL', src/coin-history.js). Saved with each chart and asked
 * for by rev/portfolio, so it's plain text checked here.
 */
const COIN = 'coin:';
const MAX_SYMBOL = 40;

export const coinSection = symbol => `${COIN}${symbol}`;

/** The coin a section shows ('coin:SOL' → 'SOL'), or null. */
export function sectionCoin(value) {
  if (typeof value !== 'string' || !value.startsWith(COIN)) return null;
  const symbol = value.slice(COIN.length);
  return symbol && symbol.length <= MAX_SYMBOL && !/[\r\n]/.test(symbol) ? symbol : null;
}

export function isPortfolioSection(value) {
  return value === 'total' || value === 'spot' || value === 'perp' || sectionCoin(value) !== null;
}

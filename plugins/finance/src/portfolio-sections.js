/** Account ownership is independent of whether a position is open. */
export function isPerpHolding(holding, sourceId = '') {
  const instrument = holding?.meta?.instrument;
  if (instrument === 'spot' || instrument === 'spot-cash') return false;
  if (instrument === 'perp' || instrument === 'perp-cash') return true;
  return /hyperliquid/i.test(sourceId) &&
    (holding?.kind === 'cash' || /\bperp\b/i.test(holding?.symbol || ''));
}
export function splitPortfolio(data, sourceId, convert) {
  const total = convert(Number(data?.value) || 0, data?.currency ?? '$');
  if (data?.spot != null && data?.perp != null && Number.isFinite(Number(data.spot)) && Number.isFinite(Number(data.perp))) {
    return { total, spot: convert(Number(data.spot), data.currency ?? '$'), perp: convert(Number(data.perp), data.currency ?? '$') };
  }
  if (!Array.isArray(data?.holdings)) return { total, spot: null, perp: null };
  let perp = 0;
  for (const holding of data.holdings) {
    if (isPerpHolding(holding, sourceId)) perp += convert(Number(holding.value) || 0, holding.currency ?? data.currency ?? '$');
  }
  return { total, spot: total - perp, perp };
}

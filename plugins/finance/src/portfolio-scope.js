import { portfolioState } from '../persist.js';

const SEP = '|';

export function holdingScopeKey(sourceId, holdingOrId) {
  const holdingId = typeof holdingOrId === 'object'
    ? holdingOrId?.id ?? holdingOrId?.holding_id
    : holdingOrId;
  return `${String(sourceId || '')}${SEP}${String(holdingId || '')}`;
}

export function excludedHoldingKeys() {
  return Object.entries(portfolioState.excludedHoldings || {})
    .filter(([, excluded]) => excluded === true)
    .map(([key]) => key)
    // Hyperliquid used to expose its internal cash and position rows here.
    // Those saved keys are obsolete now that Perp and Earn are stable groups.
    .filter(key => !key.startsWith(`hyperliquid-wallet${SEP}`));
}

export function excludedSourceIds() {
  return Object.entries(portfolioState.excludedSources || {})
    .filter(([, excluded]) => excluded === true)
    .map(([sourceId]) => sourceId);
}

export function holdingScopeGroup(sourceId, holding) {
  if (sourceId !== 'hyperliquid-wallet') return null;
  if (holding?.meta?.account === 'earn') return 'earn';
  return ['perp', 'perp-cash'].includes(holding?.meta?.instrument) ? 'perp' : null;
}

export function excludedGroupKeys() {
  return Object.entries(portfolioState.excludedGroups || {})
    .filter(([, excluded]) => excluded === true)
    .map(([key]) => key);
}

export function isGroupIncluded(sourceId, group) {
  return portfolioState.excludedGroups?.[`${sourceId}${SEP}${group}`] !== true;
}

export function setGroupIncluded(sourceId, group, included) {
  const next = { ...(portfolioState.excludedGroups || {}) };
  const key = `${sourceId}${SEP}${group}`;
  if (included) delete next[key];
  else next[key] = true;
  portfolioState.excludedGroups = next;
}

export function isSourceIncluded(sourceId) {
  return portfolioState.excludedSources?.[String(sourceId || '')] !== true;
}

export function setSourceIncluded(sourceId, included) {
  const next = { ...(portfolioState.excludedSources || {}) };
  if (included) delete next[sourceId];
  else next[sourceId] = true;
  portfolioState.excludedSources = next;
}

export function isHoldingIncluded(sourceId, holding) {
  if (!isSourceIncluded(sourceId)) return false;
  // Hyperliquid capital has two stable semantic books. Free USDC and position
  // equity are one Perp balance; reallocations between them must never change
  // scope. Earn is the second balance. Old per-holding exclusions are ignored
  // for both groups so the first experimental UI cannot leave chart artifacts.
  const group = holdingScopeGroup(sourceId, holding);
  if (group) return isGroupIncluded(sourceId, group);
  return portfolioState.excludedHoldings?.[holdingScopeKey(sourceId, holding)] !== true;
}

export function setHoldingIncluded(sourceId, holding, included) {
  const next = { ...(portfolioState.excludedHoldings || {}) };
  const key = holdingScopeKey(sourceId, holding);
  if (included) delete next[key];
  else next[key] = true;
  portfolioState.excludedHoldings = next;
}

export function scopedPortfolioData(data, sourceId) {
  if (!data || !Array.isArray(data.holdings)) return data;
  if (!isSourceIncluded(sourceId)) return { ...data, value: 0, holdings: [], spot: null, perp: null };
  const holdings = data.holdings.filter(holding => isHoldingIncluded(sourceId, holding));
  const excludedValue = data.holdings
    .filter(holding => !isHoldingIncluded(sourceId, holding))
    .reduce((sum, holding) => sum + Math.max(0, Number(holding?.value) || 0), 0);
  return {
    ...data,
    value: Math.max(0, (Number(data.value) || 0) - excludedValue),
    holdings,
    // These are aggregates from the unfiltered server frame. Force callers
    // to rebuild Spot/Perps from the filtered holdings instead of reusing
    // values that still include the excluded rows.
    spot: null,
    perp: null,
  };
}

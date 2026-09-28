import { portfolioState } from '../persist.js';
import { legacyGroup } from './legacy-holdings.js';

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
    .map(([key]) => key);
  // A saved key for a grouped holding (from before groups) is harmless: the
  // server, like isHoldingIncluded(), ignores it and goes by the group.
}

export function excludedSourceIds() {
  return Object.entries(portfolioState.excludedSources || {})
    .filter(([, excluded]) => excluded === true)
    .map(([sourceId]) => sourceId);
}

/**
 * The group a holding belongs to (meta.group, set by its connector:
 * Hyperliquid's 'perp' and 'earn', say), or null. A grouped holding is
 * included or left out with its group, never on its own.
 */
export function holdingScopeGroup(sourceId, holding) {
  const group = holding?.meta?.group;
  if (typeof group === 'string' && group) return group;
  return legacyGroup(sourceId, holding);
}

export function excludedGroupKeys() {
  return Object.entries(portfolioState.excludedGroups || {})
    .filter(([, excluded]) => excluded === true)
    .map(([key]) => key);
}

/**
 * What the portfolio includes, as one string. The VPS history depends on
 * this and on no other setting, so it is reloaded only when this changes.
 */
export function historyScopeKey() {
  return [
    ...excludedHoldingKeys().map(key => `h:${key}`),
    ...excludedSourceIds().map(id => `s:${id}`),
    ...excludedGroupKeys().map(key => `g:${key}`),
  ].sort().join('\n');
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
  // A group is one balance (Hyperliquid's free USDC and position equity are
  // one Perp balance), so moving money within it must never change scope.
  // Per-holding exclusions are ignored for grouped holdings.
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

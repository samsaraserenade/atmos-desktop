import './markets/persist.js';
import {
  onStateLoaded,
  registerStateNamespace,
  save,
} from './src/host/persist.js';

const DEFAULTS = {
  privacyMode: false,
  chartSmoothing: 0,
  chartLineOpacity: 85,
  priceTagVisible: false,
  chartLineColorUp: '#34d399',
  chartLineColorDown: '#f87171',
  timeAxisVisible: true,
  priceAxisVisible: true,
  samsaraOverlayEnabled: true,
  samsaraMaEnabled: true,
  samsaraMa1Enabled: true,
  samsaraMa2Enabled: true,
  samsaraMa3Enabled: true,
  samsaraMa4Enabled: true,
  samsaraMa5Enabled: true,
  samsaraMaOpacity: 58,
  samsaraRsiEnabled: true,
  samsaraSessionsEnabled: true,
  samsaraCandleColoringEnabled: true,
  samsaraCandleColorBasis: 'session',
  cashInvestedPaneVisible: true,
  cashInvestedPaneHeight: 56,
  portfolioChartSettings: null,
  chartVisible: false,
  toolbarCollapsed: false,
  chartLayout: 1,
  chartLayoutOrientation: 'horizontal',
  extraCharts: [],
  // Which chart the single chart-panel host is showing -- 'portfolio' (the
  // balance chart) or 'markets' (a specific ticker, whichever one is
  // current in markets/persist.js's marketQueryState.lastQuery). Restored
  // by panel.js's showMode() on every (re)mount so switching away to
  // another panel and back -- or restarting the app -- doesn't silently
  // snap back to Portfolio. The ticker itself isn't duplicated here; it
  // already persists independently via marketQueryState.
  chartMode: 'portfolio',
  // Which figure the invested/cash bar shows — flipped by clicking it
  // (see balance.js's mountCompositionBar). false = percentages, true =
  // amounts.
  compositionShowAmount: false,
  // Same idea, for the Futures accordion's own long/short bar (see
  // markets/sidebar.js's mountFuturesDirectionBar). Kept as its own
  // separate flag rather than reusing compositionShowAmount above -- the
  // two bars summarize different things and a user may want one in
  // amounts and the other in percentages.
  futuresDirectionShowAmount: false,
  // Same idea for the Day/Week/Total performance table — flipped by
  // clicking it (see balance.js's mountBalanceSection).
  performanceShowAmount: false,
  // Sort order for the Positions accordion's rows — flipped by its
  // header toggle (see markets/sidebar.js). 'change' = daily
  // performance (the long-standing default), 'share' = position size.
  positionsSortMode: 'change',
  // Sort order for Futures cards. 'pnl' ranks by unrealized profit/loss;
  // 'size' ranks by notional position value.
  futuresSortMode: 'pnl',
  // The mini sparkline behind the balance figure — toggled from
  // Finance Visuals (see sidebar-settings.js / balance.js's
  // setMiniChartVisible).
  miniChartVisible: true,
  // The big total-balance figure's typeface — picked from the Balance
  // accordion's context menu. An id into the available font list, not a raw CSS value, so an
  // old/garbage persisted string can't inject an invalid font-family.
  balanceFontFamily: 'bebas',
  // The single font imported from the Balance context menu. This remains
  // an array for compatibility with earlier saved state, but hydration and
  // imports keep only one { id, label, dataUrl } entry.
  customBalanceFonts: [],
  // All-time-high / drawdown-from-peak badge on the balance figure —
  // toggled from Finance Visuals (see balance.js's setAthVisible).
  athVisible: true,
  // "Today's Movers" list — toggled from Finance Visuals (see balance.js's
  // setMoversVisible). Ranks held assets by $ change over the last 24h,
  // computed from the VPS's per-symbol holdings history.
  moversVisible: true,
  // Market-movement vs deposits/withdrawals breakdown — toggled from
  // Finance Visuals (see balance.js's setFlowVisible). Same 24h holdings-
  // history fetch as moversVisible above; see src/daily-attribution.js.
  flowVisible: true,
  // Per-section collapsed state for the three mini-lists below the tiles
  // (Today's Movers, Portfolio Change, All-Time) — each header is its own
  // click target (see balance.js's _mountMiniList), independent from the
  // *Visible flags above (those hide a section entirely; these just fold
  // its rows away while keeping the header as a one-click way back).
  moversCollapsed: false,
  flowCollapsed: false,
  athCollapsed: false,
  // Which Futures cards have been manually collapsed (see markets/
  // sidebar.js's renderFuturesRows/click handler) -- keyed the same way
  // as the card cache itself, `${connectionId}:${coin}`, so it survives
  // an app restart the same way moversCollapsed/flowCollapsed/athCollapsed
  // above do for their own sections. A position that's since closed just
  // leaves a harmless stale key here; a reopened one starts collapsed
  // again if its key happens to match, same as any of the other
  // *Collapsed flags would.
  collapsedFutures: {},
  // Stable `${source_id}|${holding_id}` keys omitted from live totals,
  // Spot/Perps views and reconstructed history. Raw VPS records are never
  // deleted, so every exclusion is reversible.
  excludedHoldings: {},
  excludedSources: {},
  excludedGroups: {},
  allocationMode: 'capital',
  allocationBook: 'all',
  allocationDimension: 'dapp',
  tickerEnabled: {},
  // Currency every total is shown in -- cycled by the toggle in the
  // Connections header (see src/totals.js). The Currency service only
  // converts; which currency to display is Finance's own choice.
  outputCurrency: 'GBP',
};

const OUTPUT_CURRENCIES = new Set(['GBP', 'USD', 'EUR', 'CHF']);

const LEGACY_FIELDS = Object.keys(DEFAULTS).filter(
  key => !['chartVisible', 'tickerEnabled'].includes(key),
);

function objectCopy(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

function readLegacyState() {
  try {
    const raw = localStorage.getItem('samsara_v4') || localStorage.getItem('samsara_v3');
    const saved = raw ? JSON.parse(raw) : {};
    if (saved?.extensionState?.['portfolio-tracker']) return null;

    const tickerEnabled = objectCopy(JSON.parse(
      localStorage.getItem('exchange-ticker-enabled') || '{}',
    ));
    const hasFlatState = LEGACY_FIELDS.some(key => saved?.[key] != null);
    if (!hasFlatState && Object.keys(tickerEnabled).length === 0) return null;

    const migrated = structuredClone(DEFAULTS);
    for (const key of LEGACY_FIELDS) {
      if (saved?.[key] != null) migrated[key] = saved[key];
    }
    migrated.chartVisible = !!saved?.visState?.['vis-total-chart'];
    migrated.tickerEnabled = tickerEnabled;
    return migrated;
  } catch (error) {
    console.warn('[portfolio-tracker] unable to read legacy state:', error);
    return null;
  }
}

// The display currency used to be stored by the Currency service, in its
// own 'currency' namespace (and before that in a flat localStorage key).
// Read it once so the choice carries over, until Finance has saved its own.
function readLegacyOutputCurrency() {
  try {
    const raw = localStorage.getItem('samsara_v4') || localStorage.getItem('samsara_v3');
    const saved = raw ? JSON.parse(raw) : {};
    if (OUTPUT_CURRENCIES.has(saved?.extensionState?.['portfolio-tracker']?.data?.outputCurrency)) return null;
    const candidates = [
      saved?.extensionState?.currency?.data?.outputCurrency,
      localStorage.getItem('exchange-output-currency'),
    ];
    return candidates.find(value => OUTPUT_CURRENCIES.has(value)) ?? null;
  } catch {
    return null;
  }
}

const legacyState = readLegacyState();
const legacyOutputCurrency = readLegacyOutputCurrency();
let balanceFontStateNeedsSave = false;

export const portfolioState = registerStateNamespace('portfolio-tracker', {
  version: 1,
  // An imported font is kept beside Atmos state, not in it (src/host/persist.js).
  large: ['customBalanceFonts'],
  defaults: { ...(legacyState || DEFAULTS), outputCurrency: legacyOutputCurrency ?? DEFAULTS.outputCurrency },
  hydrate(namespace, saved = {}) {
    Object.assign(namespace, DEFAULTS, saved);
    namespace.outputCurrency = OUTPUT_CURRENCIES.has(saved.outputCurrency)
      ? saved.outputCurrency
      : legacyOutputCurrency ?? DEFAULTS.outputCurrency;
    namespace.tickerEnabled = objectCopy(saved.tickerEnabled);
    namespace.collapsedFutures = objectCopy(saved.collapsedFutures);
    namespace.excludedHoldings = objectCopy(saved.excludedHoldings);
    namespace.excludedSources = objectCopy(saved.excludedSources);
    namespace.excludedGroups = objectCopy(saved.excludedGroups);
    namespace.chartVisible = !!saved.chartVisible;
    const savedFonts = Array.isArray(saved.customBalanceFonts) ? saved.customBalanceFonts : [];
    const selectedCustom = savedFonts.find(font => font?.id === saved.balanceFontFamily)
      ?? savedFonts.at(-1);
    namespace.customBalanceFonts = selectedCustom ? [selectedCustom] : [];
    if (namespace.balanceFontFamily !== 'bebas' && namespace.balanceFontFamily !== selectedCustom?.id) {
      namespace.balanceFontFamily = 'bebas';
    }
    balanceFontStateNeedsSave = savedFonts.length > 1
      || (saved.balanceFontFamily != null && saved.balanceFontFamily !== namespace.balanceFontFamily);
  },
  serialize(namespace) {
    const snapshot = {};
    for (const key of Object.keys(DEFAULTS)) snapshot[key] = namespace[key];
    snapshot.tickerEnabled = objectCopy(namespace.tickerEnabled);
    snapshot.collapsedFutures = objectCopy(namespace.collapsedFutures);
    snapshot.excludedHoldings = objectCopy(namespace.excludedHoldings);
    snapshot.excludedSources = objectCopy(namespace.excludedSources);
    snapshot.excludedGroups = objectCopy(namespace.excludedGroups);
    snapshot.portfolioChartSettings = namespace.portfolioChartSettings
      ? objectCopy(namespace.portfolioChartSettings)
      : null;
    return snapshot;
  },
});

// Commit the one-time flat-state import after Core has finished hydrating.
// Without this, a migrated value only lived in the namespace's in-memory
// defaults and could disappear on the next full app reload.
if (legacyState || legacyOutputCurrency || balanceFontStateNeedsSave) onStateLoaded(save);

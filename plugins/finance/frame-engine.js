/**
 * Finance's background frame, alive for the whole session: reads the VPS,
 * polls watchlist prices and exchange rates, and publishes them to the
 * panel and widgets (src/host/mirror.js), and answers Finance's rev/
 * commands (src/commands.js). The first time Finance runs in
 * frames it also copies what the in-page Finance saved (src/host/persist.js).
 */
import { atmos, createContext, requestPanelAction, setRole } from './src/host/frame.js';

setRole('engine');

let settled;
const settingsReady = new Promise(resolve => { settled = resolve; });
let started;
const engineReady = new Promise(resolve => { started = resolve; });

// Exposed first, so views asking early wait here instead of failing.
atmos.expose({
  /** Settings are in Atmos state (copied from the page if this is the first run). */
  ready: async () => { await settingsReady; return true; },
  snapshot: async () => (await engineReady).snapshot(),
  fetchTickers: async () => (await engineReady).fetchTickers(),
  /** The saved portfolio server changed (connected, switched or disconnected). */
  reconnect: async () => (await engineReady).reconnect(),
});

await import('./src/host/persist.js');
settled();

// rev/chart, rev/timeframe and rev/portfolio in Atmos's command bar
// (src/commands.js). The chart is the panel's: they ask for it as the
// watchlist widget does.
Promise.all([
  import('./src/commands.js'), import('./markets/persist.js'), import('./persist.js'), import('./src/host/market-data.js'),
]).then(([{ handleCommands }, markets, { portfolioState }, { checkMarketData }]) => handleCommands({
  requestPanelAction,
  watchlist: () => markets.watchlistState.tickers,
  // Private mode hides what you hold: not listed in the bar either.
  held: async () => ((await import('./src/privacy.js')).isPrivate() ? [] : (await import('./markets/src/watchlist-data.js')).heldSymbols()),
  coins: async () => ((await import('./src/privacy.js')).isPrivate() ? [] : (await import('./src/coin-history.js')).portfolioCoins().map(coin => coin.symbol)),
  privateMode: async () => (await import('./src/privacy.js')).isPrivate(),
  recent: () => markets.marketQueryState.recentQueries,
  chartCount: () => Number(portfolioState.chartLayout) || 1,
  currentTimeframe: () => (portfolioState.chartMode === 'markets' ? markets.marketQueryState.chart.interval : null),
  hasMarketData: checkMarketData,
})).catch(error => console.error('[finance] rev/ commands are unavailable:', error));
const { startEngine } = await import('./src/host/mirror.js');
started(await startEngine(createContext()));

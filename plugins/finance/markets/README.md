# Markets (Finance module)

Markets was merged into the Finance plugin and is no longer installed on its
own. The root Finance entry points import these modules. `markets` is an Atmos CoreV2 live market chart plus the existing Watchlist
sidebar experience, backed by the shared `market-data` read model. The charting service powers interactive candles,
Heiken Ashi, line view, OHLC bucketing, pan/zoom, and the Samsara indicator.
The panel intentionally contains only the chart and a hover-revealed bottom
toolbar for ticker, view, timeframe, indicator, and fit controls.

## Entry points

- `sidebar.js` owns the single Markets accordion, rendering the saved Watchlist
  and opening a ticker's chart when its row is selected.
- `panel.js` owns the chart, bottom controls, ticker picker, and the market
  subscription for both toolbar data sources: Stream paints the raw trade
  tape as a line, History paints exchange candles seeded from REST backfill.
  Both stay live -- History subscribes for `market-data:candle` the same way
  Stream subscribes for `market-data:trade`, so switching to History no longer
  means a one-shot fetch that goes stale until you reload it.
- `persist.js` stores the last query, recent queries, and exchange selection in
  the plugin's own namespace, and owns the existing `watchlist` namespace so
  saved ticker lists migrate without being reset.
- Watchlist polling runs in Finance's engine frame (`frame-engine.js`); the
  panel and widgets show what it publishes.
- `src/watchlist-data.js` owns watchlist fetching and mutations.
- `watchlist.js` is the compatibility API consumed by Portfolio Tracker.

The toolbar ticker dropdown is populated from the Watchlist and accepts a typed
symbol with Enter.

Example queries include `BTC`, `ETHUSDT`, and `SOL 5m candles`.

## Boundaries

The plugin imports `market-data/api.js` and `charting/api.js` with
`atmos.library()` (Market Data gets `setBridge()` to its main process) and
takes gain/loss colors from Atmos's color variables. It does not import
exchange adapters, Portfolio Tracker, Matrix Chat, or Atmos Core. Every
subscription, timer, and chart is lifecycle-managed.

Finance's root `persist.js`, `sidebar.js`, and `panel.js` load these modules, inside Finance's frames. Ensure the `market-data`
and `charting` services are installed and enabled, then restart Atmos.

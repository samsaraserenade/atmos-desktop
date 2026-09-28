# Markets (Finance module)

Markets was merged into the Finance plugin and is no longer installed on its
own. The root Finance entry points import these modules. `markets` is a live market chart plus the watchlist,
backed by the shared `market-data` read model. The charting service powers interactive candles,
Heiken Ashi, line view, OHLC bucketing, pan/zoom, and the Samsara indicator.
The panel intentionally contains only the chart and a hover-revealed bottom
toolbar for ticker, view, timeframe, indicator, and fit controls.

## Entry points

- `sidebar.js` owns the Spot and Futures accordions (held positions); a
  Spot row opens its ticker's chart in the panel.
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

The watchlist itself lives in the panel's ticker picker (`../panel.js`,
`createTickerPicker`): a sheet fitted into the panel's bottom-left corner
with search, the exchanges, Portfolio, your holdings (with account share)
and the watched symbols. A typed symbol can be looked up or added to the
watchlist; a watched row is removed with its × (or Delete). Enter opens the
first match.

Example queries include `BTC`, `ETHUSDT`, and `SOL 5m candles`.

## Boundaries

The plugin imports `market-data/api.js` and `charting/api.js` with
`atmos.library()` (Market Data gets `setBridge()` to its main process) and
takes gain/loss colors from Atmos's color variables. It does not import
exchange adapters, Portfolio Tracker, Matrix Chat, or Atmos Core. Every
subscription, timer, and chart is lifecycle-managed.

Finance's root `persist.js`, `sidebar.js`, and `panel.js` load these modules, inside Finance's frames. Ensure the `market-data`
and `charting` services are installed and enabled, then restart Atmos.

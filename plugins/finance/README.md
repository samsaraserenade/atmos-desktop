# Finance plugin

A portfolio tracker and markets chart for Atmos. The watchlist and markets
chart work on their own; the portfolio comes from a portfolio server you run
(`backend/`; [set one up](backend/SELF_HOSTING.md)) or a hosted one.

> **Read-only, and not financial advice.** Finance never moves funds or
> places orders. Balances and prices are estimates built from third-party
> APIs (exchanges, CoinGecko, DexScreener, chain RPCs); they can be late,
> incomplete or wrong. Give the portfolio server **read-only** API keys
> only. Nothing Finance shows is a recommendation to buy or sell.

## How it's built

Finance runs in sandboxed frames (ATMOS_CORE_INTEGRATION.md § 19):

```text
finance/
├── extension.json          # frames: panel, six widgets, engine; legacyStorage
├── main.cjs                # Main process: VPS, cached network fetches
├── frame-engine.js         # Background frame: reads the VPS, polls prices and rates, publishes
├── frame-panel.js          # The Finance panel (portfolio and markets charts)
├── frame-widget-*.js       # Balance, Performance, Portfolio Connections, Spot, Futures, Watchlist
├── panel.js, sidebar.js    # Finance's panel and widgets (run inside those frames)
├── persist.js              # Versioned state namespaces and legacy migration
├── icons/                  # Panel and widget icons
├── markets/                # Markets chart and watchlist
├── src/                    # Portfolio, chart, storage, and UI implementation
│   └── host/               # Finance's link to Atmos: SDK, engine/view mirroring, stand-ins for Core modules
├── assets/                 # Static styles and other assets
├── tests/                  # Regression tests
└── backend/                # The self-hosted portfolio server (Python, see its README)
```

**One engine, many views.** `frame-engine.js` runs for the whole session and
is the only frame that fetches: it reads the VPS, polls watchlist prices and
exchange rates, and publishes what it has (`src/host/mirror.js`). The panel
and widgets run Finance's ordinary modules as views of it, so opening more
widgets never multiplies requests.

**Settings** keep their three state namespaces (`portfolio-tracker`,
`markets`, `watchlist`) with the same ids and versions, saved together in
Finance's Atmos state so every frame sees every change. An imported balance
font is kept in the frames' localStorage instead (too big for state). Chart
and per-source history are in the frames' IndexedDB (`finance-assets`), with
the same `portfolio-tracker:`-prefixed keys as before.

**Carried over once** from the in-page Finance, by the engine on its first
run: the three namespaces (and the display currency from the Currency
service's old namespace, if Finance never took it over), Finance's records in
the page's shared asset database, and Charting's saved settings.

## Where the portfolio comes from

The portfolio is collected by a portfolio server (`backend/`, a separate
Python service you run, or a hosted one) and read through Finance's main
process. The Portfolio Connections widget pairs with a server: paste the
pairing code the server prints (`atmos-finance:…`), or an address and token.
Addresses must be `https://`, or `http://` only on Tailscale (100.64.0.0/10)
or this computer. `main.cjs` checks the server (`/v1/info`, falling back to
`/v1/portfolio` on older servers), then keeps the address and token in
`finance/connection.bin` in Atmos's user-data folder, sealed with the
system's secure storage (Electron `safeStorage`). The token never reaches a
frame: frames see `vps:status` (`{ configured, address, protected }`) and
fetch through `vps:fetch`. A `portfolio-vps.json` from earlier versions is
moved into the sealed file on first run and deleted. Disconnect clears it,
and the engine frame's `reconnect()` restarts reading from what's saved.
The desktop runs no connection plugins of its own: the widget lists the
sources the server reports.
Live market data (the watchlist and markets chart) is fetched locally;
CoinGecko goes through the main process (`network:fetch`, cached) via
`src/network.js`. Earlier versions loaded connection plugins from
`%APPDATA%\atmos\connections`; that folder and `connections-storage` are no
longer used and can be deleted.

Currency, Charting and Market Data are imported as libraries with
`atmos.library()`; gain/loss colors are Atmos's `--color-positive` /
`--color-negative` variables. Main-process requests go through
`atmos.invoke('plugin:finance', ...)`.

History saved per source before the VPS (bounded v2 history chunks) is still
read and combined with the VPS's history in the chart; older v1 and
total-only history is migrated or kept as a compatibility prefix where it
cannot be decomposed retroactively.

The chart includes a JavaScript port of the Samsara TradingView study: five
moving-average calculations using its original types and lengths,
Wilder RSI state shading, merged Tokyo/London/New York/Sydney UTC sessions,
and optional session candle colours. The master `SAR` button is backed by
individual settings for each moving average's visibility, shared MA opacity, RSI states,
sessions, and candle colouring. Candle colours can follow the active market
session or the previous value of any of the five configured averages. Chart values always stay in currency; the
`Gapless`/`Gaps` toolbar control chooses between compact spacing and real
elapsed-time spacing.
VWAP/VWMA are deliberately omitted because portfolio snapshots do not contain
traded volume; labeling an unweighted portfolio average as VWAP would be
mathematically misleading.

The Portfolio Tracker sidebar places a live allocation donut beneath the
balance summary, showing each reported asset's percentage of the current
portfolio. A long tail is combined into `Other` to keep the legend readable.
An invested/cash bar beneath the donut uses the `holdings` the VPS reports
for each source and lists every valued asset. Fiat and common stablecoins are
treated as cash; a source without a breakdown is shown as unitemised coverage. Asset rows below US$1 are hidden as visual dust while
remaining included in totals and the invested/cash ratio.

Run the chart regression check with:

```powershell
node tests/chart-regression.test.cjs
node tests/settings-startup.test.cjs
node tests/samsara-indicator.test.cjs
```

## Combined plugin

Finance owns the portfolio tracker and Markets watchlist/chart. Root lifecycle modules load the internal markets/ modules; no separately installed Markets or Portfolio Tracker plugin is needed. The main-process IPC owner is finance. Existing portfolio-tracker, markets, and watchlist state namespaces, chart storage keys and portfolio-tracker panel ID intentionally remain stable to preserve saved data and layout. Finance is the displayed plugin/settings/panel name; Portfolio and Markets remain descriptive sidebar sections.

Run all regression checks with: node --experimental-vm-modules --test tests/*.test.cjs markets/tests/*.test.cjs

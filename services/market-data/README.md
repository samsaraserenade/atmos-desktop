# Atmos Market Data service

`market-data` is an Atmos CoreV2 infrastructure service. It owns exchange
connectivity and turns provider trade messages into one canonical stream of
trades and candles. Plugins consume the service contract and never import
exchange adapters.

This release carries **live trades and candles only** (Binance and Bybit
perpetuals, Kraken and Coinbase spot), which is what Finance's markets chart uses. Order
books, liquidations and CVD/flow analytics were removed until something uses
them; they are in git history before the commit "Market Data: trades and
candles only".

## Installation and discovery

Market Data is a first-party service bundled with Atmos (`services/market-data`
in the repo, `resources/extensions/services/market-data` in a build).
`extension.json` participates in CoreV2 compatibility checks; `main.cjs` is
activated by the service host before plugins. `service.json` documents the
service-owned API and event contract.

## Renderer API

`api.js` is a client library (`"library": true`; ATMOS_CORE_INTEGRATION.md
§ 19): it runs in the consumer's document and reaches this service's main
process only through the route the consumer hands it.

```js
// From a frame (declare "invokes": ["service:market-data"]):
const { market } = await import(await atmos.library('service:market-data', 'api.js'));
market.setBridge({
  invoke: (channel, ...args) => atmos.invoke('service:market-data', channel, ...args),
  listen: (channel, fn) => atmos.listen('service:market-data', channel, fn),
});

const subscription = await market.subscribe('BTCUSDT', {
  trades: true,
  candles: true,
  intervals: ['5m'],   // optional: only these candle intervals
});

render(subscription.snapshot); // Immediate committed state, possibly `empty`.

const stopTrades = market.on('trade', trade => {
  // Canonical trade; no provider-specific fields.
});

// Dispose with the owning view.
await subscription.unsubscribe();
stopTrades();
```

From the Atmos page, resolve it with `getServiceFileUrl('market-data', 'api.js')`
and pass Core's bridge (`window.atmos.extensionInvoke` / `extensionOn` with
`'service', 'market-data'`).

`subscribe()` defaults to all available exchanges. Pass an `exchanges` array
to select providers. It returns the initial committed `snapshot` and a handle
with `unsubscribe()`. The API also provides `getStatus()`, `getProviders()`,
`getSnapshot()`, `getHistory()`, and `on()`.

What a subscription receives:

- `trades: true` → every `market-data:trade`. A candles-only subscription
  gets no trade events.
- `candles: true` → `market-data:candle` and `market-data:candle-history`,
  for every interval the engine builds unless `intervals` (names like
  `'5m'`, or milliseconds) narrows it. A chart should pass the one interval
  it shows; backfill is then fetched for that interval only.
- Forming-candle updates are coalesced per subscriber to at most one per
  exchange and interval every 250 ms (`candleThrottleMs`), carrying the
  newest state. Closed candles and trades are never delayed.

Subscribing with `candles: true` also combines that live feed with historical
data: the first time this process sees a given symbol/exchange/candle
interval, it fetches REST history in the background (via `getHistory()`,
see "Combining live and historical candles" below) and merges it in, so a
chart doesn't have to wait for enough live trades to accumulate before it has
something to draw.

Every event contains a monotonically increasing `revision`. When an event at
revision N is delivered, `getSnapshot()` is guaranteed to expose revision N
or later. Plugins never need to race an event against state reconstruction.

## Main-process capability

A plugin or service main entry can consume the capability after services have
activated:

```js
const market = context.use('market-data');
const subscription = market.subscribe(
  'BTCUSDT',
  { trades: true, candles: true },
  ({ event, payload }) => consume(event, payload),
);
```

The subscription handle is the lifecycle boundary. Calling `unsubscribe()`
releases the consumer; upstream feeds stop only when their last consumer is
gone.

## Canonical contracts

All prices, quantities, volumes and deltas are numbers.
Timestamps are Unix milliseconds and symbols are uppercase with separators
removed.

## Market state

`market-state.js` is the service's externally visible read model. Calculation
engines retain their specialized internal structures; market state projects
their latest committed output by symbol and exchange. Events are published
only after that projection commits.

```js
const snapshot = await market.getSnapshot('BTCUSDT', {
  exchanges: ['binance', 'kraken'],
});

snapshot.schemaVersion;       // 2
snapshot.revision;            // Monotonic service revision
snapshot.status;              // empty | live | partial | stale
snapshot.price;               // Latest trade price with source provenance
snapshot.latestTrade;
snapshot.tradesByExchange;
snapshot.candles;             // Aggregate current bar per interval, across the selected exchanges
snapshot.candlesByExchange;   // Per exchange: current bar per interval, each with a `.history` array
snapshot.providers;
snapshot.freshness;
```

State for an unused symbol is retained briefly for fast remounts, then
evicted from the read model and the candle engine.

```js
// market-data:trade
{ symbol, price, quantity, side, aggressor, exchange, timestamp, tradeId?, revision, receivedAt }

// market-data:candle
{
  symbol, interval, intervalMs, start, end,
  open, high, low, close, volume, tradeCount,
  buyVolume, sellVolume, delta, exchange, closed, revision, receivedAt
}

// market-data:candle-history -- fires once REST backfill lands for a
// symbol/exchange/interval a consumer subscribed to; see below
{ symbol, exchange, interval, intervalMs, revision, receivedAt }
```

The service also emits `market-data:connection-status`. Each provider reports
`connecting`, `connected`, `stale`, `reconnecting`, `unavailable`, or `idle`
without affecting the operation of other providers.

## Region blocks

Binance futures and Bybit refuse some regions, the US among them (HTTP 451
and 403). When a provider's socket closes without ever opening, the service
asks that exchange's REST API (at most every 10 minutes); a 451 or 403 there,
or from any history request, marks the provider `unavailable` with
`reason: 'unavailable in this region (HTTP 451)'`. It stops reconnecting and
tries again after an hour. The other exchanges keep streaming, so a chart
subscribed to all four still has Kraken and Coinbase; the snapshot's status
is `partial`, not `stale`.

## Combining live and historical candles

The live candle engine only ever holds the bar currently forming from this
process's own trade feed -- on its own it can't answer "what did the last
250 bars look like," especially right after a fresh subscribe. `history.js`
fetches closed candles over REST (Binance, Bybit, Coinbase and Kraken) for exactly that
gap, and the service wires the two together automatically:

- Subscribing with `candles: true` triggers a background history fetch for
  every exchange/interval combination in that subscription the process
  hasn't already backfilled (deduplicated per symbol/exchange/interval, and
  cached like any other `getHistory()` call). It never blocks `subscribe()`.
- Once it lands, `MarketState#seedCandleHistory` merges those bars into the
  same per-exchange candle history the live engine appends closed bars to,
  keyed by bar start so nothing is duplicated. A live-built bar always wins
  over a later REST bar for the same start -- it was assembled trade by
  trade from this process's own feed, so it's authoritative.
- Every `candlesByExchange[exchange][interval]` object is the current bar
  (the live forming candle if one exists yet, otherwise the latest closed
  backfilled bar) plus a `history` array of every prior bar, ascending and
  gapless. `[...candle.history, candle]` is always the full continuous
  series -- that's what a chart should hand to `setData`/`append`.
- `market-data:candle-history` fires once per symbol/exchange/interval when
  backfill lands, for consumers that want to react immediately rather than
  poll `getSnapshot()`.

Call `getHistory(symbol, options)` directly for a one-off fetch (a wider
window than the live default, a symbol you're not subscribed to, etc.);
`options` takes `interval` or `intervalMs`, `limit` (up to 1000; Coinbase
returns at most 300, Kraken 720), and `exchange` or `exchanges`. A named
`exchange` is used as is. Otherwise the requested exchanges (all, by
default) are tried in the order Binance, Bybit, Coinbase, Kraken, skipping
any marked unavailable in this region or without the interval, and moving
on when one fails; `result.exchange` says which one answered. Coinbase has
no 4h candles and serves USDT/USDC symbols from its USD books (BTCUSDT is
BTC-USD); Kraken has no 3m, 2h, 6h or 12h.

## Extension points

- Add an adapter that implements `id`, `supports(feed)` (`'trades'`),
  `setSubscriptions(requirements)`, `getHealth()`, and `close()`, then
  register it with `WebSocketManager`.
- Candle intervals are a `MarketDataService` option (`candleIntervals`);
  the default is 1m, 5m, 15m, 1h, 4h and 1d.

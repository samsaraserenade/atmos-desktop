# Currency service

Exchange rates and currency conversion. A library service (`"library": true`):
pure modules with no state, no DOM and no Core imports, so they run in the
Atmos page and inside a framed consumer alike. No main-process entry and no
Settings page. It follows the library rules in ATMOS_CORE_INTEGRATION.md § 19.

## Contract

In the Atmos page, resolve files with `getServiceFileUrl('currency', file)`;
from a frame (declare `"invokes": ["service:currency"]` and the network host
below), use `await atmos.library('service:currency', file)`.

`rates.js`:

| Export | Purpose |
|---|---|
| `startRatesPolling()` / `stopRatesPolling()` | Fetch rates now and every 5 minutes |
| `getRates()` | Units of each currency per 1 GBP |
| `ratesReady()` | Whether a fetch has succeeded yet |
| `onRatesUpdate(fn)` | Called after each successful refresh; returns an unsubscribe |
| `useRates(rates)` | Use rates fetched elsewhere (e.g. by another of the consumer's frames) instead of polling |
| `BASE_CURRENCY` | `'GBP'` |

`converter.js`:

| Export | Purpose |
|---|---|
| `convertToGbp(amount, currency)` | Accepts an ISO code or symbol (`£ $ € Fr C$ A$`) |
| `convertFromGbp(amount, currency)` | Into `currency` (ISO code or symbol; GBP when omitted) |
| `OUTPUT_CURRENCIES`, `isOutputCurrency(iso)` | The display currencies a picker should offer (GBP, USD, EUR, CHF) |
| `symbolForIso(iso)`, `isoFromSymbol(symbol)` | Symbol lookups |

Until rates arrive, conversions return the amount unchanged. Rates come from
`https://cdn.moneyconvert.net/api/latest.json`, fetched in the consumer's
context, so a framed consumer must declare `cdn.moneyconvert.net` in
`permissions.network`. A failed fetch is logged and the last good rates are
kept. Polling starts only when a consumer calls `startRatesPolling()`; each
consumer document has its own copy of the modules and so its own rates.

Which currency to display is the consumer's choice and state. Finance keeps
it in its `portfolio-tracker` namespace (`outputCurrency`); it used to live in
this service's `currency` namespace, which Finance reads once to carry the
choice over.

Consumer: Finance.

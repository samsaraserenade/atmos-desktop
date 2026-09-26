# Atmos charting service

`charting` is a renderer-side CoreV2 service for reusable time-series charts.
It owns rendering, toolbar state, interactions, coordinate transforms, price
and time scales, viewport state, zoom, pan limits, visible and hidden ranges,
resize density, OHLC derivation, Heiken Ashi conversion, smoothing, optional
technical overlays, and shared chart/Samsara appearance preferences. Mounted
charts react immediately to `setChartSettings`, and named chart instances
restore their own generic toolbar and viewport state. It does not fetch data,
know about portfolios, or own a panel. Portfolio-only history, valuation and
currency conversion remain outside this service.

## Consumer contract

Charting is a library service (`"library": true`): its modules only import
each other, so they can also run inside a framed extension's own frame.
It follows the library rules (ATMOS_CORE_INTEGRATION.md § 19): shared chart
preferences (`preferences.js`) and named charts' view state (`chart-next.js`,
by `stateKey`) are kept in storage the consumer hands in, and only in memory
until it does:

```js
charting.configureChartStorage({
  get: key => localStorage.getItem('atmos:' + key),   // synchronous; string or null
  set: (key, value) => localStorage.setItem('atmos:' + key, value),
});
```

Keys are `charting-settings:v1` and `charting-instance:<stateKey>`. Finance
passes exactly that (`plugins/finance/src/chart-storage.js`), so settings
saved before this change carry over. From
a frame (declare `"invokes": ["service:charting"]`):

```js
import atmos from 'atmos-sdk';
const { createTimeSeriesChart } = await import(await atmos.library('service:charting', 'api.js'));
```

In the Atmos page, resolve the API through Core instead of importing another plugin:

```js
import { getServiceFileUrl } from 'atmos-core/core/service-loader.js';

const apiUrl = await getServiceFileUrl('charting', 'api.js');
if (!apiUrl) throw new Error('The charting service is unavailable.');
const { createTimeSeriesChart } = await import(apiUrl);

const chart = createTimeSeriesChart(hostElement, {
  type: 'line',
  signal: context.signal,
  data: [{ time: Date.now(), value: 100 }],
});
```

The lifecycle signal destroys the chart automatically. Consumers can also
call `chart.destroy()` explicitly.

Line points accept `{ time, value }` (with `{ t, v }`, `timestamp`, and
`price` aliases). Candles accept canonical `{ start, end, open, high, low,
close }` or compact `{ t0, t1, o, h, l, c }` fields. Passing line samples to
a candle chart derives OHLC buckets locally; subsequent `append()` calls can
continue streaming those price samples into the forming candle.

The returned handle exposes `setData`, `append`, `appendMany`, `updateLatest`,
`setHiddenRanges`, `setStatus`, `setType`, `setOptions`, `fitContent`, `resize`,
`getState`, coordinate conversion methods, `on`, and `destroy`. `setData`
preserves viewport state by default. Ctrl/Cmd-drag creates hidden ranges and
Ctrl/Cmd-double-click clears them. Hold Shift and drag to measure a rectangle: elapsed time, percentage change, and dollar change between its corners appear while dragging. Events are local to the chart instance:
`data`, `range`, `hover`, `hiddenRanges`, and `settings`.

Pass `toolbar: true` for the shared chart controls. Its right-side `X` and `Y`
buttons toggle the time and price axes, and its backdrop follows Core's live
`--shell-blur` and `--shell-opacity` preferences. A toolbar object may select
controls and provide `prepend`/`append` DOM elements for consumer-specific
controls such as a ticker picker; rendering and generic toolbar state remain
owned by the chart instance.

Pass `priceScale: 'log'` (default `'linear'`) for a logarithmic price axis --
useful for a series that spans multiple orders of magnitude (a small-cap
token's early history, say). It's a plain option like `type` or
`timelineMode`: read/write it via `setOptions({ priceScale })`/`getState()`,
it round-trips through a named instance's persisted state the same as the
others, and `toolbar: true` includes a Linear/Log toggle control (key
`'scale'`, or bind your own button to `[data-scale]` on a custom `toolbar.element`)
alongside the rest. Every coordinate conversion (`priceToCoordinate`,
`coordinateToPrice`, candle/line rendering, the price axis' own ticks) goes
through the same scale, so nothing else needs to know which mode is active.

Pass `surface` when the element you mount into (`hostElement`) sits inside a
separate positioned wrapper -- typically a panel's plot area that also has to
leave room for other chrome around the chart. In that case the chart service
itself positions `hostElement` flush against `surface`'s edges (`position:
absolute`, reserving space on the right for the price axis and on the bottom
for the toolbar dock), so consumers don't each need matching CSS for this.
The default reservation is `{ top: 0, right: 20, bottom: 14, left: 0 }`;
override it per instance with `edgeInset: { top, right, bottom, left }` if a
panel's layout genuinely needs something else. `surface` needs `position:
relative` (or similar) from the consumer, same as before.

`createChartViewport()` is the shared physics controller used by custom chart
shells. It owns timestamp/pixel and price/pixel mappings plus the original
Portfolio Tracker viewport model: a 60-candle initial live window, five-candle
zoom floor, 1.15x wheel steps, clamped panning, and proportional resize.
Low-level stateless primitives remain available for rendering and studies.

### Batched updates

Use `chart.batch(() => { ... })` to group synchronous data, status, options, and pane updates into one render. Batches may be nested; pending rendering is flushed even if the callback throws. Data and settings events still fire synchronously during each operation. Do not pass an async callback. Unchanged status updates do not render or emit events.

### Shared controls and series helpers

`CHART_INTERVALS`, `CHART_RANGES`, and `chartControlMarkup(control, options)`
provide the standard axes, timeline, bridge, scale, type, timeframe, and range
controls for external toolbars. `options` accepts `buttonClass`, `intervals`,
and `ranges`. Consumers retain their surrounding layout and business-specific
controls. `CHART_CONTROL_STYLES` supplies the optional flat control theme,
scoped to `.atmos-chart-controls`. `setToolbarIcon` and `setChartTypeIcons`
apply the shared accessible icons.

`parseIntervalMs`, `formatIntervalMs`, and
`bindIntervalInput(input, form, onChange)` share custom timeframe behavior.
The binding returns a cleanup function; it validates 1 second through 30 days,
normalizes the text, and calls `onChange(milliseconds)` only for valid input.

`areaPath`, `clipToDomain`, `downsampleSeries`, and `nearestSampleTime` are
non-mutating rendering helpers. Time-series lookup/clipping expects samples
sorted by their numeric `t` field. Clipping retains an adjacent sample on each
side to preserve area edges; downsampling retains the final sample.

Panes can opt into `hover: true` with sorted `{ t, ...metadata }` data.
The chart emits `paneHover` with `{ id, time, x }` at most once per animation
frame, and `paneLeave` with `{ id }`. Pending hover work is cancelled on leave
or chart destruction. Finance-specific reactions to those events stay in the
consumer.

`showTimeHoverLabel` controls the time label independently of the value label.
`priceLabelRight` optionally overrides the price and hover-value labels' right
offset in pixels. `statsOffset: { top, left }` optionally overrides status
positioning. These options avoid consumer CSS targeting internal chart nodes.

### Candle rendering

Candlestick and Heiken Ashi charts use a device-pixel-ratio-scaled 2D canvas
inside the chart SVG, between the indicator/price-line and axis layers.
The bitmap is redrawn only when candle geometry or colours change; pointer
hover stays on its separate interaction surface. Line charts remain SVG. Indicator overlays use their own cached canvas beneath
the price line and candles, with the same SVG fallback. Environments without a 2D canvas context retain the SVG
candle fallback. No Finance consumer changes are required.

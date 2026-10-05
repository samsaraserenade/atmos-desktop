const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// TradingView's timeframes. 1M, 3M, 6M and 1Y candles follow the calendar
// (candlesticks.js: CALENDAR_MONTHS); their ms stand for 30/90/180/365 days.
// A click picks the candle; Ctrl+click shows that much time instead (the
// range key 'last:<ms>', or everything for Auto).
export const CHART_INTERVALS = Object.freeze([
  { value: 'auto', label: 'Auto', ms: null, title: 'Automatic candles', rangeTitle: 'everything' },
  ...[
    ['1m', '1m', MINUTE, '1 minute'], ['3m', '3m', 3 * MINUTE, '3 minutes'], ['5m', '5m', 5 * MINUTE, '5 minutes'],
    ['10m', '10m', 10 * MINUTE, '10 minutes'], ['15m', '15m', 15 * MINUTE, '15 minutes'], ['30m', '30m', 30 * MINUTE, '30 minutes'],
    ['1h', '1H', HOUR, '1 hour'], ['2h', '2H', 2 * HOUR, '2 hours'], ['4h', '4H', 4 * HOUR, '4 hours'],
    ['6h', '6H', 6 * HOUR, '6 hours'], ['8h', '8H', 8 * HOUR, '8 hours'], ['12h', '12H', 12 * HOUR, '12 hours'],
    ['1d', '1D', DAY, '1 day'], ['2d', '2D', 2 * DAY, '2 days'], ['3d', '3D', 3 * DAY, '3 days'], ['5d', '5D', 5 * DAY, '5 days'],
    ['1w', '1W', 7 * DAY, '1 week'], ['2w', '2W', 14 * DAY, '2 weeks'],
    ['1mo', '1M', 30 * DAY, '1 month'], ['3mo', '3M', 90 * DAY, '3 months'], ['6mo', '6M', 180 * DAY, '6 months'], ['1y', '1Y', 365 * DAY, '1 year'],
  ].map(([value, label, ms, name]) => ({ value, label, ms, title: `${name} candles`, rangeTitle: `the last ${name}` })),
].map(Object.freeze));

/** The range key Ctrl+click on a timeframe shows: that much time, or everything for Auto. */
export function intervalRangeKey(interval) {
  return interval?.ms == null ? 'all' : `last:${interval.ms}`;
}

export const CHART_RANGES = Object.freeze([
  { value: '1d', label: '1D' }, { value: '1w', label: '1W' },
  { value: '1m', label: '1M' }, { value: 'ytd', label: 'YTD' }, { value: 'all', label: 'All' },
].map(Object.freeze));

// Ctrl+click is a right-click on a Mac, where Cmd+click does it.
const RANGE_MODIFIER = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? 'Cmd' : 'Ctrl';

export function intervalTitle(item) {
  return `${item.title || item.label} · ${RANGE_MODIFIER}+click: show ${item.rangeTitle || item.label}`;
}

// Generate only the shared controls; consumers retain their surrounding layout.
export function chartControlMarkup(control, { buttonClass = '', intervals = CHART_INTERVALS, ranges = CHART_RANGES } = {}) {
  const button = (attribute, value, label, title = null) => `<button type="button" class="${escape(buttonClass)}"${title == null ? '' : ` title="${escape(title)}"`} ${attribute}${value == null ? '' : `="${escape(value)}"`}>${escape(label)}</button>`;
  if (control === 'axes') return button('data-axis-x', null, 'X') + button('data-axis-y', null, 'Y');
  if (control === 'type') return [['line', 'Line'], ['candlestick', 'Candle'], ['heiken-ashi', 'Heiken']].map(([value, label]) => button('data-chart-type', value, label)).join('');
  if (control === 'timeframe') return intervals.map(item => button('data-interval', item.value, item.label, intervalTitle(item))).join('');
  if (control === 'range') return ranges.map(item => button('data-range', item.value, item.label)).join('');
  const labels = { timeline: 'Gapless', bridge: 'Bridge', scale: 'Linear' };
  return labels[control] ? button(`data-${control}`, null, labels[control]) : '';
}

export const CHART_CONTROL_STYLES = ".atmos-chart-controls button, .atmos-chart-controls button {\n  font:500 11px var(--app-font-family, \"Segoe UI\", sans-serif); height:30px;\n  color:rgba(var(--ink-rgb),.55) !important; background:transparent !important; border:1px solid transparent !important;\n  border-radius:4px; padding:0 8px; cursor:pointer; transition:color .12s ease;\n}\n.atmos-chart-controls button:hover,\n.atmos-chart-controls button.is-active,\n.atmos-chart-controls button[aria-pressed=\"true\"],\n.atmos-chart-controls button:hover,\n.atmos-chart-controls button.is-active,\n.atmos-chart-controls button[aria-pressed=\"true\"] { color:rgb(var(--ink-rgb)) !important; }\n.atmos-chart-controls button:focus-visible, .atmos-chart-controls button:focus-visible { outline:2px solid #a8c7fa; outline-offset:-2px; }\n\n.atmos-chart-controls .atmos-chart__icon-button {\n  display:inline-flex; align-items:center; justify-content:center;\n  width:32px; height:30px; padding:0; flex-shrink:0;\n  color:rgba(var(--ink-rgb),.55) !important; background:transparent !important; border-color:transparent !important;\n  transition:color .12s ease;\n}\n.atmos-chart__icon-button svg { display:block; width:18px; height:18px; pointer-events:none; }\n.atmos-chart-controls .atmos-chart__icon-button:hover,\n.atmos-chart-controls .atmos-chart__icon-button.is-active,\n.atmos-chart-controls .atmos-chart__icon-button[aria-pressed=\"true\"],\n.atmos-chart-controls .atmos-chart__icon-button[aria-expanded=\"true\"] { color:rgb(var(--ink-rgb)) !important; }\n.atmos-chart-controls .atmos-chart__icon-button:focus-visible { outline:2px solid #a8c7fa; outline-offset:-2px; border-radius:4px; }";

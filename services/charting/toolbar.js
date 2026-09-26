const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export const CHART_INTERVALS = Object.freeze([
  { value: 'auto', label: 'Auto', ms: null },
  { value: '1m', label: '1m', ms: 60000 },
  { value: '5m', label: '5m', ms: 300000 },
  { value: '15m', label: '15m', ms: 900000 },
  { value: '1h', label: '1H', ms: 3600000 },
  { value: '4h', label: '4H', ms: 14400000 },
  { value: '1d', label: '1D', ms: 86400000 },
].map(Object.freeze));
export const CHART_RANGES = Object.freeze([
  { value: '1d', label: '1D' }, { value: '1w', label: '1W' },
  { value: '1m', label: '1M' }, { value: 'ytd', label: 'YTD' }, { value: 'all', label: 'All' },
].map(Object.freeze));

// Generate only the shared controls; consumers retain their surrounding layout.
export function chartControlMarkup(control, { buttonClass = '', intervals = CHART_INTERVALS, ranges = CHART_RANGES } = {}) {
  const button = (attribute, value, label) => `<button type="button" class="${escape(buttonClass)}" ${attribute}${value == null ? '' : `="${escape(value)}"`}>${escape(label)}</button>`;
  if (control === 'axes') return button('data-axis-x', null, 'X') + button('data-axis-y', null, 'Y');
  if (control === 'type') return [['line', 'Line'], ['candlestick', 'Candle'], ['heiken-ashi', 'Heiken']].map(([value, label]) => button('data-chart-type', value, label)).join('');
  if (control === 'timeframe') return intervals.map(item => button('data-interval', item.value, item.label)).join('');
  if (control === 'range') return ranges.map(item => button('data-range', item.value, item.label)).join('');
  const labels = { timeline: 'Gapless', bridge: 'Bridge', scale: 'Linear' };
  return labels[control] ? button(`data-${control}`, null, labels[control]) : '';
}

export const CHART_CONTROL_STYLES = ".atmos-chart-controls button, .atmos-chart-controls button {\n  font:500 11px var(--app-font-family, \"Segoe UI\", sans-serif); height:30px;\n  color:rgba(var(--ink-rgb),.55) !important; background:transparent !important; border:1px solid transparent !important;\n  border-radius:4px; padding:0 8px; cursor:pointer; transition:color .12s ease;\n}\n.atmos-chart-controls button:hover,\n.atmos-chart-controls button.is-active,\n.atmos-chart-controls button[aria-pressed=\"true\"],\n.atmos-chart-controls button:hover,\n.atmos-chart-controls button.is-active,\n.atmos-chart-controls button[aria-pressed=\"true\"] { color:rgb(var(--ink-rgb)) !important; }\n.atmos-chart-controls button:focus-visible, .atmos-chart-controls button:focus-visible { outline:2px solid #a8c7fa; outline-offset:-2px; }\n\n.atmos-chart-controls .atmos-chart__icon-button {\n  display:inline-flex; align-items:center; justify-content:center;\n  width:32px; height:30px; padding:0; flex-shrink:0;\n  color:rgba(var(--ink-rgb),.55) !important; background:transparent !important; border-color:transparent !important;\n  transition:color .12s ease;\n}\n.atmos-chart__icon-button svg { display:block; width:18px; height:18px; pointer-events:none; }\n.atmos-chart-controls .atmos-chart__icon-button:hover,\n.atmos-chart-controls .atmos-chart__icon-button.is-active,\n.atmos-chart-controls .atmos-chart__icon-button[aria-pressed=\"true\"],\n.atmos-chart-controls .atmos-chart__icon-button[aria-expanded=\"true\"] { color:rgb(var(--ink-rgb)) !important; }\n.atmos-chart-controls .atmos-chart__icon-button:focus-visible { outline:2px solid #a8c7fa; outline-offset:-2px; border-radius:4px; }";

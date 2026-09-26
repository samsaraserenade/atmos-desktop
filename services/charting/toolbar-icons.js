/** Compact, shared chart toolbar icons. SVGs inherit the button color. */
const svg = paths => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const icons = {
  indicators: svg('<path d="M15 4h-2c-2 0-3 1-3.3 3L7.5 18c-.3 1.5-1 2-2.5 2H4M6 9h8M16 13l5 7m0-7-5 7"/>'),
  settings: svg('<path d="m9 3-.6 2.2-1.8 1L4.4 6 2 10l1.6 1.6v2.1L2 15.3l2.4 4 2.2-.3 1.8 1L9 22h5l.6-2 1.8-1 2.2.3 2.4-4-1.6-1.6v-2.1L21 10l-2.4-4-2.2.2-1.8-1L14 3Z"/><circle cx="11.5" cy="12.5" r="3.2"/>'),
  line: svg('<path d="m3 17 5-6 4 3 8-10M17 4h3v3"/>'),
  candlestick: svg('<path d="M6 3v4m0 10v4M17 2v8m0 7v4"/><rect x="3" y="7" width="6" height="10" rx=".5"/><rect x="14" y="10" width="6" height="7" rx=".5"/>'),
  'heiken-ashi': svg('<path d="M5 12v9M12 6v13M19 2v11"/><rect x="2.5" y="14" width="5" height="5" rx=".5" fill="currentColor"/><rect x="9.5" y="8" width="5" height="7" rx=".5" fill="currentColor"/><rect x="16.5" y="4" width="5" height="5" rx=".5" fill="currentColor"/>'),
};

export function setToolbarIcon(button, name, label) {
  button.classList.add('atmos-chart__icon-button');
  button.innerHTML = icons[name];
  button.title = label;
  button.setAttribute('aria-label', label);
}

export function setChartTypeIcons(toolbar) {
  const labels = { line: 'Line chart', candlestick: 'Candlestick chart', 'heiken-ashi': 'Heikin Ashi chart' };
  for (const button of toolbar.querySelectorAll('[data-chart-type]')) {
    setToolbarIcon(button, button.dataset.chartType, labels[button.dataset.chartType]);
  }
}

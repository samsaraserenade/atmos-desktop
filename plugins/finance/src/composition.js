import { privateFormat } from './privacy.js';

const _fmt = privateFormat(new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percent(value, total) {
  return total > 0 ? (value / total) * 100 : 0;
}

export function renderCompositionMarkup(composition, { showAmount = false } = {}) {
  const invested = Math.max(0, Number(composition?.invested) || 0);
  const cash = Math.max(0, Number(composition?.cash) || 0);
  const classified = invested + cash;
  const investedPercent = percent(invested, classified);
  const cashPercent = percent(cash, classified);
  const coverage = Math.max(0, Math.min(1, Number(composition?.coverage) || 0));
  const symbol = escapeHtml(composition?.symbol || '');

  if (classified <= 0) {
    return `<div class="pt-composition-empty">Asset mix will appear after a supported connection refreshes.</div>`;
  }

  const coverageNote = coverage < 0.995
    ? `<div class="pt-composition-coverage">${Math.round(coverage * 100)}% of the portfolio is itemised</div>`
    : '';

  // Styled to match the Positions rows' own allocation bars: low-opacity
  // fills (see balance.js's --pt-invested-fill/--pt-cash-fill, set at 25%
  // alpha) with square corners, not pills. The figures are a separate
  // overlay anchored to the bar's own left/right edges rather than boxed
  // inside their fill segment, so a lopsided split (one side down to a
  // few percent) never gets its number clipped. A muted "Invested" title
  // sits fixed at the bar's own horizontal center (not the invested
  // segment's center, which moves and could get squeezed as the split
  // changes) purely to label what the bar is -- the edge figures stay
  // number-only. The bar is clickable (see balance.js's
  // mountCompositionBar) to flip between showing the amount and the
  // percentage — both are always in the aria-label regardless of which
  // one is currently on screen.
  const investedText = showAmount ? `${symbol}${_fmt.format(invested)}` : `${investedPercent.toFixed(0)}%`;
  const cashText = showAmount ? `${symbol}${_fmt.format(cash)}` : `${cashPercent.toFixed(0)}%`;

  return `<div class="pt-composition-bar" role="button" tabindex="0" aria-pressed="${showAmount}" aria-label="Invested ${symbol}${_fmt.format(invested)}, ${investedPercent.toFixed(1)} percent; cash ${symbol}${_fmt.format(cash)}, ${cashPercent.toFixed(1)} percent. Click to show ${showAmount ? 'percentages' : 'amounts'}.">
      <span class="pt-composition-fill pt-composition-invested" style="width:${investedPercent.toFixed(3)}%"></span>
      <span class="pt-composition-fill pt-composition-cash" style="width:${cashPercent.toFixed(3)}%"></span>
      <span class="pt-composition-title">Invested</span>
      <span class="pt-composition-label pt-composition-label-invested">${investedText}</span>
      <span class="pt-composition-label pt-composition-label-cash">${cashText}</span>
    </div>
    ${coverageNote}`;
}

// Same bar, fed long/short (by position equity -- see totals.js's
// getFuturesDirectionSplit) instead of invested/cash. Reuses the exact
// same fill/label/title CSS classes with a -long/-short modifier instead
// of -invested/-cash, so it inherits the same square-corner, low-opacity
// look with zero new layout rules -- only the color custom properties
// (set by whoever mounts this: markets/sidebar.js, via price-color's
// colorForChange the same way a position's own coin label is colored)
// and the text differ.
export function renderDirectionMarkup(split, { showAmount = false } = {}) {
  const long = Math.max(0, Number(split?.long) || 0);
  const short = Math.max(0, Number(split?.short) || 0);
  const classified = long + short;
  const longPercent = percent(long, classified);
  const shortPercent = percent(short, classified);
  const symbol = escapeHtml(split?.symbol || '');

  if (classified <= 0) {
    return `<div class="pt-composition-empty">Long/short split will appear once a position is open.</div>`;
  }

  const longText = showAmount ? `${symbol}${_fmt.format(long)}` : `${longPercent.toFixed(0)}%`;
  const shortText = showAmount ? `${symbol}${_fmt.format(short)}` : `${shortPercent.toFixed(0)}%`;

  return `<div class="pt-composition-bar pt-direction-bar" role="button" tabindex="0" aria-pressed="${showAmount}" aria-label="Long ${symbol}${_fmt.format(long)}, ${longPercent.toFixed(1)} percent; short ${symbol}${_fmt.format(short)}, ${shortPercent.toFixed(1)} percent. Click to show ${showAmount ? 'percentages' : 'amounts'}.">
      <span class="pt-composition-fill pt-composition-long" style="width:${longPercent.toFixed(3)}%"></span>
      <span class="pt-composition-fill pt-composition-short" style="width:${shortPercent.toFixed(3)}%"></span>
      <span class="pt-composition-title">Long / Short</span>
      <span class="pt-composition-label pt-composition-label-long">${longText}</span>
      <span class="pt-composition-label pt-composition-label-short">${shortText}</span>
    </div>`;
}

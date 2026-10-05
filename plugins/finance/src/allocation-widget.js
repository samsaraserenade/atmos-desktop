import { isPrivate, MASK, onPrivacyChange, privateFormat } from './privacy.js';
import { portfolioState } from '../persist.js';
import { save, onLocalStateChange } from './host/persist.js';
import { getAllPortfolios, onPortfolioUpdate } from './registry.js';
import { convertToGbp, convertFromGbp, getTotal } from './totals.js';
import { ALLOCATION_DIMENSIONS, buildAllocationBreakdown, buildNetExposure } from './allocation-breakdown.js';

const amountFormat = privateFormat(new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }));
const percentFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

function shortWallet(label) {
  return label.length > 18 && /^[A-Za-z0-9]+$/.test(label)
    ? `${label.slice(0, 7)}…${label.slice(-5)}`
    : label;
}

export function mountAllocationWidget(body, context) {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('../assets/allocation.css', import.meta.url).href;
  document.head.appendChild(style);
  context.onCleanup(() => style.remove());
  // One row of plain-text toggles in the chart toolbar's vocabulary (bold is
  // the active one), then the total as a heading, then rows drawn like the
  // Spot list's: a bar behind the row, label left, figure right. "Group by"
  // lives in the widget's header menu (see sidebar.js), where a rarely
  // changed choice belongs.
  body.innerHTML = `<div class="finance-allocation">
    <div class="finance-allocation-toolbar">
      <span class="finance-allocation-group" role="group" aria-label="Allocation lens">
        <button type="button" data-mode="capital">Capital</button><button type="button" data-mode="exposure">Exposure</button>
      </span>
      <span class="finance-allocation-group finance-allocation-books" role="group" aria-label="Portfolio book">
        <button type="button" data-book="all">All</button><button type="button" data-book="spot">Spot</button><button type="button" data-book="perp">Perps</button>
      </span>
    </div>
    <div class="finance-allocation-total"></div><div class="finance-allocation-rows"></div>
  </div>`;
  const rows = body.querySelector('.finance-allocation-rows');
  const totalEl = body.querySelector('.finance-allocation-total');

  const normalize = () => {
    portfolioState.allocationMode = portfolioState.allocationMode === 'exposure' ? 'exposure' : 'capital';
    portfolioState.allocationBook = ['all', 'spot', 'perp'].includes(portfolioState.allocationBook) ? portfolioState.allocationBook : 'all';
    if (!ALLOCATION_DIMENSIONS.some(item => item.id === portfolioState.allocationDimension)) portfolioState.allocationDimension = 'dapp';
  };
  const render = () => {
    normalize();
    const book = portfolioState.allocationBook;
    const dimension = portfolioState.allocationDimension;
    const mode = portfolioState.allocationMode;
    body.querySelectorAll('[data-mode]').forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    body.querySelector('.finance-allocation-books').hidden = mode === 'exposure';
    body.querySelectorAll('[data-book]').forEach(button => {
      const active = button.dataset.book === book;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const convert = (value, currency) => convertFromGbp(convertToGbp(value, currency));
    const symbol = getTotal().symbol;
    rows.replaceChildren();
    totalEl.classList.remove('is-positive', 'is-negative', 'is-neutral');
    if (mode === 'exposure') {
      const result = buildNetExposure(getAllPortfolios(), { convert });
      totalEl.classList.add(result.net > 0 ? 'is-positive' : result.net < 0 ? 'is-negative' : 'is-neutral');
      totalEl.textContent = `Net directional · ${result.net < 0 ? '−' : ''}${symbol}${amountFormat.format(Math.abs(result.net))}`;
      if (!result.entries.length) {
        const empty = document.createElement('div'); empty.className = 'finance-allocation-empty'; empty.textContent = 'No directional exposure yet'; rows.append(empty); return;
      }
      for (const entry of result.entries) {
        // Private mode hides which coins you hold, not only how much.
        const name = isPrivate() ? MASK : entry.label;
        const row = document.createElement('div'); row.className = `finance-allocation-row finance-exposure-row ${entry.value < 0 ? 'is-short' : 'is-long'}`;
        row.title = `${name}: ${entry.value < 0 ? '−' : '+'}${symbol}${amountFormat.format(Math.abs(entry.value))} net exposure`;
        const axis = document.createElement('span'); axis.className = 'finance-exposure-axis';
        const bar = document.createElement('span'); bar.className = 'finance-allocation-bar'; bar.style.width = `${Math.min(50, entry.share * 50)}%`;
        const label = document.createElement('span'); label.className = 'finance-allocation-label'; label.textContent = name;
        const value = document.createElement('span'); value.className = 'finance-allocation-value'; value.textContent = `${entry.value < 0 ? '−' : '+'}${symbol}${amountFormat.format(Math.abs(entry.value))}`;
        row.append(axis, bar, label, value); rows.append(row);
      }
      return;
    }
    const result = buildAllocationBreakdown(getAllPortfolios(), { book, dimension, convert });
    const bookLabel = book === 'all' ? 'All capital' : book === 'perp' ? 'Perps capital' : 'Spot capital';
    const dimensionLabel = ALLOCATION_DIMENSIONS.find(item => item.id === dimension)?.label || dimension;
    totalEl.textContent = `${bookLabel} · ${symbol}${amountFormat.format(result.total)} · by ${dimensionLabel}`;
    if (!result.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'finance-allocation-empty';
      empty.textContent = `No ${book === 'all' ? '' : book === 'perp' ? 'perpetual ' : 'spot '}capital yet`;
      rows.append(empty);
      return;
    }
    for (const entry of result.entries) {
      const row = document.createElement('div');
      row.className = 'finance-allocation-row';
      // Private mode: a wallet's address is masked (anyone can look up what
      // it holds); exchanges, chains and dApps stay, as the Connections
      // widget names your sources.
      const hidden = isPrivate() && dimension === 'wallet';
      row.title = `${hidden ? MASK : entry.label}: ${symbol}${amountFormat.format(entry.value)} (${percentFormat.format(entry.share * 100)}%)`;
      const label = document.createElement('span');
      label.className = 'finance-allocation-label';
      label.textContent = hidden ? MASK : dimension === 'wallet' ? shortWallet(entry.label) : entry.label;
      const value = document.createElement('span');
      value.className = 'finance-allocation-value';
      value.textContent = `${percentFormat.format(entry.share * 100)}%`;
      const bar = document.createElement('span');
      bar.className = 'finance-allocation-bar';
      bar.style.width = `${Math.max(0, Math.min(100, entry.share * 100))}%`;
      row.append(bar, label, value);
      rows.append(row);
    }
  };
  context.listen(body.querySelector('[aria-label="Allocation lens"]'), 'click', event => {
    const button = event.target.closest('[data-mode]');
    if (!button || button.dataset.mode === portfolioState.allocationMode) return;
    portfolioState.allocationMode = button.dataset.mode;
    save(); render();
  });
  context.listen(body.querySelector('.finance-allocation-books'), 'click', event => {
    const button = event.target.closest('[data-book]');
    if (!button || button.dataset.book === portfolioState.allocationBook) return;
    portfolioState.allocationBook = button.dataset.book;
    save(); render();
  });
  context.onCleanup(onPortfolioUpdate(render));
  context.onCleanup(onPrivacyChange(render));
  context.onCleanup(onLocalStateChange(render)); // "Group by" changes from the header menu
  render();
}

/** The widget's header menu: which dimension the capital view groups by. */
export function allocationMenuItems() {
  return [{
    id: 'finance.allocation.dimension',
    type: 'select',
    label: 'Group by',
    value: ALLOCATION_DIMENSIONS.some(item => item.id === portfolioState.allocationDimension) ? portfolioState.allocationDimension : 'dapp',
    options: ALLOCATION_DIMENSIONS.map(item => ({ value: item.id, label: item.label })),
    run: value => { portfolioState.allocationDimension = value; save(); },
  }];
}

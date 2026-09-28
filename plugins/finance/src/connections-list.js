/**
 * The Portfolio Connections widget: one row per source the portfolio server
 * reports (its name, what it adds to the portfolio, and a dot for whether it
 * is reporting), then the server itself. Right-click a row to leave the
 * whole source out of the portfolio, or put it back; the row's tooltip says
 * how it's doing. With no server yet, the widget is the pairing form.
 *
 * Rows are patched in place, and rebuilt only when the sources change, so
 * the widget can redraw on every portfolio update.
 */
import { atmos } from './host/frame.js';
import { save } from './host/persist.js';
import { isPrivate, masked } from './privacy.js';
import { isSourceIncluded, scopedPortfolioData, setSourceIncluded } from './portfolio-scope.js';
import {
  getAllPortfolios, getExchanges, getServerConnection, getSourceStatus,
  isRemotePortfolioMode, notifyPortfolioUpdate,
} from './registry.js';
import { convertFromGbp, convertToGbp, getTotal } from './totals.js';
import { mountConnectionFooter, mountConnectionForm } from './connection-form.js';

const STYLE_ID = 'finance-connections-list-styles';
const STATUS_TEXT = {
  ok: 'Reporting',
  partial: 'Partly reporting: some balances are the last confirmed ones',
  error: 'Not reporting: showing the last confirmed value',
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .fin-sources { display:flex; flex-direction:column; }
    .fin-source {
      display:flex; align-items:center; gap:8px; min-height:28px; padding:0 14px; cursor:context-menu;
      border-bottom:1px solid rgba(var(--ink-rgb),.06); color:rgba(var(--ink-rgb),.52);
    }
    .fin-source:hover { background:rgba(var(--ink-rgb),.04); }
    .fin-source-dot { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:rgba(var(--ink-rgb),.2); }
    .fin-source-dot.is-ok { background:var(--color-positive, #4ade80); }
    .fin-source-dot.is-partial { background:#fbbf24; }
    .fin-source-dot.is-error { background:var(--color-negative, #f87171); }
    .fin-source-name {
      flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      font-size:.62rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
    }
    .fin-source-value {
      color:rgba(var(--ink-rgb),.82); font:600 .68rem/1.2 var(--app-font-family, Inter, "Segoe UI", Roboto, sans-serif);
      font-variant-numeric:tabular-nums; white-space:nowrap;
    }
    .fin-source.is-excluded { opacity:.38; }
    .fin-source.is-excluded .fin-source-name, .fin-source.is-excluded .fin-source-value { text-decoration:line-through; }
  `;
  document.head.appendChild(style);
}

const _valueFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const formatValue = masked((value, symbol) => `${symbol}${_valueFormat.format(value)}`);

function ago(timestamp) {
  const ms = Date.now() - Number(timestamp);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 90_000) return 'just now';
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} hours ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

/** What each row shows, in the order the server first reported the sources. */
function sourceRows() {
  const portfolios = getAllPortfolios();
  return getExchanges()
    .filter(source => portfolios.get(source.id) != null)
    .map(source => {
      const data = portfolios.get(source.id);
      const included = isSourceIncluded(source.id);
      const shown = included ? scopedPortfolioData(data, source.id) : data;
      const updated = data.lastUpdate ? ago(data.lastUpdate) : null;
      const status = getSourceStatus(source.id);
      return {
        id: source.id,
        name: String(data.label || source.name || source.id),
        // (0 until the Currency library has loaded; the widget redraws once it has)
        value: typeof convertToGbp === 'function' ? convertFromGbp(convertToGbp(Number(shown?.value) || 0, shown?.currency ?? '$')) : 0,
        included,
        status,
        lastUpdate: Number(data.lastUpdate) || 0,
        detail: [STATUS_TEXT[status] || 'Waiting for the first report', updated && `updated ${updated}`]
          .filter(Boolean).join(' · '),
      };
    });
}

// One widget per frame: its list, its footer, and what they were built from.
let _view = null;

function openMenu(event, id) {
  const row = sourceRows().find(item => item.id === id);
  if (!row) return;
  void atmos.contextMenu.open(event.clientX, event.clientY, [
    { type: 'heading', label: row.name },
    {
      id: 'finance.connections.include',
      type: 'toggle',
      label: 'Included in portfolio',
      checked: row.included,
      run(checked) {
        setSourceIncluded(id, checked);
        save();
        notifyPortfolioUpdate();
        renderConnections();
      },
    },
    { type: 'meta', label: row.detail },
  ]).catch(error => console.error('[finance] connections menu:', error));
}

function build(mount, rows, connection) {
  mount.replaceChildren();
  const list = document.createElement('div');
  list.className = 'fin-sources';
  for (const row of rows) {
    const element = document.createElement('div');
    element.className = 'fin-source';
    element.dataset.sourceId = row.id;
    const dot = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'fin-source-name';
    name.textContent = row.name;
    const value = document.createElement('span');
    value.className = 'fin-source-value';
    element.append(dot, name, value);
    list.append(element);
  }
  mount.append(list);
  const footer = mountConnectionFooter(mount, connection);
  list.addEventListener('contextmenu', event => {
    const element = event.target.closest('.fin-source');
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(event, element.dataset.sourceId);
  });
  return { list, footer };
}

/** Draw the widget into #exchange-mount, if this frame has one. */
export function renderConnections() {
  const mount = document.getElementById('exchange-mount');
  if (!mount) return;
  injectStyles();
  if (!isRemotePortfolioMode()) {
    // Built once: redrawing would clear what's being typed.
    if (_view?.mount !== mount || _view.kind !== 'form') {
      mount.replaceChildren();
      mountConnectionForm(mount);
      _view = { mount, kind: 'form' };
    }
    return;
  }
  const rows = sourceRows();
  const connection = getServerConnection();
  const key = JSON.stringify([rows.map(row => [row.id, row.name]), connection.address, connection.protected, isPrivate()]);
  if (_view?.mount !== mount || _view.key !== key) {
    _view = { mount, kind: 'sources', key, ...build(mount, rows, connection) };
  }
  const symbol = typeof convertToGbp === 'function' ? getTotal().symbol : '';
  rows.forEach((row, index) => {
    const element = _view.list.children[index];
    element.classList.toggle('is-excluded', !row.included);
    element.title = row.included ? row.detail : `Left out of the portfolio · ${row.detail}`;
    element.children[0].className = `fin-source-dot${row.status ? ` is-${row.status}` : ''}`;
    element.children[2].textContent = formatValue(row.value, symbol);
  });
  _view.footer.update(Math.max(0, ...rows.map(row => row.lastUpdate)) || null);
}

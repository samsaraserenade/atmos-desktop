/**
 * The pages the browser draws itself, where a web page would be: the
 * new-tab page, History, and what shows instead of a page that failed (a
 * certificate that isn't trusted, a page that couldn't load or stopped).
 * They follow Atmos's look and sit on its glass.
 */
import atmos from 'atmos-sdk';
import { h, icon, siteIcon, tabLabel } from './dom.js';
import { hostOf, siteName } from '../address.js';

const DAY = 24 * 60 * 60 * 1000;

function tile({ url, title, favicon }, { onOpen, onMenu }) {
  const element = h('button', { class: 'br-tile', title: `${title || url}\n${url}` },
    h('span', { class: 'br-tile-icon' }, siteIcon(favicon)),
    h('span', { class: 'br-tile-title', text: title || siteName(url) }),
    h('span', { class: 'br-tile-host', text: siteName(url) }));
  element.addEventListener('click', event => onOpen(url, { newTab: event.ctrlKey || event.metaKey }));
  element.addEventListener('auxclick', event => { if (event.button === 1) onOpen(url, { newTab: true }); });
  element.addEventListener('contextmenu', event => { event.preventDefault(); onMenu?.(event.clientX, event.clientY); });
  return element;
}

/** Open `url` from one of these pages: here, or in a tab behind this one. */
function opener(engine, tab) {
  return (url, { newTab = false } = {}) => {
    if (newTab) engine.newTab({ url, private: tab.private, after: tab.id, opener: tab.id, select: false });
    else void engine.go(tab.id, url);
  };
}

// ── New tab ──────────────────────────────────────────────────────────────────
export function renderNewTab(container, tab, { engine, focusAddress }) {
  const open = opener(engine, tab);
  const search = h('div', { class: 'br-ntp-search', role: 'button', tabindex: '0', 'aria-label': 'Search or enter an address' },
    icon('search'), h('input', { type: 'text', tabindex: '-1', readonly: true, placeholder: `Search with ${engine.searchEngines().find(item => item.id === engine.searchEngine())?.name || 'the web'} or enter an address` }));
  // The address bar does the typing (with its suggestions).
  search.addEventListener('pointerdown', event => { event.preventDefault(); focusAddress(); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusAddress(); } });
  const bookmarksEl = h('div', { class: 'br-tiles' });
  const topEl = h('div', { class: 'br-tiles' });
  const statEl = h('div', { class: 'br-ntp-stat', hidden: true });
  const column = h('div', { class: 'br-internal-column' },
    tab.private ? h('div', { class: 'br-private-note' }, icon('private'), h('div', {},
      h('strong', { text: 'A private tab' }),
      'Pages you open here have a session of their own: sign-ins, cookies and site data here are separate from your other tabs, and nothing is kept once the last private tab closes. No history is kept. Files you download stay.')) : null,
    search,
    statEl,
    h('div', { class: 'br-heading', text: 'Bookmarks' }), bookmarksEl,
    tab.private ? null : h('div', { class: 'br-heading', text: 'Most visited' }), tab.private ? null : topEl);
  const page = h('div', { class: 'br-internal br-ntp', dataset: { atmosGlass: 'panel' } }, column);
  container.replaceChildren(page);

  let seq = 0;
  async function fill() {
    const mine = ++seq;
    const [marks, top, blocker] = await Promise.all([
      engine.bookmarks.list(), tab.private ? [] : engine.history.topSites(8), engine.adblockStatus().catch(() => null),
    ]);
    if (mine !== seq) return;
    // Everything the blocker has stopped, in all (Brave's new tab has it too).
    const total = blocker?.enabled ? blocker.total || 0 : 0;
    statEl.hidden = !total;
    if (total) statEl.replaceChildren(icon('shield'), h('span', { text: `${total.toLocaleString()} ${total === 1 ? 'ad or tracker' : 'ads and trackers'} blocked so far` }));
    const markTiles = [...marks].slice(0, 16).map(item => tile({ ...item, favicon: engine.iconFor(item.url) }, {
      onOpen: open,
      onMenu: (x, y) => atmos.contextMenu.open(x, y, [
        { id: 'open-new', label: 'Open in new tab', run: () => open(item.url, { newTab: true }) },
        { id: 'remove', label: 'Remove bookmark', run: () => engine.bookmarks.remove(item.id) },
      ]),
    }));
    bookmarksEl.replaceChildren(...(markTiles.length ? markTiles : [h('div', { class: 'br-empty', text: 'Pages you bookmark (☆ in the address bar, or Ctrl+D) show here.' })]));
    const topTiles = [...top].map(item => tile({ ...item, favicon: engine.iconFor(item.url) }, {
      onOpen: open,
      onMenu: (x, y) => atmos.contextMenu.open(x, y, [
        { id: 'open-new', label: 'Open in new tab', run: () => open(item.url, { newTab: true }) },
        { id: 'forget', label: 'Remove from history', run: () => engine.history.remove(item.url) },
      ]),
    }));
    topEl.replaceChildren(...(topTiles.length ? topTiles : [h('div', { class: 'br-empty', text: 'The sites you visit most will show here.' })]));
  }
  void fill();
  return { refresh: fill, dispose() { seq += 1; } };
}

// ── History ──────────────────────────────────────────────────────────────────
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function dayLabel(time, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return `Today — ${dayFormat.format(time)}`;
  if (time >= start.getTime() - DAY) return `Yesterday — ${dayFormat.format(time)}`;
  return dayFormat.format(time);
}

export function renderHistory(container, tab, { engine }) {
  const open = opener(engine, tab);
  const input = h('input', { type: 'search', placeholder: 'Search history', spellcheck: 'false', 'aria-label': 'Search history' });
  const clearButton = h('button', { class: 'atmos-button br-heading-action', text: 'Clear browsing data…' });
  const listEl = h('div', {});
  const more = h('button', { class: 'br-button small', text: 'Show more', hidden: true });
  const column = h('div', { class: 'br-internal-column' },
    h('div', { class: 'br-heading' }, 'History', clearButton),
    h('div', { class: 'br-history-bar' }, h('div', { class: 'br-ntp-search' }, icon('search'), input)),
    listEl, h('div', { class: 'br-actions' }, more));
  container.replaceChildren(h('div', { class: 'br-internal', dataset: { atmosGlass: 'panel' } }, column));
  let limit = 300;
  let seq = 0;

  clearButton.addEventListener('click', () => {
    const rect = clearButton.getBoundingClientRect();
    const since = ms => () => engine.history.clear({ since: Date.now() - ms });
    void atmos.contextMenu.open(rect.left, rect.bottom + 4, [
      { type: 'heading', label: 'Clear history' },
      { id: 'hour', label: 'The last hour', run: since(60 * 60 * 1000) },
      { id: 'day', label: 'The last 24 hours', run: since(DAY) },
      { id: 'week', label: 'The last 7 days', run: since(7 * DAY) },
      { id: 'all', label: 'All history', hold: true, tone: 'danger', run: () => engine.clearData({ history: true }) },
      { type: 'separator' },
      { type: 'heading', label: 'Also' },
      { id: 'cookies', label: 'Cookies and site data (signs you out)', hold: true, tone: 'danger', run: () => engine.clearData({ cookies: true }) },
      { id: 'cache', label: 'Cached files', run: () => engine.clearData({ cache: true }) },
    ]);
  });

  async function fill() {
    const mine = ++seq;
    const entries = await engine.history.search(input.value, { limit: limit + 1 });
    if (mine !== seq) return;
    const shown = [...entries].slice(0, limit);
    more.hidden = entries.length <= limit;
    if (!shown.length) {
      listEl.replaceChildren(h('div', { class: 'br-empty', text: input.value ? 'Nothing in your history matches.' : 'Pages you visit in ordinary tabs show here. Private tabs keep no history.' }));
      return;
    }
    const groups = [];
    for (const entry of shown) {
      const label = dayLabel(entry.lastVisit);
      if (groups.at(-1)?.label !== label) groups.push({ label, entries: [] });
      groups.at(-1).entries.push(entry);
    }
    listEl.replaceChildren(...groups.map(group => h('div', { class: 'br-history-day' },
      h('div', { class: 'br-heading', text: group.label }),
      ...group.entries.map(entry => {
        const remove = h('button', { class: 'br-icon-button br-row-remove', title: 'Remove from history', 'aria-label': 'Remove from history' }, icon('close'));
        const row = h('div', { class: 'br-row', title: entry.url },
          h('span', { class: 'br-row-time', text: timeFormat.format(entry.lastVisit) }),
          h('span', { class: 'br-row-icon' }, siteIcon(engine.iconFor(entry.url))),
          h('span', { class: 'br-row-title', text: entry.title || entry.url }),
          h('span', { class: 'br-row-host', text: hostOf(entry.url) }),
          remove);
        remove.addEventListener('click', event => { event.stopPropagation(); void engine.history.remove(entry.url); });
        row.addEventListener('click', event => open(entry.url, { newTab: event.ctrlKey || event.metaKey }));
        row.addEventListener('auxclick', event => { if (event.button === 1) open(entry.url, { newTab: true }); });
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          void atmos.contextMenu.open(event.clientX, event.clientY, [
            { id: 'open', label: 'Open', run: () => open(entry.url) },
            { id: 'open-new', label: 'Open in new tab', run: () => open(entry.url, { newTab: true }) },
            { id: 'copy', label: 'Copy link', run: () => atmos.clipboard.writeText(entry.url) },
            { type: 'separator' },
            { id: 'remove', label: 'Remove from history', run: () => engine.history.remove(entry.url) },
          ]);
        });
        return row;
      }))));
  }
  let typing = null;
  input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { limit = 300; void fill(); }, 120); });
  more.addEventListener('click', () => { limit += 300; void fill(); });
  void fill();
  return { refresh: fill, dispose() { seq += 1; clearTimeout(typing); } };
}

// ── When a page can't be shown ───────────────────────────────────────────────
const FRIENDLY = {
  '-105': 'The site’s name couldn’t be found. Check the address, or your connection.',
  '-102': 'The site refused to connect.',
  '-106': 'You seem to be offline.',
  '-109': 'The site can’t be reached.',
  '-118': 'The site took too long to answer.',
  '-7': 'The site took too long to answer.',
  '-21': 'Your network changed while the page was loading.',
  '-100': 'The connection was closed unexpectedly.',
  '-101': 'The connection was reset.',
  '-107': 'The site’s secure connection failed (an SSL protocol error).',
  '-113': 'The site uses a security setup this browser doesn’t accept.',
  '-137': 'The site’s name couldn’t be found. Check the address, or your connection.',
  '-310': 'The site redirected too many times.',
  '-111': 'The connection through your proxy failed.',
  '-130': 'Your proxy server isn’t answering.',
  '-15': 'The page couldn’t be reached from this network.',
  '-324': 'The site sent nothing back.',
  '-6': 'That file or page wasn’t found.',
  '-20': 'This page was blocked.',
  '-27': 'This page was blocked by the browser’s rules for what may load.',
  '-301': 'This address isn’t something Atmos Browser opens.',
};

export function renderProblem(container, tab, { engine }) {
  const error = tab.error || {};
  const host = siteName(error.url || tab.url) || 'This page';
  const actions = h('div', { class: 'br-actions' });
  const button = (label, run, primary = false) => {
    const element = h('button', { class: `br-button${primary ? ' primary' : ''}`, text: label });
    element.addEventListener('click', run);
    actions.append(element);
  };
  let iconName = 'warning';
  let title = '';
  const lines = [];
  if (error.kind === 'certificate') {
    title = 'This connection isn’t private';
    lines.push(`${host}’s certificate isn’t trusted, so the page might not be the real ${host}. Someone could be trying to read or change what you send.`);
    lines.push('Atmos Browser doesn’t open sites with certificate problems.');
    if (tab.canGoBack) button('Go back', () => engine.back(tab.id), true);
    else button('Close tab', () => engine.closeTab(tab.id), true);
  } else if (error.kind === 'crashed') {
    iconName = 'file';
    title = 'This page stopped working';
    lines.push(error.description === 'oom' ? 'It ran out of memory.' : 'Something went wrong while showing it.');
    button('Reload', () => engine.reload(tab.id), true);
  } else {
    iconName = 'globe';
    title = 'This page couldn’t load';
    lines.push(`${host}: ${FRIENDLY[String(error.code)] || 'Something went wrong on the way.'}`);
    button('Try again', () => engine.reload(tab.id), true);
    const typed = tab.typed?.text;
    if (typed) button(`Search for “${typed.length > 40 ? `${typed.slice(0, 40)}…` : typed}”`, () => engine.navigate(tab.id, `? ${typed}`));
    // An address typed without http(s):// went to https; the site may only have http.
    if (typed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) && String(error.url || '').startsWith('https:') && [-102, -107, -113, -118, -7, -100, -101, -324].includes(error.code)) {
      button('Try http:// (not secure)', () => engine.go(tab.id, String(error.url).replace(/^https:/, 'http:')));
    }
  }
  const column = h('div', { class: 'br-internal-column' },
    h('div', { class: 'br-interstitial-icon' }, icon(iconName)),
    h('h1', { text: title }),
    ...lines.map(line => h('p', { text: line })),
    error.description || error.code ? h('p', { class: 'br-detail', text: [error.description, error.code ? `(${error.code})` : ''].filter(Boolean).join(' ') }) : null,
    actions);
  container.replaceChildren(h('div', { class: `br-internal br-interstitial ${error.kind || ''}`, dataset: { atmosGlass: 'panel' } }, column));
  return { refresh() {}, dispose() {} };
}

export { tabLabel };

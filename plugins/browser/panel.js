/**
 * Atmos Browser's panel: the tab strip and toolbar, and where the selected
 * tab's page goes. The page itself is Core's (atmos.web): this frame says
 * where it shows (setSurface) and draws around and, on purpose, over it.
 * Pages the browser draws itself (a new tab, History, a certificate
 * warning) show in the same place instead.
 *
 * The tabs are the engine's, in the background frame (src/engine.js), so
 * they stay open while this panel is switched away; they show again when it
 * comes back.
 */
import atmos from 'atmos-sdk';
import { engine, follow, hold } from './src/ui/engine-client.js';
import { h, perFrame } from './src/ui/dom.js';
import { createTabStrip } from './src/ui/tabstrip.js';
import { createToolbar } from './src/ui/toolbar.js';
import { createOverlays } from './src/ui/overlays.js';
import { renderNewTab, renderHistory, renderProblem } from './src/ui/pages.js';
import { pageMenuItems } from './src/ui/page-menu.js';
import { commandFor } from './src/shortcuts.js';

const style = h('link', { rel: 'stylesheet', href: new URL('./assets/browser.css', import.meta.url).href });
document.head.append(style);
document.documentElement.dataset.presentation = atmos.surface.presentation || 'full';

const root = h('div', { class: 'br-root' });
const chrome = h('header', { class: 'br-chrome', dataset: { atmosGlass: 'shell' } });
const pageEl = h('main', { class: 'br-page', 'aria-label': 'Page', tabindex: '-1' });
const viewEl = h('div', { class: 'br-page-view' });
pageEl.append(viewEl);
root.append(chrome, pageEl);
document.body.append(root);

const focusPage = id => { void engine.focusPage(id); };
const tabstrip = createTabStrip({
  engine,
  onSelected: where => {
    const tab = engine.selected();
    if (where === 'address' || tab?.kind === 'new') toolbar.focusAddress();
    else if (tab?.kind === 'page') focusPage(tab.id);
  },
});
const toolbar = createToolbar({
  engine, root, focusPage,
  onLayout: () => reportSurface(),
  openDownloads: anchor => overlays.toggleDownloads(anchor),
});
chrome.append(tabstrip.element, toolbar.element);
const overlays = createOverlays({ engine, root, pageEl, onLayout: () => reportSurface(), focusPage });
atmos.surface.trackGlass();

// ── Where the page goes ──────────────────────────────────────────────────────
let lastSurface = '';
const reportSurface = perFrame(() => {
  const page = pageEl.getBoundingClientRect();
  const over = [...root.querySelectorAll('[data-over]')]
    .filter(element => !element.hidden)
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
  const surface = { x: page.left, y: page.top, width: page.width, height: page.height, over };
  const key = JSON.stringify(surface);
  if (key === lastSurface) return;
  lastSurface = key;
  atmos.web.setSurface(surface).catch(error => console.warn('[browser] setSurface:', error.message));
});
new ResizeObserver(() => { reportSurface(); render(); }).observe(pageEl);
// What is drawn over the page changes size as it fills: the page's hole follows.
const overWatch = new ResizeObserver(() => reportSurface());
for (const element of root.querySelectorAll('[data-over]')) overWatch.observe(element);
window.addEventListener('resize', reportSurface);

// ── What shows in the page's place ───────────────────────────────────────────
let current = { key: null, view: null };
function renderView(tab) {
  const key = tab.kind === 'page' ? `page ${tab.live}`
    : `${tab.kind} ${tab.id} ${tab.private} ${tab.kind === 'error' ? JSON.stringify([tab.error, tab.typed, tab.canGoBack]) : ''}`;
  if (key === current.key) return;
  current.view?.dispose();
  current = { key, view: null };
  const context = { engine, focusAddress: () => toolbar.focusAddress() };
  if (tab.kind === 'new') current.view = renderNewTab(viewEl, tab, context);
  else if (tab.kind === 'history') current.view = renderHistory(viewEl, tab, context);
  else if (tab.kind === 'error') current.view = renderProblem(viewEl, tab, context);
  // A page still opening: Atmos's glass until it shows, not the wallpaper.
  else if (!tab.live) viewEl.replaceChildren(h('div', { class: 'br-internal br-opening', dataset: { atmosGlass: 'panel' } }));
  else viewEl.replaceChildren();
}

const render = perFrame(() => {
  const tab = engine.selected();
  if (!tab) return;
  tabstrip.render();
  toolbar.render();
  renderView(tab);
  overlays.render(tab);
  reportSurface();
});

// ── Following the engine ─────────────────────────────────────────────────────
follow(change => {
  switch (change.type) {
    case 'tabs':
    case 'tab':
    case 'settings':
      render();
      if (change.type === 'settings' && current.key?.startsWith('new ')) { current.key = null; render(); }
      return;
    case 'find': {
      const tab = engine.tab(change.id);
      if (overlays.findFor() === change.id) overlays.renderFindCount(tab);
      return;
    }
    case 'downloads':
      toolbar.renderDownloads();
      overlays.renderDownloads();
      if (change.started && document.visibilityState === 'visible') overlays.toggleDownloads(toolbar.downloadsButton);
      return;
    case 'bookmarks':
    case 'history':
      void current.view?.refresh();
      render();
      return;
    case 'command':
      if (change.command === 'focus-address') toolbar.focusAddress();
      else if (change.command === 'find') overlays.openFind(engine.tab(change.id) || engine.selected());
      else if (change.command === 'downloads') overlays.toggleDownloads(toolbar.downloadsButton);
      return;
    case 'context-menu': {
      const tab = engine.tab(change.id);
      if (!tab || !tab.selected) return;
      void pageMenu(tab, change.params);
      return;
    }
    default:
  }
});

/**
 * A right-click in the page. This frame takes the keyboard while the menu
 * is open (so Escape reaches Atmos's menu) and gives it back to the page
 * after, unless what was chosen went somewhere else.
 */
async function pageMenu(tab, params) {
  const page = pageEl.getBoundingClientRect();
  const searchName = engine.searchEngines().find(item => item.id === engine.searchEngine())?.name || 'the web';
  const items = pageMenuItems(params, tab, { engine, searchName });
  if (!items.length) return;
  const x = Number.isFinite(params.menuX) ? params.menuX : page.left + (params.x || 0);
  const y = Number.isFinite(params.menuY) ? params.menuY : page.top + (params.y || 0);
  pageEl.focus({ preventScroll: true });
  await atmos.contextMenu.open(x, y, items).catch(() => null);
  if (document.activeElement === pageEl && engine.selectedId() === tab.id) focusPage(tab.id);
}

// ── Keys while this frame has focus (the page's own go through Core) ────────
document.addEventListener('keydown', event => {
  const command = commandFor(event);
  if (!command) return;
  event.preventDefault();
  event.stopPropagation();
  engine.runCommand(command, { tabId: engine.selectedId() });
});

// The panel is here: the selected tab loads (if it hasn't) and shows.
hold(engine.attachPanel());
render();
toolbar.renderDownloads();
if (engine.selected()?.kind === 'new') toolbar.focusAddress();

// For the end-to-end check (scripts/e2e/browser.cjs).
window.__browserPanel = { engine, toolbar, overlays, reportSurface: () => lastSurface };

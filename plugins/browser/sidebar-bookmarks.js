/**
 * The Bookmarks widget: your bookmarks in the sidebar. Click one to open it
 * in Atmos Browser (in the tab you're on if it's a new-tab page, otherwise
 * in a new tab); right-click to open it elsewhere, rename or remove it.
 */
import atmos from 'atmos-sdk';
import { engine, follow } from './src/ui/engine-client.js';
import { h, siteIcon, soon } from './src/ui/dom.js';
import { siteName, displayUrl } from './src/address.js';

document.head.append(h('link', { rel: 'stylesheet', href: new URL('./assets/browser.css', import.meta.url).href }));
const list = h('div', { class: 'br-list', role: 'list' });
document.body.append(list);
let renaming = null;

function open(url, { newTab = false, private: isPrivate = false } = {}) {
  const current = engine.selected();
  if (!newTab && !isPrivate && current?.kind === 'new' && !current.private) void engine.go(current.id, url);
  else engine.newTab({ url, private: isPrivate });
  void atmos.panel.show();
}

function row(item) {
  if (renaming === item.id) {
    const input = h('input', { class: 'br-rename', value: item.title, 'aria-label': 'Bookmark name', spellcheck: 'false' });
    const done = async keep => {
      if (renaming !== item.id) return;
      renaming = null;
      if (keep) await engine.bookmarks.rename(item.id, input.value);
      render();
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void done(true); }
      if (event.key === 'Escape') { event.preventDefault(); void done(false); }
    });
    input.addEventListener('blur', () => { void done(true); });
    queueMicrotask(() => { input.focus(); input.select(); });
    return h('div', { class: 'br-row' }, h('span', { class: 'br-row-icon' }, siteIcon(engine.iconFor(item.url))), input);
  }
  const element = h('div', { class: 'br-row', role: 'listitem', title: `${item.title}\n${displayUrl(item.url)}`, dataset: { bookmark: item.id } },
    h('span', { class: 'br-row-icon' }, siteIcon(engine.iconFor(item.url))),
    h('span', { class: 'br-row-title', text: item.title || siteName(item.url) }));
  element.addEventListener('click', event => open(item.url, { newTab: event.ctrlKey || event.metaKey }));
  element.addEventListener('auxclick', event => { if (event.button === 1) open(item.url, { newTab: true }); });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    void atmos.contextMenu.open(event.clientX, event.clientY, [
      { id: 'open', label: 'Open', run: () => open(item.url) },
      { id: 'open-new', label: 'Open in new tab', run: () => open(item.url, { newTab: true }) },
      { id: 'open-private', label: 'Open in private tab', run: () => open(item.url, { private: true }) },
      { id: 'copy', label: 'Copy link', run: () => atmos.clipboard.writeText(item.url) },
      { type: 'separator' },
      { id: 'rename', label: 'Rename', run: () => { renaming = item.id; render(); } },
      { id: 'up', label: 'Move up', run: async () => { const all = await engine.bookmarks.list(); await engine.bookmarks.move(item.id, Math.max(0, all.findIndex(b => b.id === item.id) - 1)); } },
      { id: 'remove', label: 'Remove', tone: 'danger', run: () => engine.bookmarks.remove(item.id) },
    ]);
  });
  return element;
}

const render = soon(async () => {
  const items = await engine.bookmarks.list();
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'br-empty', text: 'No bookmarks yet. In Atmos Browser, press ☆ in the address bar (or Ctrl+D) to add the page you’re on.' }));
  } else {
    list.replaceChildren(...[...items].map(row));
  }
  const current = engine.selected();
  void atmos.surface.setMenu(current?.kind === 'page' && !current.private ? [
    { id: 'bookmark', label: current.bookmarked ? 'Remove bookmark for this page' : 'Bookmark the page you’re on', run: () => engine.toggleBookmark(current.id) },
  ] : []);
});

follow(change => { if (change.type === 'bookmarks' || change.type === 'tabs') render(); });
render();

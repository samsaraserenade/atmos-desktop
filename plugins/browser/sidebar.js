/**
 * The Tabs widget: Atmos Browser's open tabs in the sidebar. Click one to
 * go to it (the browser panel comes up); × closes it, the speaker mutes it.
 */
import atmos from 'atmos-sdk';
import { engine, follow } from './src/ui/engine-client.js';
import { h, icon, siteIcon, tabLabel, soon } from './src/ui/dom.js';
import { displayUrl } from './src/address.js';

document.head.append(h('link', { rel: 'stylesheet', href: new URL('./assets/browser.css', import.meta.url).href }));
const list = h('div', { class: 'br-list', role: 'list' });
document.body.append(list);

function row(tab) {
  const close = h('button', { class: 'br-icon-button br-row-remove', title: 'Close tab', 'aria-label': 'Close tab' }, icon('close'));
  const audio = tab.audible || tab.muted
    ? h('button', { class: 'br-icon-button br-row-audio', title: tab.muted ? 'Unmute tab' : 'Mute tab', 'aria-label': tab.muted ? 'Unmute tab' : 'Mute tab' }, icon(tab.muted ? 'muted' : 'speaker'))
    : null;
  const element = h('div', { class: `br-row${tab.selected ? ' selected' : ''}`, role: 'listitem', title: displayUrl(tab.url) || tabLabel(tab), dataset: { tab: tab.id } },
    h('span', { class: 'br-row-icon' }, tab.kind === 'history' ? icon('history') : tab.kind === 'new' ? icon(tab.private ? 'private' : 'plus') : siteIcon(tab.favicon)),
    h('span', { class: 'br-row-title', text: tabLabel(tab) }),
    tab.private && tab.kind !== 'new' ? h('span', { class: 'br-row-icon', title: 'Private' }, icon('private')) : null,
    audio, close);
  element.addEventListener('click', () => {
    engine.selectTab(tab.id);
    void atmos.panel.show();
  });
  element.addEventListener('auxclick', event => { if (event.button === 1) engine.closeTab(tab.id); });
  close.addEventListener('click', event => { event.stopPropagation(); engine.closeTab(tab.id); });
  audio?.addEventListener('click', event => { event.stopPropagation(); void engine.mute(tab.id, !tab.muted); });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    void atmos.contextMenu.open(event.clientX, event.clientY, [
      { id: 'reload', label: 'Reload', run: () => engine.reload(tab.id) },
      { id: 'duplicate', label: 'Duplicate', run: () => engine.duplicateTab(tab.id) },
      ...(tab.url ? [{ id: 'copy', label: 'Copy address', run: () => atmos.clipboard.writeText(tab.url) }] : []),
      { type: 'separator' },
      { id: 'close', label: 'Close tab', run: () => engine.closeTab(tab.id) },
      ...(engine.tabs().length > 1 ? [{ id: 'close-others', label: 'Close other tabs', run: () => engine.closeOtherTabs(tab.id) }] : []),
    ]);
  });
  return element;
}

let shown = '';
const render = soon(() => {
  const tabs = engine.tabs();
  const signature = JSON.stringify(tabs.map(tab => [tab.id, tabLabel(tab), tab.url, tab.kind, tab.favicon, tab.selected, tab.private, tab.audible, tab.muted]))
    + engine.closedCount();
  if (signature === shown) return;
  shown = signature;
  list.replaceChildren(...tabs.map(row));
  void atmos.surface.setMenu([
    { id: 'new-tab', label: 'New tab', run: () => { engine.newTab({}); void atmos.panel.show(); } },
    { id: 'new-private', label: 'New private tab', run: () => { engine.newTab({ private: true }); void atmos.panel.show(); } },
    ...(engine.closedCount() ? [{ id: 'reopen', label: 'Reopen closed tab', run: () => { engine.reopenClosed(); void atmos.panel.show(); } }] : []),
  ]);
});

follow(change => { if (change.type === 'tabs' || change.type === 'tab') render(); });
render();

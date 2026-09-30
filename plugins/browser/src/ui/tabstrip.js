/**
 * The tab strip: one tab per tab, in order, the selected one lit. Click
 * selects, middle-click or × closes, the speaker mutes, dragging moves a
 * tab, right-click has the tab's menu, double-click on the empty strip opens
 * a new tab.
 */
import atmos from 'atmos-sdk';
import { h, icon, siteIcon, tabLabel } from './dom.js';

const NARROW_PX = 64;

export function createTabStrip({ engine, onSelected }) {
  const tabsEl = h('div', { class: 'br-tabs', role: 'tablist', 'aria-label': 'Tabs' });
  const newButton = h('button', { class: 'br-icon-button br-newtab', title: 'New tab (Ctrl+T)', 'aria-label': 'New tab' }, icon('plus'));
  const element = h('div', { class: 'br-tabstrip' }, tabsEl, newButton);
  let drag = null;

  newButton.addEventListener('click', () => { engine.runCommand('new-tab'); });
  element.addEventListener('dblclick', event => {
    if (event.target === element || event.target === tabsEl) engine.runCommand('new-tab');
  });
  // A vertical wheel scrolls a strip too full to fit.
  tabsEl.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { tabsEl.scrollLeft += event.deltaY; event.preventDefault(); }
  }, { passive: false });

  function tabMenu(tab, x, y) {
    const items = [
      { id: 'new-right', label: 'New tab to the right', run: () => { engine.newTab({ after: tab.id, private: tab.private }); onSelected?.('address'); } },
      { type: 'separator' },
      { id: 'reload', label: 'Reload', run: () => engine.reload(tab.id) },
      { id: 'duplicate', label: 'Duplicate', run: () => engine.duplicateTab(tab.id) },
      ...(tab.live ? [{ id: 'mute', label: tab.muted ? 'Unmute tab' : 'Mute tab', run: () => engine.mute(tab.id, !tab.muted) }] : []),
      ...(tab.kind === 'page' && !tab.private ? [{ id: 'bookmark', label: tab.bookmarked ? 'Remove bookmark' : 'Bookmark', run: () => engine.toggleBookmark(tab.id) }] : []),
      { type: 'separator' },
      { id: 'close', label: 'Close tab', run: () => engine.closeTab(tab.id) },
      ...(engine.tabs().length > 1 ? [{ id: 'close-others', label: 'Close other tabs', run: () => engine.closeOtherTabs(tab.id) }] : []),
      ...(engine.closedCount() ? [{ id: 'reopen', label: 'Reopen closed tab', run: () => engine.reopenClosed() }] : []),
    ];
    void atmos.contextMenu.open(x, y, items);
  }

  function tabElement(tab) {
    const audio = tab.audible || tab.muted
      ? h('button', {
        class: `br-tab-audio${tab.audible && !tab.muted ? ' playing' : ''}`,
        title: tab.muted ? 'Unmute tab' : 'Mute tab', 'aria-label': tab.muted ? 'Unmute tab' : 'Mute tab',
      }, icon(tab.muted ? 'muted' : 'speaker'))
      : null;
    const close = h('button', { class: 'br-tab-close', title: 'Close tab (Ctrl+W)', 'aria-label': 'Close tab' }, icon('close'));
    const label = tabLabel(tab);
    const iconEl = h('span', { class: 'br-tab-icon' },
      tab.kind === 'history' ? icon('history') : tab.kind === 'new' ? icon(tab.private ? 'private' : 'plus') : siteIcon(tab.favicon));
    const element = h('div', {
      class: `br-tab${tab.selected ? ' selected' : ''}${tab.private ? ' private' : ''}${tab.loading && tab.kind === 'page' ? ' br-tab-loading' : ''}`,
      role: 'tab', 'aria-selected': tab.selected ? 'true' : 'false', title: tab.private ? `${label} — private` : label,
      dataset: { tab: tab.id },
    }, iconEl, h('span', { class: 'br-tab-title', text: label }), audio, close);
    if (tab.private && tab.kind === 'page') iconEl.after(h('span', { class: 'br-tab-icon', title: 'Private' }, icon('private')));

    audio?.addEventListener('click', event => { event.stopPropagation(); void engine.mute(tab.id, !tab.muted); });
    close.addEventListener('click', event => { event.stopPropagation(); engine.closeTab(tab.id); });
    element.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); engine.closeTab(tab.id); } });
    element.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
    element.addEventListener('contextmenu', event => { event.preventDefault(); tabMenu(tab, event.clientX, event.clientY); });
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      // Kept until the pointer is up (render() waits), so a drag can follow.
      drag = { id: tab.id, x: event.clientX, pointer: event.pointerId, moved: false, element };
      element.setPointerCapture(event.pointerId);
      element.classList.add('selected');
      for (const other of tabsEl.children) if (other !== element) other.classList.remove('selected');
      engine.selectTab(tab.id);
      onSelected?.('page');
    });
    element.addEventListener('pointermove', event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      if (!drag.moved && Math.abs(event.clientX - drag.x) < 6) return;
      drag.moved = true;
      element.classList.add('dragging');
      const others = [...tabsEl.children].filter(child => child !== element);
      const index = others.findIndex(child => {
        const rect = child.getBoundingClientRect();
        return event.clientX < rect.left + rect.width / 2;
      });
      drag.to = index < 0 ? others.length : index;
    });
    const endDrag = event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      const { id, moved, to } = drag;
      drag = null;
      element.classList.remove('dragging');
      if (moved && Number.isFinite(to)) engine.moveTab(id, to);
      render();
    };
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    return element;
  }

  const built = new Map(); // tab id -> { signature, element }
  const signature = tab => JSON.stringify([tabLabel(tab), tab.kind, tab.favicon, tab.selected, tab.private, tab.loading && tab.kind === 'page',
    tab.audible, tab.muted, tab.live, tab.bookmarked]);

  function render() {
    if (drag) return; // the pointer is down on a tab: after it's up
    const tabs = engine.tabs();
    const children = tabs.map(tab => {
      const sig = signature(tab);
      const known = built.get(tab.id);
      if (known && known.signature === sig) return known.element;
      const element = tabElement(tab);
      built.set(tab.id, { signature: sig, element });
      return element;
    });
    for (const id of [...built.keys()]) if (!tabs.some(tab => tab.id === id)) built.delete(id);
    if (children.length !== tabsEl.children.length || children.some((child, index) => tabsEl.children[index] !== child)) {
      tabsEl.replaceChildren(...children);
    }
    // Very narrow tabs show only their icon.
    requestAnimationFrame(() => {
      for (const child of tabsEl.children) child.classList.toggle('narrow', child.getBoundingClientRect().width < NARROW_PX);
      tabsEl.querySelector('.br-tab.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  return { element, render };
}

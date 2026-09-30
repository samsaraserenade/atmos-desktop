/**
 * The toolbar: back, forward, reload or stop, the address bar with its
 * suggestions, the page's zoom, bookmark star and shield (the ads and
 * trackers blocked on it), downloads, and the menu.
 *
 * The address bar shows the selected tab's address while you aren't typing
 * in it. Typing shows suggestions (what you typed, a search, bookmarks and
 * history); Enter goes to the highlighted one, Alt+Enter in a new tab,
 * Escape puts the address back.
 */
import atmos from 'atmos-sdk';
import { h, icon, siteIcon, takeFocus } from './dom.js';
import { displayUrl, siteName } from '../address.js';
import { PERMISSION_NAMES } from './icons.js';

export function createToolbar({ engine, root, onLayout, openDownloads, focusPage }) {
  const back = h('button', { class: 'br-icon-button', title: 'Back (Alt+←)', 'aria-label': 'Back' }, icon('back'));
  const forward = h('button', { class: 'br-icon-button br-hide-narrow', title: 'Forward (Alt+→)', 'aria-label': 'Forward' }, icon('forward'));
  const reload = h('button', { class: 'br-icon-button', title: 'Reload (Ctrl+R)', 'aria-label': 'Reload' }, icon('reload'));
  const privatePill = h('span', { class: 'br-private-pill', hidden: true, title: 'This tab is private' }, icon('private'), 'Private');
  const site = h('button', { class: 'br-site', 'aria-label': 'About this site' });
  const input = h('input', {
    class: 'br-address-input', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Address and search bar',
    placeholder: 'Search or enter an address',
  });
  const zoom = h('button', { class: 'br-zoom', hidden: true, title: 'Reset zoom (Ctrl+0)' });
  const star = h('button', { class: 'br-icon-button br-star', title: 'Bookmark this page (Ctrl+D)', 'aria-label': 'Bookmark this page' }, icon('star'));
  const shield = h('button', { class: 'br-icon-button br-shield', hidden: true, 'aria-label': 'Ads and trackers' });
  const address = h('div', { class: 'br-address' }, privatePill, site, input, zoom, star, shield);
  const downloads = h('button', { class: 'br-icon-button br-downloads', hidden: true, title: 'Downloads (Ctrl+J)', 'aria-label': 'Downloads' }, icon('download'));
  const menu = h('button', { class: 'br-icon-button', title: 'Menu', 'aria-label': 'Menu' }, icon('menu'));
  const bar = h('div', { class: 'br-progress-bar' });
  const element = h('div', { class: 'br-toolbar' }, back, forward, reload, address, downloads, menu, h('div', { class: 'br-progress' }, bar));

  // Suggestions, drawn over the page.
  const suggestionsEl = h('div', { class: 'br-over br-suggestions', hidden: true, role: 'listbox', dataset: { over: '' } });
  root.append(suggestionsEl);
  let suggestions = [];
  let active = 0;
  let editing = false;
  let suggestSeq = 0;

  const tab = () => engine.selected();

  // ── Buttons ───────────────────────────────────────────────────────────────
  back.addEventListener('click', () => { const t = tab(); if (t) void engine.back(t.id); });
  forward.addEventListener('click', () => { const t = tab(); if (t) void engine.forward(t.id); });
  reload.addEventListener('click', event => {
    const t = tab();
    if (!t) return;
    if (t.loading && t.kind === 'page') void engine.stop(t.id);
    else engine.reload(t.id, { hard: event.shiftKey });
  });
  zoom.addEventListener('click', () => { const t = tab(); if (t) void engine.zoom(t.id, 'reset'); });
  star.addEventListener('click', () => { const t = tab(); if (t) void engine.toggleBookmark(t.id); });
  downloads.addEventListener('click', () => openDownloads(downloads));
  menu.addEventListener('click', () => {
    const rect = menu.getBoundingClientRect();
    openMenu(rect.right - 4, rect.bottom + 2);
  });
  site.addEventListener('click', () => {
    const rect = site.getBoundingClientRect();
    void siteMenu(rect.left, rect.bottom + 4);
  });
  shield.addEventListener('click', () => {
    const rect = shield.getBoundingClientRect();
    void shieldMenu(rect.right - 4, rect.bottom + 4);
  });

  /** The shield's menu: what was blocked here, and blocking on or off for the site. */
  async function shieldMenu(x, y) {
    const t = tab();
    if (!t || t.kind !== 'page' || t.shield === 'none') return;
    const items = [{ type: 'heading', label: siteName(t.url) }];
    if (t.shield === 'disabled') {
      items.push(
        { type: 'meta', label: 'Ad and tracker blocking is off for every site' },
        { type: 'toggle', id: 'block-ads', label: 'Block ads and trackers', checked: false, run: value => { void engine.setOptions({ blockAds: value === true }); } },
      );
    } else {
      const found = t.shield === 'on' ? await engine.blocked(t.id).catch(() => null) : null;
      const count = found?.count ?? t.blocked ?? 0;
      items.push({ type: 'meta', label: t.shield === 'on' ? blockedText(count) : 'Ads and trackers are allowed on this site' });
      for (const item of (found?.hosts || []).slice(0, 6)) items.push({ type: 'meta', label: `${item.host} · ${item.count}` });
      items.push(
        { type: 'separator' },
        {
          type: 'toggle', id: 'shield', label: 'Block ads and trackers on this site', checked: t.shield === 'on',
          run: value => { void engine.setShield(t.id, value === true); },
        },
      );
    }
    void atmos.contextMenu.open(x, y, items);
  }

  async function siteMenu(x, y) {
    const t = tab();
    if (!t || t.kind !== 'page') { input.focus(); return; }
    const origin = (() => { try { return new URL(t.url).origin; } catch { return ''; } })();
    // (The site's ads and trackers are the shield's to show.)
    const stored = origin ? (await engine.sitePermissions().catch(() => [])).filter(item => item.origin === origin && item.name !== 'ads') : [];
    const items = [
      { type: 'heading', label: siteName(t.url) },
      { type: 'meta', label: t.error?.kind === 'certificate' ? 'The site’s certificate isn’t trusted' : t.secure ? 'Connection is secure' : 'Connection is not secure: what you send can be read on the way' },
    ];
    if (stored.length) {
      items.push({ type: 'separator' });
      for (const item of stored) {
        items.push({
          type: 'select', id: `perm-${item.name}`, label: PERMISSION_NAMES[item.name] || item.name, value: item.value,
          options: [{ value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }, { value: 'ask', label: 'Ask' }],
          run: value => { void engine.setSitePermission(origin, item.name, value === 'ask' ? null : value); },
        });
      }
    }
    if (t.private) items.push({ type: 'meta', label: 'Private tab: nothing from it is kept after the last private tab closes' });
    void atmos.contextMenu.open(x, y, items);
  }

  function openMenu(x, y) {
    const t = tab();
    const page = t?.kind === 'page' && t.live;
    const zoomPercent = `${Math.round((t?.zoom || 1) * 100)}%`;
    const items = [
      { id: 'new-tab', label: 'New tab', run: () => engine.runCommand('new-tab') },
      { id: 'new-private', label: 'New private tab', run: () => engine.runCommand('new-private-tab') },
      ...(engine.closedCount() ? [{ id: 'reopen', label: 'Reopen closed tab', run: () => engine.reopenClosed() }] : []),
      { type: 'separator' },
      { id: 'history', label: 'History', run: () => engine.openHistory() },
      { id: 'downloads', label: 'Downloads', run: () => openDownloads(downloads) },
      ...(t?.kind === 'page' ? [{ id: 'bookmark', label: t.bookmarked ? 'Remove bookmark' : 'Bookmark this page', run: () => engine.toggleBookmark(t.id) }] : []),
      ...(page ? [
        { type: 'separator' },
        {
          type: 'buttons', buttons: [
            { id: 'zoom-out', label: '−', title: 'Zoom out (Ctrl+−)', run: () => engine.zoom(t.id, 'out') },
            { id: 'zoom-reset', label: zoomPercent, title: 'Reset zoom (Ctrl+0)', run: () => engine.zoom(t.id, 'reset') },
            { id: 'zoom-in', label: '+', title: 'Zoom in (Ctrl++)', run: () => engine.zoom(t.id, 'in') },
          ],
        },
        { id: 'find', label: 'Find in page…', run: () => engine.runCommand('find', { tabId: t.id }) },
        { id: 'print', label: 'Print…', run: () => engine.print(t.id) },
      ] : []),
      { type: 'separator' },
      {
        type: 'toggle', id: 'open-links', label: 'Open links from Atmos here', checked: engine.options().openLinks === true,
        run: value => { void engine.setOptions({ openLinks: value === true }); },
      },
    ];
    void atmos.contextMenu.open(x, y, items);
  }

  // ── The address bar ───────────────────────────────────────────────────────
  function showAddress() {
    const t = tab();
    if (!t) return;
    input.value = t.kind === 'page' || t.kind === 'error' ? displayUrl(t.error?.url && t.kind === 'error' ? t.error.url : t.url) : '';
    input.placeholder = t.kind === 'history' ? 'History — search or enter an address' : 'Search or enter an address';
  }

  function closeSuggestions() {
    if (suggestionsEl.hidden) return;
    suggestionsEl.hidden = true;
    suggestions = [];
    onLayout();
  }

  function renderSuggestions() {
    if (!suggestions.length || document.activeElement !== input) { closeSuggestions(); return; }
    suggestionsEl.replaceChildren(...suggestions.map((item, index) => {
      const iconEl = h('span', { class: 'br-suggestion-icon' },
        item.kind === 'search' ? icon('search') : item.kind === 'url' ? icon('globe') : siteIcon(item.favicon, item.kind === 'bookmark' ? 'bookmark' : 'history'));
      const title = item.kind === 'search' ? item.title : item.title || item.url;
      const detail = item.kind === 'search' ? `${item.engine} search` : item.kind === 'url' ? '' : item.url;
      const row = h('div', {
        class: `br-suggestion${index === active ? ' active' : ''}`, role: 'option', 'aria-selected': index === active ? 'true' : 'false',
      }, iconEl, h('span', { class: 'br-suggestion-title', text: title }), h('span', { class: 'br-suggestion-url', text: detail }),
      item.kind === 'bookmark' ? h('span', { class: 'br-suggestion-kind', text: 'Bookmark' }) : null);
      row.addEventListener('pointerdown', event => { event.preventDefault(); choose(index, { newTab: event.button === 1 || event.ctrlKey }); });
      row.addEventListener('pointermove', () => { if (active !== index) { active = index; renderSuggestions(); } });
      return row;
    }));
    const box = address.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    Object.assign(suggestionsEl.style, {
      left: `${box.left - rootBox.left}px`, top: `${box.bottom - rootBox.top + 4}px`, width: `${Math.max(280, box.width)}px`,
    });
    suggestionsEl.hidden = false;
    onLayout();
  }

  async function updateSuggestions() {
    const seq = ++suggestSeq;
    const list = await engine.suggest(input.value).catch(() => []);
    if (seq !== suggestSeq) return;
    suggestions = Array.isArray(list) ? [...list] : [];
    active = 0;
    renderSuggestions();
  }

  async function choose(index, { newTab = false } = {}) {
    const item = suggestions[index];
    const text = input.value;
    closeSuggestions();
    editing = false;
    const t = tab();
    if (!t) return;
    let target = t.id;
    if (newTab) target = engine.newTab({ private: t.private }).id;
    // The first suggestion is what you typed: the address bar decides.
    const result = !item || index === 0 ? await engine.navigate(target, text) : await engine.go(target, item.url);
    if (result.ok) { input.blur(); focusPage(target); } else showAddress();
  }

  input.addEventListener('focus', () => { input.select(); });
  input.addEventListener('blur', () => {
    closeSuggestions();
    if (editing) return;
    showAddress();
  });
  input.addEventListener('input', () => {
    editing = true;
    if (!input.value.trim()) { suggestSeq += 1; closeSuggestions(); return; }
    void updateSuggestions();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestions.length) return;
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!input.value.trim()) return;
      void choose(suggestions.length ? active : -1, { newTab: event.altKey });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!suggestions.length && !editing) { input.blur(); const t = tab(); if (t) focusPage(t.id); return; }
      editing = false;
      closeSuggestions();
      showAddress();
      input.select();
    }
  });

  // The keyboard may be in the page (Ctrl+L there): see takeFocus().
  function focusAddress() {
    takeFocus(input, { select: true });
  }

  // ── Following the selected tab ────────────────────────────────────────────
  function render() {
    const t = tab();
    if (!t) return;
    back.disabled = !(t.live && t.canGoBack);
    forward.disabled = !(t.live && t.canGoForward);
    const stopping = t.loading && t.kind === 'page';
    reload.replaceChildren(icon(stopping ? 'stop' : 'reload'));
    reload.title = stopping ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
    reload.disabled = t.kind === 'new' || t.kind === 'history';
    privatePill.hidden = !t.private;
    // What the site button says.
    site.className = 'br-site';
    let siteIconName = 'search';
    let siteLabel = '';
    if (t.kind === 'error' && t.error?.kind === 'certificate') { siteIconName = 'warning'; siteLabel = 'Not secure'; site.classList.add('certificate'); }
    else if (t.kind === 'page' && t.url.startsWith('https:')) siteIconName = 'lock';
    else if (t.kind === 'page' && t.url.startsWith('http:')) { siteIconName = 'warning'; siteLabel = 'Not secure'; site.classList.add('insecure'); }
    else if (t.kind === 'history') siteIconName = 'history';
    else if (t.kind === 'error') siteIconName = 'globe';
    site.replaceChildren(icon(siteIconName), siteLabel ? h('span', { class: 'br-site-label', text: siteLabel }) : '');
    site.title = t.kind === 'page' ? 'About this site' : '';
    const zoomed = t.live && Math.abs((t.zoom || 1) - 1) > 0.001;
    zoom.hidden = !zoomed;
    if (zoomed) zoom.textContent = `${Math.round(t.zoom * 100)}%`;
    star.hidden = t.kind !== 'page';
    // The shield: the count blocked on the page, or crossed out when off.
    const shieldShown = t.kind === 'page' && t.live && t.shield && t.shield !== 'none';
    shield.hidden = !shieldShown;
    if (shieldShown) {
      const on = t.shield === 'on';
      const count = on ? t.blocked || 0 : 0;
      shield.className = `br-icon-button br-shield ${on ? 'on' : 'off'}`;
      shield.replaceChildren(icon(on ? 'shield' : 'shieldOff'), count ? h('span', { class: 'br-shield-count', text: count > 999 ? '999+' : String(count) }) : '');
      shield.title = on ? blockedText(count) : t.shield === 'off' ? 'Ads and trackers allowed on this site' : 'Ad and tracker blocking is off';
      shield.setAttribute('aria-label', shield.title);
    }
    star.classList.toggle('on', !!t.bookmarked);
    star.replaceChildren(icon(t.bookmarked ? 'starFilled' : 'star'));
    star.title = t.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
    const progress = t.kind === 'page' && t.loading ? Math.max(0.08, Math.min(0.95, t.progress || 0.08)) : 0;
    bar.classList.toggle('on', progress > 0);
    bar.style.width = `${Math.round(progress * 100)}%`;
    if (document.activeElement !== input || !editing) {
      if (document.activeElement !== input) editing = false;
      if (!editing) showAddress();
    }
  }

  function renderDownloads() {
    const list = engine.downloads();
    downloads.hidden = list.length === 0;
    const running = list.filter(item => item.state === 'progressing');
    downloads.classList.toggle('active', running.length > 0);
    downloads.querySelector('.br-ring')?.remove();
    if (running.length) {
      const total = running.reduce((sum, item) => sum + (item.total || 0), 0);
      const received = running.reduce((sum, item) => sum + (item.received || 0), 0);
      const fraction = total ? Math.min(1, received / total) : 0.25;
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ring.setAttribute('viewBox', '0 0 22 22');
      ring.setAttribute('class', 'br-ring');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      Object.entries({ cx: 11, cy: 11, r: 10, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': `${(fraction * 62.8).toFixed(1)} 62.8`, transform: 'rotate(-90 11 11)', opacity: 0.8 })
        .forEach(([name, value]) => circle.setAttribute(name, String(value)));
      ring.append(circle);
      downloads.append(ring);
    }
  }

  function blockedText(count) {
    if (!count) return 'Blocking ads and trackers: none on this page yet';
    return `${count.toLocaleString()} ${count === 1 ? 'ad or tracker' : 'ads and trackers'} blocked on this page`;
  }

  return {
    element, input, downloadsButton: downloads,
    render, renderDownloads, focusAddress, closeSuggestions,
    isEditing: () => editing && document.activeElement === input,
  };
}

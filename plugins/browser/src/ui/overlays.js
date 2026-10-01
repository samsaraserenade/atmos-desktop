/**
 * What the panel draws over the page: a site's permission question,
 * another program's link, a notice (something refused, a pop-up or a
 * download blocked), find in page, and downloads. Each is marked
 * data-over, so the panel tells Core to keep the frame there (the page
 * shows through everywhere else). What asks for an answer takes none the
 * moment it appears (guard.js).
 */
import { h, icon, bytes, takeFocus } from './dom.js';
import { siteName } from '../address.js';
import { PERMISSION_ICONS, PERMISSION_WORDS } from './icons.js';
import { createGuard, guardedClick } from './guard.js';

const NOTICE_MS = 7000;
const ACTION_NOTICE_MS = 12000; // one with a button stays a little longer

export function createOverlays({ engine, root, pageEl, onLayout, focusPage }) {
  // ── A site asks for a permission ──────────────────────────────────────────
  const permission = h('div', { class: 'br-over br-prompt', hidden: true, role: 'dialog', dataset: { over: '', test: 'permission' } });
  // ── A link to another program ─────────────────────────────────────────────
  const external = h('div', { class: 'br-over br-prompt', hidden: true, role: 'dialog', dataset: { over: '', test: 'external' } });
  // ── Something was refused ─────────────────────────────────────────────────
  const notice = h('div', { class: 'br-over br-notice', hidden: true, role: 'status', dataset: { over: '', test: 'notice' } });
  // ── Find in page ──────────────────────────────────────────────────────────
  const findInput = h('input', { type: 'text', placeholder: 'Find in page', spellcheck: 'false', 'aria-label': 'Find in page' });
  const findCount = h('span', { class: 'br-find-count' });
  const findUp = h('button', { class: 'br-icon-button', title: 'Previous (Shift+Enter)', 'aria-label': 'Previous match' }, icon('up'));
  const findDown = h('button', { class: 'br-icon-button', title: 'Next (Enter)', 'aria-label': 'Next match' }, icon('down'));
  const findClose = h('button', { class: 'br-icon-button', title: 'Close (Esc)', 'aria-label': 'Close find' }, icon('close'));
  const find = h('div', { class: 'br-over br-find', hidden: true, role: 'search', dataset: { over: '', test: 'find' } }, findInput, findCount, findUp, findDown, findClose);
  // ── Downloads ─────────────────────────────────────────────────────────────
  const downloadsList = h('div', { class: 'br-downloads-list' });
  const downloads = h('div', { class: 'br-over br-downloads-panel', hidden: true, role: 'dialog', 'aria-label': 'Downloads', dataset: { over: '', test: 'downloads' } },
    h('div', { class: 'br-downloads-head', text: 'Downloads' }), downloadsList);
  root.append(permission, external, notice, find, downloads);

  // Each answer's guard, armed as its question appears; the pointer moving
  // over one counts for its buttons.
  const permissionGuard = createGuard();
  const externalGuard = createGuard();
  const noticeGuard = createGuard();
  const openGuards = new Map(); // download id -> the guard on its Open, armed as it finished
  permission.addEventListener('pointermove', event => permissionGuard.pointer(event));
  external.addEventListener('pointermove', event => externalGuard.pointer(event));
  notice.addEventListener('pointermove', event => noticeGuard.pointer(event));
  downloads.addEventListener('pointermove', event => { for (const guard of openGuards.values()) guard.pointer(event); });

  let noticeTimer = null;
  let noticeFor = null;
  let findFor = null;
  let downloadsAnchor = null;

  const pageBox = () => {
    const page = pageEl.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    return { left: page.left - box.left, top: page.top - box.top, right: box.right - page.right, width: page.width, height: page.height };
  };
  const placeLeft = (element, offset = 0) => {
    const page = pageBox();
    Object.assign(element.style, { left: `${page.left + 12}px`, top: `${page.top + 8 + offset}px`, right: '' });
  };
  const placeRight = element => {
    const page = pageBox();
    Object.assign(element.style, { right: `${page.right + 12}px`, top: `${page.top + 8}px`, left: '' });
  };

  function renderPermission(tab) {
    const request = tab?.permission;
    if (!request) { permission.hidden = true; return; }
    if (permission.dataset.request === request.requestId && !permission.hidden) return;
    permission.dataset.request = request.requestId;
    const block = h('button', { class: 'br-button small', text: 'Block' });
    const allow = h('button', { class: 'br-button small primary', text: 'Allow' });
    const close = h('button', { class: 'br-icon-button br-prompt-close', title: 'Not now', 'aria-label': 'Not now' }, icon('close'));
    permission.replaceChildren(
      close,
      h('div', { class: 'br-prompt-title' }, h('strong', { text: siteName(request.origin) }), ' wants to'),
      h('ul', { class: 'br-prompt-list' }, ...request.permissions.map(name => h('li', {}, icon(PERMISSION_ICONS[name] || 'globe'), PERMISSION_WORDS[name] || name))),
      tab.private ? h('div', { class: 'br-prompt-note', text: 'Your answer lasts until the last private tab closes.' })
        : h('div', { class: 'br-prompt-note', text: 'Remembered for this site. Change it in Settings → Appearance → Atmos Browser.' }),
      h('div', { class: 'br-prompt-buttons' }, block, allow));
    guardedClick(permissionGuard, block, () => { void engine.answerPermission(tab.id, request.requestId, false); });
    guardedClick(permissionGuard, allow, () => { void engine.answerPermission(tab.id, request.requestId, true); });
    guardedClick(permissionGuard, close, () => { void engine.dismissPermission(tab.id, request.requestId); });
    permissionGuard.arm();
    permission.hidden = false;
  }

  function renderExternal(tab) {
    const request = tab?.external;
    if (!request) { external.hidden = true; return; }
    if (external.dataset.request === request.requestId && !external.hidden) return;
    external.dataset.request = request.requestId;
    const cancel = h('button', { class: 'br-button small', text: 'Cancel' });
    const open = h('button', { class: 'br-button small primary', text: 'Open' });
    const shown = request.url.length > 120 ? `${request.url.slice(0, 120)}…` : request.url;
    // The page that asks (a pop-up's link is asked here, in the tab you're on).
    const asking = request.site ? siteName(request.site) : siteName(tab.url);
    external.replaceChildren(
      h('div', { class: 'br-prompt-title' }, 'Open this link with another program?'),
      h('div', { class: 'br-prompt-note' }, `${asking || 'This page'} wants to open a ${request.scheme}: link:`, h('br'), shown),
      h('div', { class: 'br-prompt-buttons' }, cancel, open));
    // Each answers the request drawn here, never one that took its place before the next frame.
    guardedClick(externalGuard, cancel, () => { void engine.answerExternal(tab.id, false, request.requestId); });
    guardedClick(externalGuard, open, () => { void engine.answerExternal(tab.id, true, request.requestId); });
    externalGuard.arm();
    external.hidden = false;
  }

  function renderNotice(tab) {
    const text = tab?.notice?.text;
    if (!text) { notice.hidden = true; noticeFor = null; clearTimeout(noticeTimer); return; }
    const key = `${tab.id} ${tab.notice.id || ''} ${text}`;
    if (noticeFor === key && !notice.hidden) return;
    noticeFor = key;
    const close = h('button', { class: 'br-icon-button', title: 'Close', 'aria-label': 'Close' }, icon('close'));
    // A blocked pop-up or download offers to go ahead, which the page could time: guarded.
    const actions = (tab.notice.actions || []).slice(0, 2).map((action, index) => {
      const button = h('button', { class: `br-button small${index === 0 ? ' primary' : ''}`, text: action.label });
      guardedClick(noticeGuard, button, () => { void engine.noticeAction(tab.id, index, tab.notice.id); });
      return button;
    });
    notice.replaceChildren(icon('warning'), h('span', { text }), ...actions, close);
    close.addEventListener('click', () => engine.dismissNotice(tab.id));
    if (actions.length) noticeGuard.arm();
    notice.hidden = false;
    clearTimeout(noticeTimer);
    const id = tab.id;
    noticeTimer = setTimeout(() => engine.dismissNotice(id), actions.length ? ACTION_NOTICE_MS : NOTICE_MS);
  }

  // Find in page
  function openFind(tab) {
    if (!tab || tab.kind !== 'page') return;
    findFor = tab.id;
    find.hidden = false;
    placeRight(find);
    findInput.value = tab.find?.text || findInput.value;
    takeFocus(findInput, { select: true });
    renderFindCount(tab);
    if (findInput.value) void engine.find(tab.id, findInput.value);
    onLayout();
  }
  function closeFind({ refocus = true } = {}) {
    if (find.hidden) return;
    const id = findFor;
    find.hidden = true;
    findFor = null;
    if (id) void engine.stopFind(id);
    onLayout();
    if (refocus && id) focusPage(id);
  }
  function renderFindCount(tab) {
    const result = tab?.find;
    if (!findInput.value) { findCount.textContent = ''; findCount.classList.remove('none'); return; }
    const matches = result?.matches ?? 0;
    findCount.textContent = result ? `${matches ? result.active : 0}/${matches}` : '';
    findCount.classList.toggle('none', !!result && matches === 0);
  }
  let findTyping = null;
  findInput.addEventListener('input', () => {
    clearTimeout(findTyping);
    findTyping = setTimeout(() => { if (findFor) void engine.find(findFor, findInput.value); }, 80);
  });
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (findFor && findInput.value) void engine.find(findFor, findInput.value, { forward: !event.shiftKey, findNext: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  findUp.addEventListener('click', () => { if (findFor && findInput.value) void engine.find(findFor, findInput.value, { forward: false, findNext: true }); });
  findDown.addEventListener('click', () => { if (findFor && findInput.value) void engine.find(findFor, findInput.value, { forward: true, findNext: true }); });
  findClose.addEventListener('click', () => closeFind());

  // Downloads
  function statusOf(item) {
    if (item.state === 'progressing') {
      const done = item.total ? `${bytes(item.received)} of ${bytes(item.total)}` : bytes(item.received);
      return item.paused ? `Paused — ${done}` : done;
    }
    if (item.state === 'completed') return `Done — ${bytes(item.total || item.received)}`;
    if (item.state === 'cancelled') return 'Cancelled';
    return 'Failed';
  }
  function renderDownloads() {
    if (downloads.hidden) return;
    const list = engine.downloads();
    if (!list.length) {
      downloadsList.replaceChildren(h('div', { class: 'br-empty', style: { padding: '6px 8px 10px' }, text: 'Files you download show here.' }));
    } else {
      downloadsList.replaceChildren(...list.map(item => {
        const actions = h('div', { class: 'br-download-actions' });
        const action = (label, name, primary = false) => {
          const button = h('button', { class: `br-button small${primary ? ' primary' : ''}`, text: label });
          const run = () => {
            engine.downloadAction(item.id, name).catch(error => {
              button.textContent = error.message.length > 40 ? 'Can’t' : error.message;
              button.disabled = true;
            });
          };
          // Open appears when a download finishes, which a page can time: guarded from then.
          if (name === 'open') guardedClick(openGuards.get(item.id), button, run);
          else button.addEventListener('click', run);
          actions.append(button);
        };
        if (item.state === 'completed' && item.openable && !openGuards.has(item.id)) {
          const guard = createGuard();
          guard.arm();
          openGuards.set(item.id, guard);
        }
        if (item.state === 'completed') {
          if (item.openable) action('Open', 'open', true);
          action('Show in folder', 'show', !item.openable);
        }
        if (item.state === 'progressing') {
          action(item.paused ? 'Resume' : 'Pause', item.paused ? 'resume' : 'pause');
          action('Cancel', 'cancel');
        }
        action(item.state === 'progressing' ? 'Cancel and remove' : 'Remove from list', 'remove');
        const fraction = item.total ? Math.min(1, item.received / item.total) : 0;
        return h('div', { class: 'br-download', dataset: { download: item.id } },
          h('span', { class: 'br-download-icon' }, icon('file')),
          h('div', { class: 'br-download-body' },
            h('div', { class: 'br-download-name', text: item.name, title: item.path || item.name }),
            h('div', { class: `br-download-status${item.state === 'interrupted' ? ' failed' : ''}`, text: `${statusOf(item)}${item.private ? ' · private tab' : ''}` }),
            item.state === 'progressing' ? h('div', { class: 'br-download-bar' }, h('div', { style: { width: `${Math.round(fraction * 100)}%` } })) : null,
            item.state === 'completed' && !item.openable ? h('div', { class: 'br-prompt-note', style: { margin: '5px 0 0' }, text: 'Only documents, pictures, music, videos and archives open from here: use Show in folder.' }) : null,
            actions));
      }));
    }
    for (const id of [...openGuards.keys()]) if (!list.some(item => item.id === id)) openGuards.delete(id);
    placeDownloads();
  }
  function placeDownloads() {
    if (!downloadsAnchor) return;
    const anchor = downloadsAnchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    Object.assign(downloads.style, { right: `${Math.max(8, box.right - anchor.right)}px`, top: `${anchor.bottom - box.top + 6}px` });
  }
  function toggleDownloads(anchor) {
    if (!downloads.hidden) { closeDownloads(); return; }
    downloadsAnchor = anchor;
    downloads.hidden = false;
    renderDownloads();
    onLayout();
  }
  function closeDownloads() {
    if (downloads.hidden) return;
    downloads.hidden = true;
    onLayout();
  }
  // A click elsewhere in the panel closes it; so does one on the page (the
  // frame loses focus to it) or elsewhere in Atmos.
  document.addEventListener('pointerdown', event => {
    if (!downloads.hidden && !downloads.contains(event.target) && !downloadsAnchor?.contains(event.target)) closeDownloads();
  }, true);
  window.addEventListener('blur', () => closeDownloads());

  function render(tab) {
    renderPermission(tab);
    renderExternal(tab);
    renderNotice(tab);
    if (!permission.hidden) placeLeft(permission);
    if (!external.hidden) placeLeft(external, permission.hidden ? 0 : permission.offsetHeight + 8);
    if (!notice.hidden) placeLeft(notice, (permission.hidden ? 0 : permission.offsetHeight + 8) + (external.hidden ? 0 : external.offsetHeight + 8));
    if (findFor && (tab?.id !== findFor || tab?.kind !== 'page')) closeFind({ refocus: false });
    if (!find.hidden) { placeRight(find); renderFindCount(tab); }
    if (!downloads.hidden) placeDownloads();
    onLayout();
  }

  return {
    render,
    renderDownloads,
    openFind,
    closeFind,
    toggleDownloads,
    closeDownloads,
    findFor: () => findFor,
    renderFindCount,
  };
}

/**
 * What the panel draws over the page: a site's permission question,
 * another program's link, a refusal notice, find in page, and downloads.
 * Each is marked data-over, so the panel tells Core to keep the frame there
 * (the page shows through everywhere else).
 */
import { h, icon, bytes, takeFocus } from './dom.js';
import { siteName } from '../address.js';
import { PERMISSION_ICONS, PERMISSION_WORDS } from './icons.js';

const NOTICE_MS = 7000;

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
    block.addEventListener('click', () => { void engine.answerPermission(tab.id, request.requestId, false); });
    allow.addEventListener('click', () => { void engine.answerPermission(tab.id, request.requestId, true); });
    close.addEventListener('click', () => { void engine.dismissPermission(tab.id, request.requestId); });
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
    external.replaceChildren(
      h('div', { class: 'br-prompt-title' }, 'Open this link with another program?'),
      h('div', { class: 'br-prompt-note' }, `${siteName(tab.url) || 'This page'} wants to open a ${request.scheme}: link:`, h('br'), shown),
      h('div', { class: 'br-prompt-buttons' }, cancel, open));
    cancel.addEventListener('click', () => { void engine.answerExternal(tab.id, false); });
    open.addEventListener('click', () => { void engine.answerExternal(tab.id, true); });
    external.hidden = false;
  }

  function renderNotice(tab) {
    const text = tab?.notice?.text;
    if (!text) { notice.hidden = true; noticeFor = null; clearTimeout(noticeTimer); return; }
    if (noticeFor === `${tab.id} ${text}` && !notice.hidden) return;
    noticeFor = `${tab.id} ${text}`;
    const close = h('button', { class: 'br-icon-button', title: 'Close', 'aria-label': 'Close' }, icon('close'));
    notice.replaceChildren(icon('warning'), h('span', { text }), close);
    close.addEventListener('click', () => engine.dismissNotice(tab.id));
    notice.hidden = false;
    clearTimeout(noticeTimer);
    const id = tab.id;
    noticeTimer = setTimeout(() => engine.dismissNotice(id), NOTICE_MS);
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
          button.addEventListener('click', () => {
            engine.downloadAction(item.id, name).catch(error => {
              button.textContent = error.message.length > 40 ? 'Can’t' : error.message;
              button.disabled = true;
            });
          });
          actions.append(button);
        };
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
            item.state === 'completed' && !item.openable ? h('div', { class: 'br-prompt-note', style: { margin: '5px 0 0' }, text: 'Programs and scripts aren’t opened from here: use Show in folder.' }) : null,
            actions));
      }));
    }
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

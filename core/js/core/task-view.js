import {
  activatePanelPlugin,
  getActivePanelPluginId,
  listPanelPlugins,
} from './panel-registry.js';
import { previewParts } from './web-layer.js';
import { onEscape, onShortcut } from './shortcuts.js';

let _initialized = false;
let _overlay = null;
let _grid = null;
let _selectedIndex = 0;
let _returnFocus = null;
let _captureTimer = null;
let _captureInFlight = false;
const _previews = new Map();
// The switcher (Alt+`), as Windows' Alt+Tab: panels most recently shown
// first; held, it opens on the one before this and switches when Alt comes
// up. A quick tap flips between the last two without showing anything.
const REVEAL_MS = 140;
let _recent = [];
let _held = false;
let _revealTimer = null;
let _keys = null; // where the keyboard waits while the switcher is held but not shown yet

function _friendlyId(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The panels, those shown most recently first, the rest in their own order. */
function _plugins() {
  const plugins = listPanelPlugins();
  const rank = id => { const index = _recent.indexOf(id); return index === -1 ? Infinity : index; };
  return plugins.map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => rank(a.plugin.id) - rank(b.plugin.id) || a.index - b.index)
    .map(entry => entry.plugin);
}

function _noteShown(id) {
  if (!id) return;
  _recent = [id, ..._recent.filter(other => other !== id)].slice(0, 32);
}

function _isShown() {
  return _overlay?.classList.contains('open') === true;
}

/** Open: shown, or held (Alt+`) and about to be. */
function _isOpen() {
  return _isShown() || _held;
}

function _cards() {
  return [...(_grid?.querySelectorAll('.task-view-card') || [])];
}

function _select(index, { focus = true } = {}) {
  const cards = _cards();
  if (!cards.length) return;
  _selectedIndex = (index + cards.length) % cards.length;
  cards.forEach((card, cardIndex) => {
    const selected = cardIndex === _selectedIndex;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-selected', String(selected));
    card.tabIndex = selected ? 0 : -1;
  });
  const card = cards[_selectedIndex];
  card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) card.focus({ preventScroll: true });
}

function _activate(pluginId) {
  if (!pluginId) return;
  if (pluginId === getActivePanelPluginId()) { closeTaskView(); return; }
  activatePanelPlugin(pluginId);
  closeTaskView({ restoreFocus: false });
  // The keyboard goes to the panel now shown, once its frame has loaded:
  // until then it stays on Atmos's page (a frame that isn't listening yet
  // would lose Alt+` pressed again at once).
  const frame = document.querySelector('#panel-content iframe.atmos-extension-frame-panel');
  if (!frame) return;
  const give = () => { if (frame.isConnected && document.activeElement === _keys) frame.focus({ preventScroll: true }); };
  _keys.focus({ preventScroll: true });
  frame.addEventListener('load', () => setTimeout(give, 50), { once: true });
  setTimeout(give, 1500); // loaded already, or slow: either way, by then
}

function _schedulePreviewCapture(delay = 550) {
  clearTimeout(_captureTimer);
  _captureTimer = setTimeout(_captureActivePreview, delay);
}

function _previewBounds(host) {
  const hostBounds = host.getBoundingClientRect();
  const bounds = {
    left: hostBounds.left,
    top: hostBounds.top,
    right: hostBounds.right,
    bottom: hostBounds.bottom,
  };
  const sidebar = document.getElementById('settings-drawer');
  if (!document.body.classList.contains('drawer-open') || !sidebar?.classList.contains('open')) {
    return { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
  }

  const sidebarBounds = sidebar.getBoundingClientRect();
  const overlapLeft = Math.max(bounds.left, sidebarBounds.left);
  const overlapRight = Math.min(bounds.right, sidebarBounds.right);
  if (overlapRight > overlapLeft) {
    const sidebarOnLeft = sidebarBounds.left <= bounds.left;
    if (sidebarOnLeft) bounds.left = overlapRight;
    else bounds.right = overlapLeft;
  }
  return { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
}

function _image(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/**
 * Web pages (Atmos Browser) are <webview>s, which the window's own capture
 * leaves out: each one showing is captured on its own and drawn in its place.
 */
async function _withWebPages(preview, bounds) {
  let parts = [];
  try { parts = await previewParts(bounds); } catch { parts = []; }
  if (!preview || !parts.length) return preview;
  try {
    const base = await _image(preview);
    const scale = base.naturalWidth / bounds.width;
    const canvas = document.createElement('canvas');
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(base, 0, 0);
    for (const part of parts) {
      const page = await _image(part.image);
      context.drawImage(page, (part.rect.x - bounds.x) * scale, (part.rect.y - bounds.y) * scale, part.rect.width * scale, part.rect.height * scale);
    }
    return canvas.toDataURL('image/jpeg', 0.76);
  } catch {
    return preview;
  }
}

async function _captureActivePreview() {
  _captureTimer = null;
  if (_captureInFlight || _isOpen() || document.getElementById('boot-splash')) {
    _schedulePreviewCapture(700);
    return;
  }
  const pluginId = getActivePanelPluginId();
  const host = document.getElementById('media-fullscreen');
  const capture = window.atmosCore?.capturePanelPreview;
  if (!pluginId || !host || typeof capture !== 'function') return;
  const bounds = _previewBounds(host);
  if (bounds.width < 2 || bounds.height < 2) return;

  _captureInFlight = true;
  try {
    const preview = await _withWebPages(await capture({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }), bounds);
    if (preview && getActivePanelPluginId() === pluginId && !_isOpen()) {
      _previews.set(pluginId, preview);
    }
  } catch (error) {
    console.warn('[task-view] preview capture failed:', error);
  } finally {
    _captureInFlight = false;
  }
}

function _render() {
  if (!_grid) return;
  const plugins = _plugins();
  const activeId = getActivePanelPluginId();
  _grid.replaceChildren();

  plugins.forEach((plugin, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'task-view-card';
    card.dataset.pluginId = plugin.id;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-label', `${plugin.label || _friendlyId(plugin.id)}${plugin.id === activeId ? ', current plugin' : ''}`);

    const preview = document.createElement('span');
    preview.className = 'task-view-preview';
    const snapshot = _previews.get(plugin.id);
    if (snapshot) {
      const image = document.createElement('img');
      image.className = 'task-view-snapshot';
      image.src = snapshot;
      image.alt = '';
      preview.classList.add('has-snapshot');
      preview.appendChild(image);
    }
    const glyph = document.createElement('span');
    glyph.className = 'task-view-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = plugin.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8M8 12h5M8 16h7"/></svg>';
    preview.appendChild(glyph);

    const details = document.createElement('span');
    details.className = 'task-view-details';
    const copy = document.createElement('span');
    copy.className = 'task-view-copy';
    const label = document.createElement('span');
    label.className = 'task-view-label';
    label.textContent = plugin.label || _friendlyId(plugin.id);
    copy.appendChild(label);
    details.appendChild(copy);

    if (plugin.id === activeId) {
      card.classList.add('current');
      const badge = document.createElement('span');
      badge.className = 'task-view-current';
      badge.textContent = 'Showing';
      details.appendChild(badge);
      _selectedIndex = index;
    }

    card.append(preview, details);
    card.addEventListener('pointerenter', () => _select(index, { focus: false }));
    card.addEventListener('focus', () => _select(index, { focus: false }));
    card.addEventListener('click', () => _activate(plugin.id));
    _grid.appendChild(card);
  });

  _select(Math.min(_selectedIndex, Math.max(plugins.length - 1, 0)), { focus: false });
}

function _gridColumns() {
  if (!_grid) return 1;
  const cards = _cards();
  if (cards.length < 2) return 1;
  const firstTop = cards[0].offsetTop;
  const nextRowIndex = cards.findIndex(card => card.offsetTop > firstTop);
  return nextRowIndex === -1 ? cards.length : Math.max(1, nextRowIndex);
}

function _onKeydown(event) {
  if (!_isOpen()) return;
  // Esc with Alt still held lets go without switching (shortcuts.js's
  // Escape takes it without Alt).
  if (event.key === 'Escape' && event.altKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeTaskView();
    return;
  }
  // Alt+Shift+` (held): back one. (Alt+` itself is Atmos's key: shortcuts.js.)
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'Backquote') {
    event.preventDefault();
    event.stopImmediatePropagation();
    _reveal();
    _select(_selectedIndex - 1);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    _activate(_cards()[_selectedIndex]?.dataset.pluginId);
    return;
  }

  const columns = _gridColumns();
  const delta = event.key === 'ArrowLeft' ? -1
    : event.key === 'ArrowRight' ? 1
    : event.key === 'ArrowUp' ? -columns
    : event.key === 'ArrowDown' ? columns
    : event.key === 'Home' ? -_selectedIndex
    : event.key === 'End' ? _cards().length - 1 - _selectedIndex
    : 0;
  if (!delta) return;
  event.preventDefault();
  _reveal();
  _select(_selectedIndex + delta);
}

/** Alt+`: open held on the panel before this one, or move on to the next. */
function _onSwitcherKey() {
  if (_isOpen()) {
    _reveal();
    _select(_selectedIndex + 1, { focus: _isShown() });
    return;
  }
  if (!_overlay || _plugins().length === 0) return;
  _returnFocus = document.activeElement;
  _held = true;
  _render();
  _select(_cards().length > 1 ? 1 : 0, { focus: false });
  // The keyboard comes here at once (from a frame or a web page), so that
  // Alt coming up is seen.
  _keys.focus({ preventScroll: true });
  clearTimeout(_revealTimer);
  _revealTimer = setTimeout(_reveal, REVEAL_MS);
}

/** Alt came up: switch to the chosen panel (a held switcher only). */
function _commitHeld() {
  if (!_held) return;
  _activate(_cards()[_selectedIndex]?.dataset.pluginId);
}

function _reveal() {
  clearTimeout(_revealTimer);
  _revealTimer = null;
  if (!_overlay || _isShown()) return;
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('task-view-open');
  _select(_selectedIndex);
}

function openTaskView() {
  if (!_overlay || _isOpen() || _plugins().length === 0) return;
  _returnFocus = document.activeElement;
  _render();
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('task-view-open');
  requestAnimationFrame(() => _select(_selectedIndex));
}

function closeTaskView({ restoreFocus = true } = {}) {
  if (!_overlay || !_isOpen()) return;
  _held = false;
  clearTimeout(_revealTimer);
  _revealTimer = null;
  _overlay.classList.remove('open');
  _overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('task-view-open');
  if (restoreFocus && _returnFocus?.isConnected) _returnFocus.focus({ preventScroll: true });
  else if (document.activeElement === _keys) _keys.blur();
  _returnFocus = null;
}

export function initTaskView() {
  if (_initialized) return;
  _initialized = true;

  _overlay = document.createElement('div');
  _overlay.id = 'task-view';
  _overlay.setAttribute('aria-hidden', 'true');
  _overlay.innerHTML = `
    <div class="task-view-scrim" data-task-view-close></div>
    <section class="task-view-shell" role="dialog" aria-modal="true" aria-label="Plugin Task View">
      <div class="task-view-grid" role="listbox" aria-label="Installed plugin views"></div>
    </section>`;
  document.body.appendChild(_overlay);
  _grid = _overlay.querySelector('.task-view-grid');
  _overlay.querySelectorAll('[data-task-view-close]').forEach(element => {
    element.addEventListener('click', closeTaskView);
  });
  _keys = document.createElement('div');
  _keys.id = 'task-view-keys';
  _keys.tabIndex = -1;
  _keys.setAttribute('aria-hidden', 'true');
  document.body.appendChild(_keys);
  document.addEventListener('keydown', _onKeydown, true);
  onShortcut('switcher', _onSwitcherKey);
  onEscape({ priority: 80, isOpen: _isOpen, close: () => closeTaskView() });
  // Alt up: on Atmos's page (where the keyboard went), or in a web page
  // that still had it (web-layer.js, from web-host.cjs).
  document.addEventListener('keyup', event => { if (event.key === 'Alt') _commitHeld(); }, true);
  window.addEventListener('atmos:alt-up', _commitHeld);
  // Alt let go where Atmos couldn't see it: the next pointer or key says so.
  const altGone = event => { if (_held && !event.altKey) _commitHeld(); };
  document.addEventListener('pointermove', altGone, true);
  document.addEventListener('pointerdown', altGone, true);
  // Atmos's window left (Windows' own Alt+Tab): nothing switches.
  window.addEventListener('blur', () => { if (_held) closeTaskView(); });
  window.addEventListener('atmos:open-task-view', openTaskView);
  _noteShown(getActivePanelPluginId());
  window.addEventListener('atmos:active-panel-changed', () => {
    _noteShown(getActivePanelPluginId());
    if (_isOpen()) _render();
    _schedulePreviewCapture();
  });
  window.addEventListener('resize', () => _schedulePreviewCapture(800));
  // What a panel shows changed without a panel switch (a web page loaded in Atmos Browser).
  window.addEventListener('atmos:panel-content-changed', () => _schedulePreviewCapture(800));
  _schedulePreviewCapture();
}

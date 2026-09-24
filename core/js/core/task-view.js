import {
  activatePanelPlugin,
  getActivePanelPluginId,
  listPanelPlugins,
} from './panel-registry.js';

let _initialized = false;
let _overlay = null;
let _grid = null;
let _selectedIndex = 0;
let _returnFocus = null;
let _captureTimer = null;
let _captureInFlight = false;
const _previews = new Map();

function _friendlyId(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function _plugins() {
  return listPanelPlugins();
}

function _isOpen() {
  return _overlay?.classList.contains('open') === true;
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
  activatePanelPlugin(pluginId);
  closeTaskView();
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
    const preview = await capture({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
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
      badge.textContent = 'Selected';
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
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!_isOpen()) {
      openTaskView();
    } else {
      _select(_selectedIndex + (event.shiftKey ? -1 : 1));
    }
    return;
  }
  if (!_isOpen()) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeTaskView();
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
  _select(_selectedIndex + delta);
}

export function openTaskView() {
  if (!_overlay || _isOpen() || _plugins().length === 0) return;
  _returnFocus = document.activeElement;
  _render();
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('task-view-open');
  requestAnimationFrame(() => _select(_selectedIndex));
}

export function closeTaskView() {
  if (!_overlay || !_isOpen()) return;
  _overlay.classList.remove('open');
  _overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('task-view-open');
  if (_returnFocus?.isConnected) _returnFocus.focus({ preventScroll: true });
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
  document.addEventListener('keydown', _onKeydown, true);
  window.addEventListener('atmos:open-task-view', openTaskView);
  window.addEventListener('atmos:active-panel-changed', () => {
    if (_isOpen()) _render();
    _schedulePreviewCapture();
  });
  window.addEventListener('resize', () => _schedulePreviewCapture(800));
  _schedulePreviewCapture();
}

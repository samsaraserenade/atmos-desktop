/** Freeform layout: floating panel windows with title bars and resize handles. */
import { save } from '../persist.js';
import { panelState } from './panel-state.js';

let _windowSaveTimer = null;

window.addEventListener('beforeunload', () => clearTimeout(_windowSaveTimer));

const _DEFAULT_WINDOWS = Object.freeze({
  main: { x: .035, y: .055, width: .48, height: .46, z: 1 },
  'floating-2': { x: .49, y: .1, width: .47, height: .46, z: 2 },
  'floating-3': { x: .08, y: .5, width: .44, height: .44, z: 3 },
  'floating-4': { x: .53, y: .48, width: .43, height: .45, z: 4 },
});

function _windowState(sectionId) {
  const defaults = _DEFAULT_WINDOWS[sectionId] || _DEFAULT_WINDOWS.main;
  const saved = panelState.windows[sectionId] || {};
  return (panelState.windows[sectionId] = {
    x: Number.isFinite(saved.x) ? saved.x : defaults.x,
    y: Number.isFinite(saved.y) ? saved.y : defaults.y,
    width: Number.isFinite(saved.width) ? saved.width : defaults.width,
    height: Number.isFinite(saved.height) ? saved.height : defaults.height,
    z: Number.isFinite(saved.z) ? saved.z : defaults.z,
  });
}

function _applyWindowState(host, element, state) {
  const hostRect = host.getBoundingClientRect();
  if (!hostRect.width || !hostRect.height) return;
  const minWidth = Math.min(240, hostRect.width);
  const minHeight = Math.min(180, hostRect.height);
  state.width = Math.max(minWidth / hostRect.width, Math.min(1, state.width));
  state.height = Math.max(minHeight / hostRect.height, Math.min(1, state.height));
  const widthPx = state.width * hostRect.width;
  state.x = Math.max((-widthPx + 80) / hostRect.width, Math.min((hostRect.width - 80) / hostRect.width, state.x));
  state.y = Math.max(0, Math.min((hostRect.height - 28) / hostRect.height, state.y));
  element.style.left = `${state.x * 100}%`;
  element.style.top = `${state.y * 100}%`;
  element.style.width = `${state.width * 100}%`;
  element.style.height = `${state.height * 100}%`;
  element.style.zIndex = String(state.z);
}

function _raiseWindow(host, element, state) {
  const highest = Math.max(0, ...[...host.querySelectorAll('.panel-section')].map(panel => Number(panel.style.zIndex) || 0));
  state.z = highest + 1;
  element.style.zIndex = String(state.z);
  clearTimeout(_windowSaveTimer);
  _windowSaveTimer = setTimeout(save, 250);
}

/**
 * Give each freeform section a title bar, resize handle, saved geometry and
 * stacking order. `actions` supplies what the section shows and does:
 * { labelFor(sectionId), onClose(sectionId), onMaximize(sectionId) }.
 */
export function mountFreeformWindows(host, layout, actions) {
  if (layout.id !== 'freeform') return;
  host.querySelectorAll('.panel-window-titlebar, .panel-window-resizer').forEach(element => element.remove());
  document.body.classList.remove('panel-window-moving', 'panel-window-resizing');
  for (const section of layout.sections) {
    const element = [...host.querySelectorAll('.panel-section')]
      .find(panel => panel.dataset.panelSection === section.id);
    if (!element) continue;
    const state = _windowState(section.id);
    _applyWindowState(host, element, state);

    const titlebar = document.createElement('div');
    titlebar.className = 'panel-window-titlebar';
    titlebar.innerHTML = `
      <span class="panel-window-title"></span>
      <span class="panel-window-actions">
        <button type="button" class="panel-window-action panel-window-maximize" title="Open this plugin in Full mode" aria-label="Open this plugin in Full mode"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="1.5" width="9" height="9"/></svg></button>
        <button type="button" class="panel-window-action panel-window-close" title="Close this window" aria-label="Close this window">&#x2715;</button>
      </span>`;
    titlebar.querySelector('.panel-window-title').textContent = actions.labelFor(section.id) || section.label;
    element.prepend(titlebar);
    const resizer = document.createElement('div');
    resizer.className = 'panel-window-resizer';
    element.appendChild(resizer);

    const actionButtons = titlebar.querySelector('.panel-window-actions');
    actionButtons.addEventListener('pointerdown', event => event.stopPropagation());
    titlebar.querySelector('.panel-window-close').addEventListener('click', event => {
      event.stopPropagation();
      actions.onClose(section.id);
    });
    titlebar.querySelector('.panel-window-maximize').addEventListener('click', event => {
      event.stopPropagation();
      actions.onMaximize(section.id);
    });

    if (!element.dataset.freeformRaiseBound) {
      element.dataset.freeformRaiseBound = 'true';
      element.addEventListener('pointerdown', () => {
        if (panelState.layout === 'freeform') _raiseWindow(host, element, _windowState(element.dataset.panelSection));
      });
    }
    let drag = null;
    titlebar.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      _raiseWindow(host, element, state);
      titlebar.setPointerCapture(event.pointerId);
      const rect = element.getBoundingClientRect();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
      document.body.classList.add('panel-window-moving');
    });
    titlebar.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const hostRect = host.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const left = Math.max(-rect.width + 80, Math.min(hostRect.width - 80, drag.left - hostRect.left + event.clientX - drag.startX));
      const top = Math.max(0, Math.min(hostRect.height - 28, drag.top - hostRect.top + event.clientY - drag.startY));
      state.x = left / hostRect.width;
      state.y = top / hostRect.height;
      _applyWindowState(host, element, state);
    });
    const finishDrag = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      document.body.classList.remove('panel-window-moving');
      save();
    };
    titlebar.addEventListener('pointerup', finishDrag);
    titlebar.addEventListener('pointercancel', finishDrag);

    let resize = null;
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      _raiseWindow(host, element, state);
      resizer.setPointerCapture(event.pointerId);
      const rect = element.getBoundingClientRect();
      resize = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height };
      document.body.classList.add('panel-window-resizing');
    });
    resizer.addEventListener('pointermove', event => {
      if (!resize || resize.pointerId !== event.pointerId) return;
      const hostRect = host.getBoundingClientRect();
      state.width = Math.max(Math.min(240, hostRect.width), resize.width + event.clientX - resize.startX) / hostRect.width;
      state.height = Math.max(Math.min(180, hostRect.height), resize.height + event.clientY - resize.startY) / hostRect.height;
      _applyWindowState(host, element, state);
    });
    const finishResize = event => {
      if (!resize || resize.pointerId !== event.pointerId) return;
      resize = null;
      document.body.classList.remove('panel-window-resizing');
      save();
    };
    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);
  }
}

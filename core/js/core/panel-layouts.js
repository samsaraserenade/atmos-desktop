/** Tiled layouts: fitted section viewports and the draggable split handles. */
import { save } from '../persist.js';
import { panelState } from './panel-state.js';

/**
 * Wrap a section frame in a viewport sized to its real pixel box, so panels
 * get the section's actual width/height (and CSS variables for it) instead
 * of the window's.
 */
export function createFittedContent(frameEl) {
  const viewport = document.createElement('div');
  viewport.className = 'panel-plugin-viewport';
  frameEl.appendChild(viewport);
  let raf = null;
  let observer = null;

  const fit = () => {
    raf = null;
    const frameWidth = frameEl.clientWidth;
    const frameHeight = frameEl.clientHeight;
    if (!frameWidth || !frameHeight) return;
    // Give plugins the section's real viewport instead of trying to infer and
    // transform their natural canvas. Existing panel CSS already uses 100%,
    // container queries, and this legacy height variable to adapt itself.
    viewport.style.width = `${frameWidth}px`;
    viewport.style.height = `${frameHeight}px`;
    viewport.style.setProperty('--panel-content-vis-h', `${frameHeight}px`);
    viewport.style.setProperty('--panel-section-width', `${frameWidth}px`);
    viewport.style.setProperty('--panel-section-height', `${frameHeight}px`);
  };
  const scheduleFit = () => {
    if (raf === null) raf = requestAnimationFrame(fit);
  };

  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(scheduleFit);
    observer.observe(frameEl);
  }
  scheduleFit();
  return {
    element: viewport,
    dispose() {
      observer?.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    },
  };
}

const _DEFAULT_SPLITS = Object.freeze({
  columns: { x: .5 }, rows: { y: .5 },
  'right-stack': { x: .5745, y: .5 },
  'left-stack': { x: .4255, y: .5 },
  quad: { x: .5, y: .5 },
});

function _splitValue(layoutId, axis) {
  return panelState.splits[layoutId]?.[axis] ?? _DEFAULT_SPLITS[layoutId]?.[axis] ?? .5;
}

function _setSplitValue(host, layoutId, axis, ratio) {
  const rect = host.getBoundingClientRect();
  const length = axis === 'x' ? rect.width : rect.height;
  const minimumRatio = length > 0 ? Math.min(.35, 120 / length) : .15;
  const value = Math.max(minimumRatio, Math.min(1 - minimumRatio, ratio));
  panelState.splits[layoutId] ||= {};
  panelState.splits[layoutId][axis] = value;
  host.style.setProperty(`--panel-split-${axis}`, `${value * 100}%`);
}

function _mountSplitter(host, layout, axis, scope = 'full') {
  const splitter = document.createElement('div');
  splitter.className = `panel-splitter${scope === 'right' ? ' splitter-right' : scope === 'left' ? ' splitter-left' : ''}`;
  splitter.dataset.axis = axis;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  splitter.tabIndex = 0;
  let pointerId = null;

  const updateFromPointer = event => {
    if (event.pointerId !== pointerId) return;
    const rect = host.getBoundingClientRect();
    const ratio = axis === 'x'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    _setSplitValue(host, layout.id, axis, ratio);
  };
  const finish = event => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    splitter.classList.remove('dragging');
    document.body.classList.remove('panel-split-resizing', 'panel-split-resizing-x', 'panel-split-resizing-y');
    save();
  };
  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    splitter.setPointerCapture(pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('panel-split-resizing', `panel-split-resizing-${axis}`);
    updateFromPointer(event);
  });
  splitter.addEventListener('pointermove', updateFromPointer);
  splitter.addEventListener('pointerup', finish);
  splitter.addEventListener('pointercancel', finish);
  splitter.addEventListener('dblclick', () => {
    _setSplitValue(host, layout.id, axis, _DEFAULT_SPLITS[layout.id]?.[axis] ?? .5);
    save();
  });
  splitter.addEventListener('keydown', event => {
    const delta = axis === 'x'
      ? (event.key === 'ArrowLeft' ? -.02 : event.key === 'ArrowRight' ? .02 : 0)
      : (event.key === 'ArrowUp' ? -.02 : event.key === 'ArrowDown' ? .02 : 0);
    if (!delta) return;
    event.preventDefault();
    _setSplitValue(host, layout.id, axis, _splitValue(layout.id, axis) + delta);
    save();
  });
  host.appendChild(splitter);
}

/**
 * Mount the split handles for a tiled layout. `hasAssignment(sectionId)`
 * says whether a section currently shows a plugin; handles next to empty
 * sections are omitted.
 */
export function mountSplitters(host, layout, hasAssignment) {
  host.querySelectorAll?.('.panel-splitter').forEach(splitter => splitter.remove());
  host.style.removeProperty('--panel-split-x');
  host.style.removeProperty('--panel-split-y');
  const defaults = _DEFAULT_SPLITS[layout.id];
  if (!defaults) return;
  for (const axis of Object.keys(defaults)) {
    _setSplitValue(host, layout.id, axis, _splitValue(layout.id, axis));
    const visible = layout.id === 'columns' ? hasAssignment('right')
      : layout.id === 'rows' ? hasAssignment('bottom')
      : layout.id === 'right-stack' && axis === 'x' ? hasAssignment('top-right') || hasAssignment('bottom-right')
      : layout.id === 'right-stack' ? hasAssignment('top-right') && hasAssignment('bottom-right')
      : layout.id === 'left-stack' && axis === 'x' ? hasAssignment('top-left') || hasAssignment('bottom-left')
      : layout.id === 'left-stack' ? hasAssignment('top-left') && hasAssignment('bottom-left')
      : layout.id === 'quad' && axis === 'x' ? hasAssignment('top-right') || hasAssignment('bottom-right')
      : layout.id === 'quad' ? hasAssignment('bottom-left') || hasAssignment('bottom-right')
      : false;
    if (!visible) continue;
    const scope = axis === 'y' && layout.id === 'right-stack' ? 'right'
      : axis === 'y' && layout.id === 'left-stack' ? 'left'
      : 'full';
    _mountSplitter(host, layout, axis, scope);
  }
}

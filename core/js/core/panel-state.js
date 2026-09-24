/** Core-owned panel workspace state and layout catalogue. */
import { registerCoreStateNamespace } from '../persist.js';

export const PANEL_LAYOUTS = Object.freeze([
  { id: 'single', label: 'Full', sections: [{ id: 'main', label: 'Full' }] },
  { id: 'columns', label: 'Left / Right', sections: [{ id: 'main', label: 'Left' }, { id: 'right', label: 'Right' }] },
  { id: 'rows', label: 'Top / Bottom', sections: [{ id: 'main', label: 'Top' }, { id: 'bottom', label: 'Bottom' }] },
  { id: 'right-stack', label: 'Left + Right Stack', sections: [{ id: 'main', label: 'Left' }, { id: 'top-right', label: 'Top right' }, { id: 'bottom-right', label: 'Bottom right' }] },
  { id: 'left-stack', label: 'Left Stack + Right', sections: [{ id: 'top-left', label: 'Top left' }, { id: 'bottom-left', label: 'Bottom left' }, { id: 'main', label: 'Right' }] },
  { id: 'quad', label: 'Four Way', sections: [{ id: 'main', label: 'Top left' }, { id: 'top-right', label: 'Top right' }, { id: 'bottom-left', label: 'Bottom left' }, { id: 'bottom-right', label: 'Bottom right' }] },
  { id: 'freeform', label: 'Freeform', sections: [{ id: 'main', label: 'Window 1' }, { id: 'floating-2', label: 'Window 2' }, { id: 'floating-3', label: 'Window 3' }, { id: 'floating-4', label: 'Window 4' }] },
]);

export const panelState = registerCoreStateNamespace('panel', {
  version: 5,
  defaults: { activePlugin: null, layout: 'single', sections: {}, splits: {}, windows: {}, hiddenFreeform: [], drawers: {} },
  migrateLegacy(defaults, blob) {
    return { activePlugin: blob?.activePanelPlugin ?? defaults.activePlugin, layout: 'single', sections: {}, splits: {}, windows: {}, hiddenFreeform: [], drawers: {} };
  },
  hydrate(state, saved) {
    state.activePlugin = typeof saved.activePlugin === 'string' ? saved.activePlugin : null;
    state.layout = PANEL_LAYOUTS.some(layout => layout.id === saved.layout) ? saved.layout : 'single';
    state.sections = saved.sections && typeof saved.sections === 'object'
      ? Object.fromEntries(Object.entries(saved.sections).filter(([, value]) => typeof value === 'string'))
      : {};
    state.splits = saved.splits && typeof saved.splits === 'object'
      ? Object.fromEntries(Object.entries(saved.splits).map(([layout, value]) => [layout, {
          x: Number.isFinite(value?.x) ? Math.max(.15, Math.min(.85, value.x)) : undefined,
          y: Number.isFinite(value?.y) ? Math.max(.15, Math.min(.85, value.y)) : undefined,
        }]))
      : {};
    state.windows = saved.windows && typeof saved.windows === 'object'
      ? Object.fromEntries(Object.entries(saved.windows).map(([id, value]) => [id, {
          x: Number.isFinite(value?.x) ? value.x : undefined,
          y: Number.isFinite(value?.y) ? value.y : undefined,
          width: Number.isFinite(value?.width) ? value.width : undefined,
          height: Number.isFinite(value?.height) ? value.height : undefined,
          z: Number.isFinite(value?.z) ? value.z : undefined,
        }]))
      : {};
    state.hiddenFreeform = Array.isArray(saved.hiddenFreeform)
      ? saved.hiddenFreeform.filter(id => id === 'main')
      : [];
    // Drawer panels (see panel-drawer.js): where each one's drawer rests
    // (0 open – 1 bar – 2 hidden) and whether its bar is docked at the bottom.
    state.drawers = saved.drawers && typeof saved.drawers === 'object'
      ? Object.fromEntries(Object.entries(saved.drawers).map(([id, value]) => [id, {
          placement: Number.isFinite(value?.placement) ? Math.max(0, Math.min(2, value.placement)) : null,
          bar: value?.bar === 'bottom' ? 'bottom' : 'top',
        }]))
      : {};
  },
});

export function layoutDescriptor(id = panelState.layout) {
  return PANEL_LAYOUTS.find(layout => layout.id === id) || PANEL_LAYOUTS[0];
}

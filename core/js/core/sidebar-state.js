import { registerCoreStateNamespace } from '../persist.js';

export const sidebarState = registerCoreStateNamespace('sidebar', {
  version: 3,
  defaults: {
    open: false,
    order: [],
    enabled: {},
    openSections: [],
    dockedSections: [],
    topDockedSections: [],
    panelScopes: {},
    sectionHeights: {},
  },
  migrateLegacy(defaults, blob) {
    const legacy = blob?.sidebarWidgets;
    return {
      open: typeof blob?.sidebarOpen === 'boolean' ? blob.sidebarOpen : defaults.open,
      order: Array.isArray(legacy?.order) ? legacy.order : defaults.order,
      enabled: legacy?.enabled && typeof legacy.enabled === 'object' ? legacy.enabled : defaults.enabled,
      openSections: Array.isArray(legacy?.openSections) ? legacy.openSections : defaults.openSections,
      dockedSections: defaults.dockedSections,
      topDockedSections: defaults.topDockedSections,
      panelScopes: defaults.panelScopes,
      sectionHeights: defaults.sectionHeights,
    };
  },
  hydrate(state, saved) {
    state.open = !!saved.open;
    state.order = Array.isArray(saved.order) ? saved.order : [];
    state.enabled = saved.enabled && typeof saved.enabled === 'object' ? { ...saved.enabled } : {};
    state.openSections = Array.isArray(saved.openSections) ? saved.openSections : [];
    state.dockedSections = Array.isArray(saved.dockedSections) ? saved.dockedSections : [];
    state.topDockedSections = Array.isArray(saved.topDockedSections)
      ? [...new Set(saved.topDockedSections.filter(id => typeof id === 'string'))] : [];
    state.dockedSections = state.dockedSections.filter(id => !state.topDockedSections.includes(id));
    state.panelScopes = saved.panelScopes && typeof saved.panelScopes === 'object'
      // An empty list is an explicit Global, kept so a widget's default
      // panels ("showIn") don't apply over it.
      ? Object.fromEntries(Object.entries(saved.panelScopes)
        .filter(([, value]) => Array.isArray(value) || typeof value === 'string')
        .map(([id, value]) => [id, [...new Set((Array.isArray(value) ? value : [value])
          .filter(panelId => typeof panelId === 'string' && panelId.length > 0))]]))
      : {};
    state.sectionHeights = saved.sectionHeights && typeof saved.sectionHeights === 'object'
      ? Object.fromEntries(Object.entries(saved.sectionHeights).filter(([, value]) => value === 'auto' || Number.isFinite(value)))
      : {};
  },
});

import { registerCoreStateNamespace } from '../persist.js';

// Open in the sidebar on Atmos's first start: Atmos Browser's tabs (its
// first sidebar widget, plugins/browser), beside the browser Atmos opens on.
const FIRST_START_OPEN_SECTIONS = ['fin-section-browser'];

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
  // Nothing saved for the sidebar: an Atmos from before it had a namespace
  // (its fields at the top level), or Atmos's first start (nothing saved at
  // all). A first start opens the sidebar with the browser's tabs open, since
  // nothing else shows they're there; after that the sidebar is whatever the
  // person leaves it as, saved as usual. An Atmos used before keeps its own.
  migrateLegacy(defaults, blob) {
    const legacy = blob?.sidebarWidgets;
    const firstStart = !blob || Object.keys(blob).length === 0;
    return {
      open: typeof blob?.sidebarOpen === 'boolean' ? blob.sidebarOpen : firstStart || defaults.open,
      order: Array.isArray(legacy?.order) ? legacy.order : defaults.order,
      enabled: legacy?.enabled && typeof legacy.enabled === 'object' ? legacy.enabled : defaults.enabled,
      openSections: Array.isArray(legacy?.openSections) ? legacy.openSections
        : firstStart ? [...FIRST_START_OPEN_SECTIONS] : defaults.openSections,
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

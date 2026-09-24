/**
 * Panel registry: registration, activation and the workspace (which plugin
 * occupies which section of which layout). Layout mechanics live in
 * panel-layouts.js (tiles) and panel-windows.js (freeform), persisted state
 * in panel-state.js, and recent-panel cycling in panel-history.js.
 */
import { save } from '../persist.js';
import { createLifecycleScope } from './lifecycle.js';
import { PANEL_LAYOUTS, panelState, layoutDescriptor as _layoutDescriptor } from './panel-state.js';
import { createFittedContent as _createFittedContent, mountSplitters } from './panel-layouts.js';
import { mountFreeformWindows } from './panel-windows.js';
import { bindPanelHistory, liveHistory as _liveHistory, pushHistory as _pushHistory } from './panel-history.js';
import { getPanelAppearance, onAppearanceChange } from './appearance.js';

export { PANEL_LAYOUTS };

const $ = id => document.getElementById(id);

/** id -> panel descriptor. Every panel mounts into one content surface. */
const _plugins = new Map();

let _defaultId  = null; // first plugin registered — see ensureDefaultPanelPlugin()
let _activeId   = null;
let _activeLifecycle = null;
let _activeMountContentEl = null;
let _explicitDefaultId = null;
const _sectionMounts = new Map();

function _applyPanelAppearance(element, pluginId) {
  if (!element || !pluginId) return;
  const appearance = getPanelAppearance(pluginId);
  element.dataset.panelPlugin = pluginId;
  element.style.setProperty('--panel-blur', `${appearance.blur}px`);
  element.style.setProperty('--panel-opacity', (appearance.opacity / 100).toFixed(2));
}

function _syncPanelAppearance() {
  if (_activeId) _applyPanelAppearance($('panel-primary'), _activeId);
  for (const mounted of _sectionMounts.values()) {
    _applyPanelAppearance(mounted.element, mounted.pluginId);
  }
}

onAppearanceChange(_syncPanelAppearance);

window.addEventListener('beforeunload', () => save());

// Panel elements are looked up lazily (first activation), not at module-load
// time, because this module can be imported before index.html's panel host
// exists. Cached after the first lookup; they are never recreated.
let _hostEl = null, _contentEl = null;

function _panelEls() {
  if (!_contentEl) {
    _hostEl    = $('media-fullscreen');
    _contentEl = $('panel-content');
  }
  return { hostEl: _hostEl, contentEl: _contentEl };
}

function _mountPlugin(plugin, contentEl, context) {
  plugin.mount(contentEl, context);
}

function _unmountPlugin(plugin, contentEl, context) {
  if (typeof plugin?.unmount === 'function') plugin.unmount(contentEl, context);
}

/** Full window, a tile of a split layout, or a floating window. */
function _presentation(sectionId) {
  if (panelState.layout === 'freeform') return 'window';
  if (panelState.layout !== 'single') return 'tile';
  return sectionId === 'main' ? 'full' : 'tile';
}

/** A pass-through panel only takes pointer events where it draws something. */
function _syncPassThrough() {
  const { hostEl } = _panelEls();
  const plugin = _activeId ? _plugins.get(_activeId) : null;
  hostEl?.classList.toggle('panel-pass-through', panelState.layout === 'single' && !!plugin?.passThrough);
}

/**
 * Register a panel plugin. Does NOT mount it — see file header. Throws on a
 * duplicate id rather than silently overwriting a previous registration,
 * since two plugins claiming the same id is almost certainly a bug (e.g. a
 * plugin's panel.js imported twice under different paths).
 */
export function registerPanelPlugin(id, config) {
  if (_plugins.has(id)) {
    throw new Error(`panel-registry: '${id}' is already registered`);
  }
  if (typeof config?.mount !== 'function') {
    throw new Error(`panel-registry: '${id}' must provide a mount(surfaceEl, context) function`);
  }
  if (config.mount.length >= 3) {
    console.warn(`[panel-registry] '${id}' uses the removed mount(barEl, contentEl, extrasEl) signature; panels now receive mount(surfaceEl, context).`);
  }
  // Copy the descriptor so later changes by the caller cannot alter it.
  const normalized = {
    ...config,
    panelAppearance: config.panelAppearance === true,
    passThrough: config.passThrough === true,
  };
  _plugins.set(id, normalized);
  for (const legacyId of config.legacyIds || []) {
    if (panelState.activePlugin === legacyId) panelState.activePlugin = id;
  }
  if (normalized.default) {
    if (_explicitDefaultId && _explicitDefaultId !== id) {
      _plugins.delete(id);
      throw new Error(`panel-registry: default panel already declared by '${_explicitDefaultId}'`);
    }
    _explicitDefaultId = id;
    _defaultId = id;
  } else if (_defaultId === null) {
    _defaultId = id;
  }
}

/**
 * Switch the panel to plugin `id`. Idempotent — calling with the already-
 * active id is a no-op.
 *
 * A plugin's mount()/unmount() throwing is caught and logged here rather
 * than left to propagate — see file header. `id` still becomes `_activeId`
 * even if mount() throws: the switch itself (which plugin *should* own the
 * panel) succeeded, only that plugin's own rendering didn't. Leaving
 * `_activeId` on the old plugin would make a retry silently no-op (this
 * function returns early when `id === _activeId`), permanently wedging the
 * panel on a plugin whose markup was already torn down above.
 */
export function activatePanelPlugin(id, sectionId = 'main') {
  if (sectionId !== 'main') {
    assignPanelPlugin(sectionId, id);
    return;
  }
  if (id === _activeId) return;
  if (!_plugins.has(id)) {
    throw new Error(`panel-registry: '${id}' is not registered`);
  }
  for (const [otherSection, mounted] of _sectionMounts) {
    if (mounted.pluginId !== id) continue;
    _unmountSection(otherSection);
    delete panelState.sections[otherSection];
    if (panelState.layout !== 'single') _mountEmptySection(otherSection);
  }

  const { hostEl, contentEl } = _panelEls();
  if (!hostEl || !contentEl) {
    throw new Error('panel-registry: #media-fullscreen/#panel-content not found in the DOM yet');
  }

  if (_activeId !== null) _unmountPrimary();

  _pushHistory(_activeId);
  _activeId = id;
  panelState.activePlugin = id;
  panelState.sections.main = id;
  _mountPrimary();
  _syncPassThrough();

  if (panelState.layout === 'freeform') _mountFreeformWindows(hostEl, _layoutDescriptor());
  else if (panelState.layout !== 'single') _mountSplitters(hostEl, _layoutDescriptor());

  window.dispatchEvent(new CustomEvent('atmos:active-panel-changed', {
    detail: { id: _activeId },
  }));
  save();
}

function _unmountPrimary() {
  const { contentEl } = _panelEls();
  const outgoing = _plugins.get(_activeId);
  try {
    _unmountPlugin(outgoing, _activeMountContentEl || contentEl, _activeLifecycle?.context);
  } catch (err) {
    console.error(`[panel-registry] unmount() failed for '${_activeId}':`, err);
  } finally {
    _activeLifecycle?.dispose();
    _activeLifecycle = null;
    _activeMountContentEl = null;
  }
  // Clear the outgoing plugin's markup so the incoming plugin starts from an
  // empty surface.
  contentEl.innerHTML = '';
}

function _mountPrimary() {
  const { hostEl, contentEl } = _panelEls();
  const plugin = _plugins.get(_activeId);
  const fitting = panelState.layout === 'single' ? null : _createFittedContent(contentEl);
  _activeMountContentEl = fitting?.element || contentEl;
  _applyPanelAppearance($('panel-primary'), _activeId);
  _activeLifecycle = createLifecycleScope(_activeId, 'panel', {
    hostEl, surfaceEl: _activeMountContentEl, presentation: _presentation('main'),
  });
  if (fitting) _activeLifecycle.context.onCleanup(fitting.dispose);
  try {
    _mountPlugin(plugin, _activeMountContentEl, _activeLifecycle.context);
  } catch (err) {
    console.error(`[panel-registry] mount() failed for '${_activeId}':`, err);
    _activeLifecycle.dispose();
    _activeLifecycle = null;
    _activeMountContentEl = null;
  }
}

/**
 * Mount the default (first-registered) plugin if nothing is active yet.
 * This keeps app bootstrap independent of every plugin implementation.
 */
export function ensureDefaultPanelPlugin() {
  if (_activeId !== null) return;
  if (_defaultId === null) return; // nothing registered yet — caller's problem, not ours
  activatePanelPlugin(_defaultId);
}

/**
 * Hand the panel back to the default (first-registered) plugin, even if
 * something else is currently active. For plugins that temporarily take
 * over the panel and need to give it back without hardcoding a recipient —
 * same reasoning ensureDefaultPanelPlugin() already documents for the
 * bootstrap case, just callable mid-session too.
 */
export function activateDefaultPanelPlugin() {
  if (_defaultId === null) return;
  activatePanelPlugin(_defaultId);
}

export function getActivePanelPluginId() { return _activeId; }
export function getPersistedPanelPluginId() { return panelState.activePlugin; }
export function isPanelPluginRegistered(id) { return _plugins.has(id); }


function _hasAssignment(sectionId) {
  return sectionId === 'main' ? !!_activeId : !!panelState.sections[sectionId];
}

function _mountSplitters(host, layout) {
  mountSplitters(host, layout, _hasAssignment);
}

function _mountFreeformWindows(host, layout) {
  mountFreeformWindows(host, layout, {
    labelFor: sectionId => {
      const pluginId = sectionId === 'main' ? _activeId : panelState.sections[sectionId];
      return pluginId ? _plugins.get(pluginId)?.label : null;
    },
    onClose: sectionId => assignPanelPlugin(sectionId, null),
    onMaximize: sectionId => {
      const pluginId = sectionId === 'main' ? _activeId : panelState.sections[sectionId];
      if (!pluginId) return;
      if (sectionId !== 'main') assignPanelPlugin('main', pluginId);
      setPanelLayout('single');
    },
  });
}

function _unmountSection(sectionId) {
  const mounted = _sectionMounts.get(sectionId);
  if (!mounted) return;
  const plugin = _plugins.get(mounted.pluginId);
  try {
    _unmountPlugin(plugin, mounted.contentEl, mounted.lifecycle.context);
  } catch (error) {
    console.error(`[panel-registry] unmount() failed for '${mounted.pluginId}' in '${sectionId}':`, error);
  } finally {
    mounted.lifecycle.dispose();
    mounted.element.remove();
    _sectionMounts.delete(sectionId);
  }
}

function _mountSection(sectionId, pluginId) {
  const host = $('media-fullscreen');
  const plugin = _plugins.get(pluginId);
  if (!host || !plugin || sectionId === 'main') return;

  _unmountSection(sectionId);
  for (const child of host.querySelectorAll?.('.panel-section') || []) {
    if (child.dataset.panelSection === sectionId && child.id !== 'panel-primary') child.remove();
  }
  const element = document.createElement('section');
  element.className = 'panel-section';
  element.dataset.panelSection = sectionId;
  _applyPanelAppearance(element, pluginId);
  const contentFrameEl = document.createElement('div');
  contentFrameEl.className = 'panel-section-content';
  element.append(contentFrameEl);
  host.appendChild(element);

  const fitting = _createFittedContent(contentFrameEl);
  const contentEl = fitting.element;
  const lifecycle = createLifecycleScope(pluginId, `panel:${sectionId}`, {
    hostEl: element, surfaceEl: contentEl, presentation: _presentation(sectionId),
  });
  lifecycle.context.onCleanup(fitting.dispose);
  _sectionMounts.set(sectionId, { pluginId, element, contentEl, lifecycle });
  try {
    _mountPlugin(plugin, contentEl, lifecycle.context);
  } catch (error) {
    console.error(`[panel-registry] mount() failed for '${pluginId}' in '${sectionId}':`, error);
    lifecycle.dispose();
    _sectionMounts.delete(sectionId);
  }
}

function _mountEmptySection(sectionId) {
  // Empty slots remain assignable in Settings but have no workspace DOM.
  // This keeps tiled layouts visually clear and prevents freeform mode from
  // presenting placeholder windows the user never opened.
}

function _remountPrimary() {
  if (!_activeId) return;
  const { hostEl, contentEl } = _panelEls();
  if (!hostEl || !contentEl || !_plugins.has(_activeId)) return;
  _unmountPrimary();
  _mountPrimary();
}

function _rebuildWorkspace() {
  for (const sectionId of [..._sectionMounts.keys()]) _unmountSection(sectionId);
  const host = $('media-fullscreen');
  if (!host) return;
  const primary = $('panel-primary');
  primary?.querySelectorAll?.('.panel-window-titlebar, .panel-window-resizer').forEach(element => element.remove());
  if (primary) {
    primary.hidden = false;
    for (const property of ['left', 'top', 'width', 'height', 'z-index']) primary.style.removeProperty(property);
  }
  host.querySelectorAll?.('.panel-section:not(#panel-primary)').forEach(element => element.remove());
  const layout = _layoutDescriptor();
  const multi = layout.id !== 'single';
  host.dataset.panelLayout = layout.id;
  host.classList.toggle('panel-workspace', multi);
  _mountSplitters(host, layout);
  $('panel-primary')?.setAttribute('data-panel-section', 'main');
  _remountPrimary();

  if (multi) {
    const mountedPluginIds = new Set(_activeId ? [_activeId] : []);
    for (const { id } of layout.sections) {
      if (id === 'main') continue;
      const pluginId = panelState.sections[id];
      if (pluginId && _plugins.has(pluginId) && !mountedPluginIds.has(pluginId)) {
        mountedPluginIds.add(pluginId);
        _mountSection(id, pluginId);
      } else {
        if (pluginId) delete panelState.sections[id];
        _mountEmptySection(id);
      }
    }
    _mountFreeformWindows(host, layout);
    if (layout.id === 'freeform' && panelState.hiddenFreeform.includes('main')) {
      primary.hidden = true;
    }
  }
  _syncPassThrough();
}

/** Choose one of Core's non-overlapping workspace layouts. */
export function setPanelLayout(layoutId) {
  if (!PANEL_LAYOUTS.some(layout => layout.id === layoutId)) {
    throw new TypeError(`panel-registry: unknown panel layout '${layoutId}'`);
  }
  if (panelState.layout === layoutId && $('media-fullscreen')?.dataset.panelLayout === layoutId) return;
  panelState.layout = layoutId;
  _rebuildWorkspace();
  save();
}

/** Apply the persisted layout once plugins and the primary panel are mounted. */
export function restorePanelWorkspace() {
  _rebuildWorkspace();
}

export function getPanelLayout() { return panelState.layout; }

export function getPanelSections() {
  return _layoutDescriptor().sections.map(section => ({
    ...section,
    pluginId: section.id === 'main'
      ? (panelState.layout === 'freeform' && panelState.hiddenFreeform.includes('main') ? null : _activeId)
      : (panelState.sections[section.id] ?? null),
  }));
}

/** Assign a plugin to a visible section. A plugin can occupy one section at a time. */
export function assignPanelPlugin(sectionId, pluginId) {
  const section = _layoutDescriptor().sections.find(candidate => candidate.id === sectionId);
  if (!section) throw new Error(`panel-registry: section '${sectionId}' is not in the active layout`);
  if (pluginId !== null && !_plugins.has(pluginId)) throw new Error(`panel-registry: '${pluginId}' is not registered`);
  if (sectionId === 'main') {
    if (pluginId === null) {
      if (panelState.layout !== 'freeform') throw new Error('panel-registry: the primary section cannot be empty');
      panelState.hiddenFreeform = ['main'];
      _rebuildWorkspace();
      save();
      return;
    }
    panelState.hiddenFreeform = [];
    const outgoingPrimary = _activeId;
    let vacatedSection = null;
    for (const [otherSection, mounted] of _sectionMounts) {
      if (mounted.pluginId === pluginId) {
        vacatedSection = otherSection;
        _unmountSection(otherSection);
        delete panelState.sections[otherSection];
      }
    }
    activatePanelPlugin(pluginId);
    if (vacatedSection && outgoingPrimary && outgoingPrimary !== pluginId) {
      panelState.sections[vacatedSection] = outgoingPrimary;
    }
    _rebuildWorkspace();
    save();
    return;
  }

  for (const [otherSection, assigned] of Object.entries(panelState.sections)) {
    if (otherSection !== sectionId && assigned === pluginId) {
      delete panelState.sections[otherSection];
      _unmountSection(otherSection);
      if (_layoutDescriptor().sections.some(candidate => candidate.id === otherSection)) {
        _mountEmptySection(otherSection);
      }
    }
  }
  if (pluginId === _activeId) {
    const currentSectionPlugin = panelState.sections[sectionId];
    const replacement = currentSectionPlugin && currentSectionPlugin !== pluginId
      ? currentSectionPlugin
      : [..._plugins.keys()].find(id => id !== pluginId && !Object.values(panelState.sections).includes(id));
    if (!replacement) throw new Error('panel-registry: the primary plugin cannot also occupy another section');
    activatePanelPlugin(replacement);
  }
  if (pluginId === null) {
    delete panelState.sections[sectionId];
    if (panelState.layout !== 'freeform') {
      _unmountSection(sectionId);
      _mountEmptySection(sectionId);
    }
  } else {
    panelState.sections[sectionId] = pluginId;
    // Freeform is rebuilt once below so its title bar, saved geometry, and
    // stacking state stay coherent. Mounting here first only created a full
    // plugin lifecycle that was immediately torn down again.
    if (panelState.layout !== 'freeform') _mountSection(sectionId, pluginId);
  }
  if (panelState.layout === 'freeform') _rebuildWorkspace();
  else {
    const host = $('media-fullscreen');
    if (host) _mountSplitters(host, _layoutDescriptor());
  }
  save();
}

export function getPreviousPanelPluginId() { return _liveHistory()[0] ?? null; }

/**
 * Swap to whichever plugin was active immediately before the current one.
 * This is what makes back-and-forth toggling work with a single verb: each
 * call routes through activatePanelPlugin(), which itself pushes whatever
 * was active going in onto the front of _history — so the plugin you just
 * left becomes the new front of the stack, ready for the next call to
 * bounce straight back to it.
 *
 * A no-op if nothing has been switched yet this session (_history still
 * empty) or if every entry in it has since been unregistered — same
 * "unregistered id" case activatePanelPlugin() itself already throws on, so
 * that path is left to it rather than duplicated here.
 */
export function activatePreviousPanelPlugin() {
  const id = _liveHistory()[0];
  if (id === undefined) return;
  activatePanelPlugin(id);
}

/** For the future switcher UI (icon/label per registered plugin). */
export function listPanelPlugins() {
  return [..._plugins.entries()].map(([id, { icon, label, panelAppearance, passThrough, default: isDefault }]) => ({
    id, icon, label, panelAppearance, passThrough, default: !!isDefault,
  }));
}

bindPanelHistory({
  isRegistered: id => _plugins.has(id),
  ids: () => [..._plugins.keys()],
  activeId: () => _activeId,
  activate: id => activatePanelPlugin(id),
});



import { createLifecycleScope } from './lifecycle.js';

const _entries = new Map(); // id -> { icon, label, category, mount(bodyEl) }
const _mounted = new Map(); // id -> { bodyEl, scope }

/**
 * Register a settings panel. Does NOT mount it — see file header. Throws on
 * a duplicate id rather than silently overwriting a previous registration,
 * same reasoning the other three registries give.
 */
export function registerSettingsPanel(id, def) {
  if (_entries.has(id)) {
    throw new Error(`settings-registry: '${id}' is already registered`);
  }
  if (typeof def?.mount !== 'function') {
    throw new Error(`settings-registry: '${id}' must provide a mount(bodyEl) function`);
  }
  _entries.set(id, def);
}

/** For the plugin manager's row list — id + display metadata only. */
export function listSettingsPanels() {
  return [..._entries.entries()]
    .map(([id, { icon, label, category, order }]) => ({ id, icon, label, category, order: order ?? 0 }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Mount `id`'s settings UI into `bodyEl`. A plugin's mount() throwing is
 * caught and logged here rather than left to propagate — same reasoning
 * sidebar-registry.js's _mount() and panel-registry.js's activatePanelPlugin()
 * already give: one broken plugin's settings UI shouldn't take the whole
 * overlay down.
 */
export function mountSettingsPanel(id, bodyEl) {
  const def = _entries.get(id);
  if (!def) return;
  if (_mounted.get(id)?.bodyEl === bodyEl) return _mounted.get(id).scope.context;
  unmountSettingsPanel(id);
  const scope = createLifecycleScope(id, 'settings', { bodyEl });
  _mounted.set(id, { bodyEl, scope });
  try {
    def.mount(bodyEl, scope.context);
  } catch (err) {
    console.error(`[settings-registry] mount() failed for '${id}':`, err);
    scope.dispose();
    _mounted.delete(id);
  }
  return scope.context;
}

export function unmountSettingsPanel(id) {
  const mounted = _mounted.get(id);
  if (!mounted) return;
  const def = _entries.get(id);
  try { def?.unmount?.(mounted.bodyEl, mounted.scope.context); }
  catch (error) { console.error(`[settings-registry] unmount() failed for '${id}':`, error); }
  finally { mounted.scope.dispose(); _mounted.delete(id); }
}

export function unregisterSettingsPanel(id) {
  unmountSettingsPanel(id);
  _entries.delete(id);
}

export function isSettingsPanelRegistered(id) { return _entries.has(id); }

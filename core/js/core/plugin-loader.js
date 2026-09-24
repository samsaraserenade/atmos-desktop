

import { checkExtensionCompatibility } from './capabilities.js';

let _cache = null;
const _reportedIncompatible = new Set();

/**
 * Ask the main process what's in %appdata%/atmos/plugins. Cached for the
 * life of the page — plugin folders aren't expected to change while the
 * app is running, only between launches (see main.js's plugins:list
 * handler, which does the actual fs.readdirSync()).
 */
async function _listPlugins() {
  if (_cache) return _cache;
  try {
    _cache = (await window.atmosCore?.listPlugins?.()) ?? [];
  } catch (err) {
    console.warn('[plugin-loader] failed to list plugins:', err.message);
    _cache = [];
  }
  return _cache;
}

async function _compatiblePlugins() {
  const plugins = await _listPlugins();
  return plugins.filter(plugin => {
    // active is false when the extension is off this session or not trusted
    // (pending approval, changed, blocked or tampered); main.js won't serve it.
    if (plugin.enabled === false || plugin.active === false) return false;
    // Framed extensions never load into the Atmos page; extension-frame-host.js runs them.
    if (plugin.runtime === 'frame') return false;
    if (plugin.manifest?.invalid) {
      if (!_reportedIncompatible.has(plugin.id)) console.warn(`[plugin-loader] '${plugin.id}' skipped: invalid extension.json`);
      _reportedIncompatible.add(plugin.id);
      return false;
    }
    const result = checkExtensionCompatibility(plugin.manifest || {}, `plugin '${plugin.id}'`);
    if (!result.compatible) {
      if (!_reportedIncompatible.has(plugin.id)) console.warn(`[plugin-loader] '${plugin.id}' skipped: ${result.reasons.join('; ')}`);
      _reportedIncompatible.add(plugin.id);
    }
    return result.compatible;
  });
}

/** Every installed plugin folder (enabled or not), from the session cache. */
export async function listInstalledPlugins() {
  return [...await _listPlugins()];
}

function _toPluginUrl(pluginId, file) {
  // Plugins live outside the app's own bundle/module graph (in userData,
  // not alongside app.js), so a relative import() specifier can't reach
  // them. A raw file:// URL doesn't work either — Chromium's ES module
  // loader blocks dynamic import() across file:// directory boundaries,
  // which is what produced the uniform "Failed to fetch dynamically
  // imported module" failures across every plugin/file. Instead, route
  // through the atmos-plugin:// scheme main.js registers and serves
  // (see _registerAtmosPluginProtocol), which reads the file straight out
  // of %appdata%/atmos/plugins/<id>/<file> and returns it as a same-origin
  // resource the module loader will accept.
  return `atmos-plugin://${pluginId}/${encodeURIComponent(file)}`;
}


export async function getPluginFileUrl(pluginId, filename) {
  const plugins = await _compatiblePlugins();
  const plugin = plugins.find(p => p.id === pluginId);
  if (!plugin || !plugin.files.includes(filename)) return null;
  return _toPluginUrl(plugin.id, filename);
}

async function _importIfPresent(plugin, filename, label) {
  if (!plugin.files.includes(filename)) return null;
  try {
    return await import(_toPluginUrl(plugin.id, filename));
  } catch (err) {
    console.warn(`[plugin-loader] '${plugin.id}' ${label} failed to load:`, err.message);
    return null;
  }
}

/**
 * Import every plugin's sidebar.js, plus any *-sidebar.js files, purely
 * for their registerSection() side effects. Replaces the hand-maintained
 * import list that used to live in js/plugins/index.js.
 */
export async function loadPluginSidebars() {
  const plugins = await _compatiblePlugins();
  await Promise.all(plugins.map(async plugin => {
    await _importIfPresent(plugin, 'sidebar.js', 'sidebar section');
    const extras = plugin.files.filter(f => f !== 'sidebar.js' && f.endsWith('-sidebar.js'));
    await Promise.all(extras.map(file => _importIfPresent(plugin, file, `${file} sidebar section`)));
  }));
}

/**
 * Import every plugin's settings.js, purely for its
 * registerSettingsPanel() side effect. Replaces the hand-maintained import
 * list that used to live in js/plugins/settings-index.js.
 */
export async function loadPluginSettings() {
  const plugins = await _compatiblePlugins();
  await Promise.all(plugins.map(plugin => _importIfPresent(plugin, 'settings.js', 'settings panel')));
}


export async function loadPluginPersist() {
  const plugins = await _compatiblePlugins();
  // Legacy persisters may still hydrate flat shared state. Preserve their
  // deterministic discovery order until they migrate to state namespaces.
  for (const plugin of plugins) await _importIfPresent(plugin, 'persist.js', 'persist registration');
}

/**
 * Import every plugin's panel.js, then its boot.js, in discovery order —
 * sequentially, not in parallel, for the same reason app.js's old
 * loadPanelPlugins() was sequential: panel-registry.js's "first plugin
 * registered becomes the default" needs a deterministic order across
 * plugins, and boot.js often depends on that same plugin's panel.js having
 * already registered. Replaces the hand-maintained per-plugin await pairs
 * that used to live in app.js's loadPanelPlugins().
 */
export async function loadPluginPanelsAndBoot() {
  const plugins = await _compatiblePlugins();
  for (const plugin of plugins) {
    await _importIfPresent(plugin, 'panel.js', 'panel plugin');
    await _importIfPresent(plugin, 'boot.js', 'boot hook');
  }
}

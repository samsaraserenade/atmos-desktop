/** Versioned, feature-based renderer contract for plugins and services. */

// 4 is SDK 1.0 (keep in step with extension-host.cjs, which also checks
// "engines.atmos" against this Atmos's version before anything loads).
export const CORE_API_VERSION = 4;

const _capabilities = new Map(Object.entries({
  'extensions.manifest':      1,
  'events.namespaced':        1,
  'lifecycle.context':        1,
  'renderer.capabilities':    1,
  'surface.workspace':        1,
  'context-menu.contributions': 1,
  'state.namespaced':         1,
  'settings.appearance-contributions': 1,
  'extensions.frames': 3, // the SDK level before SDK 1.0 (2: listen, shortcut; 3: menus, notifications, wallpaper, audio, drawers, boot keys…)
}));

export function hasCapability(name, minimumVersion = 1) {
  return (_capabilities.get(name) ?? 0) >= minimumVersion;
}

export function listCapabilities() {
  return Object.fromEntries(_capabilities);
}

function _requirements(manifest = {}) {
  if (Array.isArray(manifest.requires)) return manifest.requires.map(name => [name, 1]);
  if (manifest.requires && typeof manifest.requires === 'object') {
    return Object.entries(manifest.requires)
      .filter(([, required]) => required !== false)
      .map(([name, version]) => [name, Number.isFinite(version) ? version : 1]);
  }
  return [];
}

/** Missing manifests are legacy-compatible; declared requirements are strict. */
export function checkExtensionCompatibility(manifest = {}, label = 'extension') {
  const reasons = [];
  if (manifest.apiVersion !== undefined && !Number.isFinite(manifest.apiVersion)) {
    reasons.push('apiVersion must be a number');
  }
  if (Number.isFinite(manifest.apiVersion) && manifest.apiVersion > CORE_API_VERSION) {
    reasons.push(`requires core API ${manifest.apiVersion}, current API is ${CORE_API_VERSION}`);
  }
  for (const [name, version] of _requirements(manifest)) {
    if (!hasCapability(name, version)) reasons.push(`requires capability '${name}' v${version}`);
  }
  return { compatible: reasons.length === 0, label, reasons };
}

/**
 * Discovers renderer-facing services installed in
 * %AppData%/atmos/services. Services mirror plugins: each service owns a
 * folder and may expose sidebar.js and/or settings.js registration entries.
 * Functional modules are addressed through getServiceFileUrl().
 */

import { checkExtensionCompatibility } from './capabilities.js';

let _cache = null;
const _reportedIncompatible = new Set();

async function _listServices() {
  if (_cache) return _cache;
  try {
    _cache = (await window.atmosCore?.listServices?.()) ?? [];
  } catch (err) {
    console.warn('[service-loader] failed to list services:', err.message);
    _cache = [];
  }
  return _cache;
}

async function _compatibleServices() {
  const services = await _listServices();
  return services.filter(service => {
    // active is false when the extension is off this session or not trusted
    // (pending approval, changed, blocked or tampered); main.js won't serve it.
    if (service.enabled === false || service.active === false) return false;
    // Framed extensions never load into the Atmos page; extension-frame-host.js runs them.
    if (service.runtime === 'frame') return false;
    if (service.manifest?.invalid) {
      if (!_reportedIncompatible.has(service.id)) console.warn(`[service-loader] '${service.id}' skipped: invalid extension.json`);
      _reportedIncompatible.add(service.id);
      return false;
    }
    const result = checkExtensionCompatibility(service.manifest || {}, `service '${service.id}'`);
    if (!result.compatible && !_reportedIncompatible.has(service.id)) {
      console.warn(`[service-loader] '${service.id}' skipped: ${result.reasons.join('; ')}`);
      _reportedIncompatible.add(service.id);
    }
    return result.compatible;
  });
}

/** Every installed service folder (enabled or not), from the session cache. */
export async function listInstalledServices() {
  return [...await _listServices()];
}

function _toServiceUrl(serviceId, file) {
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  return `atmos-service://${serviceId}/${encodedPath}`;
}

export async function getServiceFileUrl(serviceId, filename) {
  const services = await _compatibleServices();
  const service = services.find(item => item.id === serviceId);
  if (!service || !service.files.includes(filename)) return null;
  return _toServiceUrl(service.id, filename);
}

async function _importIfPresent(service, filename, label) {
  if (!service.files.includes(filename)) return null;
  // A library has no entry points: its modules are only ever imported by
  // consumers (getServiceFileUrl / atmos.library), never run by Core.
  if (service.manifest?.library === true) return null;
  try {
    return await import(_toServiceUrl(service.id, filename));
  } catch (err) {
    console.warn(`[service-loader] '${service.id}' ${label} failed to load:`, err.message);
    return null;
  }
}

export async function loadServiceSidebars() {
  const services = await _compatibleServices();
  await Promise.all(services.map(service => _importIfPresent(service, 'sidebar.js', 'sidebar')));
}

export async function loadServiceSettings() {
  const services = await _compatibleServices();
  await Promise.all(services.map(service => _importIfPresent(service, 'settings.js', 'settings')));
}

/**
 * A service's boot.js registers its boot hook (registerBootHook) and, like a
 * plugin's, runs with the other boot hooks once the workspace is up: the
 * background layer's Wallpaper and Audio services start this way.
 */
export async function loadServiceBoot() {
  const services = await _compatibleServices();
  for (const service of services) await _importIfPresent(service, 'boot.js', 'boot hook');
}

export async function loadServicePersist() {
  const services = await _compatibleServices();
  for (const service of services) await _importIfPresent(service, 'persist.js', 'persistence');
}

/**
 * What the main process lists as installed (plugins:list / services:list),
 * cached for the session: discovery happens once at startup, and most
 * changes apply at the next start (a community extension approved while
 * Atmos runs loads at once, and clears the cache). Settings, the frame host and first-run setup read
 * it; nothing here runs extension code. Framed extensions are started by
 * extension-frame-host.js, the system services by system-services.js.
 */

let _plugins = null;
let _services = null;

async function _list(method, label) {
  try {
    return (await window.atmosCore?.[method]?.()) ?? [];
  } catch (error) {
    console.warn(`[extensions] failed to list ${label}:`, error.message);
    return [];
  }
}

/** Every plugin Atmos found (on or off, trusted or not), from the session cache. */
export async function listInstalledPlugins() {
  _plugins ??= _list('listPlugins', 'plugins');
  return [...await _plugins];
}

/** Every service Atmos found, the system services included, from the session cache. */
export async function listInstalledServices() {
  _services ??= _list('listServices', 'services');
  return [...await _services];
}

/** Read the lists again on next use (an approved extension started loading). */
export function forgetInstalledLists() {
  _plugins = null;
  _services = null;
}

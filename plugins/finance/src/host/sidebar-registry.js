/**
 * Stands in for Atmos Core's sidebar-registry.js inside Finance's frames.
 * registerSection() records each widget's definition; each widget frame
 * (frame-widget-*.js) mounts the one it is for.
 */
const _sections = new Map();
export function registerSection(id, def) { _sections.set(id, def); }
export function unregisterSection(id) { _sections.delete(id); }
export function getRegisteredSection(id) { return _sections.get(id) ?? null; }

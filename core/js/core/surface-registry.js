/** Generic full-window renderer surfaces owned and lifecycle-managed by Core. */

import { createLifecycleScope } from './lifecycle.js';

const entries = new Map();
const LAYERS = Object.freeze({
  'workspace-background': { zIndex: 0, pointerEvents: 'none' },
  'workspace-overlay':    { zIndex: 900, pointerEvents: 'none' },
});

function mount(id, def) {
  const layer = LAYERS[def.layer];
  if (!layer) throw new Error(`surface-registry: unsupported layer '${def.layer}'`);
  const host = document.createElement('div');
  host.dataset.atmosSurface = id;
  host.dataset.atmosSurfaceLayer = def.layer;
  Object.assign(host.style, {
    position: 'fixed', inset: '0', overflow: 'hidden',
    zIndex: String(layer.zIndex), pointerEvents: layer.pointerEvents,
  });
  document.body.prepend(host);
  const scope = createLifecycleScope(id, 'surface', { hostEl: host, layer: def.layer });
  entries.set(id, { def, host, scope });
  try { def.mount(host, scope.context); }
  catch (error) {
    console.error(`[surface-registry] mount() failed for '${id}':`, error);
    scope.dispose();
    host.remove();
    entries.delete(id);
  }
}

export function registerSurface(id, def) {
  if (!id || entries.has(id)) throw new Error(`surface-registry: invalid or duplicate id '${id}'`);
  if (typeof def?.mount !== 'function') throw new Error(`surface-registry: '${id}' must provide mount(host, context)`);
  mount(id, def);
  return () => unregisterSurface(id);
}

export function unregisterSurface(id) {
  const entry = entries.get(id);
  if (!entry) return;
  try { entry.def.unmount?.(entry.host, entry.scope.context); }
  catch (error) { console.error(`[surface-registry] unmount() failed for '${id}':`, error); }
  finally {
    entry.scope.dispose();
    entry.host.remove();
    entries.delete(id);
  }
}

export function listSurfaces() {
  return [...entries.entries()].map(([id, { def }]) => ({ id, layer: def.layer }));
}

window.addEventListener('beforeunload', () => {
  for (const id of [...entries.keys()]) unregisterSurface(id);
});

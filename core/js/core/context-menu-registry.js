/** Extension contribution registry for Core's workspace context menu. */

const entries = new Map();

export function registerContextMenuItem(id, def) {
  if (!id || entries.has(id)) throw new Error(`context-menu-registry: invalid or duplicate id '${id}'`);
  if (!def?.label || typeof def?.run !== 'function') {
    throw new Error(`context-menu-registry: '${id}' requires label and run()`);
  }
  entries.set(id, def);
  return () => entries.delete(id);
}

export function listContextMenuItems() {
  return [...entries.entries()]
    .map(([id, def]) => ({ id, ...def }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}



import { createLifecycleScope } from './lifecycle.js';

const _hooks = new Map(); // id -> { order, run }
const _scopes = new Map();
const _started = new Set();

/**
 * Register a boot hook. Does NOT run it — see file header. Throws on a
 * duplicate id rather than silently overwriting a previous registration,
 * same reasoning panel-registry.js's registerPanelPlugin() gives.
 */
export function registerBootHook(id, def) {
  if (_hooks.has(id)) {
    throw new Error(`boot-registry: '${id}' is already registered`);
  }
  if (typeof def?.run !== 'function') {
    throw new Error(`boot-registry: '${id}' must provide a run(ctx) function`);
  }
  _hooks.set(id, def);
}

/**
 * Run every registered boot hook once, sequentially, in ascending `order`
 * (ties broken by registration order — Map preserves insertion order, and
 * Array#sort is stable). A hook that throws or rejects is logged and
 * skipped; it does not stop the rest of startup.
 */
export async function runBootHooks(ctx) {
  const ordered = [..._hooks.entries()].sort(
    (a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)
  );
  for (const [id, def] of ordered) {
    if (_started.has(id)) continue;
    _started.add(id);
    const inherited = ctx && typeof ctx === 'object' ? ctx : {};
    const scope = createLifecycleScope(id, 'boot', { ...inherited, app: ctx });
    _scopes.set(id, scope);
    try {
      await def.run(scope.context);
    } catch (err) {
      console.error(`[boot-registry] boot hook '${id}' failed:`, err);
      scope.dispose();
      _scopes.delete(id);
    }
  }
}

window.addEventListener('beforeunload', () => {
  for (const scope of _scopes.values()) scope.dispose();
  _scopes.clear();
});

export function isBootHookRegistered(id) { return _hooks.has(id); }

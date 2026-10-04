'use strict';
/**
 * Who may call an extension's main.cjs IPC handlers. extension-host.cjs asks
 * `authorize` before every handler runs. Moved out of main.js so it can be
 * unit-tested (invoke-authorizer.test.cjs); main.js gives it what it reads:
 *
 *   fromAtmosPage(event)  whether the sender is the Atmos page itself (ipc-gate.cjs)
 *   entryOf(ref)          the catalog entry for "plugin:<id>" / "service:<id>", or null
 *   isActive(entry)       whether it loads this session
 *   trustOf(entry)        its trust record ({ permissions: { invokes }, exports }), or null
 *
 * An extension reaches another's IPC handlers, events, exposed methods and
 * resource providers only when it declares it in "permissions.invokes" and
 * the other lists them in "exports" for its tier (extension-permissions.cjs).
 */
const { reachOf: permittedReach, reaches } = require('./extension-permissions.cjs');

const NONE = Object.freeze({ ipc: Object.freeze([]), events: Object.freeze([]), methods: Object.freeze([]) });

function createInvokeAuthorizer({ fromAtmosPage, entryOf, isActive, trustOf }) {
  /** What `entry` may use of the extension `targetRef`: { ipc, events, methods }, or null for itself. */
  function reachOf(entry, targetRef) {
    const target = entryOf(targetRef);
    if (!target) return { ipc: [], events: [], methods: [] };
    return permittedReach(
      { kind: entry.kind, id: entry.id, tier: entry.tier, invokes: trustOf(entry)?.permissions.invokes || [] },
      { kind: target.kind, id: target.id, exports: trustOf(target)?.exports },
    ) || null;
  }

  /**
   * Checked before every main.cjs IPC handler runs. Only the Atmos page
   * (never a frame) can call, and only on behalf of a framed extension
   * (`caller`, stamped by Core's bridge): the page's own code never invokes
   * a main.cjs handler. Returns a refusal, or null.
   */
  function authorize(event, caller, { kind, id, name }) {
    if (!fromAtmosPage(event)) return 'Not allowed';
    if (typeof caller !== 'string') return 'Not allowed';
    const target = `${kind}:${id}`;
    if (caller === target) return null;
    const entry = entryOf(caller);
    if (!entry || !isActive(entry)) return `${caller} is not running`;
    if (!(trustOf(entry)?.permissions.invokes || []).includes(target)) return `${caller} is not permitted to invoke ${target}`;
    const reach = reachOf(entry, target) || NONE;
    if (!reaches(reach.ipc, name)) return `${target} doesn't share its '${name}' handler with ${entry.tier === 'third-party' ? 'community' : 'other'} extensions`;
    return null;
  }

  return { authorize, reachOf };
}

module.exports = { createInvokeAuthorizer };

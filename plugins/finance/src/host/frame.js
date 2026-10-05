/**
 * Finance's link to Atmos (ATMOS_CORE_INTEGRATION.md § 19).
 *
 * Finance runs in sandboxed frames:
 *
 *   frame-engine.js          background, all session: reads the VPS, polls
 *                            watchlist prices and exchange rates, and
 *                            publishes them (src/host/mirror.js)
 *   frame-panel.js           the Finance panel (portfolio and markets charts)
 *   frame-widget-*.js        the six sidebar widgets
 *
 * The panel and widgets run Finance's ordinary modules in a view role: they
 * mirror what the engine publishes instead of fetching it themselves, and
 * share settings through Atmos state (src/host/persist.js). The modules
 * under src/host/ stand in for the Atmos Core modules Finance used when it
 * ran in the Atmos page, so the rest of Finance keeps its shape.
 */

import atmos from 'atmos-sdk';

export { atmos };
export const SELF = 'plugin:finance';

/** 'engine', 'panel', or 'widget:<id>'. Set by the entry file before anything else loads. */
export let role = 'engine';
export function setRole(value) { role = value; }
export const isEngine = () => role === 'engine';

/** Finance's own main process (main.cjs). */
export const invokeFinance = (channel, ...args) => atmos.invoke(SELF, channel, ...args);

/** One lifecycle for the whole document: a frame lives as long as its surface. */
export function createContext() {
  const controller = new AbortController();
  const cleanups = [];
  window.addEventListener('pagehide', () => {
    controller.abort();
    for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch (error) { console.error(error); } }
  }, { once: true });
  return {
    signal: controller.signal,
    listen(target, type, fn, options = {}) {
      target.addEventListener(type, fn, { ...options, signal: controller.signal });
    },
    onCleanup(fn) { cleanups.push(fn); },
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      cleanups.push(() => clearInterval(id));
      return id;
    },
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      cleanups.push(() => clearTimeout(id));
      return id;
    },
  };
}

const ACTIONS_KEPT = 10;
const ACTION_EXPIRES_MS = 60_000;
let lastStamp = 0;

const LATER_EXPIRES_MS = 24 * 60 * 60_000;

/** A request still to do: a minute at most; one for whenever the panel next shows, a day. */
const current = (item, now) => item && Number(item.at) > now - (item.later === true ? LATER_EXPIRES_MS : ACTION_EXPIRES_MS);

/**
 * Ask the panel to do something (open a symbol's chart, say), opening it if
 * needed. Kept in state so a panel that is only just starting still sees
 * it, in a short queue so requests made one after another (rev/ commands
 * in a row) are all done, in order. With `show: false` (a command run
 * "here", Alt+Enter) the panel isn't opened: a panel showing does it now,
 * else the panel does it whenever it next shows (within a day), in the
 * order asked, so it ends as the same commands run at once would.
 */
export async function requestPanelAction(action, { show = true } = {}) {
  // Each request's own stamp, later than the last (two in one millisecond).
  const at = lastStamp = Math.max(Date.now(), lastStamp + 1);
  const saved = await atmos.state.get().catch(() => null);
  const queued = (Array.isArray(saved?.pendingActions) ? saved.pendingActions : []).filter(item => current(item, at));
  const entry = show ? { ...action, at } : { ...action, at, later: true };
  await atmos.state.update({ pendingActions: [...queued, entry].slice(-ACTIONS_KEPT), pendingAction: null });
  if (show) await atmos.panel.show().catch(() => {});
}

/**
 * Panel side of requestPanelAction(): runs each request once, in the order
 * asked, one finishing before the next starts (`run` may return a promise).
 */
export function handlePanelActions(run) {
  // Each request run, by its stamp (not "everything up to the latest": one
  // stamped earlier in another frame can arrive later).
  const ran = new Map();
  let queue = Promise.resolve();
  const check = async saved => {
    const now = Date.now();
    // Forgotten once it's off the queue a while (a request put back by
    // another frame's write must not run twice).
    const queued = new Set((Array.isArray(saved?.pendingActions) ? saved.pendingActions : []).map(item => Number(item?.at)));
    for (const [at, when] of ran) if (when < now - ACTION_EXPIRES_MS && !queued.has(at)) ran.delete(at);
    const pending = (Array.isArray(saved?.pendingActions) ? saved.pendingActions : [])
      .filter(item => current(item, now) && !ran.has(Number(item.at)))
      .sort((a, b) => a.at - b.at);
    if (!pending.length) return;
    for (const item of pending) ran.set(Number(item.at), now);
    // Taken off the queue (what was added meanwhile stays). Two frames
    // writing the queue in the same moment can still lose one request.
    const latest = await atmos.state.get().catch(() => null);
    const left = (Array.isArray(latest?.pendingActions) ? latest.pendingActions : []).filter(item => !ran.has(Number(item?.at)));
    await atmos.state.update({ pendingActions: left });
    for (const action of pending) {
      queue = queue.then(() => run(action)).catch(error => console.warn('[finance] a panel request failed:', error?.message || error));
    }
  };
  atmos.state.get().then(check);
  return atmos.state.onChange(check);
}

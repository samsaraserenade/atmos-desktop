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

/**
 * Ask the panel to do something (open a symbol's chart, say), opening it if
 * needed. Kept in state so a panel that is only just starting still sees it.
 */
export async function requestPanelAction(action) {
  await atmos.state.update({ pendingAction: { ...action, at: Date.now() } });
  await atmos.panel.show().catch(() => {});
}

/** Panel side of requestPanelAction(): runs each request once. */
export function handlePanelActions(run) {
  let last = 0;
  const check = async saved => {
    const pending = saved?.pendingAction;
    if (!pending || !(pending.at > last)) return;
    last = pending.at;
    await atmos.state.update({ pendingAction: null });
    run(pending);
  };
  atmos.state.get().then(check);
  return atmos.state.onChange(check);
}

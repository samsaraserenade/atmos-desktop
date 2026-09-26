/**
 * Finance's background frame, alive for the whole session: reads the VPS,
 * polls watchlist prices and exchange rates, and publishes them to the
 * panel and widgets (src/host/mirror.js). The first time Finance runs in
 * frames it also copies what the in-page Finance saved (src/host/persist.js).
 */
import { atmos, createContext, setRole } from './src/host/frame.js';

setRole('engine');

let settled;
const settingsReady = new Promise(resolve => { settled = resolve; });
let started;
const engineReady = new Promise(resolve => { started = resolve; });

// Exposed first, so views asking early wait here instead of failing.
atmos.expose({
  /** Settings are in Atmos state (copied from the page if this is the first run). */
  ready: async () => { await settingsReady; return true; },
  snapshot: async () => (await engineReady).snapshot(),
  fetchTickers: async () => (await engineReady).fetchTickers(),
  /** The saved portfolio server changed (connected, switched or disconnected). */
  reconnect: async () => (await engineReady).reconnect(),
});

await import('./src/host/persist.js');
settled();
const { startEngine } = await import('./src/host/mirror.js');
started(await startEngine(createContext()));

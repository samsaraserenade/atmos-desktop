/**
 * Atmos Browser's background frame: the engine (src/engine.js), alive for
 * the whole session, so tabs stay open while the panel is switched away
 * and links from the rest of Atmos have somewhere to go. It answers the
 * browser's rev/ commands too (src/commands.js).
 *
 * The panel, the widgets and the settings page are frames on the same
 * origin, so they use the engine directly (atmos.background() →
 * window.__browserEngine; src/ui/engine-client.js).
 */
import atmos from 'atmos-sdk';
import { createEngine } from './src/engine.js';
import { handleCommands } from './src/commands.js';
import { openStore, memoryStore } from './src/store.js';
import engines from './src/search-engines.json' with { type: 'json' };

let store;
try {
  store = await openStore();
} catch (error) {
  // History and bookmarks can't be kept this session; browsing still works.
  console.warn('[browser] the browser database could not open; nothing will be kept this session:', error?.message || error);
  store = memoryStore();
}

const engine = createEngine({ atmos, store, engines });
Object.defineProperty(window, '__browserEngine', { value: engine });
await engine.ready;
// rev/new-tab, rev/tab and rev/close-tab in Atmos's command bar.
handleCommands(engine);

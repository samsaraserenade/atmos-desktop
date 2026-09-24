// Audio Player's background frame: the engine (src/engine.js), alive for
// the whole session so the queue carries on whichever panel is showing.
import { loadState, ENGINE_KEYS } from './src/state.js';
import { copyFromPage } from './src/store.js';
import { start } from './src/engine.js';

await loadState({ keep: ENGINE_KEYS });
await copyFromPage();
await start();

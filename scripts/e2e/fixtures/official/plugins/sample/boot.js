// The background frame: loads the engine and keeps its state, as an official
// plugin's would (scripts/e2e: extension-manager.cjs, official-packages.cjs).
import { start } from './engine.js';
await start();

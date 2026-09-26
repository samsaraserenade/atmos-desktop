/**
 * Stands in for Atmos Core's panel-registry.js inside Finance's frames.
 * registerPanelPlugin() records Finance's panel definition for
 * frame-panel.js to mount; showing the panel goes through the SDK.
 */
import { atmos, role } from './frame.js';

const _panels = new Map();
export function registerPanelPlugin(id, def) { _panels.set(id, def); }
export function getRegisteredPanel(id) { return _panels.get(id) ?? null; }

export function activatePanelPlugin() { atmos.panel.show().catch(() => {}); }
/** Only the panel frame knows it is showing. */
export function getActivePanelPluginId() { return role === 'panel' ? 'portfolio-tracker' : null; }
/** Closing the panel is Atmos's (the "]" shortcut toggles it). */
export function activateDefaultPanelPlugin() {}

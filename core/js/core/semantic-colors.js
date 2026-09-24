/** Core-owned semantic colors for any plugin: status, feedback, or numeric changes. */
import { registerCoreStateNamespace, scheduleSave, onStateLoaded } from '../persist.js';

export const DEFAULT_SEMANTIC_COLORS = Object.freeze({
  positive: '#34d399', negative: '#f87171', neutral: '#9ca3af',
});
const listeners = new Set();
const validHex = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const state = registerCoreStateNamespace('semantic-colors', {
  version: 1,
  defaults: DEFAULT_SEMANTIC_COLORS,
  migrateLegacy(defaults, blob) {
    // Colours saved before Core owned them (the old flat state).
    const legacy = blob;
    return {
      ...defaults,
      positive: validHex(legacy.chartLineColorUp) ? legacy.chartLineColorUp : defaults.positive,
      negative: validHex(legacy.chartLineColorDown) ? legacy.chartLineColorDown : defaults.negative,
    };
  },
  hydrate(target, saved) {
    for (const key of Object.keys(DEFAULT_SEMANTIC_COLORS)) {
      target[key] = validHex(saved[key]) ? saved[key] : DEFAULT_SEMANTIC_COLORS[key];
    }
  },
});

export function getSemanticColors() { return { ...state }; }

export function setSemanticColor(role, hex) {
  if (!Object.hasOwn(DEFAULT_SEMANTIC_COLORS, role) || !validHex(hex) || state[role] === hex) return;
  state[role] = hex;
  scheduleSave(); // colour pickers fire on every drag step
  emit();
}

export function onSemanticColorChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const [role, color] of Object.entries(state)) {
    globalThis.document?.documentElement?.style.setProperty(`--color-${role}`, color);
  }
  for (const listener of listeners) {
    try { listener(getSemanticColors()); }
    catch (error) { console.warn('[semantic-colors] listener failed:', error); }
  }
}

/** Legacy shape and names remain available to existing price-color consumers. */
export function getPriceColors() {
  return { up: state.positive, down: state.negative, neutral: state.neutral };
}
export function setPriceColorUp(hex) { setSemanticColor('positive', hex); }
export function setPriceColorDown(hex) { setSemanticColor('negative', hex); }
export function setPriceColorNeutral(hex) { setSemanticColor('neutral', hex); }
export function onPriceColorChange(listener) {
  return onSemanticColorChange(() => listener(getPriceColors()));
}

export function classifyChange(change) {
  if (change == null || change === 0 || !Number.isFinite(Number(change))) return 'flat';
  return change > 0 ? 'up' : 'down';
}

/** Explicit neutral overrides continue to work; otherwise use the shared neutral. */
export function colorForChange(change, flatColor = state.neutral) {
  const direction = classifyChange(change);
  return direction === 'up' ? state.positive : direction === 'down' ? state.negative : flatColor;
}

onStateLoaded(emit);

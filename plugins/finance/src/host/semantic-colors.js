/**
 * Stands in for Atmos Core's semantic-colors.js inside Finance's frames.
 * Atmos applies its shared colours to every frame as CSS variables
 * (--color-positive / --color-negative / --color-neutral); changing them is
 * Atmos's business (Settings → Appearance), not Finance's.
 */
import { atmos } from './frame.js';

const FALLBACK = { positive: '#34d399', negative: '#f87171', neutral: '#94a3b8' };

export function getSemanticColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(`--color-${name}`).trim() || fallback;
  return { positive: read('positive', FALLBACK.positive), negative: read('negative', FALLBACK.negative), neutral: read('neutral', FALLBACK.neutral) };
}

export function getPriceColors() {
  const { positive, negative, neutral } = getSemanticColors();
  return { up: positive, down: negative, neutral };
}

/** The SDK applies new appearance variables before calling listeners. */
export function onSemanticColorChange(listener) {
  return atmos.appearance.onChange(() => listener(getSemanticColors()));
}
export function onPriceColorChange(listener) {
  return atmos.appearance.onChange(() => listener(getPriceColors()));
}

export function classifyChange(change) {
  if (change == null || change === 0 || !Number.isFinite(Number(change))) return 'flat';
  return change > 0 ? 'up' : 'down';
}

export function colorForChange(change, flatColor = getSemanticColors().neutral) {
  const direction = classifyChange(change);
  const colors = getSemanticColors();
  return direction === 'up' ? colors.positive : direction === 'down' ? colors.negative : flatColor;
}

// Frames can't change Atmos's colours; kept so callers don't need to know.
export function setPriceColorUp() {}
export function setPriceColorDown() {}

/**
 * Private mode: hides what you hold (balances, amounts, position sizes and
 * prices you entered at, the server's address) so Finance can be shown or
 * screenshotted, and which coins: the Spot and Futures widgets show a note
 * instead of their rows, the picker has no Holdings, and Allocation's and
 * Movers' names are masked. Charts stay, but their value axis and labels
 * are masked. Market prices (the watchlist, the markets chart) are public
 * and stay.
 *
 * It's a saved setting, so every Finance frame follows it: formatters that
 * print your amounts go through here and print MASK instead.
 */
import { portfolioState } from '../persist.js';
import { onExternalStateChange, save } from './host/persist.js';

export const MASK = '••••';

export function isPrivate() { return portfolioState.privacyMode === true; }

const listeners = new Set();
let shown = null; // the mode this frame last drew

function privacyChanged() {
  if (shown === null || isPrivate() === shown) { shown = isPrivate(); return; }
  shown = isPrivate();
  for (const fn of [...listeners]) {
    try { fn(); } catch (error) { console.error('[finance] private mode listener failed:', error); }
  }
}
// Turned on or off in another Finance frame: the saved setting arrives.
onExternalStateChange(privacyChanged);

/**
 * fn() at once when private mode is turned on or off, here or in another
 * Finance frame: for what isn't redrawn with every portfolio update (a
 * chart's value labels, say), and so nothing waits for the next one.
 */
export function onPrivacyChange(fn) {
  if (shown === null) shown = isPrivate();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function setPrivacyMode(value) {
  portfolioState.privacyMode = !!value;
  save();
  privacyChanged();
  // Redraw this frame; the others redraw when the saved setting reaches them.
  const registry = await import('./registry.js');
  registry.renderExchangeList();
  registry.notifyPortfolioUpdate();
  (await import('../markets/src/watchlist-data.js')).refresh();
}

/** An Intl.NumberFormat-like { format } that prints MASK in private mode. */
export function privateFormat(numberFormat) {
  return { format: value => (isPrivate() ? MASK : numberFormat.format(value)) };
}

/** Wrap a formatting function so it returns MASK in private mode. */
export function masked(format) {
  return (...args) => (isPrivate() ? MASK : format(...args));
}

/** The Balance widget's right-click menu item. */
export function privacyMenuItem() {
  return { id: 'finance.privacy', label: 'Hide balances', checked: isPrivate(), run: () => setPrivacyMode(!isPrivate()) };
}

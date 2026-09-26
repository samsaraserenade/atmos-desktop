/**
 * Private mode: hides what you hold (balances, amounts, position sizes and
 * prices you entered at, the server's address) so Finance can be shown or
 * screenshotted. Charts stay, but their value axis and labels are masked.
 * Market prices (the watchlist, the markets chart) are public and stay.
 *
 * It's a saved setting, so every Finance frame follows it: formatters that
 * print your amounts go through here and print MASK instead.
 */
import { portfolioState } from '../persist.js';
import { save } from './host/persist.js';

export const MASK = '••••';

export function isPrivate() { return portfolioState.privacyMode === true; }

export async function setPrivacyMode(value) {
  portfolioState.privacyMode = !!value;
  save();
  // Redraw this frame; the others redraw when the saved setting reaches them.
  const registry = await import('./registry.js');
  registry.renderExchangeList();
  registry.notifyPortfolioUpdate();
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

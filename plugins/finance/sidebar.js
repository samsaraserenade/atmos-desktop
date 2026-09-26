import './markets/sidebar.js';
/**
 * js/plugins/portfolio-tracker/sidebar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers the "Portfolio Tracker" sidebar section (tweened total + mini sparkline,
 * previously a hardcoded #sd-balance-slot div sitting above the accordion
 * list in index.html). Registering it through sidebar-registry.js instead
 * puts it in the Settings → Sidebar list alongside Watchlist, Weather, Now
 * Playing, etc. — user-toggleable and drag-to-reorder like everything else.
 *
 * This module owns only the section's registration + its own stylesheet.
 * The widget's DOM/state/animation all live in balance.js — see
 * mountBalanceSection() there, which is what actually gets called by the
 * registry's mount(bodyEl).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { registerSection } from './src/host/sidebar-registry.js';
import {
  mountBalanceSection, mountPerformanceSection,
  setMiniChartVisible, setAthVisible, setMoversVisible, setFlowVisible,
  setBalanceFont, importBalanceFont, removeBalanceFont,
} from './src/balance.js';
import { portfolioState } from './persist.js';
import { mountPortfolioConnections } from './src/sidebar-settings.js';
import { initCurrencyService, currencyMenuItem } from './src/totals.js';
import { privacyMenuItem } from './src/privacy.js';
import { mountAllocationWidget } from './src/allocation-widget.js';

// Sidebar sections can mount as soon as they register, before this plugin's
// boot hook runs. Resolve the shared Currency service first so every sidebar
// mount sees fully initialized converter functions.
await initCurrencyService();

// ── Self-owned CSS, injected once at module-load time (same idempotent
// <link> guard pattern as audio-player/sidebar.js) ─────────────────────────
{
  const href = new URL('./assets/sidebar.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

function visibilityMenuItem(id, label, key, setVisible) {
  return {
    id,
    label,
    checked: portfolioState[key] !== false,
    run() {
      setVisible(portfolioState[key] === false);
    },
  };
}

function showFontError(message) {
  const note = document.createElement('p');
  note.className = 'finance-font-error';
  note.style.cssText = 'margin:6px 12px;font-size:11px;color:var(--color-negative, #f87171)';
  note.textContent = message;
  document.body.prepend(note);
  setTimeout(() => note.remove(), 6000);
}

function importFontFromMenu() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ttf,.otf,.woff,.woff2';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { id } = await importBalanceFont(file);
      setBalanceFont(id);
    } catch (error) {
      // Frames can't show alert(); say it in the widget instead.
      showFontError(error?.message || 'Font import failed');
    }
  }, { once: true });
  input.click();
}

registerSection('portfolio-balance-ticker', {
  order: -110,
  icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18M3 17l7-7 4 4 7-9"/></svg>',
  label: 'Balance',
  mount: mountBalanceSection,
  contextMenuItems: () => [
    privacyMenuItem(),
    currencyMenuItem(),
    visibilityMenuItem('finance.balance.mini-chart', 'Show mini chart', 'miniChartVisible', setMiniChartVisible),
    { id: 'finance.balance.import-font', label: 'Import font…', run: importFontFromMenu },
    ...((portfolioState.customBalanceFonts || []).some(font => font.id === portfolioState.balanceFontFamily)
      ? [{ id: 'finance.balance.remove-font', label: 'Remove imported font', run: () => removeBalanceFont(portfolioState.balanceFontFamily) }]
      : []),
  ],
});

registerSection('portfolio-balance', {
  // Lowest order among dynamic sections so it sorts first relative to
  // other registry-mounted plugins. Static sections already in index.html
  // (Portfolio Tracker, Background, Seek Bar) aren't part of this
  // ordering — if you need Balance pinned above those too, drag it to the
  // top once from the sidebar (order is persisted from there on).
  order: -100,
  icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.1-3-3L3 17.5"/></svg>',
  // Keep the stable `portfolio-balance` id so existing enabled/order state
  // survives the user-facing name being restored.
  label: 'Performance',
  contextMenuItems: () => [
    visibilityMenuItem('finance.performance.movers', 'Show movers', 'moversVisible', setMoversVisible),
    visibilityMenuItem('finance.performance.flow', 'Show deposits / market', 'flowVisible', setFlowVisible),
    visibilityMenuItem('finance.performance.ath', 'Show all-time highs / lows', 'athVisible', setAthVisible),
  ],
  // The "Chart" header button that used to live here was a second, less
  // discoverable way to do exactly what the toolbar's ticker picker's
  // pinned Portfolio row now does — removed rather than kept as a
  // redundant shortcut.
  mount(bodyEl, context) {
    mountPerformanceSection(bodyEl, context);
  },
});

registerSection('portfolio-connections', {
  order: -80,
  icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></svg>',
  label: 'Portfolio Connections',
  mount: mountPortfolioConnections,
});

registerSection('portfolio-allocation', {
  order: -70,
  icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v9h9"/></svg>',
  label: 'Allocation',
  defaultEnabled: true,
  mount: mountAllocationWidget,
});

/**
 * Finance's engine and views.
 *
 * The engine (frame-engine.js, a background frame for the whole session)
 * reads the VPS, polls watchlist prices and exchange rates, and publishes
 * what it has as the 'engine' event; frames that open later ask it for a
 * snapshot. Every other Finance frame is a view: it applies what the engine
 * publishes to the same modules (registry.js, totals.js, watchlist-data.js)
 * and renders from them exactly as before, so nothing is fetched more than
 * once however many Finance widgets are open.
 *
 * The VPS history is sent whole only to a frame that has just opened (the
 * snapshot) or after it was reloaded; otherwise each 'engine' event
 * carries only what changed since the last one (registry.js
 * exportEngineState). A view that missed a change asks for a snapshot.
 */

import { atmos, SELF } from './frame.js';
import { onExternalStateChange } from './persist.js';
import { historyScopeKey } from '../portfolio-scope.js';

const PUBLISH_DELAY_MS = 250;

/** Engine: start fetching and publishing. Returns the methods frame-engine.js exposes. */
export async function startEngine(context) {
  const registry = await import('../registry.js');
  const totals = await import('../totals.js');
  const watchlist = await import('../../markets/src/watchlist-data.js');

  await registry.initExchanges(context); // VPS and exchange rates
  watchlist.startPolling(context);

  const snapshot = sinceRevision => ({
    portfolio: registry.exportEngineState(sinceRevision),
    rates: totals.exportRates(),
    tickers: { ...watchlist.tickerData },
  });

  let queued = null;
  let sentRevision = -1;
  const publish = () => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = null;
      const payload = snapshot(sentRevision);
      sentRevision = payload.portfolio.historyRevision;
      registry.markHistoryPublished(sentRevision);
      atmos.events.emit('engine', payload).catch(error => console.warn('[finance] could not publish:', error.message));
    }, PUBLISH_DELAY_MS);
  };
  context.onCleanup(registry.onEngineChange(publish));
  context.onCleanup(watchlist.onUpdate(publish));
  // A view changed what the portfolio includes (a source or a holding hidden
  // or shown): reload the history for it. No other setting changes it.
  let scope = historyScopeKey();
  context.onCleanup(onExternalStateChange(() => {
    const next = historyScopeKey();
    if (next === scope) return;
    scope = next;
    registry.refreshRemoteHistory().catch(error => {
      console.warn('[finance] scoped history refresh failed:', error.message);
    });
  }));

  return {
    snapshot: () => snapshot(-1),
    fetchTickers: () => watchlist.fetchTickers(),
    reconnect: () => registry.reconnectPortfolio(),
  };
}

/** A view (the panel or a widget): mirror the engine, then set up what every view shares. */
export async function startView(context) {
  const registry = await import('../registry.js');
  const totals = await import('../totals.js');
  const watchlist = await import('../../markets/src/watchlist-data.js');

  await registry.initExchanges(context); // currency library; no fetching in a view

  const fetchSnapshot = () => atmos.call(SELF, 'snapshot').catch(error => {
    console.warn('[finance] engine unavailable:', error.message);
    return null;
  });
  let resyncing = false;
  const apply = payload => {
    if (!payload) return;
    totals.applyRates(payload.rates);
    if (payload.portfolio && !registry.applyEngineState(payload.portfolio) && !resyncing) {
      // This frame missed a change to the history: take all of it again.
      resyncing = true;
      fetchSnapshot().then(apply).finally(() => { resyncing = false; });
    }
    if (payload.tickers) watchlist.applyTickerData(payload.tickers);
  };
  context.onCleanup(atmos.events.on('engine', apply));
  apply(await fetchSnapshot());

  // The chart history and balance widgets are derived here from what was mirrored.
  const chart = await import('../total-chart.js');
  await chart.initTotalChart(context);
  chart.applySavedChartSettings();

  // Settings another Finance frame changed: redraw from them.
  context.onCleanup(onExternalStateChange(() => {
    totals.syncOutputCurrency();
    registry.renderExchangeList();
    registry.notifyPortfolioUpdate();
    watchlist.refresh();
    chart.applySavedChartSettings();
  }));
}

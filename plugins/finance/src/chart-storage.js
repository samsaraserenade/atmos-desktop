/**
 * Finance's storage for the Charting library (chart preferences and each
 * chart's view). Charting keeps nothing itself; the consumer hands it a
 * store (services/charting/storage.js). Same localStorage keys Charting
 * used before it became a library, so saved settings carry over.
 */
const PREFIX = 'atmos:';

export const financeChartStorage = {
  get: key => { try { return localStorage.getItem(PREFIX + key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(PREFIX + key, value); } catch { /* quota: keep in memory */ } },
};

/** Point a loaded Charting api.js at Finance's storage. */
export function useFinanceChartStorage(charting) {
  charting.configureChartStorage?.(financeChartStorage);
  return charting;
}

/**
 * Stable renderer API for the Atmos charting service.
 * Resolve with getServiceFileUrl('charting', 'api.js').
 */
export { createTimeSeriesChart } from './chart-next.js';
export { CHART_CONTROL_STYLES, CHART_INTERVALS, CHART_RANGES, chartControlMarkup } from './toolbar.js';
export { setToolbarIcon, setChartTypeIcons } from './toolbar-icons.js';
export { parseIntervalMs, formatIntervalMs, bindIntervalInput } from './intervals.js';
export { areaPath, nearestSampleTime, clipToDomain, downsampleSeries } from './series.js';
export { createChartViewport, computeAxisTicks, computePriceScale, niceNumber } from './viewport.js';
export {
  bucketHistory,
  computeCandleScale,
  heikenAshi,
  heikenAshiStep,
  pickBucketMs,
  renderCandlesSVG,
  renderCandlesCanvas,
} from './candlesticks.js';
export {
  buildSamsaraStudy,
  dema,
  ema,
  hma,
  mergedUtcSession,
  movingAverage,
  renderSamsaraOverlaySVG,
  renderSamsaraOverlayCanvas,
  rsi,
  SAMSARA_DEFAULTS,
  sma,
  wma,
} from './indicators.js';
export { smoothValues, smoothingAlpha } from './smoothing.js';
export { lineColorForTrend } from './colors.js';
export { CHART_SETTINGS_DEFAULTS, getChartSettings, setChartSettings, onChartSettingsChange } from './preferences.js';
export { configureChartStorage } from './storage.js';

export const CHARTING_API_VERSION = 2;
export const CHART_TYPES = Object.freeze(['line', 'candlestick', 'heiken-ashi']);

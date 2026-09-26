import { getServiceFileUrl } from './host/service-loader.js';
import { useFinanceChartStorage } from './chart-storage.js';

const apiUrl = await getServiceFileUrl('charting', 'api.js');
if (!apiUrl) throw new Error("Portfolio Tracker requires the enabled 'charting' service.");

const charting = useFinanceChartStorage(await import(apiUrl));

export const {
  CHART_CONTROL_STYLES, CHART_INTERVALS, CHART_RANGES, chartControlMarkup,
  parseIntervalMs, formatIntervalMs, bindIntervalInput,
  areaPath, nearestSampleTime, clipToDomain, downsampleSeries,
  setToolbarIcon, setChartTypeIcons,
  createTimeSeriesChart,
  createChartViewport,
  computeAxisTicks,
  computePriceScale,
  bucketHistory,
  computeCandleScale,
  heikenAshi,
  heikenAshiStep,
  pickBucketMs,
  renderCandlesSVG,
  SAMSARA_DEFAULTS,
  buildSamsaraStudy,
  dema,
  ema,
  hma,
  mergedUtcSession,
  movingAverage,
  renderSamsaraOverlaySVG,
  rsi,
  sma,
  wma,
  smoothValues,
  smoothingAlpha,
  lineColorForTrend,
  getChartSettings,
  setChartSettings,
  onChartSettingsChange,
} = charting;

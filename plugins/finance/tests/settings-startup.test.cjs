const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const persist = readFileSync(`${__dirname}/../persist.js`, 'utf8');
const chart = readFileSync(`${__dirname}/../src/total-chart.js`, 'utf8');
const sidebar = readFileSync(`${__dirname}/../src/sidebar-settings.js`, 'utf8');

assert.doesNotMatch(sidebar, />[XY]-AXIS|vis-(?:time|price)-axis/,
  'axis visibility controls must live in the chart toolbar, not settings');

// Framed Finance reapplies saved chart settings in every view at start-up
// and after another Finance frame changed them (src/host/mirror.js).
const startupApplications = [
  'setChartSmoothing(portfolioState.chartSmoothing)',
  'setChartLineOpacity(portfolioState.chartLineOpacity / 100)',
  'setPriceTagVisible(portfolioState.priceTagVisible)',
  'publishSharedSettings()',
];
const applySaved = chart.slice(chart.indexOf('export function applySavedChartSettings'), chart.indexOf('export function setTotalChartVisible'));
for (const application of startupApplications) {
  assert.ok(applySaved.includes(application), `startup must apply persisted setting: ${application}`);
}
for (const samsara of ['samsaraOverlayEnabled', 'samsaraMaEnabled', 'samsaraMaOpacity', 'samsaraRsiEnabled', 'samsaraSessionsEnabled', 'samsaraCandleColoringEnabled', 'samsaraCandleColorBasis']) {
  assert.ok(chart.slice(chart.indexOf('function publishSharedSettings')).includes(`portfolioState.${samsara}`), `Samsara setting published from saved state: ${samsara}`);
}
const mirror = readFileSync(`${__dirname}/../src/host/mirror.js`, 'utf8');
assert.equal((mirror.match(/applySavedChartSettings\(\)/g) || []).length, 2, 'applied at start-up and after other frames change settings');

assert.match(
  persist,
  /registerStateNamespace\('portfolio-tracker'/,
  'settings must use the plugin state namespace',
);
assert.match(persist, /serialize\(namespace\)/,
  'the complete Portfolio Tracker namespace must be serialized explicitly');
assert.match(persist, /outputCurrency: 'GBP'/,
  'the display currency is Finance state, not the Currency service\'s');
assert.match(sidebar, /export function indicatorContextMenuItems\(\)/,
  'indicator controls must read current persisted state whenever the chart menu opens');
assert.doesNotMatch(persist, /allocationMonotone:/, 'obsolete palette preference is no longer persisted');
for (const flag of ['samsaraOverlayEnabled', 'samsaraMaEnabled', 'samsaraRsiEnabled', 'samsaraSessionsEnabled', 'samsaraCandleColoringEnabled', 'cashInvestedPaneVisible']) {
  assert.match(persist, new RegExp(`${flag}: false`), `the chart starts with no indicators: ${flag}`);
  assert.match(persist, new RegExp(`INDICATOR_FIELDS = \\[[^\\]]*'${flag}'`), `saved "on" from version 1 is dropped once: ${flag}`);
}
assert.doesNotMatch(persist, /chartBgOpacity/, 'panel opacity is owned by Core appearance settings');
assert.doesNotMatch(sidebar + chart, /setChartOpacity|Background Opacity|chartBgOpacity/,
  'Portfolio must not retain a duplicate panel-opacity control');
assert.doesNotMatch(persist, /balanceChangeRange/,
  'simultaneous performance cards must not retain obsolete selector state');
assert.doesNotMatch(sidebar, /tc-allocation-monotone|setAllocationMonotone/, 'allocation is always monotone');
assert.doesNotMatch(sidebar, /mountPortfolioVisualOptions|portfolio-visual-options/,
  'axis controls moved to the chart toolbar must not retain a duplicate settings section');
assert.match(chart, /setChartSettings/,
  'reusable chart settings must be published to the shared charting service');

assert.match(
  chart,
  /restoreRuntimeSettings\(\);/,
  'boot-time chart initialization must replay restored runtime settings',
);
assert.match(
  chart,
  /onStateLoaded\(restoreRuntimeSettings\)/,
  'late namespace hydration must also replay settings into the live chart',
);
assert.match(
  chart,
  /function updateLegacyChartSetting[\s\S]*?saveState\(\)/,
  'every chart-settings update must reach the shared persistence layer',
);

console.log('Passed: all persisted portfolio settings are reapplied during plugin startup');

const balance = readFileSync(`${__dirname}/../src/balance.js`, 'utf8');
assert.match(balance, /const _miniSmoothingLvl = 75;/);
assert.match(balance, /const _balanceAnimMs = 60_000;/);
assert.doesNotMatch(chart, /saved\.miniSmoothing|saved\.balanceAnimMs/);
assert.doesNotMatch(sidebar, /mini-chart-smoothing|tc-balance-anim-ms/);

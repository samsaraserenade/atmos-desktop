const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/../src/sidebar-settings.js`, 'utf8').replace(/\r\n/g, '\n');
const state = {
  cashInvestedPaneVisible: true, samsaraOverlayEnabled: true, samsaraMaEnabled: true,
  samsaraMa1Enabled: true, samsaraMa2Enabled: false, samsaraMa3Enabled: false,
  samsaraMa4Enabled: false, samsaraMa5Enabled: true, samsaraMaOpacity: 58,
  samsaraRsiEnabled: true, samsaraSessionsEnabled: true,
  samsaraCandleColoringEnabled: true, samsaraCandleColorBasis: 'session',
};
const calls = [];
const globals = { portfolioState: state, renderExchangeList() {} };
for (const name of source.match(/set[A-Z]\w+/g) || []) globals[name] = (...args) => calls.push([name, ...args]);
const sandbox = vm.createContext(globals);
vm.runInContext(source.replace(/^import[\s\S]*?;\n/gm, '').replaceAll('export function', 'function'), sandbox);

const items = sandbox.indicatorContextMenuItems();
const overlay = items.find(item => item.id === 'finance.samsara-overlay');
assert.equal(overlay.checked, true, 'enabled indicator toggles are ticked (Atmos draws the tick)');
assert.equal(items.find(item => item.id === 'finance.samsara-ma-2').checked, false,
  'disabled indicator toggles are not ticked');
overlay.run();
assert.deepEqual(calls.pop(), ['setSamsaraOverlayEnabled', false]);
const opacity = items.find(item => item.id === 'finance.samsara-ma-opacity');
assert.equal(opacity.type, 'select'); assert.equal(opacity.value, '58'); opacity.run('80');
assert.deepEqual(calls.pop(), ['setSamsaraMaOpacity', 80]);
const basis = items.find(item => item.id === 'finance.samsara-candle-basis');
assert.equal(basis.type, 'select'); assert.ok(basis.options.some(option => option.value === 'consensus'));
assert.doesNotMatch(source, /mountIndicatorOptions|mountChartOptions|mountPortfolioVisualOptions/,
  'retired indicator and axis settings panels stay removed');
console.log('Passed: chart indicator context menu uses semantic toggles and shared setters');

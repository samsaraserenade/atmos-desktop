const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const script = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^import .*?;\r?\n/gm, '').replaceAll('export ', '');
const source = script('src/legacy-holdings.js') + script('src/portfolio-sections.js');
const portfolios = new Map();
const excluded = new Set();
const context = vm.createContext({
  portfolios,
  getAllPortfolios: () => portfolios,
  getExchanges: () => [],
  isHoldingIncluded: (sourceId, holding) => !excluded.has(`${sourceId}|${holding.id || `${holding.symbol}:${holding.kind || 'invested'}`}`),
  isGroupIncluded: () => true,
  isSourceIncluded: () => true,
  holdingScopeGroup: (sourceId, holding) => holding?.meta?.group || context.legacyGroup(sourceId, holding),
  scopedPortfolioData: (data, sourceId) => {
    if (!Array.isArray(data?.holdings)) return data;
    const holdings = data.holdings.filter(holding => context.isHoldingIncluded(sourceId, holding));
    const excludedValue = data.holdings.filter(holding => !context.isHoldingIncluded(sourceId, holding)).reduce((sum, holding) => sum + (Number(holding.value) || 0), 0);
    return { ...data, value: Math.max(0, Number(data.value) - excludedValue), holdings, spot: null, perp: null };
  },
});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);
run("var convert = (v, currency) => currency === 'GBP' ? v : v * .8;");
const cash = (value, instrument) => ({ symbol: 'USDC', kind: 'cash', value, currency: 'USD', meta: instrument ? { instrument } : null });
const open = { value: 1000, currency: 'USD', lastUpdate: 1, holdings: [cash(700, 'perp-cash'), { symbol: 'BTC Perp', value: 300, meta: { instrument: 'perp' } }] };
portfolios.set('hyperliquid', open);
assert.equal(run("splitPortfolio(portfolios.get('hyperliquid'), 'hyperliquid', convert).perp"), 800);
portfolios.set('hyperliquid', { ...open, holdings: [cash(1000)] });
assert.equal(run("splitPortfolio(portfolios.get('hyperliquid'), 'hyperliquid', convert).perp"), 800, 'closing the last position retains idle wallet funds in Perp');
portfolios.set('hyperliquid', { ...open, holdings: [cash(800, 'perp-cash'), cash(200, 'spot')] });
assert.equal(run("splitPortfolio(portfolios.get('hyperliquid'), 'hyperliquid', convert).spot"), 160, 'explicit spot funds stay in Spot');
portfolios.set('binance-spot', { value: 500, currency: 'USD', lastUpdate: 1, holdings: [cash(500)] });
assert.equal(run("splitPortfolio(portfolios.get('binance-spot'), 'binance-spot', convert).perp"), 0);
assert.equal(run("splitPortfolio({value: 50}, 'unknown', convert).spot"), null, 'missing breakdown is not fabricated');

let totals = fs.readFileSync(path.join(root, 'src/totals.js'), 'utf8')
  .replace(/^import .*?;\r?\n/gm, '').replace(/export \{[^}]*\};/g, '').replaceAll('export ', '');
vm.runInContext(totals, context);
run("convertToGbp = convert; convertFromGbp = v => v / .8; getOutputCurrency = () => 'USD'; symbolForIso = () => '$'; ratesReady = () => true;");
assert.equal(run('getFuturesSourceTotal()'), 800);
assert.equal(run('getPortfolioComposition().cash'), 700);
assert.equal(run('getTotal().value'), 1500);
assert.equal(run('getFuturesSourceTotal() + getPortfolioComposition().total'), 1500);
portfolios.set('hyperliquid', open);
excluded.add('hyperliquid|USDC:cash');
assert.equal(run('getTotal().value'), 800, 'excluded holding is removed from the live total');
assert.equal(run('getFuturesSourceTotal()'), 300, 'excluded collateral is removed from Perps');
excluded.clear();
portfolios.set('hyperliquid', { ...open, holdings: [cash(1000, 'perp-cash'), { symbol: 'BTC Perp', value: 0, meta: { instrument: 'perp', side: 'long', positionValue: 500 } }] });
assert.equal(run('getFuturesPositions().length'), 1, 'open cross-margin positions remain visible at zero local equity');
assert.equal(run('getFuturesPositions()[0].value'), 0);
assert.equal(run('getFuturesDirectionSplit().long'), 500, 'direction split falls back to non-zero notional exposure');
portfolios.set('hyperliquid', { ...open, holdings: [cash(1000)] });
assert.equal(run('getFuturesSourceTotal()'), 1000);
assert.equal(run('getPortfolioComposition().cash'), 500);
assert.equal(run("compositionFromHoldingsSnapshot([{source_id:'hyperliquid',kind:'cash',symbol:'USDC',value:1000,currency:'USD'}]).cash"), 0);

const chartSource = fs.readFileSync(path.join(root, 'src/total-chart.js'), 'utf8');
const selector = chartSource.slice(chartSource.indexOf('function selectSectionHistory()'), chartSource.indexOf('function syncSectionButtons()'));
vm.runInContext("var section='spot', history=[], remoteSections=[], totalHistory=[{t:1,g:100,v:125,spot:60,perp:40},{t:2,g:150,v:187.5}];", context);
vm.runInContext(selector, context);
run('selectSectionHistory()');
assert.equal(run('history.length'), 1);
assert.equal(run('history[0].v'), 75);
run("section='perp';selectSectionHistory()");
assert.equal(run('history[0].v'), 50);
run("section='total';selectSectionHistory()");
assert.equal(run('history === totalHistory'), true);
const sidebar = fs.readFileSync(path.join(root, 'markets/sidebar.js'), 'utf8');
// The Futures widget's balance rows, against a tiny stand-in for the DOM.
vm.runInContext(`
  var element = tag => { const node = { tag, dataset: {}, children: [], textContent: '', className: '',
    classList: { set: new Set(), toggle(name, on) { on ? this.set.add(name) : this.set.delete(name); }, contains(name) { return this.set.has(name); } },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    querySelector(selector) { return this.children.find(child => selector === '.' + child.className); } }; return node; };
  var document = { createElement: element };
  var futuresBalancesEl = Object.assign(element('div'), { isConnected: true });
  var _lastFuturesBalancesKey = null;
  var formatHoldingValue = v => String(v);`, context);
vm.runInContext(sidebar.slice(sidebar.indexOf('function updateFuturesTotal('), sidebar.indexOf('function openFuturesBalanceMenu(')), context);
const rows = () => JSON.parse(run('JSON.stringify(futuresBalancesEl.children.map(row => [row.dataset.futuresSource, row.dataset.futuresGroup, row.children[0].textContent, row.children[1].textContent]))'));
portfolios.clear();
const hl = holdings => ({ label: 'HL', value: holdings.reduce((sum, h) => sum + h.value, 0), currency: 'GBP', lastUpdate: 1, holdings });
portfolios.set('hyperliquid-wallet', hl([
  { symbol: 'USDC', kind: 'cash', value: 1000, currency: 'GBP', meta: { instrument: 'perp-cash', group: 'perp' } },
  { symbol: 'USDC Earn', kind: 'cash', value: 250, currency: 'GBP', meta: { instrument: 'perp-cash', account: 'earn', group: 'earn' } },
  { symbol: 'HYPE', value: 90, currency: 'GBP', meta: { instrument: 'spot' } },
]));
run('updateFuturesTotal()');
assert.deepEqual(rows(), [['hyperliquid-wallet', 'perp', 'Perp Balance', '1250'], ['hyperliquid-wallet', 'earn', 'Earn Balance', '312.5']],
  'a row per group; idle collateral is the Perp balance, Earn is its own, spot tokens are neither');
portfolios.set('hyperliquid-wallet', hl([
  { symbol: 'USDC', kind: 'cash', value: 1000, currency: 'GBP', meta: { instrument: 'perp-cash' } },
  { symbol: 'USDC Earn', kind: 'cash', value: 250, currency: 'GBP', meta: { instrument: 'perp-cash', account: 'earn' } },
]));
run('updateFuturesTotal()');
assert.deepEqual(rows().map(row => row[1]), ['perp', 'earn'], 'a server before 0.8 (no meta.group) still gets both rows');
portfolios.set('hyperliquid:alt', { ...hl([{ symbol: 'USDC', kind: 'cash', value: 5, currency: 'GBP', meta: { instrument: 'perp-cash', group: 'perp' } }]), label: 'Alt' });
run('updateFuturesTotal()');
assert.deepEqual(rows().map(row => row[2]), ['Perp Balance · HL', 'Earn Balance · HL', 'Perp Balance · Alt'], 'two accounts say whose each balance is');
console.log('Passed: section histories, currency conversion, mixed accounts, and idle perp cash');

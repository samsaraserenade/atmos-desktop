const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../markets/panel.js`,'utf8');
const start=source.indexOf('  const isolated = mountOptions.isolated');
const end=source.indexOf('  context.onCleanup(() => { queryGeneration++; });',start);
const code=source.slice(start,end);
let globalWrites=[],localWrites=[];
const base={persistChartSettings:value=>globalWrites.push(value),rememberQuery:value=>globalWrites.push(value)};
const isolated=vm.createContext({...base,mountOptions:{isolated:true,onSettings:value=>localWrites.push(value),onQuery:value=>localWrites.push(value)}});
vm.runInContext(code+"persistSettings({interval:'1h'});remember('ETHUSDT');",isolated);
assert.equal(globalWrites.length,0);
assert.equal(localWrites.length,2);
const primary=vm.createContext({...base,mountOptions:{}});
vm.runInContext(code+"persistSettings({interval:'5m'});remember('BTCUSDT');",primary);
assert.equal(globalWrites.length,2);
assert.match(source,/if \(!isolated\) context.onCleanup\(onMarketQuery/);
assert.match(source,/generation !== queryGeneration \|\| context.signal\?\.aborted/);
const panel=fs.readFileSync(`${__dirname}/../panel.js`,'utf8');
assert.match(panel,/toolbar.append\(layoutPicker\)/);
assert.doesNotMatch(panel,/const indicatorButton|className = 'finance-indicators-button'/);
assert.match(panel,/openMenu\(event\.clientX, event\.clientY, indicatorContextMenuItems\(\)/);
assert.match(panel,/closest\('\[data-axis-x\], \[data-axis-y\]'\)/);
assert.doesNotMatch(panel,/settingsButton|finance-chart-settings/);
assert.match(panel,/extraContexts.forEach\(item => item.dispose\(\)\)/);
assert.match(panel,/generation !== layoutGeneration \|\| context.signal\?\.aborted/);
assert.match(panel,/querySelectorAll\('\.finance-chart-stage, \.finance-extra-body'\)/);
assert.match(panel,/finance:refresh-chart-sizing/);
assert.match(panel,/installAltChartSync\(grid, context\)/);
console.log('Passed: extra charts keep query/settings independent and dispose stale work');

const altSync=fs.readFileSync(`${__dirname}/../src/alt-chart-sync.js`,'utf8');
assert.match(altSync,/if \(!event\.altKey \|\| relayed\.has\(event\)\) return/);
for (const action of ['click', 'wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
  assert.match(altSync, new RegExp(`context\\.listen\\(grid, '${action}'`));
assert.match(altSync,/peersFor\(sourceRoot\)/);
assert.match(altSync,/matchingControl\(peer, control\)/);
assert.match(altSync,/mappedPoint\(event, sourcePlot, target/);
assert.doesNotMatch(altSync,/services\/charting|corev3|CoreV3/i);
console.log('Passed: Alt broadcasts controls, zoom, and pan inside the Finance multichart grid');

const portfolio=fs.readFileSync(__dirname+'/../src/total-chart.js','utf8');
const markets=fs.readFileSync(__dirname+'/../markets/panel.js','utf8');
assert.match(portfolio,/context\.listen\(host, 'finance:refresh-chart-sizing'/);
assert.match(portfolio,/context\.listen\(contentEl, 'finance:refresh-chart-sizing'/);
assert.match(markets,/context\.listen\(root, 'finance:refresh-chart-sizing'/);
const fn=portfolio.slice(portfolio.indexOf('export function portfolioSectionHistory'), portfolio.indexOf('const extraPortfolioViews')).replace('export ', '');
const dataContext=vm.createContext({ totalHistory:[{t:1,v:100,g:100,spot:30,perp:70},{t:2,v:120,g:120,spot:40,perp:80}],remoteSections:[],convertFromGbp:v=>v*2 });
vm.runInContext(fn,dataContext);
assert.equal(vm.runInContext("portfolioSectionHistory('spot')[1].v",dataContext),80);
assert.equal(vm.runInContext("portfolioSectionHistory('perp')[1].v",dataContext),160);
assert.equal(vm.runInContext("portfolioSectionHistory('total')[1].v",dataContext),120);
assert.match(panel,/count = \[2, 3, 4\]/);
const css=fs.readFileSync(__dirname+'/../assets/chart-workspace.css','utf8');
assert.ok(css.includes('.finance-chart-grid[data-count="3"] > .finance-chart-stage { grid-column:1 / -1; }'));
console.log('Passed: independent portfolio series and three-chart layout');

// Both chart entry points must commit hidden ranges before live refreshes.
assert.match(portfolio, /view\.on\('hiddenRanges', updateHiddenRanges\)/);
assert.match(portfolio, /chart\.on\('hiddenRanges', updateHiddenRanges\)/);
const hiddenCode = portfolio.slice(portfolio.indexOf('function updateHiddenRanges('), portfolio.indexOf('function replaceChartData('));
const savedRanges = [], primaryRanges = [], secondaryRanges = [];
let balanceUpdates = 0;
const hiddenContext = vm.createContext({
  hiddenRanges: [],
  atmos: { events: { emit: () => Promise.resolve() } },
  saveChartHidden: ranges => savedRanges.push(JSON.stringify(ranges)),
  chart: { setOptions: options => primaryRanges.push(JSON.stringify(options.hiddenRanges)) },
  refreshExtraPortfolioViews: presentationOnly => {
    assert.equal(presentationOnly, true);
    secondaryRanges.push(vm.runInContext('JSON.stringify(hiddenRanges)', hiddenContext));
  },
  updateBalanceDisplay: () => balanceUpdates++,
});
vm.runInContext(hiddenCode, hiddenContext);
vm.runInContext('updateHiddenRanges([{ tStart: 1000, tEnd: 2000 }])', hiddenContext);
assert.deepEqual(savedRanges, ['[{"tStart":1000,"tEnd":2000}]']);
assert.deepEqual(primaryRanges, savedRanges);
assert.deepEqual(secondaryRanges, savedRanges);
vm.runInContext('updateHiddenRanges([])', hiddenContext);
assert.equal(savedRanges.at(-1), '[]');
assert.deepEqual(primaryRanges, savedRanges);
assert.deepEqual(secondaryRanges, savedRanges);
assert.equal(balanceUpdates, 2);
hiddenContext.chart = null;
assert.doesNotThrow(() => vm.runInContext('updateHiddenRanges([])', hiddenContext));
console.log('Passed: Ctrl-drag removals and restores persist and synchronize portfolio charts');

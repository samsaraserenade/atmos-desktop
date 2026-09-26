const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../panel.js`, 'utf8');

class Element {
  constructor() { this.style = {}; this.children = []; this.attributes = {}; this.handlers = {}; this.hidden = false; this.value = ''; this.nodes = new Map(); this.classList = { toggle() {}, add() {}, remove() {} }; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren() { this.children = []; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  focus() {}
  setPointerCapture() {}
}
const document = new Element();
document.createElement = () => new Element();
const context = { listen(el, event, fn) { el.handlers[event] = fn; }, onCleanup() {} };
const handles = [];
let collapsed = false, saves = 0;
const sandbox = vm.createContext({ document, context, console, portfolioState: {},
  workspace: { classList: { contains: () => collapsed, toggle: (_, value) => { collapsed = value; } }, querySelectorAll: () => handles },
  save: () => saves++, onStateLoaded: () => {},
  watchlistState: { tickers: ['BTC', 'ETH'] }, tickerData: {}, onTickerUpdate: () => () => {}, getServiceFileUrl: async () => null,
  colorForChange: () => 'rgba(255,255,255,.55)', onPriceColorChange: () => () => {},
  KNOWN_EXCHANGES: ['binance', 'bybit', 'kraken', 'coinbase'],
  parseMarketQuery: query => {
    const words = String(query).split(' ');
    const exchanges = words.slice(1).filter(word => ['binance', 'bybit', 'kraken', 'coinbase'].includes(word));
    return { symbol: words[0], exchanges: exchanges.length ? exchanges : null };
  },
});
const dockStart = source.indexOf('  const setToolbarCollapsed');
const dockEnd = source.indexOf('  const toolbarHandle = createToolbarHandle(context);', dockStart);
vm.runInContext(source.slice(dockStart, dockEnd), sandbox);
const first = sandbox.createToolbarHandle(context), second = sandbox.createToolbarHandle(context);
handles.push(first, second);
second.handlers.keydown({ key: 'Enter', preventDefault() {} });
assert.equal(collapsed, true);
assert.equal(first.attributes['aria-pressed'], 'true');
assert.equal(second.attributes['aria-pressed'], 'true');
first.handlers.pointerdown({ button: 0, pointerId: 1, clientY: 100, preventDefault() {} });
first.handlers.pointermove({ clientY: 60 });
first.handlers.pointerup();
assert.equal(collapsed, false);
assert.equal(second.attributes['aria-pressed'], 'false');
assert.equal(saves, 2);

const pickerStart = source.indexOf('  function createTickerPicker(');
const pickerEnd = source.indexOf('  let activeMode = null;', pickerStart);
vm.runInContext(source.slice(pickerStart, pickerEnd), sandbox);
const selections = [[], []];
const pickers = selections.map((selected, index) => sandbox.createTickerPicker(context, () => `Chart ${index}`, query => selected.push(query)).tickerPicker);
const button = pickers[1].children[0], panel = pickers[1].children[1];
button.handlers.click();
const list = panel.querySelector('.finance-ticker-picker-list');
list.children[2].handlers.click();
assert.deepEqual(selections, [[], ['ETHUSDT']]);
button.handlers.click();
list.children[0].handlers.click();
assert.deepEqual(selections[1], ['ETHUSDT', null]);
button.handlers.click();
const search = panel.querySelector('.finance-ticker-picker-search');
search.value = 'SOLUSDT';
search.handlers.input();
list.children[1].handlers.click();
assert.equal(selections[1].at(-1), 'SOLUSDT');

// Exchange chips: All by default; a pick applies to tickers chosen next, and
// re-runs a chart that already shows a market.
const chips = panel.querySelector('.finance-exchange-picker');
button.handlers.click();
assert.deepEqual(chips.children.map(chip => [chip.textContent, chip.attributes['aria-pressed']]), [
  ['All', 'true'], ['Binance', 'false'], ['Bybit', 'false'], ['Kraken', 'false'], ['Coinbase', 'false'],
]);
chips.children[4].handlers.click();
assert.equal(selections[1].at(-1), 'SOLUSDT', 'a portfolio chart has nothing to re-run');
assert.equal(chips.children[4].attributes['aria-pressed'], 'true');
assert.equal(chips.children[0].attributes['aria-pressed'], 'false');
search.value = '';
search.handlers.input();
list.children[2].handlers.click();
assert.equal(selections[1].at(-1), 'ETHUSDT coinbase');

const marketSelections = [];
const marketPicker = sandbox.createTickerPicker(context, () => 'BTC', query => marketSelections.push(query), () => 'BTCUSDT coinbase 1m candles').tickerPicker;
marketPicker.children[0].handlers.click();
const marketChips = marketPicker.children[1].querySelector('.finance-exchange-picker');
assert.equal(marketChips.children[4].attributes['aria-pressed'], 'true', 'starts from the chart query');
marketChips.children[3].handlers.click();
assert.deepEqual(marketSelections, ['BTCUSDT kraken coinbase']);
marketChips.children[0].handlers.click();
assert.deepEqual(marketSelections.at(-1), 'BTCUSDT');
marketChips.children[1].handlers.click(); marketChips.children[2].handlers.click();
marketChips.children[3].handlers.click(); marketChips.children[4].handlers.click();
assert.equal(marketSelections.at(-1), 'BTCUSDT', 'every exchange picked collapses back to All');
assert.equal(marketChips.children[0].attributes['aria-pressed'], 'true');
console.log('Passed: either docking handle updates all charts; secondary picker selections remain local; exchange chips apply per chart');

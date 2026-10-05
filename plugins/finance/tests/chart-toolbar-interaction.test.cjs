const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../panel.js`, 'utf8');

class Element {
  constructor() { this.style = {}; this.children = []; this.attributes = {}; this.handlers = {}; this.hidden = false; this.value = ''; this.nodes = new Map(); this.dataset = {}; this.className = ''; this.parent = null; this.classList = { toggle() {}, add() {}, remove() {} }; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  matches(selector) {
    if (selector === '[role="option"]') return this.attributes.role === 'option';
    return selector.startsWith('.') && this.className.split(' ').includes(selector.slice(1));
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  focus() {}
  setPointerCapture() {}
}
const document = new Element();
const window = new Element();
window.innerHeight = 800;
document.createElement = () => new Element();
const context = { listen(el, event, fn) { el.handlers[event] = fn; }, onCleanup() {} };
const handles = [];
let collapsed = false, saves = 0;
const sandbox = vm.createContext({ document, window, context, console, portfolioState: {},
  workspace: { classList: { contains: () => collapsed, toggle: (_, value) => { collapsed = value; } }, querySelectorAll: () => handles },
  save: () => saves++, onStateLoaded: () => {},
  watchlistState: { tickers: ['BTC', 'ETH'] }, tickerData: {}, onTickerUpdate: () => () => {}, getServiceFileUrl: async () => null, hasMarketData: () => true,
  heldSymbols: () => ['SOL'], accountShareFor: () => null, addTicker: async () => true, removeTicker() {},
  portfolioCoins: () => [{ symbol: 'SOL', value: 200 }], coinSection: symbol => `coin:${symbol}`,
  latestSectionValue: section => ({ total: 1234.5, spot: 1000, perp: 234.5 })[section],
  getTotal: () => ({ value: 1234.5, symbol: '£', ready: true, liveCount: 1, pendingCount: 0 }), masked: format => format, isPrivate: () => false, onPrivacyChange: () => () => {},
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
// Rows are delegated from the list: Portfolio (the total, Spot, Perp, each
// coin held), then Markets (the coins held, then the watchlist).
const list = panel.querySelector('.finance-ticker-picker-list');
const clickRow = index => list.handlers.click({ target: list.children[index] });
const rows = () => list.children.map(row => (row.className.includes('heading') ? `# ${row.textContent}` : row.dataset.section || row.dataset.symbol));
assert.deepEqual(rows(), ['# Portfolio', 'total', 'spot', 'perp', 'coin:SOL', '# Markets', 'SOL', 'BTC', 'ETH']);
assert.equal(list.children[1].querySelector('.finance-ticker-picker-portfolio-total').textContent, '£1,234.50', 'the total\'s card carries the live total');
assert.match(list.children[1].className, /is-current/, 'a portfolio chart\'s picker marks what it shows');
assert.equal(list.children[2].querySelector('.finance-ticker-picker-value').textContent, '£1,000.00');
assert.equal(list.children[2].querySelector('.finance-ticker-picker-share').textContent, '81%', 'Spot\'s share of the total');
assert.equal(list.children[4].querySelector('.finance-ticker-picker-symbol').textContent, 'SOL');
assert.equal(list.children[4].querySelector('.finance-ticker-picker-value').textContent, '£200.00');
clickRow(8);
assert.deepEqual(selections, [[], ['ETHUSDT']]);
button.handlers.click();
clickRow(1);
const plain = value => JSON.parse(JSON.stringify(value)); // made in the sandbox's realm
assert.deepEqual(plain(selections[1]), ['ETHUSDT', { section: 'total' }]);
button.handlers.click();
clickRow(4);
assert.deepEqual(plain(selections[1].at(-1)), { section: 'coin:SOL' }, 'a coin: what your holdings of it are worth');
button.handlers.click();
clickRow(2);
assert.deepEqual(plain(selections[1].at(-1)), { section: 'spot' });
button.handlers.click();
const search = panel.querySelector('.finance-ticker-picker-search');
search.value = 'SOLUSDT';
search.handlers.input();
// A symbol on no list: a heading, then "Look up" and "Watch".
assert.equal(list.children.length, 3);
clickRow(1);
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
clickRow(8);
assert.equal(selections[1].at(-1), 'ETHUSDT coinbase');
button.handlers.click();
search.value = 'sp';
search.handlers.input();
assert.deepEqual(rows(), ['# Portfolio', 'spot', '# Not on your lists', undefined, undefined], 'Spot found by name');
search.value = '';
button.handlers.click();

// Private mode hides what you hold: no coins under Portfolio or Markets.
sandbox.isPrivate = () => true;
button.handlers.click();
assert.deepEqual(rows(), ['# Portfolio', 'total', 'spot', 'perp', '# Markets', 'BTC', 'ETH']);
sandbox.isPrivate = () => false;

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

// Without Market Data (an optional dependency) there are no market charts:
// the picker still switches between Portfolio's charts.
sandbox.hasMarketData = () => false;
const offline = sandbox.createTickerPicker(context, () => 'Portfolio', () => {}).tickerPicker;
assert.equal(offline.hidden, false);
offline.children[0].handlers.click();
assert.deepEqual(offline.children[1].querySelector('.finance-ticker-picker-list').children.map(row => (row.className.includes('heading') ? `# ${row.textContent}` : row.dataset.section || row.dataset.symbol)),
  ['# Portfolio', 'total', 'spot', 'perp', 'coin:SOL']);
assert.equal(offline.children[1].querySelector('.finance-exchange-picker').hidden, true, 'no exchanges to pick');

'use strict';
// The Portfolio Connections list (src/connections-list.js) against a small
// stand-in for the DOM: a row per source with its value and status, a
// right-click to leave a source out, and rows patched rather than rebuilt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/connections-list.js'), 'utf8');

function element(tag) {
  const node = {
    tag, className: '', textContent: '', title: '', dataset: {}, children: [], listeners: {},
    get classList() {
      const names = () => new Set(node.className.split(' ').filter(Boolean));
      return {
        toggle(name, on) { const set = names(); on ? set.add(name) : set.delete(name); node.className = [...set].join(' '); },
        contains: name => names().has(name),
      };
    },
    append(...nodes) { for (const child of nodes) { child.parent = node; node.children.push(child); } },
    replaceChildren(...nodes) { node.children = []; node.append(...nodes); },
    addEventListener(type, fn) { node.listeners[type] = fn; },
    closest(selector) {
      for (let at = node; at; at = at.parent) if (selector === `.${at.className.split(' ')[0]}`) return at;
      return null;
    },
  };
  return node;
}

async function setUp() {
  const mount = element('div');
  const head = element('head');
  const portfolios = new Map();
  const sources = [];
  const statuses = new Map();
  const excluded = new Set();
  const state = { remote: true, privateMode: false, menus: [], forms: 0, footers: 0, lastUpdate: null };
  const context = vm.createContext({
    Intl, JSON, Math, Number, String, Date, console,
    document: { getElementById: id => (id === 'exchange-mount' ? mount : head.children.find(child => child.id === id)), createElement: element, head: { appendChild: node => head.append(node) } },
  });
  const modules = {
    './host/frame.js': { atmos: { contextMenu: { open: async (x, y, items) => { state.menus.push(items); } } } },
    './host/persist.js': { save() {} },
    './privacy.js': { isPrivate: () => state.privateMode, masked: format => (...args) => (state.privateMode ? '••••' : format(...args)) },
    './portfolio-scope.js': {
      isSourceIncluded: id => !excluded.has(id),
      scopedPortfolioData: data => data,
      setSourceIncluded: (id, included) => { if (included) excluded.delete(id); else excluded.add(id); },
    },
    './registry.js': {
      getAllPortfolios: () => portfolios, getExchanges: () => sources, getServerConnection: () => ({ configured: true, address: 'http://100.64.0.9:8787' }),
      getSourceStatus: id => statuses.get(id), isRemotePortfolioMode: () => state.remote, notifyPortfolioUpdate() {},
    },
    './totals.js': { convertToGbp: value => value, convertFromGbp: value => value, getTotal: () => ({ symbol: '$' }) },
    './connection-form.js': {
      mountConnectionForm: into => { state.forms++; into.append(element('form')); },
      mountConnectionFooter: into => { state.footers++; into.append(element('footer')); return { update: when => { state.lastUpdate = when; } }; },
    },
  };
  const linked = Object.fromEntries(Object.entries(modules).map(([name, exports]) => [name, new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context })]));
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => linked[specifier]);
  await module.evaluate();
  const rows = () => mount.children[0].children.map(row => ({
    id: row.dataset.sourceId, name: row.children[1].textContent, value: row.children[2].textContent,
    dot: row.children[0].className, excluded: row.classList.contains('is-excluded'),
  }));
  return { render: module.namespace.renderConnections, mount, portfolios, sources, statuses, excluded, state, rows };
}

test('a row per source: its name, value and whether it is reporting', async () => {
  const view = await setUp();
  view.sources.push({ id: 'solana-wallet', name: 'Solana' }, { id: 'binance-spot', name: 'Binance' }, { id: 'quiet', name: 'Quiet' });
  view.portfolios.set('solana-wallet', { label: 'Solana', value: 1234.4, currency: 'USD', lastUpdate: Date.now() });
  view.portfolios.set('binance-spot', { label: 'Binance', value: 50, currency: 'USD', lastUpdate: Date.now() - 1000 });
  view.portfolios.set('quiet', null); // reported nothing yet
  view.statuses.set('solana-wallet', 'ok');
  view.statuses.set('binance-spot', 'partial');
  view.render();
  assert.deepEqual(view.rows(), [
    { id: 'solana-wallet', name: 'Solana', value: '$1,234', dot: 'fin-source-dot is-ok', excluded: false },
    { id: 'binance-spot', name: 'Binance', value: '$50', dot: 'fin-source-dot is-partial', excluded: false },
  ]);
  assert.match(view.mount.children[0].children[1].title, /^Partly reporting/);
  assert.equal(view.state.footers, 1);
  assert.ok(view.state.lastUpdate > 0, 'the footer says when the server last reported');
});

test('right-click leaves a whole source out, and the row says so', async () => {
  const view = await setUp();
  view.sources.push({ id: 'solana-wallet' });
  view.portfolios.set('solana-wallet', { label: 'Solana', value: 10, currency: 'USD', lastUpdate: Date.now() });
  view.render();
  const row = view.mount.children[0].children[0];
  view.mount.children[0].listeners.contextmenu({ target: row, clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  const toggle = view.state.menus[0].find(item => item.type === 'toggle');
  assert.equal(toggle.checked, true);
  toggle.run(false);
  assert.ok(view.excluded.has('solana-wallet'));
  assert.deepEqual(view.rows()[0], { id: 'solana-wallet', name: 'Solana', value: '$10', dot: 'fin-source-dot', excluded: true });
  assert.match(row.title, /^Left out of the portfolio/);
});

test('new values patch the rows; a new source rebuilds them; the form is built once', async () => {
  const view = await setUp();
  view.sources.push({ id: 'a' });
  view.portfolios.set('a', { label: 'A', value: 1, currency: 'USD', lastUpdate: 1 });
  view.render();
  const first = view.mount.children[0].children[0];
  view.portfolios.set('a', { label: 'A', value: 2, currency: 'USD', lastUpdate: 2 });
  view.render();
  assert.equal(view.mount.children[0].children[0], first);
  assert.equal(first.children[2].textContent, '$2');
  view.state.privateMode = true;
  view.render();
  assert.equal(view.rows()[0].value, '••••');
  assert.equal(view.state.footers, 2, 'private mode redraws the server address too');
  view.sources.push({ id: 'b' });
  view.portfolios.set('b', { label: 'B', value: 3, currency: 'USD', lastUpdate: 3 });
  view.render();
  assert.equal(view.rows().length, 2);
  view.state.remote = false;
  view.render();
  view.render();
  assert.equal(view.state.forms, 1, 'redrawing would clear a half-typed pairing code');
});

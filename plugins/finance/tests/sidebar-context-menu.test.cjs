const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreRoot = process.env.ATMOS_CORE_PATH || path.join(__dirname, '..', '..', '..', 'core');

test('accordion settings refresh on open and failures preserve core actions', () => {
  const source = fs.readFileSync(`${coreRoot}/js/core/sidebar-shell.js`, 'utf8');
  const start = source.indexOf('export function attachSidebarSection(');
  const end = source.indexOf('export function openSidebar(', start);
  let menu;
  const sandbox = {
    wiredSections: new WeakSet(),
    attachSectionResizeHandle() {}, applySectionHeight() {}, applySidebarPanelScopes() {},
    isDocked: () => null, sectionPanelScope: () => [], listPanelPlugins: () => [],
    openMenu: (x, y, items) => { menu = items; }, console: { error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end).replace('export function', 'function'), sandbox);
  function attach(provider) {
    const listeners = {};
    const section = { id: 'example', querySelector: () => null, addEventListener: (name, fn) => { listeners[name] = fn; } };
    sandbox.attachSidebarSection(section, { contextMenuItems: provider });
    return () => listeners.contextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 2, clientY: 3 });
  }
  let enabled = true;
  const open = attach(() => [{ id: 'example.toggle', label: enabled ? '✓ Enabled' : 'Enabled', run: () => { enabled = !enabled; } }]);
  open();
  assert.equal(menu.find(item => item.id === 'example.toggle').label, '✓ Enabled');
  assert.ok(menu.some(item => item.label === 'Settings'));
  menu.find(item => item.id === 'example.toggle').run();
  open();
  assert.equal(menu.find(item => item.id === 'example.toggle').label, 'Enabled');
  for (const provider of [undefined, () => [], () => null, () => { throw Error('plugin failure'); }]) {
    attach(provider)();
    assert.ok(menu.some(item => item.id === 'sidebar.dock-top'));
    assert.ok(menu.some(item => item.id === 'sidebar.scope.global'));
    assert.ok(!menu.some(item => item.label === 'Settings'));
  }
});

test('menu font picker selects in place and treats option labels as text', async () => {
  const source = fs.readFileSync(`${coreRoot}/js/core/context-menu.js`, 'utf8');
  const start = source.indexOf('function renderMenuRow(');
  const end = source.indexOf('function positionAt(', start);
  function element(tag) {
    return {
      tag, children: [], dataset: {}, style: {}, listeners: {}, attributes: {},
      appendChild(child) { this.children.push(child); },
      setAttribute(key, value) { this.attributes[key] = value; },
      querySelector() { return this.label ||= {}; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
    };
  }
  const sandbox = { document: { createElement: element }, console };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const container = element('div');
  let selected;
  let closed = false;
  sandbox.renderMenuRow(container, {
    id: 'font', type: 'select', label: 'Balance font', value: 'bebas',
    options: [{ value: 'bebas', label: 'Bebas Neue' }, { value: 'custom', label: '<custom font>' }],
    run(value) { selected = value; },
  }, () => { closed = true; });
  const row = container.children[0];
  const select = row.children[0];
  assert.equal(select.value, 'bebas');
  assert.equal(select.attributes['aria-label'], 'Balance font');
  assert.equal(select.children[1].textContent, '<custom font>');
  assert.equal(row.listeners.click, undefined);
  select.listeners.click({ stopPropagation() {} });
  assert.equal(closed, false);
  select.value = 'custom';
  await select.listeners.change({ stopPropagation() {} });
  assert.equal(selected, 'custom');
  assert.equal(closed, true);
});

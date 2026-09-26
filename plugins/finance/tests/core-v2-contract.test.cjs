'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('declares a framed extension that keeps its surfaces\' ids', () => {
  const manifest = JSON.parse(read('extension.json'));
  assert.equal(manifest.apiVersion, 3);
  assert.equal(manifest.runtime, 'frame');
  assert.equal(manifest.requires['extensions.frames'], 3);
  const { panel, sidebar, boot } = manifest.contributes;
  assert.equal(panel.legacyId, 'portfolio-tracker');
  assert.equal(panel.shortcut, ']');
  assert.equal(panel.shortcutToggles, true);
  assert.deepEqual(sidebar.map(item => item.legacyId), ['portfolio-balance-ticker', 'portfolio-balance', 'portfolio-connections', 'portfolio-positions', 'portfolio-allocation', 'portfolio-futures', 'markets']);
  for (const item of [panel, ...sidebar, boot]) assert.ok(fs.existsSync(path.join(root, item.entry)), item.entry);
  for (const item of [panel, ...sidebar]) assert.ok(fs.existsSync(path.join(root, item.icon)), item.icon);
  assert.deepEqual(manifest.legacyStorage.state, ['portfolio-tracker', 'markets', 'watchlist', 'currency']);
  assert.deepEqual(manifest.permissions.invokes, ['service:charting', 'service:currency', 'service:market-data']);
  assert.match(read('persist.js'), /registerStateNamespace\('portfolio-tracker'/);
  assert.doesNotMatch(read('persist.js'), /registerPersist/);
});

test('uses stable identity, verified services, scoped IPC, and prefixed assets', () => {
  assert.match(read('panel.js'), /registerPanelPlugin\('portfolio-tracker'/);
  assert.doesNotMatch(read('main.cjs'), /ipcMain\./);
  assert.doesNotMatch(read('src/total-chart.js') + read('src/totals.js'), /atmos-service:\/\//);
  assert.match(read('src/storage.js'), /portfolio-tracker:chart-history/);
  assert.match(read('src/remote.js'), /invokeFinance as invoke/);
  const sidebar = read('sidebar.js');
  assert.match(sidebar, /await initCurrencyService\(\)/);
  assert.ok(sidebar.indexOf('await initCurrencyService()') < sidebar.indexOf("registerSection('portfolio-balance'"));
  assert.equal(fs.existsSync(path.join(root, 'src/currency.js')), false);
});

test('Portfolio panel appearance is owned by Core without absorbing toolbar blur', () => {
  const panel = read('panel.js');
  const css = read('assets/chart-workspace.css');
  const settings = read('src/sidebar-settings.js');
  const chart = read('src/total-chart.js');
  assert.match(panel, /panelAppearance:\s*true/);
  assert.match(css, /\.finance-workspace \{[^}]*background:transparent/);
  assert.match(css, /\.finance-workspace \.finance-plot-surface,[\s\S]*?--panel-opacity[\s\S]*?--panel-blur/);
  assert.match(css, /\.finance-portfolio-toolbar \{[\s\S]*?--shell-blur/);
  assert.match(css, /\.finance-portfolio-toolbar \{[\s\S]*?--shell-opacity/);
  assert.doesNotMatch(settings, /Background Opacity|chartBgOpacity|setChartOpacity/);
  assert.doesNotMatch(chart, /chartBgOpacity|setChartOpacity|chartOpacity/);
});

test('allocation visuals follow Atmos semantic colours', () => {
  const css = read('assets/allocation.css');
  const widget = read('src/allocation-widget.js');
  assert.match(css, /--color-positive/);
  assert.match(css, /--color-negative/);
  assert.match(css, /--color-neutral/);
  assert.doesNotMatch(css, /rgba\(52,\s*211,\s*153|rgba\(248,\s*113,\s*113/);
  assert.match(widget, /totalEl\.classList\.add\(result\.net > 0 \? 'is-positive'/);
});

test('no Finance module reaches Atmos Core or its globals directly', () => {
  const code = file => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const files = ['frame-engine.js', 'frame-panel.js', 'panel.js', 'persist.js', 'sidebar.js', 'markets/panel.js', 'markets/persist.js', 'markets/sidebar.js', 'markets/src/watchlist-data.js',
    ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`)];
  for (const file of files) assert.doesNotMatch(code(file), /from 'atmos-core|window\.atmos\b|window\.atmosCore|window\.alert\(/, file);
  for (const file of fs.readdirSync(path.join(root, 'src/host'))) {
    if (file !== 'frame.js') assert.doesNotMatch(code(`src/host/${file}`), /from 'atmos-sdk'/, `only frame.js imports the SDK (${file})`);
  }
});

test('renderer modules parse and relative imports resolve', () => {
  const files = ['frame-engine.js', 'frame-panel.js', 'panel.js', 'persist.js', 'sidebar.js',
    ...fs.readdirSync(root).filter(name => /^frame-widget-.*\.js$/.test(name)),
    ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`),
    ...fs.readdirSync(path.join(root, 'src/host')).filter(name => name.endsWith('.js')).map(name => `src/host/${name}`)];
  for (const file of files) {
    const source = read(file);
    assert.doesNotThrow(() => new vm.SourceTextModule(source, { identifier: file }), file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
      assert.equal(fs.existsSync(path.resolve(root, path.dirname(file), match[2])), true, `${file}: missing ${match[2]}`);
    }
  }
});

test('balance tween isolates and deduplicates per-frame paints', () => {
  const balance = read('src/balance.js');
  assert.match(balance, /if \(text === _lastBalanceText\) return/);
  assert.match(balance, /contain:layout paint style/);
  assert.match(balance, /_setBalanceAnimationLayer\(true\)/);
  assert.match(balance, /_setBalanceAnimationLayer\(false\)/);
  assert.match(balance, /translate3d\(0,0,0\)/);
});

test('framed sidebar controls use body UI or Core header menus, never legacy header DOM', () => {
  const markets = read('markets/sidebar.js');
  const styles = read('markets/styles.css');
  const widgetHost = read('src/host/widget.js');

  assert.doesNotMatch(markets, /headerExtra|centerSortToggleInHeader|positions-sort-toggle|futures-sort-toggle/);
  assert.doesNotMatch(styles, /accordion-total-balance|pt-sort-toggle|watchlist-inline-add/);
  assert.match(markets, /contextMenuItems:\s*spotSortMenuItems/);
  assert.match(markets, /contextMenuItems:\s*futuresSortMenuItems/);
  assert.match(markets, /id:\s*'finance\.spot\.sort'[\s\S]*?type:\s*'select'/);
  assert.match(markets, /id:\s*'finance\.futures\.sort'[\s\S]*?type:\s*'select'/);
  assert.match(markets, /body\.innerHTML = '[^']*spot-total-balance[^']*tc-sidebar-composition/);
  assert.match(markets, /body\.innerHTML = '[^']*futures-perp-balance[^']*futures-earn-balance[^']*futures-direction-bar/);
  assert.match(markets, /context\.listen\(body, 'contextmenu',[\s\S]*?openSpotVisibilityMenu/);
  assert.match(markets, /atmos\.contextMenu\.open[\s\S]*?type: 'toggle'[\s\S]*?label: 'Included in portfolio'/);
  assert.match(markets, /body\.innerHTML = '[^']*markets-watchlist-input[^']*watchlist-rows/);
  assert.match(widgetHost, /atmos\.surface\.setMenu\(items\)/);
});

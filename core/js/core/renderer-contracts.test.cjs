const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const coreDir = __dirname;
const appDir = path.resolve(coreDir, '..');

function tempModules(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-core-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const [source, destination = source] of files.map(file => Array.isArray(file) ? file : [file])) {
    fs.mkdirSync(path.dirname(path.join(dir, destination)), { recursive: true });
    fs.copyFileSync(path.join(appDir, source), path.join(dir, destination));
  }
  return {
    dir,
    import(file) {
      return import(`${pathToFileURL(path.join(dir, file)).href}?run=${Date.now()}-${Math.random()}`);
    },
  };
}

test('capability contracts accept legacy extensions and reject unmet requirements', async () => {
  const modules = tempModules(['core/capabilities.js']);
  const capabilities = await modules.import('core/capabilities.js');
  assert.equal(capabilities.checkExtensionCompatibility({}).compatible, true);
  assert.equal(capabilities.hasCapability('panel.pass-through'), true);
  assert.equal(capabilities.hasCapability('panel.immediate-state'), false);
  assert.equal(capabilities.hasCapability('settings.appearance-contributions'), true);
  assert.equal(capabilities.hasCapability('sidebar.resizable-sections'), true);
  assert.equal(capabilities.checkExtensionCompatibility({ apiVersion: 999 }).compatible, false);
  assert.equal(capabilities.checkExtensionCompatibility({ requires: ['missing.feature'] }).compatible, false);
});

test('namespaced events isolate extensions and abort with their lifecycle signal', async () => {
  const modules = tempModules(['core/events.js']);
  const events = await modules.import('core/events.js');
  const controller = new AbortController();
  const alpha = events.createEventScope('alpha', { signal: controller.signal });
  const beta = events.createEventScope('beta');
  const seen = [];
  alpha.on('changed', value => seen.push(`alpha:${value}`));
  beta.on('changed', value => seen.push(`beta:${value}`));
  alpha.emit('changed', 1);
  controller.abort();
  alpha.emit('changed', 2);
  beta.emit('changed', 3);
  assert.deepEqual(seen, ['alpha:1', 'beta:3']);
  assert.equal(events.listenerCount('alpha:changed'), 0);
});

test('renderer capabilities are optional, exclusive, observable, and revocable', async () => {
  const modules = tempModules(['core/renderer-capabilities.js']);
  const capabilities = await modules.import('core/renderer-capabilities.js');
  const seen = [];
  const unsubscribe = capabilities.onCapabilityChange('visual.background', value => seen.push(value));
  const api = { getState: () => ({}) };
  const revoke = capabilities.provideCapability('visual.background', api, { owner: 'background' });
  assert.equal(capabilities.getCapability('visual.background'), api);
  assert.throws(() => capabilities.provideCapability('visual.background', {}), /already provided/);
  revoke();
  unsubscribe();
  assert.deepEqual(seen, [null, api, null]);
});

test('lifecycle scopes clean listeners and protect core context fields', async () => {
  const modules = tempModules([
    'core/events.js', 'core/capabilities.js', 'core/lifecycle.js',
  ]);
  const { createLifecycleScope } = await modules.import('core/lifecycle.js');
  const target = new EventTarget();
  let calls = 0;
  const scope = createLifecycleScope('music', 'panel', { id: 'spoofed', custom: 42 });
  scope.context.listen(target, 'ping', () => calls++);
  target.dispatchEvent(new Event('ping'));
  scope.dispose();
  target.dispatchEvent(new Event('ping'));
  assert.equal(calls, 1);
  assert.equal(scope.context.id, 'music');
  assert.equal(scope.context.custom, 42);
  assert.equal(scope.context.signal.aborted, true);
});

test('boot hooks run at most once', async () => {
  const modules = tempModules([
    'core/events.js', 'core/capabilities.js', 'core/lifecycle.js', 'core/boot-registry.js',
  ]);
  global.window = new EventTarget();
  const boot = await modules.import('core/boot-registry.js');
  let calls = 0;
  boot.registerBootHook('once-only', { run() { calls++; } });
  await Promise.all([boot.runBootHooks(), boot.runBootHooks()]);
  await boot.runBootHooks();
  assert.equal(calls, 1);
});

test('namespaced persistence migrates active state and preserves unavailable extensions', async () => {
  const modules = tempModules(['persist.js']);
  const saved = new Map();
  global.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  global.window = new EventTarget();
  saved.set('samsara_v4', JSON.stringify({
    extensionState: {
      active: { version: 1, data: { count: 4 } },
      unavailable: { version: 7, data: { keep: true } },
    },
  }));
  const persist = await modules.import('persist.js');
  const active = persist.registerStateNamespace('active', {
    defaults: { count: 0 },
    version: 2,
    migrate: data => ({ count: data.count + 1 }),
  });
  persist.load();
  assert.equal(active.count, 5);
  active.count = 6;
  persist.save();
  const output = JSON.parse(saved.get('samsara_v4'));
  assert.deepEqual(output.extensionState.active, { version: 2, data: { count: 6 } });
  assert.deepEqual(output.extensionState.unavailable, { version: 7, data: { keep: true } });
});

test('Core shell namespaces migrate legacy root fields without retaining them', async () => {
  const modules = tempModules(['persist.js']);
  const saved = new Map();
  global.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  global.window = new EventTarget();
  saved.set('samsara_v4', JSON.stringify({ sidebarOpen: true, visState: { obsolete: true } }));
  const persist = await modules.import('persist.js');
  const sidebar = persist.registerCoreStateNamespace('sidebar', {
    defaults: { open: false },
    migrateLegacy: (defaults, blob) => ({ open: blob.sidebarOpen ?? defaults.open }),
  });
  persist.load();
  assert.equal(sidebar.open, true);
  persist.save();
  const output = JSON.parse(saved.get('samsara_v4'));
  assert.deepEqual(output.coreState.sidebar, { version: 1, data: { open: true } });
  assert.equal('sidebarOpen' in output, false);
  assert.equal('visState' in output, false);
});

test('sidebar docks, panel scopes, and section heights persist while older state gets safe defaults', async () => {
  const modules = tempModules(['persist.js', 'core/sidebar-state.js']);
  const saved = new Map([['samsara_v4', JSON.stringify({
    coreState: { sidebar: { version: 1, data: { open: true, order: ['one'], enabled: {}, openSections: [] } } },
  })]]);
  global.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  global.window = new EventTarget();
  const persistUrl = pathToFileURL(path.join(modules.dir, 'persist.js')).href;
  const sidebarUrl = pathToFileURL(path.join(modules.dir, 'core/sidebar-state.js')).href;
  const persist = await import(persistUrl);
  const { sidebarState } = await import(sidebarUrl);
  persist.load();
  assert.deepEqual(sidebarState.dockedSections, []);
  assert.deepEqual(sidebarState.topDockedSections, []);
  assert.deepEqual(sidebarState.panelScopes, {});
  assert.deepEqual(sidebarState.sectionHeights, {});
  sidebarState.dockedSections.push('one');
  sidebarState.topDockedSections.push('three', 'two');
  sidebarState.panelScopes.one = 'notes';
  sidebarState.sectionHeights.one = 280;
  sidebarState.sectionHeights.two = 'auto';
  persist.save();
  const output = JSON.parse(saved.get('samsara_v4'));
  assert.deepEqual(output.coreState.sidebar.data.dockedSections, ['one']);
  assert.deepEqual(output.coreState.sidebar.data.topDockedSections, ['three', 'two']);
  assert.deepEqual(output.coreState.sidebar.data.panelScopes, { one: 'notes' });
  assert.deepEqual(output.coreState.sidebar.data.sectionHeights, { one: 280, two: 'auto' });
  assert.equal(output.coreState.sidebar.version, 3);
  // Existing single-panel preferences become selections without losing their scope.
  persist.load();
  assert.deepEqual(sidebarState.topDockedSections, ['three', 'two']);
  assert.deepEqual(sidebarState.dockedSections, ['one']);
  assert.deepEqual(sidebarState.panelScopes, { one: ['notes'] });
  sidebarState.panelScopes.one.push('audio-player');
  persist.save();
  persist.load();
  assert.deepEqual(sidebarState.panelScopes, { one: ['notes', 'audio-player'] });
  const multiSaved = JSON.parse(saved.get('samsara_v4'));
  multiSaved.coreState.sidebar.data.panelScopes = {
    one: ['notes', 'audio-player', 'notes', null, ''],
    empty: [], invalid: 42,
  };
  saved.set('samsara_v4', JSON.stringify(multiSaved));
  persist.load();
  // An empty list is an explicit Global (it overrides a widget's "showIn").
  assert.deepEqual(sidebarState.panelScopes, { one: ['notes', 'audio-player'], empty: [] });
});

test('Core owns sidebar resize handles and extensions only declare constraints', () => {
  const readSource = relativePath => fs.readFileSync(path.resolve(appDir, relativePath), 'utf8');
  const shell = readSource('core/sidebar-shell.js');
  const registry = readSource('core/sidebar-registry.js');
  const audioManifest = JSON.parse(readSource('../../plugins/audio-player/extension.json'));
  const shellMarkup = fs.readFileSync(path.resolve(appDir, '../index.html'), 'utf8');
  assert.match(shell, /fin-section-resize-handle/);
  assert.match(shell, /sectionHeights/);
  assert.match(shell, /dblclick/);
  assert.match(shell, /DEFAULT_SECTION_RESIZE_STEP = 28/);
  assert.match(shell, /snapSectionHeight/);
  assert.doesNotMatch(shell, /declaredMaximum|shellMaximum/);
  assert.match(shellMarkup, /\.fin-section-body::\-webkit-scrollbar \{ display:none/);
  assert.match(shellMarkup, /scrollbar-width: none/);
  assert.match(shellMarkup, /\.fin-section-body > :first-child \{ margin-top:0 !important; padding-top:0 !important; \}/);
  assert.match(shellMarkup, /\.fin-section\[data-resizable="false"\]\.open \.fin-section-body/);
  assert.match(shellMarkup, /id="sidebar-footer"/);
  assert.match(shellMarkup, /id="sidebar-footer-settings"/);
  assert.match(shell, /loadSidebarFooterVersion/);
  assert.match(shell, /module\.openSettingsMenu\(\)/);
  assert.match(shellMarkup, /height: auto !important/);
  assert.match(registry, /def\.defaultHeight/);
  assert.match(registry, /def\.resizeStep/);
  assert.match(registry, /def\.minHeight/);
  assert.match(registry, /def\.resizable/);
  assert.doesNotMatch(registry, /def\.maxHeight/);
  // Widgets only declare constraints (Now Playing follows its content).
  assert.ok(audioManifest.contributes.sidebar.every(widget => widget.defaultHeight === undefined && widget.minHeight === undefined));
  assert.equal(audioManifest.contributes.sidebar[0].resizable, false);
});

test('standard context menus render interactive controls with typed values', () => {
  const contextMenu = fs.readFileSync(path.resolve(appDir, 'core/context-menu.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(appDir, '../index.html'), 'utf8');

  assert.match(contextMenu, /entry\.type === 'heading'/);
  assert.match(contextMenu, /entry\.type === 'toggle'[\s\S]*?runControl\(toggle\.checked\)/);
  assert.match(contextMenu, /entry\.type === 'range'[\s\S]*?Number\(range\.value\)[\s\S]*?runControl\(numericValue\)/);
  assert.match(contextMenu, /entry\.type === 'number'[\s\S]*?Number\(number\.value\)[\s\S]*?runControl\(numericValue\)/);
  assert.match(contextMenu, /entry\.type === 'colors'[\s\S]*?inputs\.map\(input => input\.value\)/);
  assert.match(contextMenu, /entry\.closeOnChange !== false/);
  assert.match(contextMenu, /opts\.title/);
  assert.match(html, /\.ctx-control-toggle:checked[^{]*\{[^}]*var\(--color-positive/);
  assert.match(html, /\.ctx-control-row input\[type="range"\]/);
  assert.match(html, /\.ctx-control-value/);
});

test('wallpaper behavior belongs to the optional background plugin, not Core', () => {
  const readSource = relativePath => fs.readFileSync(path.resolve(appDir, relativePath), 'utf8');
  const persistSource = readSource('persist.js');
  const contextMenuSource = readSource('core/context-menu.js');
  const appSource = readSource('../app.js');
  const html = readSource('../index.html');

  const pluginState = readSource('../../services/wallpaper/persist.js');
  const pluginEngine = readSource('../../services/wallpaper/engine.js');
  const pluginBoot = readSource('../../services/wallpaper/boot.js');
  const pluginSettings = readSource('../../services/wallpaper/settings.js');

  for (const coreSource of [persistSource, contextMenuSource, appSource, html]) {
    assert.doesNotMatch(coreSource, /bgHue|bgContrast|parallax-bg|setBgFrom|saveBg|loadBg/);
  }
  assert.match(pluginState, /registerStateNamespace\('wallpaper'/);
  assert.match(pluginState, /bgHue: 'hue'/);
  // Saved settings from when Wallpaper was the Background plugin carry over.
  assert.match(pluginState, /extensionState;[\s\S]*saved\?\.background\?\.data/);
  assert.match(pluginEngine, /wallpaperApi|setTemporaryEffects|setWallpaper/);
  assert.match(pluginBoot, /provideCapability\('visual\.wallpaper'/);
  assert.match(pluginSettings, /category: 'Appearance'/);
  assert.match(appSource, /loadPluginSettings/);
  assert.match(appSource, /loadServiceSettings/);
  assert.match(readSource('core/settings-menu.js'), /category === 'Appearance'/);
});

test('plugin-specific player chrome does not become a Core panel convention', () => {
  const readSource = relativePath => fs.readFileSync(path.resolve(appDir, relativePath), 'utf8');
  const html = readSource('../index.html');
  const registry = readSource('core/panel-registry.js');
  const guide = readSource('../../ATMOS_CORE_INTEGRATION.md');

  assert.doesNotMatch(html, /--seekbar-opacity|backdrop-filter:blur\(60px\)|click again to close/);
  assert.match(registry, /mount\(surfaceEl, context\)/);
  assert.match(guide, /waveform, track metadata, album art, playback controls/);
});

test('shell and panel appearance settings remain independently scoped', () => {
  const readSource = relativePath => fs.readFileSync(path.resolve(appDir, relativePath), 'utf8');
  const appearance = readSource('core/appearance.js');
  const registry = readSource('core/panel-registry.js');
  const settings = readSource('core/settings-menu.js');
  const html = readSource('../index.html');
  const audioCss = readSource('../../plugins/audio-player/assets/panel.css');

  assert.match(appearance, /defaultPanelBlur: DEFAULT_PANEL_BLUR/);
  assert.match(appearance, /defaultPanelOpacity: DEFAULT_PANEL_OPACITY/);
  assert.match(appearance, /panelOverrides: \{\}/);
  assert.match(appearance, /'Panel Blur'/);
  assert.match(appearance, /'Panel Opacity'/);
  assert.match(appearance, /mountPanelAppearanceOverrides/);
  assert.match(settings, /mountAppearanceControls\(page, _homeContext, listPanelPlugins\(\)\)/);
  assert.match(registry, /--panel-blur/);
  assert.match(registry, /--panel-opacity/);
  assert.match(registry, /panelAppearance: config\.panelAppearance === true/);
  assert.match(appearance, /shellBlur: DEFAULT_SHELL_BLUR/);
  assert.match(appearance, /shellOpacity: DEFAULT_SHELL_OPACITY/);
  assert.match(appearance, /'Interface Blur'/);
  assert.match(appearance, /'Interface Opacity'/);
  assert.match(html, /#settings-drawer[\s\S]*--shell-blur/);
  assert.match(html, /#settings-drawer[\s\S]*--shell-opacity/);
  assert.doesNotMatch(html, /--sidebar-panel-(?:blur|opacity)/);
  // A drawer panel's glass is Core's (the frame can't blur the page) and
  // follows the panel's own blur; the frame's tint follows its opacity.
  assert.match(html, /\.atmos-drawer-glass-body \{[^}]*var\(--panel-blur, var\(--default-panel-blur/);
  assert.match(audioCss, /--panel-opacity/);
  assert.notEqual(appearance.indexOf('shellBlur: DEFAULT_SHELL_BLUR'), appearance.indexOf('defaultPanelBlur: DEFAULT_PANEL_BLUR'));
  assert.notEqual(appearance.indexOf('shellOpacity: DEFAULT_SHELL_OPACITY'), appearance.indexOf('defaultPanelOpacity: DEFAULT_PANEL_OPACITY'));
});

test('panel appearance resolves persisted overrides independently from shell appearance', async () => {
  const modules = tempModules(['persist.js', 'core/semantic-colors.js', 'core/appearance.js']);
  const saved = new Map([['samsara_v4', JSON.stringify({
    coreState: {
      appearance: { version: 1, data: {
        surfaceBlur: 7,
        shellOpacity: 64,
        defaultPanelBlur: 24,
        defaultPanelOpacity: 76,
        panelOverrides: { sidebar: { blur: 11 }, 'audio-player': { opacity: 62 } },
      } },
    },
  })]]);
  global.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const properties = new Map();
  global.document = {
    documentElement: {
      dataset: {},
      style: { setProperty: (name, value) => properties.set(name, value) },
    },
    fonts: { add() {}, delete() {} },
  };
  global.window = new EventTarget();
  const persist = await import(pathToFileURL(path.join(modules.dir, 'persist.js')).href);
  const appearance = await import(pathToFileURL(path.join(modules.dir, 'core/appearance.js')).href);
  persist.load();

  assert.deepEqual(appearance.getPanelAppearance('sidebar'), { blur: 11, opacity: 76, overridden: true });
  assert.deepEqual(appearance.getPanelAppearance('audio-player'), { blur: 24, opacity: 62, overridden: true });
  assert.deepEqual(appearance.getPanelAppearance('notes-panel'), { blur: 24, opacity: 76, overridden: false });
  assert.equal(properties.get('--shell-blur'), '7px');
  assert.equal(properties.get('--shell-opacity'), '0.64');
  assert.equal(properties.get('--default-panel-blur'), '24px');
  assert.equal(properties.get('--default-panel-opacity'), '0.76');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('cover appearance is restored from the saved settings', () => {
  const state = {
    albumCoverSize: 120,
    albumCoverSaturation: 75,
    browserOpacity: 60,
    albumDim: 25,
    albumLabelsHidden: true,
  };
  const properties = new Map(), classes = new Map();
  let saves = 0, folderAdds = 0;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    audioState: state,
    save: () => saves++,
    addFolder: () => folderAdds++,
    rescanLibrary() {},
    scanForNewFolders() {},
    renderLibraryMenu() {},
    document: {
      getElementById: element,
      documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } },
      body: { classList: { toggle: (key, value) => classes.set(key, value) } },
    },
  });
  const source = fs.readFileSync(path.join(root, 'src/panel-settings.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '');
  vm.runInContext(source, context);

  context.applyDisplayPreferences();
  assert.equal(properties.get('--alb-cover-size'), '120px');
  assert.equal(properties.get('--alb-cover-sat'), '75%');
  assert.equal(classes.get('album-labels-hidden'), true);
  assert.equal(saves, 0);
  assert.equal(properties.get('--alb-dim-opacity'), (1 - 0.70 * 25 / 100).toFixed(3));
  assert.equal(classes.get('albums-always-dimmed'), true);

  context.applyDimAmount(0);
  assert.equal(classes.get('albums-no-hover'), true);
  context.applyCoverSaturation(100);
  assert.equal(classes.get('albums-custom-saturation'), false);
});

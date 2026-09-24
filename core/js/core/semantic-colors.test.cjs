const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('Core colors migrate, persist, and share subscriptions through the price-color names', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-colors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const file of ['persist.js', 'core/semantic-colors.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(dir, file));
  }
  const stored = new Map([['samsara_v4', JSON.stringify({ chartLineColorUp: '#112233', chartLineColorDown: '#445566' })]]);
  global.window = new EventTarget();
  global.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  t.after(() => { delete global.window; delete global.localStorage; });
  const loadModule = file => import(pathToFileURL(path.join(dir, file)).href);
  const core = await loadModule('core/semantic-colors.js');
  const persist = await loadModule('persist.js');
  persist.load();
  assert.equal(core.getSemanticColors().positive, '#112233');
  assert.equal(core.getSemanticColors().negative, '#445566');
  const seen = [];
  const stop = core.onPriceColorChange(colors => seen.push(colors));
  core.setSemanticColor('neutral', '#abcdef');
  core.setPriceColorUp('#123456');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].neutral, '#abcdef');
  assert.equal(core.colorForChange(0), '#abcdef');
  assert.equal(core.colorForChange(null), '#abcdef');
  assert.equal(core.colorForChange(NaN), '#abcdef');
  assert.equal(core.colorForChange(0, 'transparent'), 'transparent');
  assert.equal(core.colorForChange(1), '#123456');
  assert.equal(core.colorForChange(-1), '#445566');
  stop();
  core.setSemanticColor('negative', '#654321');
  assert.equal(seen.length, 2);
  core.setSemanticColor('neutral', 'invalid');
  assert.equal(core.getSemanticColors().neutral, '#abcdef');
  // Colour changes are batched; nothing is written until the batch flushes.
  assert.equal(stored.get('samsara_v4').includes('coreState'), false);
  assert.equal(persist.flushPendingSave(), true);
  const saved = JSON.parse(stored.get('samsara_v4'));
  assert.equal(saved.coreState['semantic-colors'].data.neutral, '#abcdef');
  // Rehydration must prefer the Core settings over the old flat values.
  persist.load();
  assert.deepEqual(core.getSemanticColors(), { positive: '#123456', negative: '#654321', neutral: '#abcdef' });
});

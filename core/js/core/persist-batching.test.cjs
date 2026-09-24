const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('scheduled saves coalesce, explicit saves write immediately, unload flushes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-persist-batching-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, '..', 'persist.js'), path.join(dir, 'persist.js'));
  let writes = 0;
  global.window = new EventTarget();
  global.localStorage = { getItem: () => null, setItem: () => { writes++; } };
  t.after(() => { delete global.window; delete global.localStorage; });
  const persist = await import(pathToFileURL(path.join(dir, 'persist.js')).href);
  const prefs = persist.registerStateNamespace('batching-test', { defaults: { value: 0 } });
  persist.load();

  for (let i = 1; i <= 20; i++) { prefs.value = i; persist.scheduleSave(20); }
  assert.equal(writes, 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(writes, 1, 'a burst of scheduled saves produces one write');

  persist.scheduleSave(1000);
  persist.save();
  assert.equal(writes, 2, 'save() writes immediately');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(persist.flushPendingSave(), false, 'save() absorbs the pending scheduled write');

  persist.scheduleSave(1000);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(writes, 3, 'unload flushes a pending write');
  assert.equal(persist.flushPendingSave(), false);
});

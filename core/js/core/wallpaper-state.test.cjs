// The Wallpaper service's saved state without the see-through window (Atmos
// 0.24, state version 3): `mode` and `opacity` dropped, and removed kept by
// its own flag. Loads Core's persist.js and the service's persist.js as the
// page does, against a saved blob.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const core = path.join(__dirname, '..', '..');

/** A fresh page: Core's persist and the service's, loaded over `saved` (what localStorage holds). */
async function loadWallpaper(t, saved, legacy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-wallpaper-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(core, 'js', 'persist.js'), path.join(dir, 'core-persist.js'));
  const source = fs.readFileSync(path.join(core, 'system', 'wallpaper', 'persist.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'wallpaper-persist.js'), source.replace("from 'atmos-core/persist.js'", "from './core-persist.js'"));
  const storage = new Map(Object.entries({ ...legacy, ...(saved ? { samsara_v4: JSON.stringify(saved) } : {}) }));
  global.window = new EventTarget();
  global.localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  t.after(() => { delete global.window; delete global.localStorage; });
  const persist = await import(pathToFileURL(path.join(dir, 'core-persist.js')).href);
  const wallpaper = await import(pathToFileURL(path.join(dir, 'wallpaper-persist.js')).href);
  persist.load();
  const stored = () => JSON.parse(storage.get('samsara_v4') || '{}');
  return { state: wallpaper.wallpaperState, persist, storage, stored };
}

const as023 = data => ({ extensionState: { wallpaper: { version: 2, data } } });

test('0.23\'s Remove (See-through at 0%, removed) stays removed, without mode or opacity', async t => {
  const { state, persist, stored } = await loadWallpaper(t, as023({ mode: 'transparent', opacity: 0, wallpaperRemoved: true, vignette: 40 }));
  assert.equal(state.wallpaperRemoved, true);
  assert.equal(state.vignette, 40, 'the rest is kept');
  assert.ok(!('mode' in state) && !('opacity' in state));
  persist.save();
  assert.equal(stored().extensionState.wallpaper.version, 3);
  assert.deepEqual(Object.keys(stored().extensionState.wallpaper.data).filter(key => key === 'mode' || key === 'opacity'), []);
});

test('an image chosen after a Remove (See-through at 0%, the flag cleared) is not removed', async t => {
  const { state } = await loadWallpaper(t, as023({ mode: 'transparent', opacity: 0, wallpaperRemoved: false }));
  assert.equal(state.wallpaperRemoved, false);
});

test('See-through at 0% saved before the removed flag existed is removed; any other mode is not', async t => {
  assert.equal((await loadWallpaper(t, as023({ mode: 'transparent', opacity: 0 }))).state.wallpaperRemoved, true);
  assert.equal((await loadWallpaper(t, as023({ mode: 'transparent', opacity: 40 }))).state.wallpaperRemoved, false);
  assert.equal((await loadWallpaper(t, as023({ mode: 'wallpaper', opacity: 100 }))).state.wallpaperRemoved, false);
});

test('version 3 is taken as it is', async t => {
  const { state } = await loadWallpaper(t, { extensionState: { wallpaper: { version: 3, data: { wallpaperRemoved: false, hue: 20 } } } });
  assert.equal(state.wallpaperRemoved, false);
  assert.equal(state.hue, 20);
});

test('the Background plugin\'s See-through at 0% comes over as removed', async t => {
  const { state } = await loadWallpaper(t, { extensionState: { background: { version: 1, data: { mode: 'transparent', opacity: 0, vignette: 10 } } } });
  assert.equal(state.wallpaperRemoved, true);
  assert.equal(state.vignette, 10);
  assert.ok(!('mode' in state));
});

test('the oldest Atmos\'s See-through or Wallpaper choice is cleared, and changes nothing', async t => {
  const { state, storage } = await loadWallpaper(t, null, { atmos_background_mode: 'transparent' });
  assert.equal(storage.has('atmos_background_mode'), false);
  assert.equal(state.wallpaperRemoved, false);
  assert.ok(!('mode' in state));
});

test('the fake Atmos takes a mode of \'transparent\' and reports what Atmos does (SDK 1.7)', async () => {
  const { createFakeAtmos } = await import(pathToFileURL(path.join(core, 'js', 'sdk', 'testing', 'fake-atmos.mjs')).href);
  const atmos = createFakeAtmos({ permissions: { invokes: ['service:wallpaper'] }, wallpaper: { mode: 'transparent', opacity: 0, thumbnail: 'data:,' } });
  assert.deepEqual(await atmos.wallpaper.get(), { thumbnail: 'data:,', mode: 'wallpaper', opacity: 100, canRestore: false });
  atmos.fake.setWallpaper({ mode: 'transparent', opacity: 30 });
  assert.deepEqual(await atmos.wallpaper.get(), { thumbnail: null, mode: 'wallpaper', opacity: 100, canRestore: false });
});

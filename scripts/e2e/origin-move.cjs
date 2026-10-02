// Moving official extensions' storage out of the shared first-party origin
// into origins of their own (Atmos 0.12):
//
//  1. As before 0.12: Finance and Audio Player without
//     "isolation", all in atmos-ext://first-party. Data is left there in each
//     one's declared databases and keys (a Blob and an ArrayBuffer among
//     them), plus a database and a key nobody declares, and a value in
//     Audio Player's atmos.state.
//  2. The current manifests, with the move made to time out: each runs
//     from the shared origin once more (its data is still there), Settings
//     says why, and the move is recorded as failed.
//  3. Normal start: the data is copied into each extension's own origin
//     (Blobs and all), recorded as copied, its frames run there and read
//     it; the shared copies are still there; the state value is kept.
//  4. Next start: the shared copies of what was moved are gone, what nobody
//     declared is still there, the moved data is intact.
//
// Usage: node scripts/e2e/origin-move.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const { isolatedEnv, savedFrameState, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'origin-move'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-origin-move-');
const MOVED = ['finance', 'audio-player'];

// "Before": the bundled extensions as they were, sharing one origin.
const before = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-before-'));
for (const kind of ['plugins', 'services']) {
  fs.cpSync(path.join(repo, kind), path.join(before, kind), { recursive: true, filter: src => !/node_modules|[\\/]tests[\\/]|_to_delete|backups/.test(src) });
}
for (const id of MOVED) {
  const file = path.join(before, 'plugins', id, 'extension.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete manifest.isolation;
  delete manifest.legacyStorage.sharedOrigin;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

async function launch(root, extra = []) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${root}`, ...extra, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  if (process.env.E2E_LOGS) { app.process().stdout.on('data', d => process.stderr.write(d)); app.process().stderr.on('data', d => process.stderr.write(d)); }
  const page = await atmosWindow(app);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/TUNNEL|Failed to load resource|rate fetch|ERR_NAME|net::|VPS unavailable/.test(m.text())) errors.push(m.text()); });
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { app, page, logs, errors };
}
const origins = page => page.evaluate(async ids => {
  const plugins = await window.atmosCore.listPlugins();
  return Object.fromEntries(ids.map(id => [id, plugins.find(p => p.id === id)?.frame?.origin ?? null]));
}, MOVED);
/** A frame evaluation that gives up after 15 s instead of hanging the run. */
const within = (promise, what) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(`timed out: ${what}`), 15000))]);
const bootFrame = (page, id) => page.frames().find(f => f.url().includes(`ext=plugin%3A${id}`) && f.url().includes('surface=boot'));
async function waitBoot(page, id) {
  for (let i = 0; i < 100; i += 1) { const frame = bootFrame(page, id); if (frame) return frame; await page.waitForTimeout(100); }
  return null;
}

/** What a frame's origin holds: database names with record counts, and localStorage keys. */
const inventory = frame => within(frame.evaluate(async () => {
  const count = name => new Promise(resolve => {
    const request = indexedDB.open(name);
    request.onsuccess = async () => {
      const db = request.result;
      let total = 0;
      for (const store of db.objectStoreNames) {
        total += await new Promise(done => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => done(r.result); r.onerror = () => done(-1); });
      }
      db.close();
      resolve(total);
    };
    request.onerror = () => resolve(-1);
  });
  const databases = {};
  for (const { name } of await indexedDB.databases()) if (name) databases[name] = await count(name);
  return { databases, keys: Object.keys(localStorage).sort() };
}), 'inventory');

/**
 * The shared first-party origin's contents as extension frames see them: a
 * frame of that origin inside a hidden Atmos page (Chromium keys a frame's
 * storage by the page it is in, so a top-level page of that origin would
 * see other storage). Nothing of an extension runs there any more.
 */
const sharedInventory = app => app.evaluate(async ({ WebContentsView }) => {
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  try {
    await view.webContents.loadURL('atmos-app://local/__atmos/storage.html');
    await view.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.onload = resolve;
      frame.src = 'atmos-ext://first-party/__atmos/blank.html';
      document.body.append(frame);
    })`);
    const frame = view.webContents.mainFrame.frames[0];
    return await frame.executeJavaScript(`(async () => {
      const names = (await indexedDB.databases()).map(db => db.name).filter(Boolean).sort();
      return { databases: names, keys: Object.keys(localStorage).sort() };
    })()`);
  } finally { view.webContents.close(); }
});

const movesRecord = () => {
  try { return JSON.parse(fs.readFileSync(path.join(installRoot, 'extension-origin-moves.json'), 'utf8')).moves; } catch { return null; }
};
const summarize = moves => moves && Object.fromEntries(Object.entries(moves).map(([ref, move]) => [ref, {
  status: move.status, copied: move.copied, cleaned: !!move.cleaned, error: move.error ? move.error.slice(0, 60) : undefined,
}]));

/** What each moved extension reads in its own origin. */
const readMoved = async page => ({
  'audio-player': await within((await waitBoot(page, 'audio-player'))?.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'audio-player') && new Promise(resolve => {
    const request = indexedDB.open('audio-player');
    request.onsuccess = () => {
      const store = request.result.transaction('assets').objectStore('assets');
      const blob = store.get('e2e-blob');
      blob.onsuccess = () => {
        const json = store.get('e2e-json');
        json.onsuccess = async () => resolve({ blob: blob.result instanceof Blob ? `${blob.result.type} ${blob.result.size} ${await blob.result.text()}` : null, json: json.result });
      };
    };
    request.onerror = () => resolve('error');
  })).catch(e => e.message), 'audio-player'),
  finance: await within((await waitBoot(page, 'finance'))?.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'finance-assets') && new Promise(resolve => {
    const request = indexedDB.open('finance-assets');
    request.onsuccess = () => {
      const get = request.result.transaction('assets').objectStore('assets').get('e2e-asset');
      get.onsuccess = () => resolve({ asset: get.result ?? null, state: localStorage.getItem('finance:state:e2e'), charting: localStorage.getItem('atmos:charting-e2e'), unrelated: localStorage.getItem('unrelated:key') });
    };
    request.onerror = () => resolve('error');
  })).catch(e => e.message), 'finance'),
});

(async () => {
  const r = { home };
  const progress = () => fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(r, null, 1));

  // 1. Before 0.12: one shared origin. Leave data there.
  let s = await launch(before);
  r['1-origins'] = await origins(s.page);
  const player = await waitBoot(s.page, 'audio-player');
  await player.evaluate(async () => {
    const put = (name, store, entries) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(store);
      request.onsuccess = () => {
        const tx = request.result.transaction(store, 'readwrite');
        for (const [key, value] of entries) tx.objectStore(store).put(value, key);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    await put('audio-player', 'assets', [['e2e-blob', new Blob(['hello blob'], { type: 'text/plain' })], ['e2e-json', { tracks: 3 }]]);
    await put('finance-assets', 'assets', [['e2e-asset', 'kept']]);
    await put('unrelated-db', 'things', [['a', 1]]);
    localStorage.setItem('finance:state:e2e', '1');
    localStorage.setItem('atmos:charting-e2e', '{"x":1}');
    localStorage.setItem('unrelated:key', 'stays');
    const { default: atmos } = await import('atmos-sdk');
    await atmos.state.update({ e2eMarker: 'kept' });
  });
  r['1-shared'] = await inventory(player);
  await s.page.waitForTimeout(600);
  await s.app.close();
  progress();

  // 2. The current manifests, but the move times out: the shared origin once more.
  s = await launch(repo, ['--origin-move-timeout=1']);
  r['2-origins'] = await origins(s.page);
  r['2-moves'] = summarize(movesRecord());
  r['2-problems'] = await s.page.evaluate(async () => (await window.atmosCore.extensionManager.status()).summary.problems.map(p => `${p.id}: ${p.reason.slice(0, 50)}`));
  r['2-finance'] = (await readMoved(s.page)).finance;
  r['2-errors'] = s.errors;
  await s.app.close();
  progress();

  // 3. The move: copied into each one's own origin.
  s = await launch(repo);
  r['3-origins'] = await origins(s.page);
  r['3-moves'] = summarize(movesRecord());
  progress();
  r['3-read'] = await readMoved(s.page);
  progress();
  r['3-own'] = Object.fromEntries(await Promise.all(MOVED.map(async id => [id, await inventory(await waitBoot(s.page, id))])));
  r['3-shared'] = await sharedInventory(s.app);
  r['3-state'] = savedFrameState(installRoot, 'plugin', 'audio-player')?.e2eMarker ?? null;
  r['3-errors'] = s.errors;
  await s.page.screenshot({ path: path.join(out, '30-moved.png') });
  await s.app.close();

  // 4. The next start: the shared copies are gone; the rest stays.
  s = await launch(repo);
  await s.page.waitForTimeout(1500); // the clean-up runs once the window is up
  r['4-shared'] = await sharedInventory(s.app);
  r['4-moves'] = summarize(movesRecord());
  r['4-read'] = await readMoved(s.page);
  r['4-errors'] = s.errors;
  await s.app.close();

  console.log(JSON.stringify(r, null, 1));
})().catch(error => { console.error(error); process.exit(1); });

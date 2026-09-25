'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveMedia } = require('../src/media-resource.cjs');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const importSource = file => import(`data:text/javascript;base64,${Buffer.from(source(file)).toString('base64')}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const decoded = value => ({ getChannelData: () => new Float32Array(1000).fill(value) });

test('a slower old waveform cannot overwrite the current track or cache', async () => {
  const { createWaveformLoader } = await importSource('src/waveform-loader.js');
  const old = deferred();
  const current = deferred();
  const published = [], stored = [];
  const loader = createWaveformLoader({
    getContext: () => ({ decodeAudioData: id => id === 'old' ? old.promise : current.promise }),
    getCached: () => null, store: key => stored.push(key), publish: data => published.push(data),
  });
  const first = loader.load({ arrayBuffer: async () => 'old' }, 'old');
  await Promise.resolve();
  const second = loader.load({ arrayBuffer: async () => 'current' }, 'current');
  await Promise.resolve();
  current.resolve(decoded(0.75));
  await second;
  old.resolve(decoded(0.25));
  await first;
  assert.equal(published.at(-1)[0], 0.75);
  assert.deepEqual(stored, ['current']);
});

test('cached selection supersedes pending decode and deferred context work', async () => {
  const { createWaveformLoader } = await importSource('src/waveform-loader.js');
  let context = null, data, decodes = 0;
  const loader = createWaveformLoader({
    getContext: () => context, getCached: key => key === 'cached' ? [0.5] : null,
    store() {}, publish: value => { data = value; },
  });
  await loader.load({ arrayBuffer: async () => 'old' }, 'old');
  await loader.load('cached-url', 'cached');
  context = { decodeAudioData: async () => { decodes++; return decoded(1); } };
  await loader.resume();
  assert.equal(decodes, 0);
  assert.equal(data[0], 0.5);
});

test('changing tracks aborts waveform fetch; stale errors do not clear the new waveform', async () => {
  const { createWaveformLoader } = await importSource('src/waveform-loader.js');
  const pending = deferred();
  let signal, data;
  const loader = createWaveformLoader({
    getContext: () => ({}), getCached: key => key === 'new' ? [1] : null,
    store() {}, publish: value => { data = value; },
    fetchAudio: (_url, options) => { signal = options.signal; return pending.promise; },
  });
  const first = loader.load('old', 'old');
  await loader.load('new', 'new');
  assert.equal(signal.aborted, true);
  pending.reject(new Error('aborted'));
  await first;
  assert.equal(data[0], 1);
});

test('startup restores only the selected source after cache and library readiness', async () => {
  const { restorePlayback } = await importSource('src/restore-playback.js');
  const cache = deferred(), library = deferred(), calls = [];
  const restoring = restorePlayback({
    saved: { trackKey: 'album/track', trackPos: 15 },
    loadCache: () => cache.promise, restoreLibrary: () => library.promise,
    loadFiles: async () => { throw Error('must not load stale uploads'); },
    restoreFiles: () => assert.fail('wrong source'),
    restoreLibraryTrack: async (key, pos) => calls.push([key, pos]),
    isCurrent: () => true, reportError: error => { throw error; },
  });
  library.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  cache.resolve();
  await restoring;
  assert.deepEqual(calls, [['album/track', 15]]);
});

test('user interaction supersedes a slow uploaded-playlist restore', async () => {
  const { restorePlayback } = await importSource('src/restore-playback.js');
  const files = deferred();
  let current = true;
  const restoring = restorePlayback({
    saved: {}, loadCache: async () => {}, restoreLibrary: async () => {},
    loadFiles: () => files.promise, restoreFiles: () => assert.fail('overwrites user'),
    isCurrent: () => current, reportError: error => { throw error; },
  });
  await Promise.resolve();
  current = false;
  files.resolve(['old']);
  await restoring;
});

test('media streaming supports full, bounded, suffix, empty, HEAD and invalid ranges', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.mp3');
  fs.writeFileSync(file, '0123456789');
  const get = (range, method = 'GET', filename = file) => serveMedia(
    new Request('https://audio.test/track', { method, headers: range ? { range } : {} }),
    filename, new Set(['mp3']), () => 'audio/mpeg');
  for (const [range, status, body] of [[null, 200, '0123456789'], ['bytes=2-4', 206, '234'],
    ['bytes=7-', 206, '789'], ['bytes=-3', 206, '789'], ['bytes=-30', 206, '0123456789'],
    ['bytes=8-99', 206, '89']]) {
    const response = await get(range);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-length'), String(body.length));
    assert.equal(await response.text(), body);
  }
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=5-2', 'bytes=0-1,3-4']) {
    const response = await get(range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  const head = await get(null, 'HEAD');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await get(null, 'GET', path.join(dir, 'missing.mp3'))).status, 404);
  assert.equal((await get(null, 'GET', 'relative.mp3')).status, 400);
  fs.writeFileSync(file, '');
  assert.equal(await (await get()).text(), '');
  assert.equal((await get('bytes=0-')).status, 416);
});

test('cancelling a media response releases the file stream', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'large.mp3');
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  const response = await serveMedia(new Request('https://audio.test/track'), file, new Set(['mp3']), () => 'audio/mpeg');
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length < 1024 * 1024);
  await reader.cancel();
});

test('async directory handlers preserve direct-file and recursive-tree semantics', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'album'));
  fs.writeFileSync(path.join(dir, 'root.mp3'), '');
  fs.writeFileSync(path.join(dir, 'album', 'track.flac'), '');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), '');
  const handlers = {};
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-userdata-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  let media = null;
  require('../main.cjs')({ handle: (name, fn) => { handlers[name] = fn; }, registerResourceProvider: (_name, fn) => { media = fn; }, app: { getPath: () => userData } });
  const stream = pathname => media({ request: new Request('atmos-resource://audio-player-media/x'), pathname });
  assert.equal((await stream(path.join(dir, 'root.mp3'))).status, 403, 'no streaming outside the library');
  // Outside the folders you picked, nothing is readable.
  await assert.rejects(handlers['list-files'](null, dir, ['mp3']), /not in your music library/);
  await assert.rejects(async () => handlers['directory-exists'](null, dir), /not in your music library/);
  handlers['adopt-folders'](null, [dir]);
  assert.equal(handlers['directory-exists'](null, dir), true);
  const files = await handlers['list-files'](null, dir, ['mp3', 'flac']);
  assert.deepEqual(files, [path.join(dir, 'root.mp3')]);
  assert.equal((await stream(path.join(dir, 'root.mp3'))).status, 200, 'tracks in the library stream');
  assert.equal((await stream(path.join(dir, '..', 'elsewhere.mp3'))).status, 403, '.. cannot leave the library');
  const tree = await handlers['list-dir-tree'](null, dir, ['mp3', 'flac']);
  assert.equal(tree.length, 2);
  assert.ok(tree.every(entry => entry.hasMatchingFiles));
});

test('concurrent tracks in one album share a single artwork conversion', async () => {
  const grouping = await importSource('src/metadata-grouping.js');
  const library = source('src/library.js');
  const code = library.slice(library.indexOf('async function batchProcess('), library.indexOf('// ── Add / remove folders'));
  let conversions = 0;
  const state = { library: { albums: {}, folders: [] } };
  const dependencies = {
    BATCH_SIZE: 2, library: state.library,
    _readTagsWithFallback: async () => ({ artist: 'Artist', album: 'Album', picture: { data: [1] } }),
    ...grouping, albumKey: grouping.albumKey, _stripFeat: grouping.stripFeaturedArtists,
    picToDataUrl: async () => { conversions++; await Promise.resolve(); return 'data:cover'; },
    setLibStatus() {}, setLibProgress() {}, invalidateAlbumsCache() {},
    mergeCompilations: grouping.mergeSplitAlbums, persistLibrary() {}, announce() {}, setTimeout() {},
  };
  const build = new Function('deps', `const { ${Object.keys(dependencies).join(',')} } = deps; ${code}; return buildFromFiles;`)(dependencies);
  await build([1, 2, 3].map(i => ({ key: `album/${i}.mp3`, filePath: `C:/music/album/${i}.mp3` })));
  assert.equal(conversions, 1);
  const albums = Object.values(state.library.albums);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].tracks.length, 3);
  assert.equal(albums[0].cover, 'data:cover');
});

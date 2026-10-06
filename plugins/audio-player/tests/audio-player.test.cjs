'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function importSource(file) {
  const source = read(file);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}


const manifest = () => JSON.parse(read('extension.json'));
const sources = () => fs.readdirSync(root, { recursive: true })
  .filter(file => /\.(js|cjs)$/.test(file) && !file.startsWith('tests') && !file.includes('node_modules'))
  .map(file => [file, read(file)]);

test('runs in frames: drawer panel, Queue and Library widgets, a boot frame with Space', () => {
  const m = manifest();
  assert.equal(m.apiVersion, 4);
  assert.equal(m.runtime, 'frame');
  assert.equal(m.requires['extensions.frames'], 3);
  assert.deepEqual(m.contributes.panel.drawer, { bar: 54, keys: true });
  // Not the panel Atmos opens on any more: Atmos Browser, built in, is (Atmos 0.18).
  assert.equal(m.contributes.panel.default, undefined);
  // Same widget ids as before frames (audio-player-queue, -library), so
  // saved sidebar layouts still apply. Now Playing (audio-player) is the
  // Now Playing service's since Audio Player 1.2.0, under the same id.
  assert.deepEqual(m.contributes.sidebar.map(item => item.legacyId ?? `audio-player-${item.id}`), ['audio-player-queue', 'audio-player-library']);
  assert.deepEqual(m.contributes.boot, { entry: 'boot.js', keys: ['Space'] });
  assert.deepEqual([...m.permissions.invokes].sort(), ['service:audio', 'service:media-metadata', 'service:now-playing', 'service:wallpaper']);
  assert.deepEqual(m.permissions.resources, ['audio-player-media']);
  assert.deepEqual(m.legacyStorage.indexedDB, [{ name: 'samsara_db', keys: ['audio-player:*', 'library-meta', 'waveform-cache', 'playlist'] }]);
});

test('talks to Atmos only through the SDK', () => {
  for (const [file, text] of sources()) {
    if (file === 'main.cjs' || file.endsWith('.cjs')) continue;
    assert.doesNotMatch(text, /atmos-core\//, `${file} imports Core`);
    assert.doesNotMatch(text, /window\.atmos\b|window\.atmosCore|atmos-service:\/\//, `${file} reaches for page globals`);
    assert.doesNotMatch(text, /localStorage\./, `${file} uses localStorage`);
  }
  assert.match(read('src/fs-bridge.js'), /atmos\.invoke\('plugin:audio-player'/);
  assert.match(read('src/media-metadata.js'), /atmos\.library\('service:media-metadata', 'renderer\.js'\)/);
  assert.match(read('main.cjs'), /registerResourceProvider\('audio-player-media'/);
});

test('sound comes from the Audio service; the engine owns the queue', () => {
  const engine = read('src/engine.js');
  assert.match(engine, /const audio = atmos\.audio;/);
  assert.match(engine, /audio\.load\(track\.source, \{ id: track\.key \|\| track\.name, position, play \}\)/);
  assert.match(engine, /value\.type === 'ended'\) \{[^}]*getNextIndex\(\{ ended: true \}\)/);
  assert.match(engine, /atmos\.surface\.onKey\(\(\{ code \}\) => \{ if \(code === 'Space'\) void togglePlay\(\); \}\)/);
  assert.match(engine, /await atmos\.expose\(\{/);
  assert.doesNotMatch(engine, /document\.createElement\('audio'\)|new Audio\(/);
  // Views never play anything themselves.
  for (const file of ['src/player-view.js', 'src/client.js', 'sidebar-queue.js', 'sidebar-library.js']) {
    assert.doesNotMatch(read(file), /atmos\.audio\.(load|play|pause|seek|setVolume)\(/, file);
  }
});

test('the engine saves playback keys, views save display keys', () => {
  const state = read('src/state.js');
  assert.match(state, /ENGINE_KEYS = Object\.freeze\(\['vol', 'shuffleOn', 'repeatMode', 'trackIdx', 'trackPos', 'trackKey', 'electronFolders'\]\)/);
  assert.match(state, /atmos\.state\.update\(patch\)/);
  assert.doesNotMatch(state, /atmos\.state\.set\(/);
  assert.match(read('boot.js'), /loadState\(\{ keep: ENGINE_KEYS \}\)/);
  assert.match(read('src/store.js'), /atmos\.legacy\.readIndexedDB\('samsara_db'\)/);
  assert.match(read('src/store.js'), /records\.get\(`audio-player:\$\{name\}`\) \?\? records\.get\(name\)/);
});

test('the drawer is Atmos\'s; the old position is handed over once', () => {
  const view = read('src/player-view.js');
  assert.match(view, /atmos\.drawer\.onChange\(applyDrawerState\)/);
  assert.match(view, /atmos\.drawer\.setPlacement\(audioState\.drawerPlacement\)/);
  assert.match(view, /audioState\.drawerHandedOver = true/);
  assert.match(view, /content\.dataset\.atmosDrawerScroll = ''/);
  assert.equal(fs.existsSync(path.join(root, 'src/drawer.js')), false);
});

test('compact widths preserve primary transport controls and waveform space', () => {
  const css = read('assets/panel.css');
  assert.match(css, /#ap-bar \{ container-type:inline-size; \}/);
  assert.match(css, /@container \(max-width: 800px\)/);
  assert.match(css, /#mp-shuffle-btn, #mp-repeat-btn, #mp-vol-pct \{ display:none; \}/);
  assert.match(css, /#mp-vol-track, #mp-mute-btn \{ display:none; \}/);
  assert.match(css, /@container \(max-width: 250px\)[^{]*\{[^}]*#mp-seek-row \{ display:none; \}/s);
  assert.match(css, /@container \(max-width: 440px\)[\s\S]*#mp-left \{ display:none; \}/);
  assert.doesNotMatch(css, /#mp-prev-btn[^}]+display:none|#mp-pp-main[^}]+display:none|#mp-next-btn[^}]+display:none/);
});

test('the bar and browser tint over the glass Atmos draws behind the frame', () => {
  const css = read('assets/panel.css');
  const template = read('src/panel-template.js');
  assert.match(css, /#ap-bar::before,\s*\.audio-player-panel-bar::before \{[^}]*background:rgba\(var\(--surface-rgb,[^)]+\),var\(--shell-opacity, \.88\)\)/);
  assert.doesNotMatch(css, /#ap-bar,\s*\.audio-player-panel-bar \{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /#mp-browser \{[^}]*backdrop-filter/);
  assert.match(css, /#mp-browser \{[^}]*height:var\(--atmos-drawer-visible-h, calc\(100vh - 54px\)\)/);
  assert.doesNotMatch(template, /mp-dock-blur/);
  assert.doesNotMatch(css, /mp-dock-blur|pending-close|\.ap-surface/);
});

test('menus keep their controls: waveform appearance and cover appearance', () => {
  const view = read('src/player-view.js');
  assert.match(view, /type: 'heading', label: 'Waveform Appearance'/);
  assert.match(view, /id: 'wave-dock', type: 'toggle', label: 'Dock Player'/);
  assert.match(view, /type: 'number', label: 'Refresh Rate'/);
  assert.match(view, /type: 'colors', label: 'Gradient'/);
  assert.match(view, /type: 'heading', label: 'Cover Appearance'/);
  assert.match(view, /type: 'range', label: 'Cover Size'/);
  assert.match(view, /zeroLabel: 'Off'/);
  assert.match(read('sidebar-queue.js'), /label: 'Show in Explorer'/);
});

test('Atmos\'s command bar opens over the player bar; rev/ in the search goes to it', () => {
  const view = read('src/player-view.js');
  assert.match(view, /atmos\.commands\.bar\(bar\)/);
  assert.match(view, /atmos\.commands\.field\(search\);\r?\n  search\.addEventListener\('input'/, 'before the search\'s own listener, so rev/ never filters the grid');
  assert.match(read('src/engine.js'), /handleCommands\(\{ togglePlay, playNext, playPrev, playTrack, playAlbum, status \}\)/, 'answered in the background frame');
});

test('typing searches the library, in the panel or on the workspace', () => {
  const view = read('src/player-view.js');
  assert.match(view, /function typeToSearch\(key\)/);
  assert.match(view, /if \(!browserOpen\) openBrowser\(\)/);
  assert.match(view, /lastQuery \+= key/);
  assert.match(view, /atmos\.drawer\.onKey\(\(\{ key \}\) => typeToSearch\(key\)\)/);
});

test('double-clicking an album starts it without leaving the grid; failures keep the grid', () => {
  const view = read('src/player-view.js');
  assert.match(view, /card\.addEventListener\('dblclick'[\s\S]*?void playAlbum\(album, 0\)/);
  assert.match(view, /Track unavailable — rescan the library/);
});

test('the waveform paints only while it can change, at the chosen rate', () => {
  const view = read('src/player-view.js');
  const css = read('assets/panel.css');
  assert.match(view, /function vizTick\(timestamp\) \{\s*vizRaf = null;/);
  assert.match(view, /1000 \/ Math\.max\(1, Math\.min\(1000, Number\(audioState\.waveformFps\) \|\| 5\)\)/);
  assert.match(view, /if \(canPaintViz\(\) && player\.playback\.playing\) vizRaf = requestAnimationFrame\(vizTick\)/);
  assert.match(view, /vizCanvas\?\.isConnected && !document\.hidden/);
  assert.match(css, /\.mp-alb-card \{[^}]*content-visibility:auto/);
  assert.match(css, /#mp-album-grid\.is-scrolling \.mp-alb-card/);
});

test('what plays goes to Now Playing, and its controls come back here', () => {
  const engine = read('src/engine.js');
  const manifest = JSON.parse(read('extension.json'));
  assert.ok(manifest.permissions.invokes.includes('service:now-playing'));
  assert.deepEqual(manifest.dependencies['now-playing'], { version: '^1.0.0', optional: true, recommended: true }, 'installed with Music, removable');
  assert.equal(manifest.engines.atmos, '>=0.21.0', 'atmos.nowPlaying is SDK 1.4 (Atmos 0.21.0)');
  // Its own Now Playing widget went to the service; the Queue keeps the id it had.
  assert.deepEqual(manifest.contributes.sidebar.map(widget => widget.label), ['Queue', 'Library']);
  assert.equal(manifest.contributes.sidebar[0].legacyId, 'audio-player-queue');
  assert.ok(!fs.existsSync(path.join(root, 'sidebar.js')));
  assert.match(engine, /atmos\.nowPlaying\?\.onControl\(onNowPlayingControl\)/);
  assert.match(engine, /actions: NOW_PLAYING_ACTIONS/);
  assert.match(engine, /published\?\.fingerprint === fingerprint && Math\.abs\(position - expected\) < 2\) return;/, 'not every tick: only what changed, or a jump');
});

test('metadata grouping preserves releases, discs, and repeated titles', async () => {
  const { albumKey, compareTracks, mergeSplitAlbums, metadataNumber, metadataReleaseDate, releaseScope } = await importSource('src/metadata-grouping.js');

  assert.equal(metadataNumber({ track: 7, total: 12 }), 7);
  assert.equal(metadataNumber({ disk: 2, total: 3 }), 2);
  assert.equal(metadataReleaseDate('2024-7-18'), '2024-07');
  assert.equal(metadataReleaseDate('March 2021'), '2021-03');
  assert.equal(metadataReleaseDate('1998'), '1998');
  assert.equal(releaseScope("Artist/Album/12''1/01.flac"), releaseScope("Artist/Album/12''2/02.flac"));
  assert.equal(releaseScope('Artist/Album/(One)/01.flac'), releaseScope('Artist/Album/(Two)/02.flac'));

  assert.equal(
    albumKey('Beyonce\u0301', 'Album\u200b', '', 'Artist/Album/01.mp3'),
    albumKey('Beyonc\u00e9', 'Album', '', 'Artist/Album/02.mp3'),
  );

  const albums = {
    a: { album: 'Greatest Hits', artist: 'Singer A', tracks: [
      { key: 'Singer A/Greatest Hits/01.mp3', title: 'Intro', artist: 'Singer A', disc: 1, num: 1 },
    ] },
    b: { album: 'Greatest Hits', artist: 'Singer B', tracks: [
      { key: 'Singer B/Greatest Hits/01.mp3', title: 'Intro', artist: 'Singer B', disc: 1, num: 1 },
    ] },
  };
  mergeSplitAlbums(albums);
  assert.equal(Object.keys(albums).length, 2, 'same-named releases in different folders must remain separate');

  const compilation = {
    one: { album: 'Sampler', artist: 'Artist A', tracks: [
      { key: 'Samplers/Sampler/Disc 1/01.mp3', title: 'Theme', artist: 'Artist A', disc: 1, num: 1 },
      { key: 'Samplers/Sampler/Disc 1/01.mp3', title: 'Theme', artist: 'Artist A', disc: 1, num: 1 },
    ] },
    two: { album: 'Sampler', artist: 'Artist B', tracks: [
      { key: 'Samplers/Sampler/Disc 2/01.mp3', title: 'Theme', artist: 'Artist B', disc: 2, num: 1 },
    ] },
  };
  mergeSplitAlbums(compilation);
  const merged = Object.values(compilation);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tracks.length, 2, 'same-titled tracks on different discs must both survive');
  assert.equal(merged[0].artist, 'Various Artists');
  assert.deepEqual(merged[0].tracks.sort(compareTracks).map(t => t.disc), [1, 2]);

  const titleVariants = {
    short: { album: 'Nothing Lasts', artist: 'Shpongle', tracks: [
      { key: 'Shpongle/Album/01.flac', title: 'A', artist: 'Shpongle', num: 1 },
    ] },
    long: { album: 'Nothing Lasts... But Nothing Is Lost', artist: 'Shpongle', tracks: [
      { key: 'Shpongle/Album/02.flac', title: 'B', artist: 'Shpongle', num: 2 },
    ] },
  };
  mergeSplitAlbums(titleVariants);
  assert.equal(Object.keys(titleVariants).length, 1);
  assert.equal(Object.values(titleVariants)[0].album, 'Nothing Lasts... But Nothing Is Lost');

  const editions = {
    vinyl: { album: 'Yanqui U.X.O.', artist: 'Godspeed You! Black Emperor', tracks: [
      { key: "Artist/Yanqui/12''1/01.flac", title: '09-15-00', artist: 'Godspeed You! Black Emperor', num: 1 },
      { key: "Artist/Yanqui/12''2/02.flac", title: 'Rockets Fall', artist: 'Godspeed You! Black Emperor', num: 2 },
    ] },
    cd: { album: 'Yanqui U.X.O.', artist: 'Godspeed You! Black Emperor', tracks: [
      { key: 'Artist/Yanqui CD/01.flac', title: '09-15-00', artist: 'Godspeed You! Black Emperor', num: 1 },
      { key: 'Artist/Yanqui CD/02.flac', title: 'Rockets Fall', artist: 'Godspeed You! Black Emperor', num: 2 },
      { key: 'Artist/Yanqui CD/03.flac', title: 'Motherfucker=Redeemer', artist: 'Godspeed You! Black Emperor', num: 3 },
    ] },
  };
  mergeSplitAlbums(editions);
  assert.equal(Object.keys(editions).length, 1);
  assert.deepEqual(Object.values(editions)[0].tracks.map(t => t.title), ['09-15-00', 'Rockets Fall', 'Motherfucker=Redeemer']);
});

test('metadata scans retain extended fields and sidecar artwork support', () => {
  const library = read('src/library.js');
  assert.match(library, /tags\.disc \|\| tags\.disk \|\| tags\.TPOS/);
  assert.match(library, /tags\.compilation \?\? tags\.TCMP \?\? tags\.cpil/);
  assert.match(library, /readCoverSidecar/);
  assert.match(read('main.cjs'), /read-cover-sidecar/);
  assert.match(read('main.cjs'), /choose-cover/);
  assert.match(read('main.cjs'), /defaultPath/);
  assert.match(read('main.cjs'), /cover\.webp/);
  assert.match(read('main.cjs'), /folder\.webp/);
  assert.match(read('main.cjs'), /read-tag-fallback/);
  assert.match(read('main.cjs'), /list-files/);
  assert.match(library, /audioFs\.listFiles/);
  assert.match(library, /_readTagsWithFallback/);
  assert.match(read('src/cover-editor.js'), /const mimeType = \/\^data:image\\\/png/);
});

test('native metadata fallbacks decode ID3 sizes and Vorbis comments', () => {
  const { parseVorbisComments, synchsafeSize } = require('../main.cjs')._test;
  assert.equal(synchsafeSize(Buffer.from([0, 0, 2, 0])), 256);

  const vendor = Buffer.from('Atmos');
  const comments = ['TITLE=Opening', 'ALBUMARTIST=Various Artists', 'DISCNUMBER=2', 'TRACKNUMBER=04'];
  const parts = [];
  const vendorLength = Buffer.alloc(4); vendorLength.writeUInt32LE(vendor.length);
  const count = Buffer.alloc(4); count.writeUInt32LE(comments.length);
  parts.push(vendorLength, vendor, count);
  for (const comment of comments) {
    const value = Buffer.from(comment);
    const length = Buffer.alloc(4); length.writeUInt32LE(value.length);
    parts.push(length, value);
  }
  const tags = parseVorbisComments(Buffer.concat(parts), 0);
  assert.equal(tags.title, 'Opening');
  assert.equal(tags.albumArtist, 'Various Artists');
  assert.equal(tags.disc, '2');
  assert.equal(tags.track, '04');
});

test('sidecar artwork reports WebP with the correct media type', () => {
  const { imageContentType } = require('../main.cjs')._test;
  assert.equal(imageContentType('cover.webp'), 'image/webp');
  assert.equal(imageContentType('cover.WEBP'), 'image/webp');
});

// IndexedDB with one store, kept in `data`; `fail.get` / `fail.put` make
// reads or writes fail.
function fakeIndexedDB() {
  const data = new Map();
  const fail = { get: false, put: false };
  const later = fn => setTimeout(fn, 0);
  const db = {
    objectStoreNames: ['assets'],
    createObjectStore() {},
    transaction() {
      const transaction = { error: null };
      const request = (failing, done) => {
        const req = {};
        later(() => {
          if (failing) { req.error = transaction.error = new Error('IndexedDB failed'); req.onerror?.(); transaction.onerror?.(); return; }
          req.result = done();
          req.onsuccess?.();
          transaction.oncomplete?.();
        });
        return req;
      };
      transaction.objectStore = () => ({
        get: key => request(fail.get, () => data.get(key)),
        put: (value, key) => request(fail.put, () => { data.set(key, value); }),
      });
      return transaction;
    },
  };
  const indexedDB = { open() { const req = { result: db }; later(() => { req.onupgradeneeded?.({ target: req }); req.onsuccess?.({ target: req }); }); return req; } };
  return { data, fail, indexedDB };
}

test('a copy from the page that fails is tried again next start (R16)', async () => {
  const vm = require('node:vm');
  const idb = fakeIndexedDB();
  let legacy = async () => { throw new Error('page not ready'); };
  const start = async () => {
    const context = vm.createContext({ indexedDB: idb.indexedDB, console: { ...console, warn() {}, error() {} }, setTimeout });
    const sdk = new vm.SyntheticModule(['default'], function () {
      this.setExport('default', { legacy: { readIndexedDB: (...args) => legacy(...args) } });
    }, { context });
    const store = new vm.SourceTextModule(read('src/store.js'), { context });
    await store.link(() => sdk);
    await store.evaluate();
    return store.namespace.copyFromPage();
  };
  await start();
  assert.equal(idb.data.get('copied-from-page'), undefined, "a failed read isn't done");
  legacy = async () => ({ stores: { assets: [['audio-player:playlist', ['a.mp3']], ['library-meta', { albums: { x: 1 }, folders: [] }]] } });
  idb.fail.put = true;
  await start();
  assert.equal(idb.data.get('copied-from-page'), undefined, "nor a failed write");
  idb.fail.put = false;
  idb.data.set('library-meta', { albums: {}, folders: ['mine'] });
  idb.fail.get = true;
  await start();
  assert.deepEqual(idb.data.get('library-meta'), { albums: {}, folders: ['mine'] }, "what couldn't be read isn't written over");
  idb.fail.get = false;
  assert.equal(await start(), true);
  assert.deepEqual(idb.data.get('playlist'), ['a.mp3']);
  assert.deepEqual(idb.data.get('library-meta'), { albums: {}, folders: ['mine'] }, 'kept: saved here already');
  assert.equal(idb.data.get('copied-from-page'), true);
  legacy = async () => { throw new Error('not asked again'); };
  assert.equal(await start(), false);
});

test('what plays next: repeat off stops at the end (R24)', async () => {
  const { nextIndex } = await importSource('src/queue.js');
  const at = (index, options) => nextIndex({ index, length: 2, repeatMode: 'none', shuffleOn: false, ...options });
  assert.equal(at(0, { ended: true }), 1);
  assert.equal(at(1, { ended: true }), null, 'the last song ending with repeat off: the end');
  assert.equal(at(1, { ended: true, repeatMode: 'all' }), 0);
  assert.equal(at(1, {}), 0, 'Next on the last song goes round');
  assert.equal(nextIndex({ index: 0, length: 1, repeatMode: 'none', shuffleOn: true, ended: true }), null, 'one song, shuffled, repeat off: the end too');
  assert.equal(nextIndex({ index: 0, length: 3, repeatMode: 'none', shuffleOn: true, random: () => 0.5 }), 1);
  assert.equal(nextIndex({ index: 0, length: 0, repeatMode: 'all', shuffleOn: false }), null);
  const engine = read('src/engine.js');
  assert.match(engine, /value\.type === 'ended'\) \{[^}]*getNextIndex\(\{ ended: true \}\)/);
});

test('repeat one replays a song when it ends, but Next goes to the next (R47)', async () => {
  const { nextIndex } = await importSource('src/queue.js');
  const at = options => nextIndex({ index: 0, length: 2, repeatMode: 'one', shuffleOn: false, ...options });
  assert.equal(at({ ended: true }), 0, 'the same song again when it ends');
  assert.equal(at({}), 1, 'Next: the next one');
  assert.equal(at({ shuffleOn: true, random: () => 0.9 }), 1, 'shuffled too');
});

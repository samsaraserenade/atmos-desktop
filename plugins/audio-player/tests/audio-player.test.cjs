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

test('runs in frames: drawer panel, three widgets, a boot frame with Space', () => {
  const m = manifest();
  assert.equal(m.apiVersion, 3);
  assert.equal(m.runtime, 'frame');
  assert.equal(m.requires['extensions.frames'], 3);
  assert.deepEqual(m.contributes.panel.drawer, { bar: 54, keys: true });
  assert.equal(m.contributes.panel.default, true);
  // Same widget ids as before frames (audio-player, -queue, -library), so
  // saved sidebar layouts still apply.
  assert.deepEqual(m.contributes.sidebar.map(item => item.id ?? null), [null, 'queue', 'library']);
  assert.equal(m.contributes.sidebar[0].resizable, false);
  assert.deepEqual(m.contributes.boot, { entry: 'boot.js', keys: ['Space'] });
  assert.deepEqual([...m.permissions.invokes].sort(), ['service:audio', 'service:media-metadata', 'service:wallpaper']);
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
  assert.match(engine, /value\.type === 'ended'\) \{ void loadTrack\(getNextIndex\(\)\)/);
  assert.match(engine, /atmos\.surface\.onKey\(\(\{ code \}\) => \{ if \(code === 'Space'\) void togglePlay\(\); \}\)/);
  assert.match(engine, /await atmos\.expose\(\{/);
  assert.doesNotMatch(engine, /document\.createElement\('audio'\)|new Audio\(/);
  // Views never play anything themselves.
  for (const file of ['src/player-view.js', 'src/client.js', 'sidebar.js', 'sidebar-queue.js', 'sidebar-library.js']) {
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

test('now-playing widget avoids perpetual animation and redundant layout writes', () => {
  const sidebar = read('sidebar.js');
  const css = read('assets/sidebar.css');
  assert.match(sidebar, /if \(snap\.playing !== _lastPlaying\)/);
  assert.match(sidebar, /fillEl\.style\.transform = `scaleX/);
  assert.doesNotMatch(sidebar, /fillEl\.style\.width/);
  assert.doesNotMatch(css, /ap-mini-marquee 8s linear infinite/);
  assert.match(css, /animation: ap-mini-marquee 8s linear 2/);
  assert.match(css, /\.ap-mini-cover-info \{[\s\S]*?padding: 10px 12px 13px;/);
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

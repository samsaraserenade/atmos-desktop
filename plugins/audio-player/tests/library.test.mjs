// src/library.js against a fake disk (fake-library-env.mjs): folders added,
// rescanned and found missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const fake = new URL('./fake-library-env.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/library.js') && ['atmos-sdk', './state.js', './store.js', './fs-bridge.js', './media-metadata.js'].includes(specifier)) return { url: fake, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { disk, audioState, saves } = await import('./fake-library-env.mjs');
const library = await import('../src/library.js');

/** A fresh library with these folders on disk ({ path: [files] }). */
async function fresh(folders) {
  disk.folders = new Map(Object.entries(folders));
  disk.unreadable = new Set();
  audioState.electronFolders = [];
  library.setLibrary({ albums: {}, folders: [] });
  await library.reconnectFolders();
  saves.length = 0;
}
const add = async folder => { disk.chosen = folder; await library.addFolder(); };
const tracks = () => Object.values(library.library.albums).flatMap(album => album.tracks.map(track => track.key)).sort();
const pathOf = key => library.getFilePath(key);

test('two music folders with the same album folder keep their own songs; removing one folder removes only its own (R25)', async () => {
  await fresh({ '/a/Music/Album': ['song.mp3'], '/b/Music/Album': ['song.mp3'], '/a/Music/Album/Disc': ['other.mp3'] });
  await add('/a/Music');
  await add('/b/Music');
  const keys = tracks();
  assert.equal(keys.length, 3, 'three songs, three entries');
  assert.deepEqual(keys.map(pathOf).sort(), ['/a/Music/Album/Disc/other.mp3', '/a/Music/Album/song.mp3', '/b/Music/Album/song.mp3']);
  await library.removeFolderByPath('Album', '/a/Music/Album');
  assert.deepEqual(tracks().map(pathOf).sort(), ['/a/Music/Album/Disc/other.mp3', '/b/Music/Album/song.mp3'], 'not Album/Disc, nor the other Album');
});

test("a rescan that can't read a folder leaves its songs as they were (R26)", async () => {
  await fresh({ '/m/Music/A': ['one.mp3'], '/m/Music/B': ['two.mp3'] });
  await add('/m/Music');
  const before = tracks();
  assert.equal(before.length, 2);
  disk.unreadable.add('/m/Music/A'); // a passing access failure
  await library.rescanFolder('A', '/m/Music/A');
  assert.deepEqual(tracks(), before, 'one folder');
  await library.rescanFolders(['A', 'B']);
  assert.deepEqual(tracks(), before, 'several');
  await library.rescanLibrary();
  assert.deepEqual(tracks(), before, 'all of them');
  assert.deepEqual(before.map(pathOf), ['/m/Music/A/one.mp3', '/m/Music/B/two.mp3'], 'and they still play');
  const last = saves.at(-1);
  assert.ok(!last || Object.values(last.albums).flatMap(album => album.tracks).length === 2, 'nothing smaller saved');
  disk.unreadable.clear();
  await library.rescanLibrary();
  assert.deepEqual(tracks(), before);
});

test("a drive that isn't there keeps its folders and songs; a folder deleted from a drive that is there goes (R46)", async () => {
  await fresh({ '/d/Music/A': ['one.mp3'], '/d/Music/B': ['two.mp3'], '/c/Other/C': ['three.mp3'] });
  await add('/d/Music');
  await add('/c/Other');
  const before = tracks();
  assert.equal(before.length, 3);
  const savedFolders = audioState.electronFolders.map(folder => folder.path).sort();
  // Atmos starts with the drive D: away.
  disk.folders.delete('/d/Music/A');
  disk.folders.delete('/d/Music/B');
  await library.reconnectFolders();
  assert.deepEqual(tracks(), before, 'its songs kept');
  assert.deepEqual(audioState.electronFolders.map(folder => folder.path).sort(), savedFolders, 'its folders kept');
  await library.rescanLibrary();
  await library.rescanFolder('A', '/d/Music/A');
  assert.deepEqual(tracks().length, 3, 'a rescan keeps them too');
  // The drive is back, without B, deleted meanwhile.
  disk.folders.set('/d/Music/A', ['one.mp3']);
  await library.reconnectFolders();
  await library.rescanLibrary();
  assert.deepEqual(tracks().map(pathOf).sort(), ['/c/Other/C/three.mp3', '/d/Music/A/one.mp3']);
});

test('a library saved before names were kept apart: the new names are saved, taken from no other folder, and a stale name acts on the folder at its path (R25)', async () => {
  await fresh({ '/a/Music/Album': ['song.mp3'], '/b/Music/Album': ['song.mp3'], '/c/Music/Album (2)': ['three.mp3'] });
  // Both "Album" from before; "Album (2)" a folder's own name.
  audioState.electronFolders = [
    { name: 'Album', path: '/a/Music/Album', root: 'Music', rootPath: '/a/Music' },
    { name: 'Album', path: '/b/Music/Album', root: 'Music', rootPath: '/b/Music' },
    { name: 'Album (2)', path: '/c/Music/Album (2)', root: 'Music', rootPath: '/c/Music' },
  ];
  const track = (key, title) => ({ key, title, artist: 'Artist', album: title });
  library.setLibrary({ albums: {
    a: { artist: 'Artist', album: 'Album', tracks: [track('Album/song.mp3', 'Album')] },
    c: { artist: 'Artist', album: 'Album (2)', tracks: [track('Album (2)/three.mp3', 'Album (2)')] },
  }, folders: [{ name: 'Album' }, { name: 'Album (2)' }] });
  await library.reconnectFolders();
  const names = audioState.electronFolders.map(folder => `${folder.path} ${folder.name}`);
  assert.deepEqual(names, ['/a/Music/Album Album', '/b/Music/Album Album (3)', '/c/Music/Album (2) Album (2)'], 'saved, and the other "Album (2)" kept');
  assert.equal(pathOf('Album (2)/three.mp3'), '/c/Music/Album (2)/three.mp3');
  // The Library widget had the old list: "Album" at /b.
  await library.rescanFolder('Album', '/b/Music/Album');
  assert.equal(pathOf('Album/song.mp3'), '/a/Music/Album/song.mp3', '/a\'s song still plays from /a');
  await library.removeFolderByPath('Album', '/b/Music/Album');
  assert.deepEqual(tracks().map(pathOf).sort(), ['/a/Music/Album/song.mp3', '/c/Music/Album (2)/three.mp3'], 'only /b\'s songs went');
  assert.deepEqual(audioState.electronFolders.map(folder => folder.path), ['/a/Music/Album', '/c/Music/Album (2)']);
});

test('a picked folder that is there but empty (a mount point, its drive away) keeps its songs; the whole picked folder can be removed at once (R46)', async () => {
  await fresh({ '/mnt/music/A': ['one.mp3'], '/mnt/music/B': ['two.mp3'], '/c/Other/C': ['three.mp3'] });
  await add('/mnt/music');
  await add('/c/Other');
  const before = tracks();
  assert.equal(before.length, 3);
  // Atmos starts with the drive not mounted: /mnt/music is there, empty.
  disk.folders = new Map([['/mnt/music', []], ['/c/Other/C', ['three.mp3']]]);
  await library.reconnectFolders();
  assert.deepEqual(tracks(), before, 'at start');
  await library.rescanLibrary();
  await library.scanForNewFolders();
  assert.deepEqual(tracks(), before, 'and after a rescan');
  assert.equal(audioState.electronFolders.length, 3);
  // Deleted for good: the picked folder's header removes it all at once.
  await library.removePickedFolder('/mnt/music');
  assert.deepEqual(tracks().map(pathOf), ['/c/Other/C/three.mp3']);
  assert.deepEqual(audioState.electronFolders.map(folder => folder.path), ['/c/Other/C']);
});

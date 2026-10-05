// Audio Player's rev/ commands (src/commands.js) as Atmos's bar uses them,
// against the SDK's fake Atmos, a library of three albums and a stand-in
// for the engine's playback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const fakeSdk = new URL('../../../core/js/sdk/testing/sdk.mjs', import.meta.url).href;
const fakeLibrary = `data:text/javascript,${encodeURIComponent('export const getAlbums = () => globalThis.__audioAlbums;')}`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeSdk, shortCircuit: true };
  if (specifier === './library.js' && context.parentURL?.endsWith('/src/commands.js')) return { url: fakeLibrary, shortCircuit: true };
  return nextResolve(specifier, context);
} });

const LIBRARY = [
  { key: 'a1', album: 'Discovery', artist: 'Daft Punk', year: 2001, tracks: [
    { key: 't1', title: 'One More Time', artist: 'Daft Punk' },
    { key: 't2', title: 'Digital Love', artist: 'Daft Punk' },
  ] },
  { key: 'a2', album: 'Random Access Memories', artist: 'Daft Punk', year: 2013, tracks: [
    { key: 't3', title: 'Get Lucky', artist: 'Daft Punk' },
    { key: 't4', title: 'Instant Crush', artist: 'Daft Punk' },
  ] },
  { key: 'a3', album: 'Day/Night', artist: 'Parcels', tracks: [{ key: 't5', title: 'Lightenup', artist: 'Parcels' }] },
];
globalThis.__audioAlbums = LIBRARY;

const { installFakeAtmos } = await import('../../../core/js/sdk/testing/fake-atmos.mjs');
const manifest = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8'));
const atmos = installFakeAtmos({ extension: { id: 'audio-player', tier: 'first-party' }, commands: manifest.contributes.commands });
const { handleCommands, findSongs, findAlbums } = await import('../src/commands.js');

// The engine's side: a queue of track names, what's playing, what was asked.
const titles = Object.fromEntries(LIBRARY.flatMap(album => album.tracks.map(track => [track.key, track.title])));
const player = {
  queue: [], index: 0, playing: false, position: 0, calls: [], missing: new Set(),
  broken: false, // the next load fails (its file gone)
  reset() { Object.assign(this, { queue: [], index: 0, playing: false, position: 0, calls: [], missing: new Set(), broken: false }); },
  status() { return { playing: this.playing, track: this.queue[this.index] || null, queued: this.queue.length, position: this.position }; },
  async togglePlay() { this.calls.push(['togglePlay']); if (this.broken) return false; this.playing = !this.playing; return true; },
  async playNext() { this.calls.push(['playNext']); this.index = (this.index + 1) % this.queue.length; this.position = 0; return !this.broken; },
  async playPrev() {
    this.calls.push(['playPrev']);
    if (this.position <= 3) this.index = (this.index - 1 + this.queue.length) % this.queue.length;
    this.position = 0;
    return true;
  },
  async playTrack(key) {
    this.calls.push(['playTrack', key]);
    if (this.missing.has(key)) return false;
    const album = LIBRARY.find(item => item.tracks.some(track => track.key === key));
    this.queue = album.tracks.map(track => track.title);
    this.index = album.tracks.findIndex(track => track.key === key);
    this.playing = true;
    return true;
  },
  async playAlbum(key) {
    this.calls.push(['playAlbum', key]);
    if (this.missing.has(key)) return false;
    this.queue = LIBRARY.find(item => item.key === key).tracks.map(track => track.title);
    this.index = 0;
    this.playing = true;
    return true;
  },
};
handleCommands(player);

const run = (name, input = {}) => atmos.fake.runCommand(name, input);
const suggest = (name, input = {}) => atmos.fake.suggestCommand(name, input);

test('the commands are declared for Atmos\'s bar, with the Atmos that has it, and all handled', () => {
  assert.equal(manifest.engines.atmos, '>=0.20.0', 'atmos.commands is SDK 1.3 (Atmos 0.20.0)');
  assert.deepEqual(manifest.contributes.commands.map(command => command.name), ['play', 'next', 'previous', 'song', 'album']);
  assert.deepEqual(atmos.fake.commandsHandled.sort(), ['album', 'next', 'play', 'previous', 'song']);
  const play = manifest.contributes.commands[0];
  assert.ok(!play.takesArgs && !play.suggests, 'rev/play plays or pauses at once');
});

test('rev/play plays or pauses what\'s queued, and says which', async () => {
  player.reset();
  await assert.rejects(run('play'), /Nothing to play yet/);
  player.queue = ['One More Time', 'Digital Love'];
  assert.deepEqual(await run('play'), { done: 'Playing One More Time.' });
  assert.deepEqual(await run('play'), { done: 'Paused.' });
  assert.deepEqual(player.calls, [['togglePlay'], ['togglePlay']]);
});

test('rev/play with a name: the song that starts so, else the album, else a song it\'s in', async () => {
  player.reset();
  assert.deepEqual(await run('play', { args: 'one more' }), { done: 'Playing One More Time.' });
  assert.deepEqual(await run('play', { args: 'random' }), { done: 'Playing Random Access Memories.' });
  assert.deepEqual(await run('play', { args: 'parcels' }), { done: 'Playing Day/Night.' }, 'an artist: their album');
  assert.deepEqual(player.calls, [['playTrack', 't1'], ['playAlbum', 'a2'], ['playAlbum', 'a3']]);
  await assert.rejects(run('play', { args: 'zzz' }), /Nothing in your library is called “zzz”/);
});

test('rev/next and rev/previous say what plays; previous past 3 s restarts the song', async () => {
  player.reset();
  await assert.rejects(run('next'), /Nothing to play yet/);
  player.queue = ['One More Time', 'Digital Love'];
  assert.deepEqual(await run('next'), { done: 'Playing Digital Love.' });
  player.position = 42;
  assert.deepEqual(await run('previous'), { done: 'From the start of Digital Love.' });
  assert.deepEqual(await run('previous'), { done: 'Playing One More Time.' });
});

test('rev/song lists songs by title first, then by artist or album, and plays the one chosen', async () => {
  player.reset();
  assert.deepEqual(findSongs('di').map(({ track }) => track.title), ['Digital Love', 'One More Time'], 'Discovery\'s other song is in it');
  assert.deepEqual(await suggest('song', { args: 'di' }), [
    { title: 'Digital Love', sub: 'Daft Punk · Discovery', action: 'Play', value: 't2', complete: 'Digital Love' },
    { title: 'One More Time', sub: 'Daft Punk · Discovery', action: 'Play', value: 't1', complete: 'One More Time' },
  ]);
  assert.deepEqual(await suggest('song'), [{ note: 'Type a song, an artist or an album.' }]);
  assert.deepEqual(await suggest('song', { args: 'nope' }), [{ note: 'No song in your library matches “nope”.' }]);
  assert.deepEqual(await run('song', { args: 'di', value: 't2' }), { done: 'Playing Digital Love.' });
  assert.deepEqual(await run('song', { args: 'get' }), { done: 'Playing Get Lucky.' }, 'Enter before the list caught up: the first match');
  player.missing.add('t4');
  await assert.rejects(run('song', { args: 'instant', value: 't4' }), /Couldn’t find Instant Crush’s file/);
  await assert.rejects(run('song', { value: 'gone' }), /isn’t in your library any more/);
  assert.equal(titles.t2, 'Digital Love');
});

test('rev/album lists albums (all of them before anything is typed) and plays the one chosen', async () => {
  player.reset();
  assert.deepEqual(findAlbums('daft').map(album => album.album), ['Discovery', 'Random Access Memories'], 'by artist');
  assert.deepEqual((await suggest('album')).map(row => row.title), ['Discovery', 'Random Access Memories', 'Day/Night']);
  assert.deepEqual((await suggest('album', { args: 'day' }))[0], { title: 'Day/Night', sub: 'Parcels · 1 song', action: 'Play', value: 'a3', complete: 'Day/Night' });
  assert.equal((await suggest('album', { args: 'disc' }))[0].sub, 'Daft Punk · 2001 · 2 songs');
  assert.deepEqual(await run('album', { args: 'disc', value: 'a1' }), { done: 'Playing Discovery.' });
  await assert.rejects(run('album', { args: 'nope' }), /No album in your library matches “nope”/);
});

test('with an empty library, the lists say how to fill it', async () => {
  globalThis.__audioAlbums = [];
  try {
    assert.deepEqual(await suggest('song', { args: 'x' }), [{ note: 'Your library is empty. Add a folder in the Library widget.' }]);
    assert.deepEqual(await suggest('album'), [{ note: 'Your library is empty. Add a folder in the Library widget.' }]);
  } finally {
    globalThis.__audioAlbums = LIBRARY;
  }
});

test('a song that won\'t load says so rather than "Playing"', async () => {
  player.reset();
  player.queue = ['One More Time', 'Digital Love'];
  player.broken = true;
  await assert.rejects(run('play'), /Couldn’t play One More Time\. Is its file still there\?/);
  await assert.rejects(run('next'), /Couldn’t play Digital Love/);
});

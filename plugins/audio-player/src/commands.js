/**
 * Audio Player's rev/ commands in Atmos's command bar (SDK 1.3), declared in
 * extension.json ("contributes.commands") and answered here, in the
 * background frame where the queue lives, so they work whichever panel is
 * showing:
 *
 *   song <title>           a song from your library, by title, artist or album
 *   album <name>           an album from your library, by name or artist
 *
 * Play/pause, next and previous (rev/play, rev/pause, rev/next,
 * rev/previous and Space) are the Now Playing service's since Audio Player
 * 1.2.3: they act on whatever plays, Music included, through its controls.
 *
 * `player` is the engine's (engine.js start()): playTrack, playAlbum and
 * more. Rows and results are plain text: Atmos draws them.
 */
import atmos from 'atmos-sdk';
import { getAlbums } from './library.js';

const lower = value => String(value ?? '').toLowerCase().trim();
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const MAX_ROWS = 8;

function emptyLibrary() {
  return getAlbums().length ? null : [{ note: 'Your library is empty. Add a folder in the Library widget.' }];
}

/** Songs matching `query`: titles that start with it first, then the rest by title, artist or album. */
export function findSongs(query, albums = getAlbums()) {
  const q = lower(query);
  if (!q) return [];
  const starts = [], contains = [];
  for (const album of albums) {
    for (const track of album.tracks) {
      const title = lower(track.title);
      if (title.startsWith(q)) starts.push({ track, album });
      else if (title.includes(q) || lower(track.artist).includes(q) || lower(album.album).includes(q) || lower(album.artist).includes(q)) contains.push({ track, album });
    }
  }
  return [...starts, ...contains];
}

/** Albums matching `query`: names that start with it first, then by name or artist. */
export function findAlbums(query, albums = getAlbums()) {
  const q = lower(query);
  if (!q) return [];
  const starts = albums.filter(album => lower(album.album).startsWith(q));
  const rest = albums.filter(album => !lower(album.album).startsWith(q) && (lower(album.album).includes(q) || lower(album.artist).includes(q)));
  return [...starts, ...rest];
}

const songRow = ({ track, album }) => ({
  title: track.title || 'Untitled',
  sub: [track.artist || album.artist, album.album].filter(Boolean).join(' · '),
  action: 'Play',
  value: track.key,
  complete: track.title || '',
});

const albumRow = album => ({
  title: album.album || 'Untitled',
  sub: [album.artist, album.year, plural(album.tracks.length, 'song')].filter(Boolean).join(' · '),
  action: 'Play',
  value: album.key,
  complete: album.album || '',
});

export function handleCommands(player) {

  async function playSong(key) {
    const found = getAlbums().flatMap(album => album.tracks.map(track => ({ track, album }))).find(entry => entry.track.key === key);
    if (!found) throw new Error('That song isn’t in your library any more.');
    if (await player.playTrack(key) === false) throw new Error(`Couldn’t find ${found.track.title || 'that song'}’s file. Is its folder still there?`);
    return { done: `Playing ${found.track.title || 'it'}.` };
  }

  async function playAlbum(key) {
    const album = getAlbums().find(candidate => candidate.key === key);
    if (!album) throw new Error('That album isn’t in your library any more.');
    if (await player.playAlbum(key) === false) throw new Error(`Couldn’t find ${album.album || 'that album'}’s files. Is its folder still there?`);
    return { done: `Playing ${album.album || 'the album'}.` };
  }

  atmos.commands.handle('song', ({ args, value }) => {
    const key = value || findSongs(args)[0]?.track.key;
    if (!key) throw new Error(args ? `No song in your library matches “${args}”.` : 'Type a song, an artist or an album.');
    return playSong(key);
  }, {
    suggest: ({ args }) => {
      if (!args) return emptyLibrary() || [{ note: 'Type a song, an artist or an album.' }];
      const rows = findSongs(args).slice(0, MAX_ROWS).map(songRow);
      return emptyLibrary() || (rows.length ? rows : [{ note: `No song in your library matches \u201c${args}\u201d.` }]);
    },
  });

  atmos.commands.handle('album', ({ args, value }) => {
    const key = value || findAlbums(args)[0]?.key;
    if (!key) throw new Error(args ? `No album in your library matches “${args}”.` : 'Type an album or an artist.');
    return playAlbum(key);
  }, {
    suggest: ({ args }) => {
      const rows = (args ? findAlbums(args) : getAlbums()).slice(0, MAX_ROWS).map(albumRow);
      return emptyLibrary() || (rows.length ? rows : [{ note: `No album in your library matches \u201c${args}\u201d.` }]);
    },
  });
}

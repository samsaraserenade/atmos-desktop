/**
 * Audio Player's engine, running in its boot frame for the whole session.
 *
 * Owns what is Audio Player's own: the playlist, shuffle and repeat, the
 * library (library.js), the waveform of the current track and restoring the
 * last session. The sound itself comes from Atmos's Audio service
 * (atmos.audio): this engine tells it what to load, play and pause, and
 * hears back when a track ends.
 *
 * The panel and widgets are views: they call the methods exposed below
 * (atmos.call('plugin:audio-player', …)), follow the 'engine' event for the
 * playlist and settings, and follow atmos.audio directly for time and
 * play/pause.
 */
import atmos from 'atmos-sdk';
import { audioState, save, flush } from './state.js';
import {
  loadWaveformCache, saveWaveformCache, loadTracks, saveTracks, loadLibraryMeta, saveLibraryMeta,
} from './store.js';
import {
  getAlbums, resolveFile, getFilePath, reconnectFolders, mergeCompilations, setLibrary, library,
  onLibraryUpdate, addFolder, removeFolderByPath, rescanFolder, rescanFolders, scanForNewFolders,
  rescanLibrary, getLibraryStatus, invalidateAlbumsCache,
} from './library.js';
import { persistCover } from './cover-writer.js';
import { createWaveformLoader } from './waveform-loader.js';
import { restorePlayback } from './restore-playback.js';

const audio = atmos.audio;

/** [{ name, key, source }]: source is a resource URL or a File opened from disk. */
let playlist = [];
let playbackRevision = 0;
let now = { playing: false, currentTime: 0, duration: 0, source: null };

// ── Snapshot for the views ──────────────────────────────────────────────────

let snapshotQueued = false;
let snapshotRevision = 0;

export function snapshot() {
  return {
    revision: snapshotRevision,
    playlist: playlist.map(track => ({ name: track.name, key: track.key || null })),
    trackIdx: audioState.trackIdx,
    trackKey: audioState.trackKey,
    shuffleOn: audioState.shuffleOn,
    repeatMode: audioState.repeatMode,
    vol: audioState.vol,
    playing: now.playing,
    currentTime: now.currentTime,
    duration: now.duration,
  };
}

function announce() {
  if (snapshotQueued) return;
  snapshotQueued = true;
  queueMicrotask(() => {
    snapshotQueued = false;
    snapshotRevision++;
    atmos.events.emit('engine', snapshot());
  });
}

// ── Waveform ────────────────────────────────────────────────────────────────

let waveCache = {};
let waveform = { key: null, data: null, max: 1 };
let currentWaveKey = null;
let decodeContext = null;

const waveformLoader = createWaveformLoader({
  // Decoding needs no sound output: an offline context does it quietly.
  getContext: () => (decodeContext ||= new OfflineAudioContext(1, 1, 44100)),
  getCached: key => waveCache[key],
  store: (key, data) => {
    waveCache[key] = Array.from(data);
    saveWaveformCache(waveCache);
  },
  publish: (data, max) => {
    waveform = { key: currentWaveKey, data: data ? Array.from(data) : null, max };
    atmos.events.emit('waveform', waveform);
  },
});

function decodeWaveform(track) {
  currentWaveKey = track ? (track.key || track.name) : null;
  if (!track) return waveformLoader.load(null);
  return waveformLoader.load(track.source, track.key || null);
}

/** Drop cached waveforms of tracks no longer in the library. */
function pruneWaveformCache() {
  if (!Object.keys(waveCache).length) return;
  const live = new Set();
  getAlbums().forEach(album => album.tracks.forEach(track => live.add(track.key)));
  let changed = false;
  for (const key of Object.keys(waveCache)) {
    if (!live.has(key)) { delete waveCache[key]; changed = true; }
  }
  if (changed) saveWaveformCache(waveCache);
}

// ── Playback ────────────────────────────────────────────────────────────────

function getNextIndex() {
  if (audioState.repeatMode === 'one') return audioState.trackIdx;
  if (audioState.shuffleOn) {
    let next;
    do { next = Math.floor(Math.random() * playlist.length); }
    while (playlist.length > 1 && next === audioState.trackIdx);
    return next;
  }
  return (audioState.trackIdx + 1) % playlist.length;
}

export async function loadTrack(index, { play = true, position = 0 } = {}) {
  playbackRevision++;
  const track = playlist[index];
  if (!track) return false;
  audioState.trackIdx = index;
  audioState.trackPos = position || 0;
  audioState.trackKey = track.key || null;
  save('trackIdx', 'trackPos', 'trackKey');
  announce();
  decodeWaveform(track);
  try {
    await audio.load(track.source, { id: track.key || track.name, position, play });
  } catch (error) {
    console.error('[audio-player] could not load', track.name, error);
    return false;
  }
  return true;
}

export async function togglePlay() {
  playbackRevision++;
  if (!now.playing && playlist.length) {
    // Nothing loaded yet (a restored queue, say): load where it was.
    if (!now.source) return loadTrack(audioState.trackIdx, { play: true, position: audioState.trackPos || 0 });
    await audio.play();
  } else if (now.playing) {
    await audio.pause();
  }
  return true;
}

export const play = () => (now.playing ? true : togglePlay());
export const pause = () => audio.pause();

/** Restart the track if more than 3s in, otherwise go to the previous one. */
export function playPrev() {
  if (!playlist.length) return false;
  if (now.currentTime > 3) { audio.seek(0); return true; }
  return loadTrack((audioState.trackIdx - 1 + playlist.length) % playlist.length);
}

export function playNext() {
  return playlist.length ? loadTrack(getNextIndex()) : false;
}

export function seek(seconds) {
  if (!Number.isFinite(seconds)) return;
  audioState.trackPos = seconds;
  return audio.seek(seconds);
}

let volumeTimer = null;
export function setVolume(value) {
  const volume = Math.max(0, Math.min(100, Number(value) || 0));
  audioState.vol = volume;
  audio.setVolume(volume / 100);
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => save('vol'), 300);
  announce();
  return volume;
}

export function toggleShuffle() {
  audioState.shuffleOn = !audioState.shuffleOn;
  save('shuffleOn');
  announce();
  return audioState.shuffleOn;
}

export function cycleRepeat() {
  audioState.repeatMode = audioState.repeatMode === 'none' ? 'all' : audioState.repeatMode === 'all' ? 'one' : 'none';
  save('repeatMode');
  announce();
  return audioState.repeatMode;
}

// ── Playlists from the library ──────────────────────────────────────────────

function albumTracks(album) {
  return album.tracks
    .map((track, index) => ({ track, index, source: resolveFile(track.key) }))
    .filter(entry => entry.source);
}

function albumByKey(albumKey) {
  return getAlbums().find(album => album.key === albumKey) || null;
}

/** Play an album from one of its tracks. Resolves false when none can be found on disk. */
export async function playAlbum(albumKey, startIndex = 0) {
  const revision = ++playbackRevision;
  const album = albumByKey(albumKey);
  if (!album) return false;
  const valid = albumTracks(album);
  if (revision !== playbackRevision) return false;
  if (!valid.length) {
    console.warn(`[audio-player] no playable files resolved for '${album.album}'`);
    return false;
  }
  let index = valid.findIndex(entry => entry.index === startIndex);
  if (index < 0) index = 0;
  playlist = valid.map(({ track, source }) => ({ name: track.title, key: track.key, source }));
  return loadTrack(index);
}

export function queueAlbum(albumKey) {
  const album = albumByKey(albumKey);
  if (!album) return false;
  const tracks = albumTracks(album).map(({ track, source }) => ({ name: track.title, key: track.key, source }));
  if (!tracks.length) return false;
  playlist.push(...tracks);
  announce();
  return true;
}

/** A library track (its album becomes the playlist), or a queue entry by key or name. */
export function playTrack(key, name = null) {
  if (key) {
    const album = getAlbums().find(candidate => candidate.tracks.some(track => track.key === key));
    if (album) return playAlbum(album.key, album.tracks.findIndex(track => track.key === key));
  }
  const index = playlist.findIndex(track => (key && track.key === key) || track.name === name);
  return index >= 0 ? loadTrack(index) : false;
}

export function queueTrack(key) {
  const track = getAlbums().flatMap(album => album.tracks).find(candidate => candidate.key === key);
  const source = track && resolveFile(track.key);
  if (!source) return false;
  playlist.push({ name: track.title, key: track.key, source });
  announce();
  return true;
}

/** Files chosen with the file picker become the playlist. */
export async function playFiles(files) {
  playbackRevision++;
  const list = [...(files || [])].filter(file => file instanceof Blob);
  if (!list.length) return false;
  playlist = list.map(file => ({ name: String(file.name || 'Track').replace(/\.[^/.]+$/, ''), key: null, source: file }));
  saveTracks(list);
  return loadTrack(0);
}

// ── Restoring the last session ──────────────────────────────────────────────

function restoreFiles(files, trackIdx, trackPos) {
  if (!files?.length) return;
  playlist = files.map(file => ({ name: String(file.name || 'Track').replace(/\.[^/.]+$/, ''), key: null, source: file }));
  const index = Math.max(0, Math.min(trackIdx || 0, playlist.length - 1));
  return loadTrack(index, { play: false, position: trackPos > 0 ? trackPos : 0 });
}

async function restoreLibraryTrack(trackKey, trackPos, isCurrent) {
  const album = getAlbums().find(candidate => candidate.tracks.some(track => track.key === trackKey));
  if (!album) return;
  const valid = albumTracks(album);
  const index = valid.findIndex(entry => entry.track.key === trackKey);
  if (index < 0 || !isCurrent()) return;
  playlist = valid.map(({ track, source }) => ({ name: track.title, key: track.key, source }));
  // Seek to the saved position but don't play: the user resumes.
  await loadTrack(index, { play: false, position: trackPos > 0 ? trackPos : 0 });
}

async function restore() {
  const saved = { trackKey: audioState.trackKey, trackIdx: audioState.trackIdx, trackPos: audioState.trackPos };
  const revision = playbackRevision;
  const reportError = error => console.error('[audio-player] startup restore:', error);
  await restorePlayback({
    saved,
    loadCache: async () => { waveCache = { ...await loadWaveformCache(), ...waveCache }; },
    async restoreLibrary() {
      const { albums, folders } = await loadLibraryMeta();
      if (albums) mergeCompilations(albums);
      setLibrary({ albums, folders });
      await reconnectFolders();
    },
    loadFiles: loadTracks,
    restoreFiles,
    restoreLibraryTrack,
    isCurrent: () => revision === playbackRevision,
    reportError,
  }).catch(reportError);
  announce();
}

// ── Library and covers (asked for by the views) ─────────────────────────────

function mediaPathForAlbum(albumKey) {
  const album = albumByKey(albumKey);
  return album ? album.tracks.map(track => getFilePath(track.key)).find(Boolean) || null : null;
}

function albumFolder(albumKey) {
  const filePath = mediaPathForAlbum(albumKey);
  return filePath ? filePath.replace(/[/\\][^/\\]+$/, '') : null;
}

async function saveCover(albumKey, embedBase64, mimeType, thumbDataUrl) {
  const album = albumByKey(albumKey);
  if (!album) throw new Error('That album is no longer in the library.');
  const result = await persistCover(album.tracks.map(track => getFilePath(track.key)), embedBase64, mimeType);
  if (library.albums[albumKey]) {
    library.albums[albumKey].cover = thumbDataUrl;
    invalidateAlbumsCache();
  }
  await saveLibraryAndAnnounce();
  return result;
}

// library.js announces its own changes; a cover edit is saved here.
async function saveLibraryAndAnnounce() {
  await saveLibraryMeta(library.albums, library.folders);
  atmos.events.emit('library-changed', { revision: Date.now() });
}

// ── Start ───────────────────────────────────────────────────────────────────

export async function start() {
  audio.onChange(value => {
    const previous = now;
    now = value;
    if (value.type === 'ended') { void loadTrack(getNextIndex()); return; }
    if (value.type === 'pause' && value.currentTime > 0) {
      audioState.trackPos = value.currentTime;
      save('trackPos');
    }
    if (value.playing !== previous.playing || value.type === 'source' || value.type === 'loaded') announce();
  });
  now = await audio.state();
  await audio.setVolume((Number(audioState.vol) || 0) / 100);

  // Save the position now and then while playing, and when Atmos closes.
  setInterval(() => {
    if (now.playing && now.currentTime > 0) {
      audioState.trackPos = now.currentTime;
      save('trackPos');
    }
  }, 5000);
  addEventListener('pagehide', () => {
    if (now.currentTime > 0) audioState.trackPos = now.currentTime;
    save('trackPos');
    void flush();
  });

  onLibraryUpdate(() => { pruneWaveformCache(); announce(); });

  // Space anywhere in Atmos outside a text field (boot "keys" in extension.json).
  atmos.surface.onKey(({ code }) => { if (code === 'Space') void togglePlay(); });

  await atmos.expose({
    snapshot,
    waveform: () => waveform,
    togglePlay, play, pause, playPrev, playNext, seek, setVolume, toggleShuffle, cycleRepeat,
    loadIndex: index => loadTrack(Number(index)),
    playAlbum, queueAlbum, playTrack, queueTrack, playFiles,
    filePath: key => getFilePath(key),
    albumFolder,
    mediaPathForAlbum,
    saveCover,
    libraryStatus: getLibraryStatus,
    addFolder, removeFolder: removeFolderByPath, rescanFolder, rescanFolders, scanForNewFolders, rescanLibrary,
  });

  await restore();
}

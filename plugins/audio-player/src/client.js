/**
 * What Audio Player's panel and widgets see of the engine (boot.js):
 *
 *   engine     the playlist, current track, shuffle, repeat and volume
 *              (the engine's 'engine' event)
 *   playback   playing / currentTime / duration, straight from Atmos's Audio
 *              service (atmos.audio), so time moves without the engine
 *   waveform   the current track's waveform (the 'waveform' event)
 *   library    albums and folders, read from the shared IndexedDB whenever
 *              the engine says it changed ('library-changed')
 *
 * Every action goes to the engine with call(); nothing here plays sound.
 */
import atmos from 'atmos-sdk';
import { loadState } from './state.js';
import { loadLibraryMeta } from './store.js';
import { normaliseMetadataText } from './metadata-grouping.js';

const SELF = 'plugin:audio-player';
export const call = (method, ...args) => atmos.call(SELF, method, ...args);

export const engine = {
  revision: -1, playlist: [], trackIdx: 0, trackKey: null,
  shuffleOn: false, repeatMode: 'none', vol: 100,
};
export const playback = { playing: false, currentTime: 0, duration: 0, at: 0, source: null };
export let waveform = { key: null, data: null, max: 1 };
export const library = { albums: {}, folders: [] };
export let libraryStatus = { msg: '', isErr: false, pct: 0 };

const topics = { engine: new Set(), playback: new Set(), waveform: new Set(), library: new Set(), status: new Set() };
function notify(topic) {
  for (const fn of [...topics[topic]]) {
    try { fn(); } catch (error) { console.error(`[audio-player] ${topic} listener failed:`, error); }
  }
}
/** Follow a part of the engine: 'engine', 'playback', 'waveform', 'library' or 'status'. */
export function on(topic, fn) {
  topics[topic].add(fn);
  return () => topics[topic].delete(fn);
}

function applyEngine(snapshot) {
  if (!snapshot || snapshot.revision < engine.revision) return;
  Object.assign(engine, {
    revision: snapshot.revision,
    playlist: snapshot.playlist || [],
    trackIdx: snapshot.trackIdx ?? 0,
    trackKey: snapshot.trackKey ?? null,
    shuffleOn: !!snapshot.shuffleOn,
    repeatMode: snapshot.repeatMode || 'none',
    vol: Number.isFinite(snapshot.vol) ? snapshot.vol : 100,
  });
  notify('engine');
}

function applyPlayback(value) {
  if (!value) return;
  Object.assign(playback, {
    playing: !!value.playing,
    currentTime: Number(value.currentTime) || 0,
    duration: Number(value.duration) || 0,
    source: value.source ?? null,
    at: performance.now(),
  });
  notify('playback');
}

/** The playhead now, moving smoothly between the service's time updates. */
export function currentTime() {
  if (!playback.playing) return playback.currentTime;
  const moved = playback.currentTime + (performance.now() - playback.at) / 1000;
  return playback.duration ? Math.min(playback.duration, moved) : moved;
}

let albumsCache = null;
async function reloadLibrary() {
  const { albums, folders } = await loadLibraryMeta();
  library.albums = albums && typeof albums === 'object' ? albums : {};
  library.folders = Array.isArray(folders) ? folders : [];
  albumsCache = null;
  notify('library');
}

/** Albums sorted by artist, then title (the engine's own order). */
export function getAlbums() {
  if (albumsCache) return albumsCache;
  albumsCache = Object.entries(library.albums)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (normaliseMetadataText(a.artist) + normaliseMetadataText(a.album))
      .localeCompare(normaliseMetadataText(b.artist) + normaliseMetadataText(b.album)));
  return albumsCache;
}

export const hasLibrary = () => Object.keys(library.albums).length > 0;

export function currentTrack() {
  return engine.playlist[engine.trackIdx] || null;
}

let connecting = null;
/** Load everything once and follow changes. Call before drawing a view. */
export function connect() {
  connecting ||= (async () => {
    await loadState();
    atmos.events.on('engine', applyEngine);
    atmos.events.on('waveform', value => { waveform = value || { key: null, data: null, max: 1 }; notify('waveform'); });
    atmos.events.on('library-changed', () => { void reloadLibrary(); });
    atmos.events.on('library-status', value => { libraryStatus = value || libraryStatus; notify('status'); });
    atmos.audio.onChange(applyPlayback);
    const [snapshot, wave, status, state] = await Promise.all([
      call('snapshot'), call('waveform'), call('libraryStatus'), atmos.audio.state(), reloadLibrary(),
    ]);
    applyEngine(snapshot);
    applyPlayback(state);
    if (wave) waveform = wave;
    if (status) libraryStatus = status;
  })();
  return connecting;
}

// ── Actions ─────────────────────────────────────────────────────────────────

const report = promise => promise.catch(error => { console.error('[audio-player]', error); return false; });

export const togglePlay = () => report(call('togglePlay'));
export const playPrev = () => report(call('playPrev'));
export const playNext = () => report(call('playNext'));
export const toggleShuffle = () => report(call('toggleShuffle'));
export const cycleRepeat = () => report(call('cycleRepeat'));
export const loadIndex = index => report(call('loadIndex', index));
export const playAlbum = (albumKey, index = 0) => report(call('playAlbum', albumKey, index));
export const queueAlbum = albumKey => report(call('queueAlbum', albumKey));
export const playTrack = (key, name) => report(call('playTrack', key, name));
export const queueTrack = key => report(call('queueTrack', key));
export const playFiles = files => report(call('playFiles', [...files]));

export function seek(seconds) {
  playback.currentTime = seconds;
  playback.at = performance.now();
  notify('playback');
  return report(call('seek', seconds));
}

export function setVolume(value) {
  engine.vol = Math.max(0, Math.min(100, Number(value) || 0));
  notify('engine');
  return report(call('setVolume', engine.vol));
}

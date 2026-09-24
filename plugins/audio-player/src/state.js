/**
 * Audio Player's saved settings, shared by all of its frames.
 *
 * Atmos keeps them in the `audio-player` state namespace: the same one the
 * in-page Audio Player used, so everything saved before the move to frames
 * is simply there. Each frame holds a copy (audioState) and follows every
 * change another frame saves.
 *
 * The engine (boot.js) owns playback keys, the views own display keys; each
 * saves only its own, so neither overwrites what the other just changed.
 */
import atmos from 'atmos-sdk';

const LEGACY_GRADIENT = {
  default: ['#c084fc', '#818cf8', '#38bdf8'],
  sunset: ['#fb923c', '#f472b6', '#c084fc'],
  aurora: ['#34d399', '#22d3ee', '#818cf8'],
};
const LEGACY_SOLID = {
  white: '#ffffff', purple: '#a855f7', teal: '#2dd4bf',
  pink: '#f472b6', amber: '#fbbf24',
};

export const defaults = Object.freeze({
  albumCoverSize: 160,
  albumCoverSaturation: 100,
  trackIdx: 0,
  trackKey: null,
  trackPos: null,
  shuffleOn: false,
  repeatMode: 'none',
  vol: 100,
  seekStyle: 'waveform',
  waveformFps: 5,
  // Before frames, Audio Player moved its own drawer; Atmos does now.
  // These two are only read once, to hand the old position to Atmos.
  audioBarPlacement: 'top',
  drawerPlacement: null,
  drawerHandedOver: false,
  seekColor: { mode: 'solid', stops: [...LEGACY_GRADIENT.default], solid: '#ffffff', autoStops: null },
  electronFolders: [],
  albumLabelsHidden: false,
  albumDimMode: 'always',
  albumDim: 50,
  albumGridSort: 'artist',
  tracklistWidth: 246,
  tracklistCollapsed: false,
  fullBarWaveform: false,
});

/** Saved by the engine (boot frame). Everything else is saved by views. */
export const ENGINE_KEYS = Object.freeze(['vol', 'shuffleOn', 'repeatMode', 'trackIdx', 'trackPos', 'trackKey', 'electronFolders']);

export const audioState = structuredClone({ ...defaults });

export function applySaved(target, saved = {}) {
  if (!saved || typeof saved !== 'object') return;
  if (Number.isFinite(saved.vol)) target.vol = saved.vol;
  if (typeof saved.shuffleOn === 'boolean') target.shuffleOn = saved.shuffleOn;
  if (['none', 'all', 'one'].includes(saved.repeatMode)) target.repeatMode = saved.repeatMode;
  if (saved.trackIdx != null) target.trackIdx = saved.trackIdx;
  if (saved.trackPos !== undefined) target.trackPos = saved.trackPos;
  if (saved.trackKey !== undefined) target.trackKey = saved.trackKey;
  if (saved.seekStyle) target.seekStyle = saved.seekStyle === 'freqbars' || saved.seekStyle === 'spectrum' ? 'waveform' : saved.seekStyle;
  if (Number.isFinite(saved.waveformFps)) target.waveformFps = Math.max(1, Math.min(1000, Math.round(saved.waveformFps)));
  if (saved.audioBarPlacement !== undefined) target.audioBarPlacement = saved.audioBarPlacement === 'bottom' ? 'bottom' : 'top';
  if (Number.isFinite(saved.drawerPlacement)) target.drawerPlacement = Math.max(0, Math.min(2, saved.drawerPlacement));
  if (typeof saved.drawerHandedOver === 'boolean') target.drawerHandedOver = saved.drawerHandedOver;
  for (const key of ['albumCoverSize', 'albumCoverSaturation', 'albumDim', 'tracklistWidth']) {
    if (Number.isFinite(saved[key])) target[key] = saved[key];
  }
  for (const key of ['albumLabelsHidden', 'fullBarWaveform', 'tracklistCollapsed']) {
    if (typeof saved[key] === 'boolean') target[key] = saved[key];
  }
  if (saved.albumDimMode === 'always' || saved.albumDimMode === 'hover') target.albumDimMode = saved.albumDimMode;
  if (['artist', 'album', 'year-desc', 'year-asc'].includes(saved.albumGridSort)) target.albumGridSort = saved.albumGridSort;
  if (Array.isArray(saved.electronFolders)) target.electronFolders = saved.electronFolders.map(folder => ({ ...folder }));
  if (saved.seekColor && typeof saved.seekColor === 'object') {
    const color = saved.seekColor;
    target.seekColor = {
      mode: ['gradient', 'solid', 'auto'].includes(color.mode) ? color.mode : 'gradient',
      stops: Array.isArray(color.stops) && color.stops.length >= 2
        ? [...color.stops] : [...(LEGACY_GRADIENT[color.preset] || LEGACY_GRADIENT.default)],
      solid: typeof color.solid === 'string' && color.solid
        ? color.solid : (LEGACY_SOLID[color.preset] || '#ffffff'),
      autoStops: target.seekColor?.autoStops ?? null,
    };
  }
}

function serialize(key) {
  const value = audioState[key];
  if (key === 'seekColor') return { mode: value.mode, stops: [...value.stops], solid: value.solid };
  if (key === 'electronFolders') return value.map(folder => ({ ...folder }));
  return value;
}

const listeners = new Set();
let loaded = null;

/**
 * Load the saved settings once and follow changes from other frames. Keys in
 * `keep` are this frame's own (the engine's playback keys): another frame's
 * save never overwrites them here.
 */
export function loadState({ keep = [] } = {}) {
  loaded ||= (async () => {
    applySaved(audioState, await atmos.state.get());
    atmos.state.onChange(saved => {
      // This frame's own keys, and changes it hasn't saved yet, stay as they are.
      const own = Object.fromEntries([...keep, ...pending].map(key => [key, audioState[key]]));
      applySaved(audioState, saved);
      Object.assign(audioState, own);
      for (const fn of [...listeners]) {
        try { fn(); } catch (error) { console.error('[audio-player] state listener failed:', error); }
      }
    });
  })();
  return loaded;
}

/** Called after another frame saved settings. Returns an unsubscribe function. */
export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const pending = new Set();
let timer = null;

/** Save these keys (debounced; rapid slider drags write once). */
export function save(...keys) {
  for (const key of keys.flat()) if (key in defaults) pending.add(key);
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

/** Write pending keys now (before the frame goes away, say). */
export function flush() {
  clearTimeout(timer);
  timer = null;
  if (!pending.size) return Promise.resolve();
  const patch = {};
  for (const key of pending) patch[key] = serialize(key);
  pending.clear();
  return atmos.state.update(patch).catch(error => console.error('[audio-player] could not save settings:', error));
}

addEventListener('pagehide', () => { void flush(); });

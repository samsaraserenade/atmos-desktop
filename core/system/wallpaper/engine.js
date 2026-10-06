import { createEventScope } from 'atmos-core/core/events.js';
import { deleteAsset, loadAsset, saveAsset } from 'atmos-core/persist.js';
import { wallpaperState, updateWallpaperState } from './persist.js';
import { applyWallpaperPresentation } from './interaction.js';

const events = createEventScope('wallpaper');
const temporary = new Map();
const ASSET_KEY = 'wallpaper:image';
// The image an extension replaced, kept so it can be put back (restorePrevious).
const PREVIOUS_KEY = 'wallpaper:previous';
// Where the image was kept before: as the Background plugin, and before that.
const LEGACY_ASSET_KEYS = ['background:wallpaper', 'background'];

// The image Atmos shows until you choose your own or remove it (Core's
// assets, served with the Atmos page).
const DEFAULT_IMAGE = new URL('assets/atmos-background.jpg', document.baseURI).href;

let imageEl = null;
let overlayEl = null;
let persistentImage = DEFAULT_IMAGE;
let persistentObjectUrl = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

function effective() {
  const value = { ...wallpaperState, image: persistentImage };
  for (const override of temporary.values()) Object.assign(value, override);
  return value;
}

function paint() {
  const value = effective();
  applyWallpaperPresentation();
  if (!imageEl || !overlayEl) return;
  imageEl.style.backgroundImage = value.image ? `url("${String(value.image).replaceAll('"', '\\"')}")` : 'none';
  imageEl.style.backgroundPosition = `${value.positionX}% ${value.positionY}%`;
  imageEl.style.filter = `brightness(${value.brightness / 100}) contrast(${value.contrast / 100}) hue-rotate(${value.hue}deg) saturate(${value.glassSaturation / 100})`;
  overlayEl.style.background = `radial-gradient(circle, rgba(0,0,0,0) 30%, rgba(0,0,0,${value.vignette / 100}) 100%)`;
  // Avoid a full-window backdrop-filter compositor pass at the default 0px.
  // Saturation is handled by the image filter above.
  overlayEl.style.backdropFilter = value.glassBlur > 0 ? `blur(${value.glassBlur}px)` : 'none';
  overlayEl.style.webkitBackdropFilter = overlayEl.style.backdropFilter;
  events.emit('changed', getState());
}

function replacePersistentObjectUrl(blob) {
  if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
  persistentObjectUrl = URL.createObjectURL(blob);
  persistentImage = persistentObjectUrl;
}

export async function initialize() {
  if (wallpaperState.wallpaperRemoved === true) persistentImage = '';
  let blob = await loadAsset(ASSET_KEY);
  for (const legacyKey of LEGACY_ASSET_KEYS) {
    if (blob) break;
    const legacy = await loadAsset(legacyKey);
    if (legacy && await saveAsset(ASSET_KEY, legacy)) {
      blob = legacy;
      await deleteAsset(legacyKey);
    }
  }
  // Your own image, else the default, unless the wallpaper was removed.
  if (wallpaperState.wallpaperRemoved === true) persistentImage = '';
  else if (blob) replacePersistentObjectUrl(blob);
  else persistentImage = DEFAULT_IMAGE;
  paint();
}

export function mount(host, context) {
  host.innerHTML = '<div class="wallpaper-image"></div><div class="wallpaper-overlay"></div>';
  imageEl = host.querySelector('.wallpaper-image');
  overlayEl = host.querySelector('.wallpaper-overlay');
  paint();

  let frame = null;
  context.onCleanup(() => { if (frame) cancelAnimationFrame(frame); });
  context.listen(document, 'mousemove', event => {
    if (wallpaperState.parallaxStrength <= 0 || frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const divisor = 2000 / wallpaperState.parallaxStrength;
      imageEl.style.transform = `translate3d(${(innerWidth / 2 - event.pageX) / divisor}px, ${(innerHeight / 2 - event.pageY) / divisor}px, 0) scale(1.1)`;
    });
  });
  context.listen(document, 'wheel', event => {
    if (!event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    const step = (event.deltaY > 0 ? 1 : -1) * 2;
    if (event.ctrlKey) setState({ positionY: clamp(Number(wallpaperState.positionY) + step, 0, 100) });
    else setState({ positionX: clamp(Number(wallpaperState.positionX) + step, 0, 100) });
  }, { passive: false });
  context.onCleanup(() => {
    imageEl = null;
    overlayEl = null;
    if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
    persistentObjectUrl = null;
  });
}

// `mode` and `opacity` are what they always are now, for code that still
// reads them: the see-through window they described is gone (Atmos 0.24).
const SEE_THROUGH_GONE = Object.freeze({ mode: 'wallpaper', opacity: 100 });

export function getState() { return Object.freeze({ ...effective(), ...SEE_THROUGH_GONE }); }
export function getPersistentState() {
  return Object.freeze({ ...wallpaperState, image: persistentImage, ...SEE_THROUGH_GONE });
}

let warnedSeeThrough = false;

export function setState(patch) {
  const next = {};
  // Deprecated (SDK 1.7): 'transparent' (See-through) and an opacity are
  // still taken, so nothing that sets them breaks, and change nothing.
  if (patch.mode != null && !['transparent', 'wallpaper'].includes(patch.mode)) throw new TypeError(`background: invalid mode '${patch.mode}'`);
  if ((patch.mode === 'transparent' || patch.opacity != null) && !warnedSeeThrough) {
    warnedSeeThrough = true;
    console.warn('[wallpaper] mode \'transparent\' and opacity are deprecated and do nothing: Atmos has no see-through window');
  }
  if (patch.parallaxStrength != null) next.parallaxStrength = clamp(patch.parallaxStrength, 0, 100);
  if (patch.glassBlur != null) next.glassBlur = clamp(patch.glassBlur, 0, 50);
  if (patch.glassSaturation != null) next.glassSaturation = clamp(patch.glassSaturation, 0, 200);
  if (patch.vignette != null) next.vignette = clamp(patch.vignette, 0, 100);
  if (patch.brightness != null) next.brightness = clamp(patch.brightness, 10, 100);
  if (patch.contrast != null) next.contrast = clamp(patch.contrast, 50, 150);
  if (patch.hue != null) next.hue = clamp(patch.hue, -180, 180);
  if (patch.positionX != null) next.positionX = clamp(patch.positionX, 0, 100);
  if (patch.positionY != null) next.positionY = clamp(patch.positionY, 0, 100);
  updateWallpaperState(next);
  if (next.parallaxStrength === 0 && imageEl) imageEl.style.transform = 'translate3d(0,0,0) scale(1.1)';
  paint();
}

function checkImage(file) {
  if (!(file instanceof Blob)) throw new TypeError('wallpaper: wallpaper must be an image Blob');
  if (file.type && !file.type.startsWith('image/')) throw new TypeError('wallpaper: wallpaper must be an image');
}

/** The user chose something themselves: what an extension replaced is theirs to lose. */
async function forgetPrevious() {
  if (!wallpaperState.setBy && !wallpaperState.previous) return;
  await deleteAsset(PREVIOUS_KEY);
  updateWallpaperState({ setBy: null, setByName: null, previous: null });
}

/** The user's own image (Settings, a paste). */
export async function setWallpaper(file) {
  checkImage(file);
  if (!await saveAsset(ASSET_KEY, file)) throw new Error('wallpaper: wallpaper could not be saved');
  await forgetPrevious();
  updateWallpaperState({ wallpaperRemoved: false });
  replacePersistentObjectUrl(file);
  paint();
}

/**
 * An extension's image (atmos.wallpaper.set). What it replaces is kept,
 * once: after several extensions in a row, the one kept is still what the
 * user had. `owner` is "plugin:<id>", `name` what Settings calls it.
 */
export async function setWallpaperFor(owner, name, file) {
  if (typeof owner !== 'string' || !owner) throw new TypeError('wallpaper: an extension wallpaper needs its owner');
  checkImage(file);
  let previous = wallpaperState.previous;
  if (!wallpaperState.setBy || !previous) {
    previous = imageKind();
    if (previous === 'own') {
      const current = await loadAsset(ASSET_KEY);
      if (!current || !await saveAsset(PREVIOUS_KEY, current)) throw new Error('wallpaper: the current wallpaper could not be kept, so it was not replaced');
    } else {
      await deleteAsset(PREVIOUS_KEY);
    }
  }
  if (!await saveAsset(ASSET_KEY, file)) throw new Error('wallpaper: wallpaper could not be saved');
  updateWallpaperState({ wallpaperRemoved: false, setBy: owner, setByName: String(name || owner), previous });
  replacePersistentObjectUrl(file);
  paint();
}

/**
 * Put back what an extension's wallpaper replaced. `owner` given (a frame
 * asking): only if that extension set the current one. Resolves whether
 * anything was put back.
 */
export async function restorePrevious(owner = null) {
  const { setBy, previous } = wallpaperState;
  if (!setBy || !previous || (owner !== null && owner !== setBy)) return false;
  if (previous === 'own') {
    const blob = await loadAsset(PREVIOUS_KEY);
    if (!blob) throw new Error('wallpaper: the previous wallpaper is no longer there');
    if (!await saveAsset(ASSET_KEY, blob)) throw new Error('wallpaper: wallpaper could not be saved');
    replacePersistentObjectUrl(blob);
    updateWallpaperState({ wallpaperRemoved: false });
  } else {
    if (!await deleteAsset(ASSET_KEY)) throw new Error('wallpaper: wallpaper could not be restored');
    if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
    persistentObjectUrl = null;
    persistentImage = previous === 'default' ? DEFAULT_IMAGE : '';
    updateWallpaperState({ wallpaperRemoved: previous === 'none' });
  }
  await deleteAsset(PREVIOUS_KEY);
  updateWallpaperState({ setBy: null, setByName: null, previous: null });
  paint();
  return true;
}

export async function removeWallpaper() {
  if (!await deleteAsset(ASSET_KEY)) throw new Error('wallpaper: wallpaper could not be removed');
  await forgetPrevious();
  for (const legacyKey of LEGACY_ASSET_KEYS) await deleteAsset(legacyKey);
  if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
  persistentObjectUrl = null;
  persistentImage = '';
  updateWallpaperState({ wallpaperRemoved: true });
  paint();
}

/** Back to Atmos's default image: your own is deleted, and the wallpaper shows again. */
export async function useDefaultWallpaper() {
  if (!await deleteAsset(ASSET_KEY)) throw new Error('wallpaper: wallpaper could not be reset');
  await forgetPrevious();
  for (const legacyKey of LEGACY_ASSET_KEYS) await deleteAsset(legacyKey);
  if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
  persistentObjectUrl = null;
  persistentImage = DEFAULT_IMAGE;
  updateWallpaperState({ wallpaperRemoved: false });
  paint();
}

/** Which image is showing: 'own', 'default' or 'none'. */
export function imageKind() {
  if (!persistentImage) return 'none';
  return persistentImage === DEFAULT_IMAGE ? 'default' : 'own';
}

export function setTemporaryEffects(owner, effects = {}) {
  if (!owner) throw new TypeError('wallpaper: temporary effect owner is required');
  temporary.set(owner, { ...(temporary.get(owner) || {}), ...effects });
  paint();
}

export function clearTemporaryEffects(owner) {
  if (temporary.delete(owner)) paint();
}

export function subscribe(listener, options = {}) {
  const off = events.on('changed', listener, options);
  listener(getState());
  return off;
}

// A small copy of the current image, for code that samples its colours
// without being able to load the page's own blob: URL (framed extensions).
const thumbnails = new Map(); // image URL -> Promise<data URL | null>
export function getThumbnail(width = 320) {
  const image = effective().image;
  if (!image) return Promise.resolve(null);
  const size = Math.max(16, Math.min(640, Math.round(Number(width) || 320)));
  const cacheKey = `${size}|${image}`;
  if (!thumbnails.has(cacheKey)) {
    if (thumbnails.size > 8) thumbnails.clear();
    thumbnails.set(cacheKey, new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = Math.max(1, Math.round(size * img.naturalHeight / Math.max(1, img.naturalWidth)));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = image;
    }));
  }
  return thumbnails.get(cacheKey);
}

export const wallpaperApi = Object.freeze({
  getState, getPersistentState, setState, setWallpaper, setWallpaperFor, restorePrevious, removeWallpaper, useDefaultWallpaper, imageKind,
  setTemporaryEffects, clearTemporaryEffects, subscribe, getThumbnail,
});

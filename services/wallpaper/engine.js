import { createEventScope } from 'atmos-core/core/events.js';
import { deleteAsset, loadAsset, saveAsset } from 'atmos-core/persist.js';
import { wallpaperState, updateWallpaperState } from './persist.js';
import { applyWallpaperPresentation, isTransparentWindowActive } from './interaction.js';

const events = createEventScope('wallpaper');
const temporary = new Map();
export const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1503416997304-7f8b4a73b6e7?q=80&w=2000';
const ASSET_KEY = 'wallpaper:image';
// Where the image was kept before: as the Background plugin, and before that.
const LEGACY_ASSET_KEYS = ['background:wallpaper', 'background'];

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
  applyWallpaperPresentation(value);
  if (!imageEl || !overlayEl) return;
  imageEl.parentElement.style.opacity = String(
    value.mode === 'wallpaper' || !isTransparentWindowActive() ? 1 : value.opacity / 100,
  );
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
  if (blob && wallpaperState.wallpaperRemoved !== true) replacePersistentObjectUrl(blob);
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

export function getState() { return Object.freeze({ ...effective() }); }
export function getPersistentState() {
  return Object.freeze({ ...wallpaperState, image: persistentImage });
}

export function setState(patch) {
  const next = {};
  if (patch.mode != null) {
    if (!['transparent', 'wallpaper'].includes(patch.mode)) throw new TypeError(`background: invalid mode '${patch.mode}'`);
    next.mode = patch.mode;
  }
  if (patch.opacity != null) next.opacity = clamp(patch.opacity, 0, 100);
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

export async function setWallpaper(file) {
  if (!(file instanceof Blob)) throw new TypeError('wallpaper: wallpaper must be an image Blob');
  if (file.type && !file.type.startsWith('image/')) throw new TypeError('wallpaper: wallpaper must be an image');
  if (!await saveAsset(ASSET_KEY, file)) throw new Error('wallpaper: wallpaper could not be saved');
  updateWallpaperState({ wallpaperRemoved: false });
  replacePersistentObjectUrl(file);
  paint();
}

export async function removeWallpaper() {
  if (!await deleteAsset(ASSET_KEY)) throw new Error('wallpaper: wallpaper could not be removed');
  for (const legacyKey of LEGACY_ASSET_KEYS) await deleteAsset(legacyKey);
  if (persistentObjectUrl) URL.revokeObjectURL(persistentObjectUrl);
  persistentObjectUrl = null;
  persistentImage = '';
  updateWallpaperState({ mode: 'transparent', opacity: 0, wallpaperRemoved: true });
  paint();
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
  getState, getPersistentState, setState, setWallpaper, removeWallpaper,
  setTemporaryEffects, clearTemporaryEffects, subscribe, getThumbnail,
});

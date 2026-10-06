import {
  registerPersist, registerStateNamespace, onStateLoaded, save,
} from 'atmos-core/persist.js';

export const wallpaperState = registerStateNamespace('wallpaper', {
  version: 3,
  defaults: {
    // Off until chosen (Atmos 0.18): the wallpaper stays still.
    parallaxStrength: 0,
    glassBlur: 0,
    glassSaturation: 60,
    vignette: 25,
    brightness: 90,
    contrast: 100,
    hue: 0,
    positionX: 50,
    positionY: 50,
    // No image: the theme's workspace colour shows instead (Remove).
    wallpaperRemoved: false,
    // Set by an extension (atmos.wallpaper.set): which one ("plugin:<id>"),
    // its name for Settings, and what it replaced ('own', 'default' or
    // 'none'; an own image is kept as the 'wallpaper:previous' asset).
    setBy: null,
    setByName: null,
    previous: null,
  },
  migrate: (data, fromVersion) => (fromVersion < 3 ? withoutSeeThrough(data) : data),
});

/**
 * Version 3 (Atmos 0.24): the see-through window is gone, and with it the
 * wallpaper's `mode` ('transparent' or 'wallpaper') and `opacity`, which
 * only mattered in a see-through window. Remove used to save See-through at
 * 0% as well as `wallpaperRemoved`, and only the flag says removed: an image
 * chosen after a Remove clears it and leaves See-through at 0% saved (an
 * opaque window showed that image). Saved before the flag existed,
 * See-through at 0% was how no wallpaper was kept.
 */
export function withoutSeeThrough(data) {
  if (!data || typeof data !== 'object') return data;
  const { mode, opacity, ...rest } = data;
  if (rest.wallpaperRemoved === undefined && mode === 'transparent' && Number(opacity) === 0) rest.wallpaperRemoved = true;
  return rest;
}

let importedLegacyState = false;

// Wallpaper was the Background plugin, which saved under 'background'.
// Carry that namespace over once; the older bridges below read it too.
registerPersist('wallpaper-from-background', {
  serialize: () => ({}),
  hydrate(blob) {
    const saved = blob?.extensionState;
    if (saved?.wallpaper || !saved?.background?.data) return;
    const data = withoutSeeThrough(saved.background.data);
    for (const key of Object.keys(wallpaperState)) {
      if (data[key] !== undefined) wallpaperState[key] = data[key];
    }
    importedLegacyState = true;
  },
});

// One release bridge from the pre-CoreV2 root fields into this namespace.
registerPersist('background-legacy-migration', {
  serialize: () => ({}),
  hydrate(blob) {
    const saved = blob?.extensionState?.wallpaper ?? blob?.extensionState?.background;
    if (saved) return;
    const mappings = {
      parallaxStrength: 'parallaxStrength', glassBlur: 'glassBlur',
      glassSaturation: 'glassSaturation', vignette: 'vignette',
      bgBrightness: 'brightness', bgContrast: 'contrast', bgHue: 'hue',
      bgPositionX: 'positionX', bgPositionY: 'positionY',
    };
    for (const [legacy, current] of Object.entries(mappings)) {
      if (blob?.[legacy] == null) continue;
      wallpaperState[current] = blob[legacy];
      importedLegacyState = true;
    }
    if (blob?.parallaxStrength == null && blob?.px != null) {
      wallpaperState.parallaxStrength = blob.px === 'off' ? 0 : 50;
      importedLegacyState = true;
    }
  },
});

onStateLoaded(() => {
  // The oldest Atmos kept See-through or Wallpaper here; neither is a choice
  // now (the see-through window is gone).
  try { localStorage.removeItem('atmos_background_mode'); } catch {}
  // Core builds a fresh root object on save, so this successful namespaced
  // write also drops the obsolete root fields instead of preserving sediment.
  if (importedLegacyState) save();
});

export function updateWallpaperState(patch) {
  Object.assign(wallpaperState, patch);
  save();
}

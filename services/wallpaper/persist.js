import {
  registerPersist, registerStateNamespace, onStateLoaded, save,
} from 'atmos-core/persist.js';

export const wallpaperState = registerStateNamespace('wallpaper', {
  version: 2,
  defaults: {
    mode: 'transparent',
    opacity: 0,
    parallaxStrength: 50,
    glassBlur: 0,
    glassSaturation: 60,
    vignette: 25,
    brightness: 90,
    contrast: 100,
    hue: 0,
    positionX: 50,
    positionY: 50,
    wallpaperRemoved: false,
  },
});

let importedLegacyState = false;
let hasPluginPresentationState = false;

// Wallpaper was the Background plugin, which saved under 'background'.
// Carry that namespace over once; the older bridges below read it too.
registerPersist('wallpaper-from-background', {
  serialize: () => ({}),
  hydrate(blob) {
    const saved = blob?.extensionState;
    if (saved?.wallpaper || !saved?.background?.data) return;
    const data = saved.background.data;
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
    hasPluginPresentationState = ['transparent', 'wallpaper'].includes(saved?.data?.mode);
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
  if (!hasPluginPresentationState) {
    try {
      const legacyMode = localStorage.getItem('atmos_background_mode');
      if (legacyMode === 'transparent' || legacyMode === 'wallpaper') {
        wallpaperState.mode = legacyMode;
        wallpaperState.opacity = legacyMode === 'wallpaper' ? 100 : 0;
        importedLegacyState = true;
      }
      localStorage.removeItem('atmos_background_mode');
    } catch {}
  }
  // Core builds a fresh root object on save, so this successful namespaced
  // write also drops the obsolete root fields instead of preserving sediment.
  if (importedLegacyState) save();
});

export function updateWallpaperState(patch) {
  Object.assign(wallpaperState, patch);
  save();
}

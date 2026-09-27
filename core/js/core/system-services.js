/**
 * The system services: Wallpaper, Audio and Location, part of Atmos itself
 * (core/system/<id>). Core loads their modules directly, in the same phases
 * as the rest of the page starts: their state before the saved state is
 * read, their Appearance settings once it is, and their boot hooks (the
 * background layer) with Core's own. They are listed with the extensions
 * (Settings → System) and declare their permissions like them, but are not
 * discovered or switched off.
 */

const SYSTEM = new URL('../../system/', import.meta.url);

async function _load(files) {
  for (const file of files) {
    try {
      await import(new URL(file, SYSTEM).href);
    } catch (error) {
      console.error(`[system] ${file} failed to load:`, error);
    }
  }
}

/** Register their state namespaces; call before persist.js load(). */
export function loadSystemState() {
  return _load(['location/persist.js', 'wallpaper/persist.js']);
}

/** Their controls on Settings → Appearance. */
export function loadSystemSettings() {
  return _load(['location/settings.js', 'wallpaper/settings.js']);
}

/** Register their boot hooks (Audio, then Wallpaper: the background layer). */
export function loadSystemBoot() {
  return _load(['audio/boot.js', 'wallpaper/boot.js']);
}

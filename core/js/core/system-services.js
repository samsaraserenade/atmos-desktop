/**
 * The system services: Wallpaper and Audio, part of Atmos itself
 * (core/system/<id>). (Location is an official service since 0.21,
 * services/location; Core keeps only what hands it to readers.) Core loads their modules directly, in the same phases
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

/**
 * Register their state namespaces; call before persist.js load(). With the
 * location Atmos kept before Location was a service, so the service can
 * take it over (location-legacy.js).
 */
export async function loadSystemState() {
  try { await import('./location-legacy.js'); } catch (error) { console.error('[system] location-legacy.js failed to load:', error); }
  return _load(['wallpaper/persist.js']);
}

/** Their controls on Settings → Appearance. */
export function loadSystemSettings() {
  return _load(['wallpaper/settings.js']);
}

/** Register their boot hooks (Audio, then Wallpaper: the background layer). */
export function loadSystemBoot() {
  return _load(['audio/boot.js', 'wallpaper/boot.js']);
}

/**
 * js/services/location.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Location service — the first of ATMOS's shared services.
 *
 * Owns the versioned `location` state namespace. Handles GPS auto-detect, manual city search
 * (open-meteo geocoding), and reverse geocoding (Nominatim).
 *
 * This module is DOM-free and feature-agnostic: it doesn't know weather,
 * maps, or a sun tracker exist. Consumers (any plugin) either call its
 * functions directly, or listen for the events it emits:
 *
 *   onLocationChange()  → { mode, lat, lon, label }   (fires on every update)
 *   onLocationError()   → { code, message }           (detect() failures)
 *
 * Weather, Maps, Sun Tracker, etc. all read the same service-owned state
 * and subscribe through the namespaced event helpers instead of the service knowing
 * anything about them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { save }  from 'atmos-core/persist.js';
import { createEventScope } from 'atmos-core/core/events.js';
import { locationState } from './persist.js';

const GEOCODE_SEARCH_URL  = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_GEOCODE_URL = 'https://nominatim.openstreetmap.org/reverse';
const events = createEventScope('location');

export function onLocationChange(fn, options) { return events.on('changed', fn, options); }
export function onLocationError(fn, options) { return events.on('error', fn, options); }

// ── Reads ──────────────────────────────────────────────────────────────────

/** Current location snapshot: { mode, lat, lon, label }. */
export function getLocation() {
  return locationState;
}

export function hasLocation() {
  return locationState.lat !== null;
}

// ── Writes ─────────────────────────────────────────────────────────────────

function commit(next) {
  Object.assign(locationState, next);
  save();
  events.emit('changed', getLocation());
  return getLocation();
}

/**
 * Detect the user's location via the browser Geolocation API, then reverse
 * geocode it to a human-readable label. Resolves with the new location, or
 * rejects with an Error (also emitted as 'location:error') on failure.
 */
export function detectLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      const message = 'Geolocation not supported by this browser.';
      events.emit('error', { code: 'unsupported', message });
      reject(new Error(message));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let label = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
        try {
          const r = await fetch(`${REVERSE_GEOCODE_URL}?lat=${lat}&lon=${lon}&format=json`);
          const d = await r.json();
          label = d.address?.city
               || d.address?.town
               || d.address?.village
               || d.address?.county
               || label;
        } catch (_e) { /* keep coordinate fallback */ }

        resolve(commit({ mode: 'auto', lat, lon, label }));
      },
      err => {
        const msgs = { 1: 'Permission denied.', 2: 'Position unavailable.', 3: 'Request timed out.' };
        const message = msgs[err.code] || 'Detection failed.';
        events.emit('error', { code: err.code, message });
        reject(new Error(message));
      },
      { timeout: 8000 }
    );
  });
}

/**
 * Search for places matching a free-text query (open-meteo geocoding).
 * Returns the raw results array: [{ name, admin1, country, latitude, longitude, ... }]
 * Throws on network failure — callers decide how to surface that.
 */
export async function searchLocations(query) {
  query = (query ?? '').trim();
  if (!query) return [];

  const r = await fetch(
    `${GEOCODE_SEARCH_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`
  );
  const d = await r.json();
  return d.results || [];
}

/**
 * Commit a chosen place (one of the objects returned by searchLocations)
 * as the active location.
 */
export function setLocation(place) {
  return commit({
    mode: 'manual',
    lat:  place.latitude,
    lon:  place.longitude,
    label: place.name,
  });
}

/** Clear the active location back to the unset default. */
export function resetLocation() {
  return commit({ mode: 'auto', lat: null, lon: null, label: 'Not set' });
}

/**
 * The Location service's logic, without the page (tests/location.test.mjs):
 * what a kept location is, and what the two geocoding services answer.
 *
 *   { mode: 'auto' | 'manual', lat, lon, label }, or null when none is set.
 *
 * Search: Open-Meteo's geocoding API. Detect's place name: OpenStreetMap
 * Nominatim's reverse geocoding. Both through atmos.fetch (no cookies, only
 * these two hosts, declared in extension.json).
 */

export const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const text = (value, max) => (typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

/** A location as kept, checked; null for anything that isn't one. */
export function cleanLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const { lat, lon } = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { mode: value.mode === 'manual' ? 'manual' : 'auto', lat, lon, label: text(value.label, 100) || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
}

/** The search's address for `query`. */
export function searchUrl(query) {
  return `${SEARCH_URL}?name=${encodeURIComponent(String(query).trim().slice(0, 60))}&count=5&language=en&format=json`;
}

/** Open-Meteo's answer: [{ name, sub, lat, lon }], five at most. */
export function placesFrom(answer) {
  const results = Array.isArray(answer?.results) ? answer.results : [];
  return results.slice(0, 5).map(place => ({
    name: text(place?.name, 80),
    sub: [text(place?.admin1, 60), text(place?.country, 60)].filter(Boolean).join(', '),
    lat: place?.latitude,
    lon: place?.longitude,
  })).filter(place => place.name && cleanLocation({ lat: place.lat, lon: place.lon }));
}

/** The reverse geocoding's address for a point. */
export function reverseUrl(lat, lon) {
  return `${REVERSE_URL}?lat=${lat}&lon=${lon}&format=json&zoom=10`;
}

/** Nominatim's answer: the place's name (a city, town, village or county), or null. */
export function placeName(answer) {
  const address = answer?.address || {};
  return text(address.city || address.town || address.village || address.county || '', 100) || null;
}

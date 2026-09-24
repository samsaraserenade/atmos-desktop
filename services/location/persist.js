import {
  onStateLoaded,
  registerPersist,
  registerStateNamespace,
  save,
} from 'atmos-core/persist.js';

const DEFAULT_LOCATION = { mode: 'auto', lat: null, lon: null, label: 'Not set' };

function applyLocation(target, value) {
  const valid = value && typeof value === 'object';
  target.mode = valid && value.mode === 'manual' ? 'manual' : 'auto';
  target.lat = valid && Number.isFinite(value.lat) ? value.lat : null;
  target.lon = valid && Number.isFinite(value.lon) ? value.lon : null;
  target.label = valid && typeof value.label === 'string' && value.label
    ? value.label
    : 'Not set';
}

export const locationState = registerStateNamespace('location', {
  version: 1,
  defaults: DEFAULT_LOCATION,
  hydrate: applyLocation,
});

let migratedLegacyState = false;
registerPersist('location-legacy-v1', {
  serialize: () => ({}),
  hydrate(blob) {
    if (blob?.extensionState?.location || !blob?.userLocation) return;
    applyLocation(locationState, blob.userLocation);
    migratedLegacyState = true;
  },
});

onStateLoaded(() => { if (migratedLegacyState) save(); });

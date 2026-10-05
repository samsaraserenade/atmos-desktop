/**
 * The location Atmos kept itself before Location was an official service
 * (Atmos 0.20 and older: the `location` state namespace, and the older flat
 * `userLocation`). Kept as it was until the service has it: the service
 * reads it (atmos.location.takeEarlier), saves it as its own, and only then
 * has it cleared (atmos.location.forgetEarlier, after the service's state
 * is on disk), so a crash in between loses nothing. Without the service it
 * waits here, for when one is installed. The frame host doesn't copy this
 * namespace into the service's state on its first use, as it does other
 * namespaces for the extension of their name (extension-frame-host.js
 * _stateFor).
 */
import { registerPersist, registerStateNamespace, save } from 'atmos-core/persist.js';

const EMPTY = { mode: 'auto', lat: null, lon: null, label: 'Not set' };

function apply(target, value) {
  const valid = value && typeof value === 'object';
  target.mode = valid && value.mode === 'manual' ? 'manual' : 'auto';
  target.lat = valid && Number.isFinite(value.lat) ? value.lat : null;
  target.lon = valid && Number.isFinite(value.lon) ? value.lon : null;
  target.label = valid && typeof value.label === 'string' && value.label ? value.label : 'Not set';
}

const earlier = registerStateNamespace('location', { version: 1, defaults: EMPTY, hydrate: apply });

// Older still: a flat userLocation, before the namespace.
registerPersist('location-legacy-v1', {
  serialize: () => ({}),
  hydrate(blob) {
    if (blob?.extensionState?.location || !blob?.userLocation) return;
    apply(earlier, blob.userLocation);
  },
});

const has = () => Number.isFinite(earlier.lat) && Number.isFinite(earlier.lon);

/** The location kept before, or null. */
export function takeEarlierLocation() {
  return has() ? { mode: earlier.mode, lat: earlier.lat, lon: earlier.lon, label: earlier.label } : null;
}

/** The service has it now: Atmos's copy goes (saved only if there was one). */
export function forgetEarlierLocation() {
  if (!has()) return;
  apply(earlier, EMPTY);
  save();
}

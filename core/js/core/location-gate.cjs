'use strict';
/**
 * Location is off until someone asks for it.
 *
 * The Location service (services/location, official) declares the
 * browser's "geolocation" permission for its frame, and the Atmos page has
 * it too should anything there declare it. Declared isn't the same as
 * wanted: nothing should be able to read where you are just because Atmos
 * is open. So those origins may use geolocation only for a short while
 * after you pressed Detect (Settings → Appearance → Location: the service
 * asks Core, which checks the click landed on its frame); at any other time
 * the permission is refused.
 *
 * Community extensions' frames that declared "geolocation" are not
 * affected: you approved that permission for them.
 */

const DETECT_WINDOW_MS = 15000;

/** `gated(origin)`: whether an origin's geolocation waits for Detect. */
function createLocationGate({ gated, now = () => Date.now(), windowMs = DETECT_WINDOW_MS } = {}) {
  let openUntil = 0;
  return {
    /** Called when the person presses Detect. */
    open() { openUntil = now() + windowMs; },
    /** Whether a declared permission may be used right now by `origin`. */
    allows(permission, origin) {
      if (permission !== 'geolocation' || !gated(origin)) return true;
      return now() < openUntil;
    },
  };
}

module.exports = { createLocationGate };

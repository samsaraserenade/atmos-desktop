'use strict';
/**
 * Location is off until someone asks for it.
 *
 * The Location service runs in the Atmos page, which declares the browser's
 * "geolocation" permission on its behalf. Declared isn't the same as wanted:
 * nothing should be able to read where you are just because Atmos is open.
 * So the Atmos page may use geolocation only for a short while after the
 * Location service says you pressed Detect (Settings → Appearance →
 * Location); at any other time the permission is refused.
 *
 * Framed extensions that declared "geolocation" are not affected: you
 * approved that permission for them when you installed them.
 */

const DETECT_WINDOW_MS = 15000;

function createLocationGate({ appOrigin, now = () => Date.now(), windowMs = DETECT_WINDOW_MS } = {}) {
  let openUntil = 0;
  return {
    /** Called when the person presses Detect. */
    open() { openUntil = now() + windowMs; },
    /** Whether a declared permission may be used right now by `origin`. */
    allows(permission, origin) {
      if (permission !== 'geolocation' || origin !== appOrigin) return true;
      return now() < openUntil;
    },
  };
}

module.exports = { createLocationGate, DETECT_WINDOW_MS };

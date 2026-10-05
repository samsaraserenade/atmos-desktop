/**
 * The user's location, on its way from the Location service to the
 * extensions that read it (atmos.location, "invokes": ["service:location"]).
 *
 * Location is an official service (services/location, Atmos 0.21): it keeps
 * the location, and its Settings page sets it. Core keeps only this: what
 * the service last published, checked, handed to readers (Core is in the
 * middle so a reader needs only its declared permission, not the service's
 * exports) and sent to those following it. Nothing here is saved; the
 * service publishes again when it starts.
 */

const MAX_LABEL = 100;

/** { lat, lon, label, mode }, or null: what a reader may know of the location. */
export function cleanLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const { lat, lon } = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const label = typeof value.label === 'string'
    ? value.label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) || null
    : null;
  return { lat, lon, label, mode: value.mode === 'manual' ? 'manual' : 'auto' };
}

/**
 * `running()`: whether the Location service is there to publish (else a
 * read is null at once); `later(fn, ms)`: a timer. A read before the
 * service's first word waits for it, `waitMs` at most; once a wait runs
 * out, every read waiting ends with it and later ones are null at once
 * until it speaks (a service that never does costs one wait, not one per
 * read). It stopping ends them too.
 */
export function createLocationHub({ running = () => true, waitMs = 15000, later = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let value = null;
  let heard = false;
  let gaveUp = false;
  const waiting = [];
  const watchers = new Set();
  const release = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const tell = () => {
    for (const fn of [...watchers]) {
      try { fn(value); } catch (error) { console.error('[location] watcher failed:', error); }
    }
  };
  return {
    /** The Location service says where you are (null: nowhere set). */
    publish(input) {
      const next = cleanLocation(input);
      const changed = JSON.stringify(next) !== JSON.stringify(value);
      value = next;
      heard = true;
      gaveUp = false;
      release();
      if (changed) tell();
      return value;
    },
    /** The location, once the service has said (or null without it). */
    async get() {
      if (!heard && !gaveUp && running()) {
        await new Promise(resolve => {
          waiting.push(resolve);
          later(() => {
            if (!waiting.includes(resolve)) return; // it spoke (or stopped) in time
            gaveUp = true;
            release();
          }, waitMs);
        });
      }
      return value ? { ...value } : null;
    },
    /** fn(location) on every change. Returns the unsubscribe. */
    subscribe(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    /** The service stopped: nothing to read until it's back. */
    forget() {
      const had = value !== null;
      value = null;
      heard = false;
      gaveUp = false;
      release();
      if (had) tell();
    },
  };
}

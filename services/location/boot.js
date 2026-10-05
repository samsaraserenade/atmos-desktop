/**
 * The Location service's background frame: it keeps the location (in its
 * atmos.state) and publishes it for the extensions that read it
 * (atmos.location; Core hands it to them). Settings → Appearance → Location
 * (settings.js) changes it; this follows the change and publishes again.
 *
 * The first time, it takes over the location Atmos kept itself before it
 * was a service (0.20 and older).
 */
import atmos from 'atmos-sdk';
import { cleanLocation } from './src/location.js';

let published;
async function publish(value) {
  const location = cleanLocation(value);
  const json = JSON.stringify(location);
  if (json === published) return;
  published = json;
  await atmos.location.publish(location).catch(error => console.warn('[location] publish:', error.message));
}

// Settings (another frame) changes it: published again. Followed from the
// start, so a change made while this starts isn't missed (and isn't
// published over with what was read before it).
let changedMeanwhile = false;
atmos.state.onChange(next => {
  changedMeanwhile = true;
  void publish(next?.location);
});

// What it kept; null if that can't be read, and then it writes nothing
// (an empty state saved over it would lose the location).
const saved = await atmos.state.get().then(value => value || {}, error => {
  console.warn('[location] read:', error.message);
  return null;
});
let location = cleanLocation(saved?.location);
if (saved && !saved.tookEarlier) {
  // The first time: what Atmos kept before 0.21 becomes its own, unless
  // you chose in Settings meanwhile (it marks tookEarlier too).
  try {
    const earlier = cleanLocation(await atmos.location.takeEarlier());
    const now = (await atmos.state.get()) || {};
    location = cleanLocation(now.location);
    if (!now.tookEarlier) {
      location ??= earlier;
      await atmos.state.update({ location, tookEarlier: true });
    }
    saved.tookEarlier = true;
  } catch (error) {
    console.warn('[location] taking over the earlier location:', error.message);
  }
}
// Saved here: Atmos's copy can go. (Every start, in case one stopped
// between the save and this; Atmos writes only if there's one.)
if (saved?.tookEarlier) await atmos.location.forgetEarlier().catch(error => console.warn('[location] forget earlier:', error.message));
if (!changedMeanwhile) await publish(location);

// The Location service: what it keeps, the geocoders' answers (src/location.js),
// and its background frame against a fake Atmos (boot.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { cleanLocation, placesFrom, placeName, searchUrl, reverseUrl } from '../src/location.js';
import { installFakeAtmos } from '../../../core/js/sdk/testing/fake-atmos.mjs';

// 'atmos-sdk' is the SDK's fake (as the template's register.mjs makes it).
const fakeSdk = new URL('../../../core/js/sdk/testing/sdk.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, nextResolve) => (specifier === 'atmos-sdk' ? { url: fakeSdk, shortCircuit: true } : nextResolve(specifier, context)) });

test('a kept location is a place on Earth, with a plain name', () => {
  assert.deepEqual(cleanLocation({ mode: 'manual', lat: 51.5, lon: -0.12, label: ' London‮ ' }), { mode: 'manual', lat: 51.5, lon: -0.12, label: 'London' });
  assert.deepEqual(cleanLocation({ lat: 1.234, lon: 5.678 }), { mode: 'auto', lat: 1.234, lon: 5.678, label: '1.23, 5.68' }, 'no name: its coordinates');
  for (const bad of [null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: '1', lon: 2 }]) assert.equal(cleanLocation(bad), null);
});

test('the geocoders: their answers, bounded; addresses escaped', () => {
  assert.equal(searchUrl(' São Paulo&x=1 '), 'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo%26x%3D1&count=5&language=en&format=json');
  assert.equal(reverseUrl(51.5, -0.12), 'https://nominatim.openstreetmap.org/reverse?lat=51.5&lon=-0.12&format=json&zoom=10');
  const places = placesFrom({ results: [
    { name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.5, longitude: -0.12 },
    { name: 'Nowhere', latitude: 200, longitude: 0 },
    { name: '', latitude: 1, longitude: 1 },
    ...Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, latitude: i, longitude: i })),
  ] });
  assert.deepEqual(places[0], { name: 'London', sub: 'England, United Kingdom', lat: 51.5, lon: -0.12 });
  assert.equal(places.length, 3, 'five looked at, the ones without a place on Earth or a name dropped');
  assert.deepEqual(placesFrom(null), []);
  assert.equal(placeName({ address: { town: 'Bath', county: 'Somerset' } }), 'Bath');
  assert.equal(placeName({}), null);
});

test('its background frame takes over the location Atmos kept, once, and publishes what it keeps', async () => {
  const atmos = installFakeAtmos({
    extension: { id: 'location', kind: 'service', tier: 'first-party' },
    earlierLocation: { mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' },
  });
  await import('../boot.js');
  assert.deepEqual(atmos.fake.locationPublished, [{ mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' }]);
  assert.deepEqual(await atmos.state.get(), { location: { mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' }, tookEarlier: true });
  assert.equal(atmos.fake.earlierLocation, null, 'saved here: gone from Atmos');
  // Settings (another frame) changes it: published again; cleared: null.
  atmos.fake.setState({ location: { mode: 'manual', lat: 51.5, lon: -0.12, label: 'London' }, tookEarlier: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  atmos.fake.setState({ location: null, tookEarlier: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(atmos.fake.locationPublished.slice(1), [{ mode: 'manual', lat: 51.5, lon: -0.12, label: 'London' }, null]);
});

test('what it kept unreadable: it writes nothing, and Atmos keeps its copy', async () => {
  const paris = { mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' };
  const atmos = installFakeAtmos({ extension: { id: 'location', kind: 'service', tier: 'first-party' }, earlierLocation: paris, state: { location: paris, tookEarlier: true } });
  const real = globalThis.__atmosFake;
  globalThis.__atmosFake = { ...real, state: { ...real.state, get: async () => { throw new Error('unreadable'); } } };
  try { await import('../boot.js?unreadable'); } finally { globalThis.__atmosFake = real; }
  assert.deepEqual(atmos.fake.locationPublished, [null]);
  assert.deepEqual(await atmos.state.get(), { location: paris, tookEarlier: true }, 'not written over');
  assert.deepEqual(atmos.fake.earlierLocation, paris);
});

test('saved here but stopped before Atmos cleared its copy: cleared at the next start, nothing taken twice', async () => {
  const london = { mode: 'manual', lat: 51.5, lon: -0.12, label: 'London' };
  const atmos = installFakeAtmos({
    extension: { id: 'location', kind: 'service', tier: 'first-party' },
    earlierLocation: { mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' },
    state: { location: london, tookEarlier: true },
  });
  await import('../boot.js?again');
  assert.deepEqual(atmos.fake.locationPublished, [london]);
  assert.equal(atmos.fake.earlierLocation, null);
});

test('chosen in Settings while it starts: that stands, over what Atmos kept and what it read before', async () => {
  const paris = { mode: 'manual', lat: 48.85, lon: 2.35, label: 'Paris' };
  const london = { mode: 'manual', lat: 51.5, lon: -0.12, label: 'London' };
  const atmos = installFakeAtmos({ extension: { id: 'location', kind: 'service', tier: 'first-party' }, earlierLocation: paris });
  const real = globalThis.__atmosFake;
  globalThis.__atmosFake = { ...real, location: { ...real.location, async takeEarlier() {
    const earlier = await real.location.takeEarlier();
    atmos.fake.setState({ location: london, tookEarlier: true }); // Settings, meanwhile
    return earlier;
  } } };
  try { await import('../boot.js?meanwhile'); } finally { globalThis.__atmosFake = real; }
  assert.deepEqual(await atmos.state.get(), { location: london, tookEarlier: true });
  assert.deepEqual(atmos.fake.locationPublished, [london]);
  assert.equal(atmos.fake.earlierLocation, null);
});

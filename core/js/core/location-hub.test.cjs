'use strict';
// The location on its way from the Location service to its readers (location-hub.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, 'location-hub.js')).href);

test('only a place on Earth, with a plain label', async () => {
  const { cleanLocation } = await load();
  assert.deepEqual(cleanLocation({ lat: 51.5, lon: -0.12, label: ' London‮ ', mode: 'manual', extra: 1 }), { lat: 51.5, lon: -0.12, label: 'London', mode: 'manual' });
  assert.equal(cleanLocation({ lat: 91, lon: 0 }), null);
  assert.equal(cleanLocation({ lat: 0, lon: 'x' }), null);
  assert.equal(cleanLocation(null), null);
  assert.equal(cleanLocation({ lat: 1, lon: 2, label: 'x'.repeat(500) }).label.length, 100);
  assert.equal(cleanLocation({ lat: 1, lon: 2 }).mode, 'auto');
});

test('a read waits for the service\'s first word; followers hear changes only', async () => {
  const { createLocationHub } = await load();
  const timers = [];
  let running = true;
  const hub = createLocationHub({ running: () => running, later: (fn, ms) => timers.push({ fn, ms }) });
  const heard = [];
  hub.subscribe(value => heard.push(value));
  const early = hub.get();
  hub.publish({ lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' });
  assert.deepEqual(await early, { lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' });
  hub.publish({ lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' });
  assert.equal(heard.length, 1, 'the same again: nothing to tell');
  hub.publish(null);
  assert.deepEqual(heard, [{ lat: 48.85, lon: 2.35, label: 'Paris', mode: 'manual' }, null]);
  // The service gone: null at once.
  hub.forget();
  running = false;
  assert.equal(await hub.get(), null);
  // Running but silent: the wait ends, and the next reads don't wait again.
  running = true;
  timers.splice(0); // the first read's, long answered
  const late = [hub.get(), hub.get()];
  assert.equal(timers.length, 2);
  timers.shift().fn(); // the first wait runs out: both end
  assert.deepEqual(await Promise.all(late), [null, null]);
  timers.shift().fn(); // the second's timer: nothing left to do
  assert.equal(await hub.get(), null);
  assert.equal(timers.length, 0, 'given up: null at once');
  // Until it speaks; stopped and back, a read waits for it again.
  hub.publish({ lat: 1, lon: 2 });
  assert.deepEqual(await hub.get(), { lat: 1, lon: 2, label: null, mode: 'auto' });
  hub.forget();
  const again = hub.get();
  assert.equal(timers.length, 1);
  hub.publish(null);
  assert.equal(await again, null);
  timers[0].fn(); // its timer, after it spoke: nothing
  assert.equal(timers[0].ms, 15000);
  // Stopped while a read waits: it ends at once; its old timer, firing
  // once the service is back, gives nothing up.
  hub.forget();
  timers.splice(0);
  const waitingWhenStopped = hub.get();
  hub.forget();
  assert.equal(await waitingWhenStopped, null);
  hub.publish({ lat: 3, lon: 4 });
  timers[0].fn();
  hub.forget();
  const afterBack = hub.get();
  assert.equal(timers.length, 2, 'a read waits again: nothing was given up');
  hub.publish({ lat: 5, lon: 6 });
  assert.equal((await afterBack).lat, 5);
});

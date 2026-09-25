'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocationGate } = require('./location-gate.cjs');

test('location is refused to the Atmos page until Detect, then only briefly', () => {
  let clock = 1000;
  const gate = createLocationGate({ appOrigin: 'atmos-app://local', now: () => clock, windowMs: 15000 });
  assert.equal(gate.allows('geolocation', 'atmos-app://local'), false);
  gate.open();
  assert.equal(gate.allows('geolocation', 'atmos-app://local'), true);
  clock += 15001;
  assert.equal(gate.allows('geolocation', 'atmos-app://local'), false);
});

test('other permissions and approved framed extensions are unaffected', () => {
  const gate = createLocationGate({ appOrigin: 'atmos-app://local', now: () => 0 });
  assert.equal(gate.allows('notifications', 'atmos-app://local'), true);
  assert.equal(gate.allows('geolocation', 'atmos-ext://plugin-weather'), true);
});

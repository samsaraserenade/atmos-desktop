'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocationGate } = require('./location-gate.cjs');

const SERVICE = 'atmos-ext://first-party-service-location';
const gated = origin => origin === SERVICE || origin === 'atmos-app://local';

test('location is refused to the Location service until Detect, then only briefly', () => {
  let clock = 1000;
  const gate = createLocationGate({ gated, now: () => clock, windowMs: 15000 });
  for (const origin of [SERVICE, 'atmos-app://local']) assert.equal(gate.allows('geolocation', origin), false, origin);
  gate.open();
  assert.equal(gate.allows('geolocation', SERVICE), true);
  clock += 15001;
  assert.equal(gate.allows('geolocation', SERVICE), false);
});

test('other permissions and approved community frames are unaffected', () => {
  const gate = createLocationGate({ gated, now: () => 0 });
  assert.equal(gate.allows('notifications', SERVICE), true);
  assert.equal(gate.allows('geolocation', 'atmos-ext://plugin-weather'), true);
});

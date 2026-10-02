'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkElectron } = require('./electron-current.cjs');

const tags = { latest: '44.5.1', '44-x-y': '44.5.1', '43-x-y': '43.7.7' };

test('the newest patch of its line is current; an older one is not', () => {
  assert.equal(checkElectron('44.5.1', tags).ok, true);
  const old = checkElectron('44.4.5', tags);
  assert.equal(old.ok, false);
  assert.match(old.message, /behind 44\.5\.1.*electron@44\.5\.1/);
  assert.equal(checkElectron('^44.4.5', tags).ok, false, 'a range is read as its lowest version');
});

test('a newer major is mentioned, not required', () => {
  const result = checkElectron('43.7.7', tags);
  assert.equal(result.ok, true);
  assert.match(result.message, /44\.5\.1 \(a newer major\)/);
});

test('a line npm doesn\'t list (or no answer) doesn\'t stop a release', () => {
  assert.equal(checkElectron('40.0.0', tags).ok, true);
  assert.equal(checkElectron('44.5.1', null).ok, true);
});

'use strict';
// What extensions share with each other ("exports" in extension.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExports, levelAllows, reachOf, describePermissions } = require('./extension-permissions.cjs');

test('exports: missing shares nothing; names map to "official" or "all"', () => {
  assert.deepEqual(normalizeExports(undefined), { ipc: {}, events: {}, methods: {}, resources: {} });
  assert.deepEqual(normalizeExports({ ipc: { 'read-tags': 'official' }, methods: { greet: 'all' } }).ipc, { 'read-tags': 'official' });
  assert.throws(() => normalizeExports([]), /must be an object/);
  assert.throws(() => normalizeExports({ files: {} }), /unknown exports "files"/);
  assert.throws(() => normalizeExports({ ipc: ['read'] }), /exports\.ipc must be an object/);
  assert.throws(() => normalizeExports({ ipc: { read: true } }), /must be "official" or "all"/);
  assert.throws(() => normalizeExports({ ipc: { '../x': 'all' } }), /invalid name/);
});

test('exports: "official" reaches system and official extensions, "all" community ones too', () => {
  assert.equal(levelAllows('official', 'system'), true);
  assert.equal(levelAllows('official', 'first-party'), true);
  assert.equal(levelAllows('official', 'third-party'), false);
  assert.equal(levelAllows('all', 'third-party'), true);
  assert.equal(levelAllows(undefined, 'first-party'), false);
});

test('reach: own extension everything, undeclared nothing, declared what is shared with its tier', () => {
  const target = {
    kind: 'service', id: 'media-metadata',
    exports: { ipc: { 'read-file-bytes': 'official', 'read-tags': 'all' }, events: { changed: 'all' }, resources: { art: 'official' } },
  };
  const own = { kind: 'service', id: 'media-metadata', tier: 'first-party', invokes: [] };
  assert.equal(reachOf(own, target), null);

  const official = { kind: 'plugin', id: 'audio-player', tier: 'first-party', invokes: ['service:media-metadata'] };
  assert.deepEqual(reachOf(official, target), { ipc: ['read-file-bytes', 'read-tags'], events: ['changed'], methods: [], resources: ['art'] });

  const community = { kind: 'plugin', id: 'hello', tier: 'third-party', invokes: ['service:media-metadata'] };
  assert.deepEqual(reachOf(community, target), { ipc: ['read-tags'], events: ['changed'], methods: [], resources: [] });

  const undeclared = { kind: 'plugin', id: 'hello', tier: 'first-party', invokes: [] };
  assert.deepEqual(reachOf(undeclared, target), { ipc: [], events: [], methods: [], resources: [] });

  const malformed = { ...target, exports: { ipc: { read: 'everyone' } } };
  assert.deepEqual(reachOf(official, malformed), { ipc: [], events: [], methods: [], resources: [] });
});

test('the approval text says an extension uses what others share, not that it can call them', () => {
  assert.ok(describePermissions({ invokes: ['service:media-metadata'] }).includes('Use what media-metadata shares with other extensions'));
});

test('reach: an official extension with no "exports" yet shares everything with official ones, nothing with community ones', () => {
  const { reaches } = require('./extension-permissions.cjs');
  const legacy = { kind: 'service', id: 'market-data', exports: undefined };
  const finance = { kind: 'plugin', id: 'finance', tier: 'first-party', invokes: ['service:market-data'] };
  const community = { kind: 'plugin', id: 'hello', tier: 'third-party', invokes: ['service:market-data'] };
  const all = reachOf(finance, legacy);
  assert.deepEqual(all.ipc, ['*']);
  assert.equal(reaches(all.ipc, 'subscribe'), true);
  assert.deepEqual(reachOf(community, legacy), { ipc: [], events: [], methods: [], resources: [] });
  // An empty block is a choice: nothing shared, even with official extensions.
  assert.deepEqual(reachOf(finance, { ...legacy, exports: {} }).ipc, []);
  assert.equal(reaches([], 'subscribe'), false);
});

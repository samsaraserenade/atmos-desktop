'use strict';
// What extensions share with each other ("exports" in extension.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExports, exportDetails, describeExports, sharingRisk, levelAllows, reachOf, describePermissions } = require('./extension-permissions.cjs');

test('exports: missing shares nothing; names map to "official" or "all"', () => {
  assert.deepEqual(normalizeExports(undefined), { ipc: {}, events: {}, methods: {} });
  assert.deepEqual(normalizeExports({ ipc: { 'read-tags': 'official' }, methods: { greet: 'all' } }).ipc, { 'read-tags': 'official' });
  assert.throws(() => normalizeExports([]), /must be an object/);
  assert.throws(() => normalizeExports({ files: {} }), /unknown exports "files"/);
  assert.throws(() => normalizeExports({ ipc: ['read'] }), /exports\.ipc must be an object/);
  assert.throws(() => normalizeExports({ ipc: { read: true } }), /must be "official", "all" or \{/);
  assert.throws(() => normalizeExports({ ipc: { read: 'everyone' } }), /must be "official" or "all"/);
  assert.throws(() => normalizeExports({ ipc: { '../x': 'all' } }), /invalid name/);
});

test('exports: a name may say what it gives ({ with, description }), which only Settings uses', () => {
  const block = {
    methods: { palette: { with: 'all', description: '  The sky\'s   colours now,\nwithout your location ' }, paint: 'official' },
    events: { sky: { with: 'official' } },
  };
  assert.deepEqual(normalizeExports(block), { ipc: {}, events: { sky: 'official' }, methods: { palette: 'all', paint: 'official' } });
  assert.equal(exportDetails(block).methods.palette.description, 'The sky\'s colours now, without your location');
  assert.equal(exportDetails(block).events.sky.description, null);
  assert.throws(() => normalizeExports({ methods: { a: { with: 'all', desc: 'x' } } }), /unknown "desc"/);
  assert.throws(() => normalizeExports({ methods: { a: { description: 'x' } } }), /\.with must be/);
  assert.throws(() => normalizeExports({ methods: { a: { with: 'all', description: '' } } }), /1–200 characters/);
  assert.throws(() => normalizeExports({ methods: { a: { with: 'all', description: 'x'.repeat(201) } } }), /1–200 characters/);
  // Reach is decided by the level alone.
  const target = { kind: 'plugin', id: 'skyloom', exports: block };
  assert.deepEqual(reachOf({ kind: 'plugin', id: 'other', tier: 'third-party', invokes: ['plugin:skyloom'] }, target).methods, ['palette']);
});

test('exports: its own card says what it shares, with whom and what for', () => {
  assert.equal(describeExports(undefined), null);
  assert.deepEqual(describeExports({}), []);
  assert.deepEqual(describeExports({
    methods: { snapshot: { with: 'all', description: 'The sky now' }, paint: 'official' },
    events: { sky: 'all' },
    ipc: { 'read-tags': 'official' },
  }), [
    'Any extension can call snapshot(): The sky now',
    'Any extension can hear its sky events',
    'Official extensions can call paint()',
    'Official extensions can use its read-tags handler',
  ]);
});

test('exports: holding something sensitive and sharing with every extension is flagged', () => {
  const shares = { methods: { snapshot: 'all' }, events: { sky: 'all' } };
  assert.equal(sharingRisk({ invokes: ['service:location'] }, shares),
    'It can know your location, and shares sky events and snapshot() with any extension, so what it shares could pass that on.');
  assert.match(sharingRisk({ browser: ['media', 'clipboard-read'] }, { methods: { a: 'all' } }), /^It can read the clipboard and use your camera or microphone, and shares a\(\)/);
  // Nothing sensitive, shared with official extensions only, or nothing shared: no flag.
  assert.equal(sharingRisk({ network: ['api.example.com'] }, shares), null);
  assert.equal(sharingRisk({ invokes: ['service:location'] }, { methods: { snapshot: 'official' } }), null);
  assert.equal(sharingRisk({ invokes: ['service:location'] }, undefined), null);
  assert.equal(sharingRisk({ invokes: ['service:location'] }, { methods: 'bad' }), null);
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
    exports: { ipc: { 'read-file-bytes': 'official', 'read-tags': 'all' }, events: { changed: 'all' } },
  };
  const own = { kind: 'service', id: 'media-metadata', tier: 'first-party', invokes: [] };
  assert.equal(reachOf(own, target), null);

  const official = { kind: 'plugin', id: 'audio-player', tier: 'first-party', invokes: ['service:media-metadata'] };
  assert.deepEqual(reachOf(official, target), { ipc: ['read-file-bytes', 'read-tags'], events: ['changed'], methods: [] });

  const community = { kind: 'plugin', id: 'hello', tier: 'third-party', invokes: ['service:media-metadata'] };
  assert.deepEqual(reachOf(community, target), { ipc: ['read-tags'], events: ['changed'], methods: [] });

  const undeclared = { kind: 'plugin', id: 'hello', tier: 'first-party', invokes: [] };
  assert.deepEqual(reachOf(undeclared, target), { ipc: [], events: [], methods: [] });

  const malformed = { ...target, exports: { ipc: { read: 'everyone' } } };
  assert.deepEqual(reachOf(official, malformed), { ipc: [], events: [], methods: [] });
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
  assert.deepEqual(reachOf(community, legacy), { ipc: [], events: [], methods: [] });
  // An empty block is a choice: nothing shared, even with official extensions.
  assert.deepEqual(reachOf(finance, { ...legacy, exports: {} }).ipc, []);
  assert.equal(reaches([], 'subscribe'), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvokeAuthorizer } = require('./invoke-authorizer.cjs');

// A small catalog: Finance (official) and Audio Player (official) and a
// community extension, with what each declares and shares.
function setup(overrides = {}) {
  const entries = {
    'plugin:finance': { kind: 'plugin', id: 'finance', tier: 'first-party' },
    'service:media-metadata': { kind: 'service', id: 'media-metadata', tier: 'first-party' },
    'service:no-exports': { kind: 'service', id: 'no-exports', tier: 'first-party' },
    'plugin:weather': { kind: 'plugin', id: 'weather', tier: 'third-party' },
    'plugin:stopped': { kind: 'plugin', id: 'stopped', tier: 'third-party' },
  };
  const trust = {
    'plugin:finance': { permissions: { invokes: ['service:media-metadata', 'service:no-exports'] } },
    'service:media-metadata': { permissions: { invokes: [] }, exports: { ipc: { 'read-tags': 'all', 'write-tags': 'official' } } },
    'service:no-exports': { permissions: { invokes: [] } },
    'plugin:weather': { permissions: { invokes: ['service:media-metadata', 'service:no-exports'] } },
    'plugin:stopped': { permissions: { invokes: ['service:media-metadata'] } },
    ...overrides.trust,
  };
  const pageEvent = { fromPage: true };
  const authorizer = createInvokeAuthorizer({
    fromAtmosPage: event => event?.fromPage === true,
    entryOf: ref => entries[ref] || null,
    isActive: entry => entry.id !== 'stopped',
    trustOf: entry => trust[`${entry.kind}:${entry.id}`] || null,
  });
  return { ...authorizer, entries, pageEvent };
}

const media = name => ({ kind: 'service', id: 'media-metadata', name });

test('only the Atmos page may call, never a frame or a web page', () => {
  const { authorize } = setup();
  assert.equal(authorize({ fromPage: false }, 'plugin:finance', media('read-tags')), 'Not allowed');
  assert.equal(authorize(null, 'plugin:finance', media('read-tags')), 'Not allowed');
  assert.equal(authorize(undefined, 'plugin:finance', media('read-tags')), 'Not allowed');
});

test('the caller must be named, as a string stamped by Core’s bridge', () => {
  const { authorize, pageEvent } = setup();
  for (const caller of [undefined, null, 42, { toString: () => 'plugin:finance' }, ['plugin:finance']]) {
    assert.equal(authorize(pageEvent, caller, media('read-tags')), 'Not allowed', String(caller));
  }
});

test('an extension may always call its own handlers', () => {
  const { authorize, pageEvent } = setup();
  assert.equal(authorize(pageEvent, 'service:media-metadata', media('anything')), null);
});

test('an unknown or stopped caller is refused', () => {
  const { authorize, pageEvent } = setup();
  assert.match(authorize(pageEvent, 'plugin:nobody', media('read-tags')), /not running/);
  assert.match(authorize(pageEvent, 'plugin:stopped', media('read-tags')), /not running/);
  assert.match(authorize(pageEvent, 'theme:finance', media('read-tags')), /not running/);
  assert.match(authorize(pageEvent, '', media('read-tags')), /not running/);
});

test('a target the caller didn’t declare in "invokes" is refused', () => {
  const { authorize, pageEvent } = setup();
  assert.match(authorize(pageEvent, 'plugin:finance', { kind: 'plugin', id: 'weather', name: 'x' }), /not permitted to invoke plugin:weather/);
  // A declared id of the other kind is not the same extension.
  assert.match(authorize(pageEvent, 'plugin:finance', { kind: 'plugin', id: 'media-metadata', name: 'read-tags' }), /not permitted/);
});

test('a handler shared with everyone reaches community extensions; one shared with official ones doesn’t', () => {
  const { authorize, pageEvent } = setup();
  assert.equal(authorize(pageEvent, 'plugin:finance', media('read-tags')), null);
  assert.equal(authorize(pageEvent, 'plugin:finance', media('write-tags')), null);
  assert.equal(authorize(pageEvent, 'plugin:weather', media('read-tags')), null);
  assert.match(authorize(pageEvent, 'plugin:weather', media('write-tags')), /doesn't share its 'write-tags' handler with community extensions/);
  assert.match(authorize(pageEvent, 'plugin:finance', media('delete-everything')), /doesn't share its 'delete-everything' handler with other extensions/);
});

test('with no "exports" block: everything to official extensions, nothing to community ones', () => {
  const { authorize, pageEvent } = setup();
  const target = { kind: 'service', id: 'no-exports', name: 'anything' };
  assert.equal(authorize(pageEvent, 'plugin:finance', target), null);
  assert.match(authorize(pageEvent, 'plugin:weather', target), /community/);
});

test('a malformed "exports" block shares nothing, and a missing trust record grants nothing', () => {
  const { authorize, pageEvent } = setup({ trust: { 'service:media-metadata': { permissions: {}, exports: { ipc: { 'read-tags': 'everyone' } } } } });
  assert.match(authorize(pageEvent, 'plugin:finance', media('read-tags')), /doesn't share/);
  const bare = setup({ trust: { 'plugin:finance': null } });
  assert.match(bare.authorize(bare.pageEvent, 'plugin:finance', media('read-tags')), /not permitted/);
});

test('a handler name that only looks like a wildcard is just a name', () => {
  const { authorize, pageEvent } = setup();
  assert.match(authorize(pageEvent, 'plugin:weather', media('*')), /doesn't share/);
});

test('reachOf: what one extension may use of another', () => {
  const { reachOf, entries } = setup();
  assert.deepEqual(reachOf(entries['plugin:weather'], 'service:media-metadata'), { ipc: ['read-tags'], events: [], methods: [] });
  assert.deepEqual(reachOf(entries['plugin:finance'], 'service:media-metadata'), { ipc: ['read-tags', 'write-tags'], events: [], methods: [] });
  assert.deepEqual(reachOf(entries['plugin:finance'], 'service:no-exports'), { ipc: ['*'], events: ['*'], methods: ['*'] });
  assert.deepEqual(reachOf(entries['plugin:finance'], 'service:missing'), { ipc: [], events: [], methods: [] });
  assert.equal(reachOf(entries['plugin:finance'], 'plugin:finance'), null);
});

test('the target needn\u2019t be running for the check to pass (extension-host finds no handler then)', () => {
  const { authorize, pageEvent } = setup();
  assert.equal(authorize(pageEvent, 'plugin:weather', { kind: 'plugin', id: 'stopped', name: 'x' }), 'plugin:weather is not permitted to invoke plugin:stopped');
  const declared = setup({ trust: { 'plugin:weather': { permissions: { invokes: ['plugin:stopped'] } }, 'plugin:stopped': { permissions: { invokes: [] }, exports: { ipc: { x: 'all' } } } } });
  assert.equal(declared.authorize(declared.pageEvent, 'plugin:weather', { kind: 'plugin', id: 'stopped', name: 'x' }), null);
});

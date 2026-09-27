'use strict';
// Each extension's atmos.state in a file of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionStateStore } = require('./extension-state.cjs');

function store(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-state-')), 'extension-state');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const warnings = [];
  return { dir, warnings, state: createExtensionStateStore({ dir, warn: message => warnings.push(message) }) };
}

test('each extension saves to its own file, and loads back by kind:id', t => {
  const { dir, state } = store(t);
  assert.deepEqual(state.loadAll(), {});
  state.save('plugin', 'finance', { currency: 'EUR' });
  state.save('service', 'finance', { other: true });
  state.save('plugin', 'audio-player', { volume: 0.5 });
  state.save('plugin', 'finance', { currency: 'GBP' });
  assert.deepEqual(state.loadAll(), {
    'plugin:audio-player': { volume: 0.5 },
    'plugin:finance': { currency: 'GBP' },
    'service:finance': { other: true },
  });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['plugin-audio-player.json', 'plugin-finance.json', 'service-finance.json'], 'no temporary files left');
  state.remove('plugin', 'finance');
  assert.equal(state.has('plugin', 'finance'), false);
  assert.deepEqual(Object.keys(state.loadAll()).sort(), ['plugin:audio-player', 'service:finance']);
});

test('only plain objects of at most 1 MB, for valid ids', t => {
  const { state } = store(t);
  assert.throws(() => state.save('plugin', 'x', [1]), /must be an object/);
  assert.throws(() => state.save('plugin', 'x', null), /must be an object/);
  assert.throws(() => state.save('plugin', 'x', { big: 'x'.repeat(1024 * 1024 + 1) }), /larger than 1 MB/);
  assert.throws(() => state.save('plugin', '../escape', {}), /not an extension/);
  assert.throws(() => state.save('theme', 'x', {}), /not an extension/);
  assert.equal(state.has('plugin', 'x'), false, 'a refused save writes nothing');
});

test('an unreadable file is set aside and reported, not lost', t => {
  const { dir, state, warnings } = store(t);
  state.save('plugin', 'good', { ok: true });
  fs.writeFileSync(path.join(dir, 'plugin-broken.json'), '{ not json');
  assert.deepEqual(state.loadAll(), { 'plugin:good': { ok: true } });
  assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('plugin-broken.json.unreadable-')));
});

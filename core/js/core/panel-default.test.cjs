'use strict';
// Which panel Atmos opens on (panel-default.js, used by panel-registry.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const register = async panels => {
  const { nextDefault } = await import('./panel-default.js');
  let current = null;
  const ignored = [];
  for (const panel of panels) {
    const next = nextDefault(current, panel);
    if (next.ignored) ignored.push(next.ignored);
    current = { id: next.id, rank: next.rank };
  }
  return { id: current?.id ?? null, ignored };
};

test('the built-in browser is the panel Atmos opens on, whatever registers first', async () => {
  // Start order is alphabetical: Audio Player 1.0.2 (still saying "default": true) registers before the browser.
  assert.deepEqual(await register([
    { id: 'audio-player', declared: true },
    { id: 'browser', builtIn: true },
    { id: 'finance' },
  ]), { id: 'browser', ignored: [] });
  assert.deepEqual(await register([{ id: 'browser', builtIn: true }, { id: 'audio-player', declared: true }]), { id: 'browser', ignored: [] });
});

test('without a built-in panel: a declared default, else the first registered', async () => {
  assert.deepEqual(await register([{ id: 'finance' }, { id: 'audio-player', declared: true }]), { id: 'audio-player', ignored: [] });
  assert.deepEqual(await register([{ id: 'finance' }, { id: 'matrix-chat' }]), { id: 'finance', ignored: [] });
  assert.deepEqual(await register([]), { id: null, ignored: [] });
});

test('a second claim of the same rank is reported and passed over, never refused', async () => {
  // Before 0.18 the second "default": true threw, and that extension's panel was lost.
  assert.deepEqual(await register([{ id: 'a', declared: true }, { id: 'b', declared: true }]), { id: 'a', ignored: ['b'] });
  assert.deepEqual(await register([{ id: 'x', builtIn: true }, { id: 'y', builtIn: true }]), { id: 'x', ignored: ['y'] });
});

'use strict';
// src/host/persist.js against a stand-in for Atmos's state: frames write only
// the fields they changed, two frames saving at once keep both changes, and
// the engine moves the earlier { namespaces } layout to a key per field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/host/persist.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 2)); };

/**
 * Atmos's state for one extension, as extension-frame-host.js keeps it:
 * requests handled one at a time, `update` merging top-level keys, the new
 * state sent to every other frame, and each frame's messages in order.
 */
function createCore(initial = {}) {
  const core = { state: structuredClone(initial), frames: [], patches: [] };
  const deliver = (frame, fn) => { frame.inbox.push(fn); setTimeout(() => frame.inbox.shift()()); };
  core.update = (frame, patch) => new Promise((resolve, reject) => {
    setTimeout(() => {
      if (core.refuse?.(patch)) { deliver(frame, () => reject(new Error('state is too big'))); return; }
      core.patches.push({ role: frame.role, keys: Object.keys(patch).sort() });
      core.state = { ...core.state, ...structuredClone(patch) };
      for (const other of core.frames) if (other !== frame) deliver(other, () => other.listeners.forEach(fn => fn(structuredClone(core.state))));
      deliver(frame, resolve);
    });
  });
  return core;
}

async function startFrame(core, role, { engineReady = Promise.resolve() } = {}) {
  const frame = { role, inbox: [], listeners: [] };
  core.frames.push(frame);
  const storage = new Map();
  const context = vm.createContext({
    structuredClone, queueMicrotask, console, setTimeout,
    window: { addEventListener() {} },
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)) },
  });
  const atmos = {
    state: {
      get: async () => structuredClone(core.state),
      update: patch => core.update(frame, patch),
      onChange: fn => { frame.listeners.push(fn); return () => {}; },
    },
    call: async (_target, method) => { if (method === 'ready') await engineReady; return true; },
    legacy: { readState: async () => null, readIndexedDB: async () => null, readLocalStorage: async () => ({}) },
  };
  const host = new vm.SyntheticModule(['atmos', 'isEngine', 'role', 'SELF'], function () {
    this.setExport('atmos', atmos);
    this.setExport('isEngine', () => role === 'engine');
    this.setExport('role', role);
    this.setExport('SELF', 'plugin:finance');
  }, { context });
  const persist = new vm.SourceTextModule(source, { context, identifier: `${role}/persist.js` });
  await persist.link(() => host);
  await persist.evaluate();
  return persist.namespace;
}

const PREPARED = { settingsLayout: 2, 'nsv:portfolio-tracker': 1, 'ns:portfolio-tracker:a': 1, 'ns:portfolio-tracker:b': 1 };

test('a frame writes only the fields it changed', async () => {
  const core = createCore(PREPARED);
  const frame = await startFrame(core, 'widget:balance');
  const state = frame.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, b: 0 } });
  assert.deepEqual(plain(state), { a: 1, b: 1 });
  state.a = 2;
  frame.save();
  await settle();
  assert.deepEqual(core.patches, [{ role: 'widget:balance', keys: ['ns:portfolio-tracker:a'] }]);
  frame.save(); // nothing changed since
  await settle();
  assert.equal(core.patches.length, 1);
});

test('two frames saving at once keep both changes', async () => {
  const core = createCore(PREPARED);
  const one = await startFrame(core, 'widget:balance');
  const two = await startFrame(core, 'widget:spot');
  const first = one.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, b: 0 } });
  const second = two.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, b: 0 } });
  const heardByTwo = [];
  two.onExternalStateChange(() => heardByTwo.push(plain(second)));
  // Neither has seen the other's change when it saves.
  first.a = 2; one.save();
  second.b = 3; two.save();
  await settle();
  assert.equal(core.state['ns:portfolio-tracker:a'], 2);
  assert.equal(core.state['ns:portfolio-tracker:b'], 3);
  assert.deepEqual(plain(first), { a: 2, b: 3 });
  // The other frame's change arrived before Atmos confirmed this one's; it
  // must not bring back the old value in between.
  assert.deepEqual(plain(second), { a: 2, b: 3 });
  assert.deepEqual(heardByTwo, [{ a: 2, b: 3 }]);
});

test('Finance\'s other state (a pending panel action) redraws nothing', async () => {
  const core = createCore(PREPARED);
  const one = await startFrame(core, 'widget:watchlist');
  const two = await startFrame(core, 'panel');
  one.registerStateNamespace('portfolio-tracker', { defaults: {} });
  two.registerStateNamespace('portfolio-tracker', { defaults: {} });
  let heard = 0;
  two.onExternalStateChange(() => heard++);
  await core.update(core.frames[0], { pendingAction: { type: 'open-market', at: 1 } });
  await settle();
  assert.equal(heard, 0);
});

test('the engine moves the earlier layout to a key per field, before any view reads it', async () => {
  const earlier = {
    namespaces: {
      'portfolio-tracker': { version: 1, data: { a: 5, excludedSources: { wallet: true } } },
      markets: { version: 2, data: { lastQuery: 'SOLUSDT' } },
    },
    copiedFromPage: '2026-09-23T00:00:00.000Z',
  };
  const core = createCore(earlier);
  let engineReady;
  const ready = new Promise(resolve => { engineReady = resolve; });
  const viewStarting = startFrame(core, 'widget:balance', { engineReady: ready });
  const engine = await startFrame(core, 'engine');
  engineReady();
  const view = await viewStarting;
  assert.equal(core.state.settingsLayout, 2);
  assert.equal(core.state['ns:portfolio-tracker:a'], 5);
  assert.deepEqual(plain(core.state['ns:portfolio-tracker:excludedSources']), { wallet: true });
  assert.equal(core.state['nsv:markets'], 2);
  assert.ok(core.state.namespaces, 'kept, unread, for an earlier Finance');
  for (const frame of [engine, view]) {
    const state = frame.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, excludedSources: {} } });
    assert.deepEqual(plain(state), { a: 5, excludedSources: { wallet: true } });
  }
});

test('if Atmos refuses the move, every frame still reads the earlier layout', async () => {
  const core = createCore({ namespaces: { 'portfolio-tracker': { version: 1, data: { a: 5, b: 6 } } } });
  core.refuse = patch => 'settingsLayout' in patch;
  const engine = await startFrame(core, 'engine');
  const view = await startFrame(core, 'widget:balance');
  const inEngine = engine.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, b: 0 } });
  const inView = view.registerStateNamespace('portfolio-tracker', { defaults: { a: 0, b: 0 } });
  assert.deepEqual(plain(inEngine), { a: 5, b: 6 });
  assert.deepEqual(plain(inView), { a: 5, b: 6 });
  inView.a = 7; view.save();
  await settle();
  assert.deepEqual(plain(inEngine), { a: 7, b: 6 }, 'a change still reaches the other frames, without losing the rest');
});

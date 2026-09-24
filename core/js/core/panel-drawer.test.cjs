'use strict';
// The drawer physics Core runs for drawer panels (Audio Player), driven with
// fake elements and a manual animation clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadDrawer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-drawer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, 'panel-drawer.js'), path.join(dir, 'panel-drawer.js'));
  return import(pathToFileURL(path.join(dir, 'panel-drawer.js')).href);
}

function fakeElement(height = 0) {
  const classes = new Set();
  return {
    clientHeight: height,
    dataset: {},
    style: { setProperty(name, value) { this[name] = value; } },
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
  };
}

function withClock(t) {
  const frames = new Map();
  let next = 1;
  globalThis.requestAnimationFrame = fn => { const id = next++; frames.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; });
  return {
    run(limit = 2000) {
      for (let i = 0; i < limit && frames.size; i++) {
        const [id, fn] = frames.entries().next().value;
        frames.delete(id);
        fn(i * 16);
      }
      return frames.size === 0;
    },
  };
}

test('placements map to positions and back; saved placement is restored', async t => {
  const { createPanelDrawer } = await loadDrawer(t);
  withClock(t);
  const surface = fakeElement(800);
  const drawer = fakeElement();
  const physics = createPanelDrawer({ surface, drawer }, { barHeight: 54, placement: 1 });
  // BAR = 800 - 54 = 746: only the bar shows.
  assert.equal(drawer.style.transform, 'translateY(746px)');
  assert.equal(physics.getPlacement(), 1);
  assert.equal(physics.state().open, true);
  assert.equal(physics.state().expanded, false);
  physics.setPlacement(0);
  assert.equal(drawer.style.transform, 'translateY(0px)');
  assert.equal(physics.state().expanded, true);
  assert.equal(surface.style['--atmos-drawer-visible-h'], '746px');
  physics.setPlacement(2);
  assert.equal(physics.state().open, false);
  assert.equal(surface.style['--atmos-drawer-visible-h'], '0px');
});

test('commands glide to their snap and report where they settled', async t => {
  const { createPanelDrawer } = await loadDrawer(t);
  const clock = withClock(t);
  const surface = fakeElement(800);
  const drawer = fakeElement();
  const settled = [];
  const states = [];
  const physics = createPanelDrawer({ surface, drawer }, {
    barHeight: 54, placement: 2,
    onSettle: placement => settled.push(placement),
    onState: state => states.push(`${state.open}/${state.expanded}`),
  });
  physics.open();
  assert.ok(clock.run());
  assert.equal(Math.round(physics.getPlacement() * 100) / 100, 1);
  physics.expand();
  assert.ok(clock.run());
  assert.equal(physics.getPlacement(), 0);
  physics.close();
  assert.ok(clock.run());
  assert.equal(physics.getPlacement(), 2);
  assert.equal(settled.length, 3);
  assert.deepEqual(states, ['true/false', 'true/true', 'false/false']);
});

test('wheel moves it with momentum; a short upward flick from hidden stops at the bar', async t => {
  const { createPanelDrawer } = await loadDrawer(t);
  const clock = withClock(t);
  const surface = fakeElement(800);
  const drawer = fakeElement();
  const physics = createPanelDrawer({ surface, drawer }, { barHeight: 54, placement: 2 });
  for (let i = 0; i < 6; i++) physics.wheel(-400);
  assert.ok(clock.run());
  assert.equal(Math.round(physics.getPlacement() * 100) / 100, 1);
  for (let i = 0; i < 4; i++) physics.wheel(-300);
  assert.ok(clock.run());
  assert.ok(physics.getPlacement() < 1, 'kept going up into the open range');
  assert.equal(physics.state().expanded, true);
});

test('docking the bar reveals the browser with a clip instead of moving', async t => {
  const { createPanelDrawer } = await loadDrawer(t);
  withClock(t);
  const surface = fakeElement(600);
  const drawer = fakeElement();
  const physics = createPanelDrawer({ surface, drawer }, { barHeight: 54, placement: 1, barPlacement: 'bottom' });
  assert.equal(drawer.style.transform, 'none');
  assert.equal(drawer.style.clipPath, 'inset(546px 0 0 0)');
  physics.setBarPlacement('top');
  assert.equal(drawer.style.transform, 'translateY(546px)');
  assert.throws(() => physics.setBarPlacement('left'), TypeError);
});

test('a resize keeps the placement', async t => {
  const { createPanelDrawer } = await loadDrawer(t);
  withClock(t);
  const surface = fakeElement(800);
  const drawer = fakeElement();
  const physics = createPanelDrawer({ surface, drawer }, { barHeight: 54, placement: 0.5 });
  surface.clientHeight = 400;
  physics.resized();
  assert.equal(physics.getPlacement(), 0.5);
  assert.equal(drawer.style.transform, `translateY(${(400 - 54) / 2}px)`);
});

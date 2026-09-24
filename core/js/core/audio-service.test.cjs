'use strict';
// The background layer's Audio service (services/audio/engine.js), with a
// fake <audio> element: channels per owner, loading, seeking once metadata
// arrives, Blob sources, stopping.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.attributes = {};
    this.error = null;
  }
  set src(value) { this.attributes.src = value; this.currentTime = 0; this.duration = NaN; }
  get src() { return this.attributes.src || ''; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  load() {}
  async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  metadata(duration) { this.duration = duration; this.dispatchEvent(new Event('loadedmetadata')); }
}

async function loadEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, '../../../services/audio/engine.js'), path.join(dir, 'engine.js'));
  const elements = [];
  const host = { children: [], appendChild(child) { this.children.push(child); } };
  globalThis.document = {
    getElementById: () => (host.attached ? host : null),
    createElement(tag) {
      if (tag === 'audio') { const element = new FakeAudio(); elements.push(element); return element; }
      return host;
    },
    body: { appendChild(node) { node.attached = true; } },
  };
  const urls = [];
  const revoked = [];
  globalThis.URL.createObjectURL = () => { const url = `blob:atmos/${urls.length}`; urls.push(url); return url; };
  globalThis.URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { delete globalThis.document; });
  const engine = await import(pathToFileURL(path.join(dir, 'engine.js')).href);
  return { engine, elements, urls, revoked };
}

test('each owner gets its own channel, reported to its listeners', async t => {
  const { engine, elements } = await loadEngine(t);
  const music = engine.channel('plugin:audio-player');
  const sounds = engine.channel('plugin:ambience');
  assert.notEqual(music, sounds);
  assert.equal(engine.channel('plugin:audio-player'), music);
  assert.equal(elements.length, 2);
  assert.throws(() => engine.channel(''), TypeError);

  const seen = [];
  const off = music.subscribe(value => seen.push(`${value.type}:${value.playing}`));
  music.load('atmos-resource://audio-player-media/a.mp3', { id: 'k1', play: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(music.state().source, 'k1');
  assert.equal(music.state().playing, true);
  assert.equal(sounds.state().playing, false);
  music.pause();
  off();
  music.play();
  assert.deepEqual(seen, ['source:false', 'play:true', 'pause:false']);
  assert.deepEqual(engine.listChannels().map(item => item.owner), ['plugin:audio-player', 'plugin:ambience']);
});

test('a start position is applied once metadata arrives, and only for the latest load', async t => {
  const { engine, elements } = await loadEngine(t);
  const channel = engine.channel('plugin:audio-player');
  const [element] = elements;
  channel.load('atmos-resource://p/one.mp3', { position: 90 });
  channel.load('atmos-resource://p/two.mp3', { position: 30 });
  element.metadata(200);
  assert.equal(element.currentTime, 30);
  channel.load('atmos-resource://p/three.mp3', { position: 500 });
  element.metadata(120);
  assert.equal(element.currentTime, 120, 'clamped to the duration');
  channel.seek(-5);
  assert.equal(element.currentTime, 0);
  channel.setVolume(3);
  assert.equal(element.volume, 1);
});

test('Blob sources get an object URL that is released on the next load and on stop', async t => {
  const { engine, elements, revoked } = await loadEngine(t);
  const channel = engine.channel('plugin:audio-player');
  channel.load(new Blob(['x'], { type: 'audio/mpeg' }), { id: 'upload' });
  assert.equal(elements[0].src, 'blob:atmos/0');
  channel.load(new Blob(['y'], { type: 'audio/mpeg' }));
  assert.deepEqual(revoked, ['blob:atmos/0']);
  channel.stop();
  assert.deepEqual(revoked, ['blob:atmos/0', 'blob:atmos/1']);
  assert.equal(elements[0].getAttribute('src'), null);
  assert.equal(channel.state().source, null);
});

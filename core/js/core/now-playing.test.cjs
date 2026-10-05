'use strict';
// What each extension plays, on its way to the Now Playing service
// (now-playing.js, atmos.nowPlaying in SDK 1.4): checked, stamped with who
// set it, and controls back to that extension only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, 'now-playing.js')).href);
const settle = () => new Promise(resolve => setImmediate(resolve));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBytes = () => Uint8Array.from(atob(PNG.split(',')[1]), c => c.charCodeAt(0));
const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** A PNG header claiming width × height. */
function pngOfSize(width, height) {
  const bytes = pngBytes();
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
// A JPEG's start: SOI, an APP0 segment, then SOF0 for 48 × 32.
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...'JFIF\0'.split('').map(c => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
// A GIF: a 10 × 20 screen, no colour table, then (optionally) a frame and the end.
const gif = (frame = null) => Uint8Array.from([...'GIF89a'].map(c => c.charCodeAt(0)).concat([10, 0, 20, 0, 0, 0, 0],
  frame ? [0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, ...frame.flatMap(v => [v & 255, v >> 8]), 0, 2, 2, 0x4c, 0x01, 0] : [], [0x3b]));
const GIF = gif();
function webpVp8x(width, height) {
  const bytes = new Uint8Array(30);
  bytes.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
  bytes.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8);
  const w = width - 1, h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}

/** A hub on a clock and timers the test moves. */
async function hubWithClock(start = 1000) {
  const { createNowPlayingHub } = await load();
  const clock = { at: start, timers: [], clicked: new Set() };
  const sent = [];
  const hub = createNowPlayingHub({
    send: (owner, control) => sent.push([owner, control]),
    clickedJustNow: async owner => clock.clicked.has(owner),
    now: () => clock.at,
    later: (fn, ms) => clock.timers.push({ fn, due: clock.at + ms }),
  });
  clock.advance = async ms => {
    clock.at += ms;
    for (const timer of clock.timers.filter(t => t.due <= clock.at)) { clock.timers.splice(clock.timers.indexOf(timer), 1); timer.fn(); }
    await settle();
  };
  return { hub, clock, sent };
}
const music = { id: 'plugin:audio-player', name: 'Audio Player', community: false };
const browser = { id: 'plugin:browser', name: 'Atmos Browser', community: false };
const stranger = { id: 'plugin:x', name: 'X', community: true };

test('a session is checked: plain text, known controls, sane numbers', async () => {
  const { normalizeSession } = await load();
  const session = normalizeSession({
    title: '  One\u202E\nby\tTester  ', artist: 'Tester', album: null, from: 'example.com',
    duration: 180, position: 200, playing: true, actions: ['toggle', 'next', 'toggle'], volume: 40, extra: 'ignored',
  });
  assert.deepEqual(session, {
    title: 'One by Tester', artist: 'Tester', album: null, from: 'example.com',
    duration: 180, position: 180, playing: true, actions: ['toggle', 'next'], volume: 40,
  }, 'control and direction characters are spaces; position within the length; no unknown fields');
  assert.equal(normalizeSession({ title: 'x'.repeat(500) }).title.length, 200);
  assert.equal(normalizeSession({ title: 'x', playing: 'yes' }).playing, false, 'playing is true or it isn\'t');
  assert.equal(normalizeSession({ title: 'Family 👨\u200D👩\u200D👧' }).title, 'Family 👨\u200D👩\u200D👧', 'the joiners emoji need stay');
  assert.equal(normalizeSession({ title: 'a\u3164\u115Fb' }).title, 'a b', 'blank fillers are spaces');
  assert.equal(normalizeSession({ title: '😀'.repeat(300) }).title, '😀'.repeat(200), 'cut between characters, not inside one');
  assert.equal(normalizeSession({ title: `x${'\u202E'.repeat(5_000_000)}` }).title, 'x', 'a huge string is cut before it is cleaned');
  for (const [bad, message] of [
    [{ playing: true }, /has a title/],
    [{ title: ' \n ', playing: true }, /has a title/],
    [{ title: 3, playing: true }, /string/],
    [{ title: 'x', actions: ['delete'] }, /“delete” isn’t one/],
    [{ title: 'x', actions: 'toggle' }, /a list/],
    [{ title: 'x', duration: -1 }, /0 or more/],
    [{ title: 'x', position: Infinity }, /0 or more/],
    [{ title: 'x', volume: 101 }, /0–100/],
    [null, /is an object/],
  ]) assert.throws(() => normalizeSession(bad), message);
});

test('artwork is read by its bytes: PNG, JPEG, WebP or GIF, 1 MB and 4096 pixels a side at most', async () => {
  const { readArtwork, sniffImage } = await load();
  const png = await readArtwork(PNG);
  assert.ok(png.blob instanceof Blob);
  assert.deepEqual([png.blob.type, png.blob.size, png.bytes], ['image/png', pngBytes().length, pngBytes().length]);
  assert.equal((await readArtwork(new Blob([pngBytes()], { type: 'application/octet-stream' }))).key, png.key, 'the same bytes, the same key, whatever the type says');
  assert.equal(await readArtwork(null), null);
  assert.deepEqual(sniffImage(JPEG), { type: 'image/jpeg', width: 48, height: 32 });
  assert.deepEqual(sniffImage(GIF), { type: 'image/gif', width: 10, height: 20 });
  assert.deepEqual(sniffImage(gif([0, 0, 10, 20])), { type: 'image/gif', width: 10, height: 20 }, 'a frame within the screen');
  assert.deepEqual(sniffImage(gif([5, 0, 60000, 60000])), { type: 'image/gif', width: 60005, height: 60000 }, 'a frame past it: as large as it reaches');
  assert.deepEqual(sniffImage(webpVp8x(300, 200)), { type: 'image/webp', width: 300, height: 200 });
  assert.equal((await readArtwork(new Blob([JPEG], { type: 'image/png' }))).blob.type, 'image/jpeg', 'typed by what it is');
  assert.equal((await readArtwork(dataUrl('image/gif', GIF))).blob.type, 'image/gif');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const [bad, message] of [
    ['https://example.com/cover.png', /data: URL/],
    ['data:image/svg+xml;base64,PHN2Zy8+', /data: URL/],
    [new Blob([svg], { type: 'image/svg+xml' }), /PNG, JPEG, WebP or GIF/],
    [new Blob([svg], { type: 'image/png' }), /PNG, JPEG, WebP or GIF/, 'SVG claiming to be a PNG'],
    [dataUrl('image/png', svg), /PNG, JPEG, WebP or GIF/],
    [new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' }), /1 MB/],
    [`data:image/png;base64,${'A'.repeat(2_000_000)}`, /1 MB/],
    [new Blob([pngOfSize(5000, 10)]), /4096 pixels/],
    [new Blob([pngOfSize(0, 10)]), /4096 pixels/],
    [new Blob([webpVp8x(4097, 1)]), /4096 pixels/],
    [new Blob([gif([0, 0, 60000, 60000])]), /4096 pixels/, 'a 10 × 20 GIF whose first frame is 60000 a side'],
    [{ src: PNG }, /image Blob or a data: URL/],
  ]) await assert.rejects(readArtwork(bad), message);
});

test('sessions are stamped with who set them; the service hears them at once, then 10 times a second at most', async () => {
  const { hub, clock, sent } = await hubWithClock();
  const heard = [];
  hub.watch(list => heard.push(list));
  assert.deepEqual(heard, [[]], 'the service hears what there is at once');

  await hub.set(music, 'main', { title: 'One', playing: true, actions: ['toggle', 'next'], duration: 60, position: 5, artwork: PNG });
  await settle();
  assert.equal(heard.length, 2, 'the first change: at once');
  clock.at = 1050;
  await hub.set(browser, 'tab-1', { title: 'ASMR', from: 'youtube.com', playing: true, actions: ['toggle'] });
  await settle();
  assert.equal(heard.length, 2, 'the next within 100 ms: held');
  await clock.advance(50);
  assert.equal(heard.length, 3, '…and heard 100 ms after the last');
  const [song, tab] = heard[2];
  assert.deepEqual({ id: song.id, source: song.source, key: song.key, playingSince: song.playingSince, positionAt: song.positionAt, type: song.artwork.type },
    { id: 'plugin:audio-player|main', source: { id: 'plugin:audio-player', name: 'Audio Player', community: false }, key: 'main', playingSince: 1000, positionAt: 1000, type: 'image/png' });
  assert.ok(song.artwork instanceof Blob && song.artworkKey, 'artwork as a Blob Core made, with a key for the image');
  assert.equal(tab.playingSince, 1050, 'started later: the service shows it');

  // Still playing: when it started stays; paused: none, but when it last played is kept.
  await clock.advance(1000);
  await hub.set(music, 'main', { title: 'One', playing: true, actions: ['toggle'], position: 9, artwork: PNG });
  await clock.advance(1000);
  await hub.set(browser, 'tab-1', { title: 'ASMR', playing: false });
  await clock.advance(200);
  const [song2, tab2] = heard.at(-1);
  assert.equal(song2.playingSince, 1000);
  assert.equal(song2.positionAt, 2100);
  assert.equal(song2.artwork, song.artwork, 'the same image: the same Blob');
  assert.deepEqual([tab2.playingSince, tab2.lastActive], [null, 1050]);

  // A control goes to the session's extension, and only one it takes.
  hub.control('plugin:audio-player|main', 'toggle');
  assert.deepEqual(sent, [['plugin:audio-player', { key: 'main', action: 'toggle', value: null }]]);
  assert.throws(() => hub.control('plugin:audio-player|main', 'next'), /doesn’t take “next”/, 'its last set listed only toggle');
  assert.throws(() => hub.control('plugin:browser|tab-1', 'seek', 3), /doesn’t take “seek”/);
  assert.throws(() => hub.control('plugin:nobody|main', 'toggle'), /has ended/);

  // Its frames stop: its sessions go.
  hub.forget('plugin:browser');
  await clock.advance(200);
  assert.deepEqual(heard.at(-1).map(session => session.id), ['plugin:audio-player|main']);
  await hub.clear('plugin:audio-player', 'other');
  await clock.advance(200);
  assert.equal(heard.at(-1).length, 1, 'clearing a key it doesn\'t have changes nothing');
  await hub.clear('plugin:audio-player');
  await clock.advance(200);
  assert.deepEqual(heard.at(-1), []);
});

test('flicking play on and off doesn\'t make a session the newest; a real pause and play does', async () => {
  const { hub, clock } = await hubWithClock();
  let latest = [];
  hub.watch(list => { latest = list; });
  clock.clicked.add('plugin:x'); // you just clicked in it, each time
  const since = () => latest.find(session => session.source.id === 'plugin:x')?.playingSince;
  await hub.set(stranger, 'main', { title: 'x', playing: true });
  await clock.advance(10_000);
  await hub.set(stranger, 'main', { title: 'x', playing: false });
  await clock.advance(500);
  await hub.set(stranger, 'main', { title: 'x', playing: true });
  await clock.advance(200);
  assert.equal(since(), 1000, 'paused half a second: the same start');
  await hub.set(stranger, 'main', { title: 'x', playing: false });
  await clock.advance(1000);
  await hub.set(stranger, 'main', { title: 'x', playing: false, position: 3 });
  await clock.advance(2500);
  await hub.set(stranger, 'main', { title: 'x', playing: true });
  await clock.advance(200);
  assert.equal(since(), 15_200, 'paused 3.5 s (updates while paused don\'t restart it): started again');
  assert.equal(latest[0].source.community, true, 'a community extension is marked');
});

test('limits: past 20 updates a second the newest of each waits for the next second; 16 sessions and 4 MB of artwork an extension; a set after its frames stop lands nowhere', async () => {
  const { hub, clock } = await hubWithClock();
  let latest = [];
  hub.watch(list => { latest = list; });
  for (let i = 0; i < 20; i++) await hub.set(stranger, 'main', { title: `x${i}`, volume: i });
  // A volume drag past the budget: none refused, the last one lands.
  let settled = 0;
  const waits = [21, 22, 59].map(volume => hub.set(stranger, 'main', { title: 'drag', volume }).then(() => { settled += 1; }));
  await settle();
  assert.equal(settled, 2, 'replaced before it got in: settled at once');
  await clock.advance(200);
  assert.equal(latest[0].volume, 19, 'the rest waits');
  await clock.advance(800);
  await Promise.all(waits);
  await clock.advance(200);
  assert.equal(latest[0].volume, 59, 'the next second: where the drag ended');
  // A clear after a set that waits: cleared, in the order they were asked.
  for (let i = 0; i < 25; i++) hub.set(stranger, 'main', { title: 'again' }).catch(() => {});
  await hub.clear('plugin:x');
  await clock.advance(1200);
  assert.deepEqual(latest, []);
  await clock.advance(1000);
  await hub.set(stranger, 'main', { title: 'again' });

  for (let i = 1; i < 16; i++) { await clock.advance(100); await hub.set(stranger, `t${i}`, { title: 'x' }); }
  await clock.advance(1000);
  await assert.rejects(hub.set(stranger, 't16', { title: 'x' }), /16 sessions/);
  await hub.set(stranger, 't1', { title: 'y' });

  // Four images of just under 1 MB fit; a fifth doesn't.
  const big = n => { const bytes = new Uint8Array(1024 * 1024 - 10); bytes.set(pngBytes()); bytes[100] = n; return new Blob([bytes]); };
  for (let i = 1; i <= 4; i++) { await clock.advance(100); await hub.set(stranger, `t${i}`, { title: 'x', artwork: big(i) }); }
  await assert.rejects(hub.set(stranger, 't5', { title: 'x', artwork: big(5) }), /4 MB/);
  await hub.set(stranger, 't4', { title: 'x', artwork: big(9) }); // replacing one of its own is fine

  // A set still reading its artwork when the frames stop doesn't come back.
  const { hub: other, clock: clock2 } = await hubWithClock();
  let heard = [];
  other.watch(list => { heard = list; });
  const pending = other.set(stranger, 'main', { title: 'late', artwork: PNG });
  other.forget('plugin:x');
  await pending;
  await clock2.advance(500);
  assert.deepEqual(heard, []);
});

test('a community extension\'s start counts only just after you used it: else it shows only when nothing else plays', async () => {
  const { hub, clock } = await hubWithClock();
  const { normalizeSession } = await load();
  let latest = [];
  hub.watch(list => { latest = list; });
  const since = id => latest.find(session => session.id === id)?.playingSince;
  await hub.set(music, 'main', { title: 'One', playing: true });
  await clock.advance(1000);
  await hub.set(stranger, 'a', { title: 'by itself', playing: true, actions: ['toggle'] });
  clock.clicked.add('plugin:x');
  await hub.set(stranger, 'b', { title: 'you clicked play in it', playing: true });
  clock.clicked.delete('plugin:x');
  await clock.advance(200);
  assert.equal(since('plugin:x|a'), 0, 'started on its own: behind Music');
  assert.equal(since('plugin:x|b'), 2000, 'started as you used it: in front');
  // Paused, then played from the widget: you used it.
  await hub.set(stranger, 'a', { title: 'by itself', playing: false, actions: ['toggle'] });
  await clock.advance(5000);
  hub.control('plugin:x|a', 'toggle');
  await hub.set(stranger, 'a', { title: 'by itself', playing: true, actions: ['toggle'] });
  await clock.advance(200);
  assert.equal(since('plugin:x|a'), 7200);
  // Cleared and set again under another key a while later, on its own: behind again.
  await hub.clear('plugin:x', 'a');
  await clock.advance(6000);
  await hub.set(stranger, 'c', { title: 'again by itself', playing: true });
  await clock.advance(200);
  assert.equal(since('plugin:x|c'), 0);
  assert.equal(since('plugin:audio-player|main'), 1000, 'an official extension is trusted to say when it starts');
  // …and to say when a start wasn't the user's (Atmos Browser's page that began by itself).
  await hub.set(browser, 'tab-9', { title: 'autoplay', playing: true, startedByUser: false });
  await clock.advance(200);
  assert.equal(since('plugin:browser|tab-9'), 0);
  await hub.set(browser, 'tab-8', { title: 'you pressed play', playing: true, startedByUser: true });
  await clock.advance(200);
  assert.ok(since('plugin:browser|tab-8') > 0);
  assert.throws(() => normalizeSession({ title: 'x', startedByUser: 'yes' }), /true or false/);
});

test('seek and volume carry a number in range; keys are plain; set then clear stays cleared', async () => {
  const { hub, clock, sent } = await hubWithClock();
  await hub.set(stranger, 'main', { title: 'x', playing: true, duration: 100, actions: ['seek', 'volume'] });
  hub.control('plugin:x|main', 'seek', 250);
  hub.control('plugin:x|main', 'volume', 55);
  assert.deepEqual(sent.map(([, control]) => control), [{ key: 'main', action: 'seek', value: 100 }, { key: 'main', action: 'volume', value: 55 }]);
  assert.throws(() => hub.control('plugin:x|main', 'seek', -1), /0 or more/);
  assert.throws(() => hub.control('plugin:x|main', 'volume', 120), /0–100/);
  assert.throws(() => hub.set(stranger, 'a b', { title: 'x' }), /letters, digits/);
  assert.throws(() => hub.set(stranger, 'x|y', { title: 'x' }), /letters, digits/, 'no way to name another\'s session');

  let latest;
  hub.watch(list => { latest = list; });
  const setting = hub.set(stranger, 'main', { title: 'y', artwork: PNG });
  const clearing = hub.clear('plugin:x');
  await Promise.all([setting, clearing]);
  await clock.advance(500);
  assert.deepEqual(latest, [], 'in the order they were asked');
});

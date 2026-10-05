// Which session Now Playing shows (src/choose.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSession, pickExpired, positionNow, formatTime, subtitle, sourceLabel } from '../src/choose.js';

const music = { id: 'plugin:audio-player|main', playing: true, playingSince: 100, lastActive: 100 };
const asmr = { id: 'plugin:browser|t1', playing: true, playingSince: 200, lastActive: 200 };
const book = { id: 'plugin:books|main', playing: false, playingSince: null, lastActive: 150 };

test('the one you started last shows, whichever it is', () => {
  assert.equal(chooseSession([]), null);
  assert.equal(chooseSession([music, asmr]).id, asmr.id, 'Music, then a video: the video');
  assert.equal(chooseSession([{ ...music, playingSince: 300 }, asmr]).id, music.id, 'the video, then Music: Music');
  assert.equal(chooseSession([{ ...music, playing: false, playingSince: null }, asmr]).id, asmr.id);
});

test('paused: the one that played last stays, to resume', () => {
  const pausedMusic = { ...music, playing: false, playingSince: null, lastActive: 400 };
  const pausedTab = { ...asmr, playing: false, playingSince: null, lastActive: 350 };
  assert.equal(chooseSession([pausedMusic, pausedTab, book]).id, music.id);
  assert.equal(chooseSession([book]).id, book.id);
});

test('one picked with the dots stays until something starts after that', () => {
  assert.equal(chooseSession([music, asmr, book], { id: book.id, at: 250 }).id, book.id, 'a paused one, picked');
  assert.equal(chooseSession([music, asmr], { id: music.id, at: 250 }).id, music.id);
  assert.equal(chooseSession([music, { ...asmr, playingSince: 260 }], { id: music.id, at: 250 }).id, asmr.id, 'started after the pick: it shows');
  assert.equal(chooseSession([music, asmr], { id: 'gone', at: 250 }).id, asmr.id, 'the picked one ended');
  // Over is over: the video that ended the pick pauses, and Music, still playing, shows; not the old pick.
  const pick = { id: book.id, at: 250 };
  const videoStarted = [music, { ...asmr, playingSince: 260 }, book];
  assert.equal(pickExpired(videoStarted, pick), true);
  assert.equal(pickExpired([music, asmr, book], pick), false);
  assert.equal(pickExpired([music, asmr], pick), true, 'its session ended');
  assert.equal(pickExpired([music], null), false);
  const videoPaused = [music, { ...asmr, playing: false, playingSince: null }, book];
  assert.equal(chooseSession(videoPaused, null).id, music.id, 'the widget dropped the expired pick: Music');
});

test('the position moves on while playing, within the length', () => {
  assert.equal(positionNow({ position: 10, positionAt: 1000, playing: true, duration: 60 }, 6000), 15);
  assert.equal(positionNow({ position: 10, positionAt: 1000, playing: false, duration: 60 }, 6000), 10);
  assert.equal(positionNow({ position: 58, positionAt: 1000, playing: true, duration: 60 }, 9000), 60);
  assert.equal(positionNow({ position: null, playing: true }), 0);
  assert.equal(formatTime(187), '3:07');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(subtitle({ artist: '', from: 'youtube.com', source: { name: 'Atmos Browser' } }), 'youtube.com');
  assert.equal(subtitle({ artist: 'Tester', from: 'youtube.com', source: { name: 'Atmos Browser' } }), 'Tester · youtube.com', 'a tab: its site always');
  assert.equal(subtitle({ artist: 'Tester', source: { name: 'Music' } }), 'Tester');
  assert.equal(subtitle({ source: { name: 'Music' } }), 'Music');
  // A community extension's name always shows, marked, so it can't pass for Music.
  const fake = { artist: 'Tester', source: { name: 'Music', community: true } };
  assert.equal(subtitle(fake), 'Tester · Music', 'and the widget marks it "· community" beside that');
  assert.equal(subtitle({ source: { name: 'Rain', community: true } }), 'Rain');
  assert.equal(sourceLabel(fake), 'Music · community');
  assert.equal(sourceLabel({ source: { name: 'Audio Player', community: false } }), 'Audio Player');
});

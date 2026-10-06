'use strict';
// Rebuilding an ID3v2 tag with a new cover keeps every other frame.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildId3WithCover, decodeSynchsafe } = require('../formats/id3.cjs');

const AUDIO = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(256, 7)]);
const COVER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function synchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
/** A v2.3 frame: 4-character id, 32-bit size, two flag bytes. */
function frame23(id, text) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), body]);
}
function tag(version, flags, body) {
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([version, 0, flags]), synchsafe(body.length), body]);
}
/** The frames of a v2.3 or v2.4 tag at the start of `data`: [[id, body]]. */
function framesOf(data) {
  assert.equal(data.subarray(0, 3).toString('ascii'), 'ID3');
  const version = data[3];
  const end = 10 + decodeSynchsafe(data[6], data[7], data[8], data[9]);
  const frames = [];
  for (let pos = 10; pos + 10 <= end;) {
    const id = data.subarray(pos, pos + 4).toString('ascii');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? decodeSynchsafe(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]) : data.readUInt32BE(pos + 4);
    frames.push([id, data.subarray(pos + 10, pos + 10 + size)]);
    pos += 10 + size;
  }
  return { version, frames, audio: data.subarray(end) };
}

test('a v2.3 tag keeps its frames and its audio', () => {
  const file = Buffer.concat([tag(3, 0, Buffer.concat([frame23('TIT2', 'Title'), frame23('TPE1', 'Artist')])), AUDIO]);
  const out = framesOf(buildId3WithCover(file, COVER, 'image/jpeg'));
  assert.equal(out.version, 3);
  assert.deepEqual(out.frames.map(([id]) => id), ['TIT2', 'TPE1', 'APIC']);
  assert.ok(out.audio.equals(AUDIO));
});

test('a v2.3 tag with an extended header keeps its frames (R44)', () => {
  // v2.3's extended header size leaves out its own four bytes: 6 means
  // two flag bytes and a four-byte padding size follow it.
  const extended = Buffer.from([0, 0, 0, 6, 0, 0, 0, 0, 0, 0]);
  const file = Buffer.concat([tag(3, 0x40, Buffer.concat([extended, frame23('TIT2', 'Title'), frame23('TPE1', 'Artist')])), AUDIO]);
  const out = framesOf(buildId3WithCover(file, COVER, 'image/jpeg'));
  assert.deepEqual(out.frames.map(([id]) => id), ['TIT2', 'TPE1', 'APIC']);
  assert.equal(out.frames[0][1].subarray(1).toString('latin1'), 'Title');
  assert.ok(out.audio.equals(AUDIO));
});

test('a v2.4 tag with an extended header keeps its frames', () => {
  // v2.4's extended header size counts its own four bytes (synchsafe).
  const extended = Buffer.from([0, 0, 0, 6, 1, 0]);
  const frame24 = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id, 'ascii'), synchsafe(body.length), Buffer.from([0, 0]), body]);
  };
  const file = Buffer.concat([tag(4, 0x40, Buffer.concat([extended, frame24('TIT2', 'Title'), frame24('TPE1', 'Artist')])), AUDIO]);
  const out = framesOf(buildId3WithCover(file, COVER, 'image/jpeg'));
  assert.equal(out.version, 4);
  assert.deepEqual(out.frames.map(([id]) => id), ['TIT2', 'TPE1', 'APIC']);
  assert.ok(out.audio.equals(AUDIO));
});

/** A v2.2 frame: 3-character id, 24-bit size, no flags. */
function frame22(id, body) {
  const size = Buffer.alloc(3);
  size.writeUIntBE(body.length, 0, 3);
  return Buffer.concat([Buffer.from(id, 'ascii'), size, body]);
}
const text22 = text => Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);

test('a v2.2 tag stays v2.2: its frames kept, the cover as its own PIC frame (R45)', () => {
  const oldPicture = frame22('PIC', Buffer.concat([Buffer.from([0]), Buffer.from('PNG'), Buffer.from([3, 0]), Buffer.from([0x89, 0x50, 0x4e, 0x47])]));
  const file = Buffer.concat([tag(2, 0, Buffer.concat([frame22('TT2', text22('Title')), oldPicture, frame22('TP1', text22('Artist')), Buffer.alloc(16)])), AUDIO]);
  const out = buildId3WithCover(file, COVER, 'image/jpeg');
  assert.equal(out[3], 2, 'still v2.2');
  const end = 10 + decodeSynchsafe(out[6], out[7], out[8], out[9]);
  const frames = [];
  for (let pos = 10; pos + 6 <= end;) {
    const id = out.subarray(pos, pos + 3).toString('ascii');
    if (!/^[A-Z0-9]{3}$/.test(id)) break;
    const size = out.readUIntBE(pos + 3, 3);
    frames.push([id, out.subarray(pos + 6, pos + 6 + size)]);
    pos += 6 + size;
  }
  assert.deepEqual(frames.map(([id]) => id), ['TT2', 'TP1', 'PIC']);
  assert.equal(frames[0][1].subarray(1).toString('latin1'), 'Title');
  const picture = frames[2][1];
  assert.equal(picture.subarray(1, 4).toString('ascii'), 'JPG');
  assert.equal(picture[4], 3, 'front cover');
  assert.ok(picture.subarray(6).equals(COVER));
  assert.ok(out.subarray(end).equals(AUDIO));
});

test('a tag it can\'t rewrite faithfully is refused before anything is written (R45)', () => {
  const frames = frame23('TIT2', 'Title');
  for (const [file, why] of [
    [Buffer.concat([tag(5, 0, frames), AUDIO]), /ID3v2\.5/],
    [Buffer.concat([tag(3, 0x80, frames), AUDIO]), /unsynchronised/],
    [Buffer.concat([tag(2, 0x40, frame22('TT2', text22('Title'))), AUDIO]), /compressed/],
  ]) {
    assert.throws(() => buildId3WithCover(file, COVER, 'image/jpeg'), why);
  }
});

test('a v2.4 footer goes with the old tag, not into the audio (R45)', () => {
  const frame24 = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id, 'ascii'), synchsafe(body.length), Buffer.from([0, 0]), body]);
  };
  const frames = frame24('TIT2', 'Title');
  const footer = Buffer.concat([Buffer.from('3DI', 'ascii'), Buffer.from([4, 0, 0x10]), synchsafe(frames.length)]);
  const file = Buffer.concat([tag(4, 0x10, frames), footer, AUDIO]);
  const out = framesOf(buildId3WithCover(file, COVER, 'image/jpeg'));
  assert.deepEqual(out.frames.map(([id]) => id), ['TIT2', 'APIC']);
  assert.ok(out.audio.equals(AUDIO), 'the audio starts where it did, without the old footer');
});

test('an extended header whose size runs past the tag is refused, not taken for an empty tag (R45)', () => {
  const extended = Buffer.from([0, 0, 0x7f, 0x7f, 0, 0, 0, 0, 0, 0]);
  const file = Buffer.concat([tag(3, 0x40, Buffer.concat([extended, frame23('TIT2', 'Title')])), AUDIO]);
  assert.throws(() => buildId3WithCover(file, COVER, 'image/jpeg'), /extended header/);
});

'use strict';
// Writing cover art replaces the audio file whole, through a temporary copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCoverArt, replaceFile } = require('../cover-art.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-cover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an MP3 gets its cover embedded, and no temporary file is left beside it', t => {
  const dir = tempDir(t);
  const song = path.join(dir, 'song.mp3');
  // An empty ID3v2.3 tag, then an MPEG frame header and some audio.
  const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(512, 7)]);
  fs.writeFileSync(song, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), audio]));
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  assert.deepEqual(writeCoverArt(song, cover, 'image/jpeg'), { ok: true });
  const written = fs.readFileSync(song);
  assert.ok(written.includes(Buffer.from('APIC')), 'the picture frame is there');
  assert.ok(written.includes(cover), 'with the image');
  assert.ok(written.subarray(written.length - audio.length).equals(audio), 'the audio is untouched');
  assert.deepEqual(fs.readdirSync(dir), ['song.mp3']);
});

test('replaceFile swaps the whole file, keeps its mode, and leaves the original alone if writing fails', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'track.flac');
  fs.writeFileSync(file, 'old contents');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  replaceFile(file, Buffer.from('new contents'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ['track.flac']);

  // Data that can't be written (not a Buffer or string): the original stays as it was.
  assert.throws(() => replaceFile(file, 42));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  assert.deepEqual(fs.readdirSync(dir), ['track.flac'], 'and no temporary file is left');
});

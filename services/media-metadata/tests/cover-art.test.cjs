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

test('an MP3 gets its cover embedded, and no temporary file is left beside it', async t => {
  const dir = tempDir(t);
  const song = path.join(dir, 'song.mp3');
  // An empty ID3v2.3 tag, then an MPEG frame header and some audio.
  const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(512, 7)]);
  fs.writeFileSync(song, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), audio]));
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  assert.deepEqual(await writeCoverArt(song, cover, 'image/jpeg'), { ok: true });
  const written = fs.readFileSync(song);
  assert.ok(written.includes(Buffer.from('APIC')), 'the picture frame is there');
  assert.ok(written.includes(cover), 'with the image');
  assert.ok(written.subarray(written.length - audio.length).equals(audio), 'the audio is untouched');
  assert.deepEqual(fs.readdirSync(dir), ['song.mp3']);
});

test('replaceFile swaps the whole file, keeps its mode, and leaves the original alone if writing fails', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'track.flac');
  fs.writeFileSync(file, 'old contents');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  await replaceFile(file, Buffer.from('new contents'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ['track.flac']);

  // Data that can't be written (not a Buffer or string): the original stays as it was.
  await assert.rejects(replaceFile(file, 42));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  assert.deepEqual(fs.readdirSync(dir), ['track.flac'], 'and no temporary file is left');
});

test('a file another program holds is reported, never copied over in place (R22)', async t => {
  const dir = tempDir(t);
  const song = path.join(dir, 'song.mp3');
  const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(4096, 7)]);
  const original = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), audio]);
  fs.writeFileSync(song, original);
  // As on Windows when another program has the file open: it can't be
  // replaced, and writing over it fails part-way.
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); });
  t.mock.method(fs, 'copyFileSync', (from, to) => {
    fs.writeFileSync(to, Buffer.from([1, 2, 3, 4]));
    throw Object.assign(new Error('EBUSY: resource busy or locked, copyfile'), { code: 'EBUSY' });
  });
  const result = await writeCoverArt(song, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), 'image/jpeg');
  assert.equal(fs.readFileSync(song).length, original.length, 'the original is untouched');
  assert.ok(fs.readFileSync(song).equals(original));
  assert.deepEqual(fs.readdirSync(dir), ['song.mp3'], 'and no temporary file is left');
  assert.equal(result.ok, false);
  assert.match(result.error, /song\.mp3 couldn't be replaced/);
});

test('a file held for a moment (a virus scanner, the indexer) is replaced once it\'s free (R22)', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'track.flac');
  fs.writeFileSync(file, 'old contents');
  const rename = fs.renameSync;
  let refusals = 2;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (refusals-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    return rename(from, to);
  });
  await replaceFile(file, Buffer.from('new contents'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  assert.deepEqual(fs.readdirSync(dir), ['track.flac']);
});

test('a cover saved beside the song replaces a cover.jpg that is a link, never what it leads to (R23)', async t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'Album'));
  fs.mkdirSync(path.join(dir, 'Private'));
  const song = path.join(dir, 'Album', 'song.ogg');
  fs.writeFileSync(song, 'OggS audio');
  const notes = path.join(dir, 'Private', 'notes.txt');
  fs.writeFileSync(notes, 'my notes');
  // Links to files need Developer Mode (or an administrator) on Windows.
  try { fs.symlinkSync(notes, path.join(dir, 'Album', 'cover.jpg')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('file links are not allowed here'); throw error; }
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  assert.deepEqual(await writeCoverArt(song, cover, 'image/jpeg'), { ok: true, sidecar: true, ext: 'ogg' });
  assert.equal(fs.readFileSync(notes, 'utf8'), 'my notes', 'what the link led to is untouched');
  const written = path.join(dir, 'Album', 'cover.jpg');
  assert.equal(fs.lstatSync(written).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(written), cover);
  // And a cover.jpg already there is replaced whole.
  const second = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  assert.deepEqual(await writeCoverArt(song, second, 'image/jpeg'), { ok: true, sidecar: true, ext: 'ogg' });
  assert.deepEqual(fs.readFileSync(written), second);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Album')).sort(), ['cover.jpg', 'song.ogg']);
});

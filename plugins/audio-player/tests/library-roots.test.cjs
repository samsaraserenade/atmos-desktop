'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLibraryRoots } = require('../src/library-roots.cjs');

// An in-memory stand-in for the one JSON file the list is saved to.
function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync(file, text) { files.set(file, text); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync() {},
  };
}

test('Windows paths: only inside picked folders, whatever the case or tricks', () => {
  const fs = memoryFs();
  const roots = createLibraryRoots({ fs, path: path.win32, file: 'C:\\data\\library-folders.json' });
  roots.add('C:\\Users\\Me\\Music');
  assert.equal(roots.contains('C:\\Users\\Me\\Music\\Album\\01.flac'), true);
  assert.equal(roots.contains('c:\\users\\me\\MUSIC\\Album\\01.flac'), true);
  assert.equal(roots.contains('C:\\Users\\Me\\Music'), true);
  assert.equal(roots.contains('C:\\Users\\Me\\Music2\\x.mp3'), false, 'a sibling sharing the prefix');
  assert.equal(roots.contains('C:\\Users\\Me\\Music\\..\\Documents\\secret.mp3'), false, '.. escapes');
  assert.equal(roots.contains('C:\\Users\\Me\\Documents'), false);
  assert.equal(roots.contains('D:\\Users\\Me\\Music\\x.mp3'), false, 'another drive');
  assert.equal(roots.contains('Music\\x.mp3'), false, 'relative paths');
  assert.throws(() => roots.check('C:\\Windows\\System32'), /not in your music library/);
});

test('POSIX paths behave the same', () => {
  const roots = createLibraryRoots({ fs: memoryFs(), path: path.posix, file: '/data/folders.json' });
  roots.add('/home/me/Music');
  assert.equal(roots.contains('/home/me/Music/a/b.mp3'), true);
  assert.equal(roots.contains('/home/me/Music/../.ssh/id_rsa'), false);
  assert.equal(roots.contains('/home/me/Musicals/x.mp3'), false);
});

test('keepOnly can only remove; adopt happens once; the list is saved', () => {
  const fs = memoryFs();
  const file = '/data/folders.json';
  const make = () => createLibraryRoots({ fs, path: path.posix, file });

  const first = make();
  assert.deepEqual(first.adopt(['/home/me/Music', '/home/me/Podcasts', 'relative']), { adopted: true, folders: ['/home/me/Music', '/home/me/Podcasts'] });
  assert.equal(first.adopt(['/']).adopted, false, 'a second handover is refused');
  assert.equal(first.contains('/etc/passwd'), false);

  assert.deepEqual(first.keepOnly(['/home/me/Music', '/etc']), ['/home/me/Music'], 'keepOnly never adds');
  assert.equal(first.contains('/home/me/Podcasts/x.mp3'), false);

  const reopened = make(); // next launch
  assert.deepEqual(reopened.list(), ['/home/me/Music']);
  assert.equal(reopened.adopt(['/']).adopted, false, 'no handover once the list exists');
  reopened.add('/home/me/Music');
  assert.deepEqual(reopened.list(), ['/home/me/Music'], 'adding twice keeps one entry');
});

test('a link inside a music folder that leads out of it is refused; a picked folder that is itself a link is fine (R23)', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-roots-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const music = path.join(base, 'Music');
  const outside = path.join(base, 'Private');
  fs.mkdirSync(path.join(music, 'Album'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(music, 'Album', 'song.mp3'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.mp3'), 'x');
  fs.symlinkSync(outside, path.join(music, 'escape'), 'junction');
  // Links to files need Developer Mode (or an administrator) on Windows.
  try { fs.symlinkSync(path.join(outside, 'secret.mp3'), path.join(music, 'Album', 'cover.mp3')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('file links are not allowed here'); throw error; }
  fs.symlinkSync(music, path.join(base, 'MusicLink'), 'junction');
  const roots = createLibraryRoots({ fs, path, file: path.join(base, 'folders.json') });
  roots.add(music);
  assert.equal(roots.contains(path.join(music, 'Album', 'song.mp3')), true);
  assert.equal(roots.contains(path.join(music, 'escape', 'secret.mp3')), false, 'through a linked folder');
  assert.equal(roots.contains(path.join(music, 'escape')), false);
  assert.equal(roots.contains(path.join(music, 'Album', 'cover.mp3')), false, 'a linked file');
  assert.throws(() => roots.check(path.join(music, 'escape', 'secret.mp3')), /not in your music library/);
  assert.equal(roots.contains(path.join(music, 'Album', 'not-there.mp3')), true, 'nothing there yet: as written');
  // A cover beside a song that's a link out of the library isn't read.
  fs.writeFileSync(path.join(outside, 'private.jpg'), 'secret image');
  fs.symlinkSync(path.join(outside, 'private.jpg'), path.join(music, 'Album', 'cover.jpg'));
  const { readCoverSidecar } = require('../main.cjs')._test;
  assert.equal(readCoverSidecar(path.join(music, 'Album', 'song.mp3'), candidate => roots.contains(candidate)), null);
  const linked = createLibraryRoots({ fs, path, file: path.join(base, 'linked.json') });
  linked.add(path.join(base, 'MusicLink'));
  assert.equal(linked.contains(path.join(base, 'MusicLink', 'Album', 'song.mp3')), true, 'the folder picked is a link itself');
});

test("a picked folder whose real path can't be read doesn't stop the others; the native call failing on a drive falls back (R23)", () => {
  const fs = memoryFs();
  const calls = [];
  const leadsTo = { '/ok/Music/Linked/song.mp3': '/b/Music/song.mp3' };
  const realpath = value => {
    calls.push(value);
    if (value.startsWith('/locked/')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return leadsTo[value] || value;
  };
  fs.realpathSync = Object.assign(value => realpath(value), {
    // As on a Windows RAM disk or Google Drive's drive.
    native: value => { if (value.startsWith('/ramdisk/')) throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' }); return realpath(value); },
  });
  const roots = createLibraryRoots({ fs, path: path.posix, file: '/data/folders.json' });
  for (const folder of ['/ok/Music', '/locked/Music', '/b/Music', '/ramdisk/Music']) roots.add(folder);
  assert.equal(roots.contains('/ok/Music/Linked/song.mp3'), true, 'leads into another picked folder, past the one that can\'t be read');
  assert.equal(roots.contains('/ramdisk/Music/song.mp3'), true);
  calls.length = 0;
  assert.equal(roots.contains('/b/Music/Album/song.mp3'), true);
  assert.deepEqual(calls, ['/b/Music/Album/song.mp3', '/b/Music'], 'the folder it is in as written is tried first');
});

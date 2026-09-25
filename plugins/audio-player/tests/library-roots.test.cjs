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

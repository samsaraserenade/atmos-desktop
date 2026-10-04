'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mimeFor, readServableFile, MIME_BY_EXT } = require('./protocol-files.cjs');

test('mimeFor: by extension, any case; unknown types are opaque bytes', () => {
  assert.equal(mimeFor('a/panel.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('A/STYLE.CSS'), 'text/css; charset=utf-8');
  assert.equal(mimeFor('x.wasm'), 'application/wasm');
  assert.equal(mimeFor('x.exe'), 'application/octet-stream');
  assert.equal(mimeFor('Makefile'), 'application/octet-stream');
  assert.equal(mimeFor('.js'), 'application/octet-stream'); // a dotfile, not a script
  // Every text type says its charset (the protocols send raw bytes).
  for (const [ext, type] of Object.entries(MIME_BY_EXT)) {
    if (/^text\/|json/.test(type)) assert.match(type, /charset=utf-8$/, ext);
  }
  assert.throws(() => { MIME_BY_EXT['.exe'] = 'text/html'; });
});

test('readServableFile: a file’s bytes, or null for what isn’t one', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ext', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ext', 'a.txt'), 'inside');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
  const ext = path.join(root, 'ext');
  assert.equal(String(await readServableFile(path.join(ext, 'a.txt'), ext)), 'inside');
  assert.equal(String(await readServableFile(path.join(ext, 'a.txt'))), 'inside');
  assert.equal(await readServableFile(path.join(ext, 'missing.txt'), ext), null);
  assert.equal(await readServableFile(path.join(ext, 'a.txt', 'below'), ext), null); // ENOTDIR
  assert.equal(await readServableFile(path.join(ext, 'dir'), ext), null);
  assert.equal(await readServableFile(ext, ext), null); // the root itself
  assert.equal(await readServableFile(path.join(root, 'secret.txt'), ext), null);
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(ext, 'link.txt'));
    fs.symlinkSync(root, path.join(ext, 'up'));
    fs.symlinkSync(path.join(ext, 'a.txt'), path.join(ext, 'dir', 'same.txt'));
  } catch { linked = false; }
  if (linked) {
    assert.equal(await readServableFile(path.join(ext, 'link.txt'), ext), null);
    assert.equal(await readServableFile(path.join(ext, 'up', 'secret.txt'), ext), null);
    // A link that stays inside is fine.
    assert.equal(String(await readServableFile(path.join(ext, 'dir', 'same.txt'), ext)), 'inside');
    // Without a root there is no containment check (atmos-app:// resolves its own paths).
    assert.equal(String(await readServableFile(path.join(ext, 'link.txt'))), 'outside');
  }
  // A root that is itself reached through a link still contains its files.
  if (linked) {
    fs.symlinkSync(ext, path.join(root, 'ext-link'));
    assert.equal(String(await readServableFile(path.join(root, 'ext-link', 'a.txt'), path.join(root, 'ext-link'))), 'inside');
  }
});

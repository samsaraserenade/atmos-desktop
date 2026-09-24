'use strict';
// Every bundled extension — system, first-party, whatever its tier — must
// declare exactly the permissions its code uses. A new require('child_process')
// or an unlisted API host fails here instead of slipping in unnoticed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditExtension, auditLibrary } = require('./extension-audit.cjs');

const repo = path.resolve(__dirname, '..');
const extensions = ['plugins', 'services'].flatMap(kind =>
  fs.readdirSync(path.join(repo, kind), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(repo, kind, entry.name, 'extension.json')))
    .map(entry => path.join(kind, entry.name)));

test('bundled extensions have a tier and declare their permissions', () => {
  for (const relative of extensions) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, relative, 'extension.json'), 'utf8'));
    assert.ok(['system', 'first-party'].includes(manifest.tier), `${relative}: tier must be system or first-party`);
    assert.ok(manifest.permissions && typeof manifest.permissions === 'object', `${relative}: missing "permissions"`);
  }
});

for (const relative of extensions) {
  test(`${relative} uses only what it declares`, () => {
    assert.deepEqual(auditExtension(path.join(repo, relative)), []);
  });
}

// Library services follow the library rules (see auditLibrary()). Known
// exceptions are listed here, by file, until they are fixed.
const LIBRARY_STORAGE_EXCEPTIONS = {
  // None at the moment. Add a library's files here, with the reason and
  // the plan to remove it, rather than granting it in a manifest.
};

for (const relative of extensions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, relative, 'extension.json'), 'utf8'));
  if (manifest.library !== true) continue;
  test(`${relative} follows the library rules`, () => {
    const key = relative.split(path.sep).join('/');
    assert.deepEqual(auditLibrary(path.join(repo, relative), { allowStorage: LIBRARY_STORAGE_EXCEPTIONS[key] || [] }), []);
  });
}

test('the library audit catches entry points, foreign imports, Atmos globals and storage', t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lib = path.join(dir, 'bad-lib');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'extension.json'), JSON.stringify({ library: true, contributes: { panel: {} }, permissions: {} }));
  fs.writeFileSync(path.join(lib, 'settings.js'), '');
  fs.writeFileSync(path.join(lib, 'api.js'), [
    "import { save } from 'atmos-core/persist.js';",
    "import other from '../other/x.js';",
    "import { ok } from './ok.js';",
    'window.atmos.extensionInvoke();',
    "localStorage.setItem('k', 'v');",
  ].join('\n'));
  fs.writeFileSync(path.join(lib, 'ok.js'), 'export const ok = 1;');
  fs.writeFileSync(path.join(lib, 'main.cjs'), "require('fs'); localStorage;");
  const problems = auditLibrary(lib).join('\n');
  for (const expected of [/contributes no surfaces/, /settings\.js is an entry point/, /imports 'atmos-core\/persist\.js'/,
    /imports '\.\.\/other\/x\.js', outside the library/, /uses Atmos globals/, /api\.js: persists on its own/]) {
    assert.match(problems, expected);
  }
  assert.doesNotMatch(problems, /ok\.js|main\.cjs/);
  assert.deepEqual(auditLibrary(lib, { allowStorage: ['api.js'] }).filter(p => /persists/.test(p)), []);
});

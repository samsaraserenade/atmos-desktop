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

// Every bundled extension is a package: a version, a publisher, and every
// service it calls listed as a dependency whose range the repo's copy meets.
// A released extension's required dependencies are released too.
test('bundled extensions have a version, a publisher and complete dependencies', () => {
  const { isValidVersion, satisfies } = require('../core/js/core/extension-version.cjs');
  const { normalizeDependencies } = require('../core/js/core/extension-dependencies.cjs');
  const manifests = new Map(extensions.map(relative => {
    const [kind, id] = relative.split(path.sep);
    return [`${kind === 'plugins' ? 'plugin' : 'service'}:${id}`, JSON.parse(fs.readFileSync(path.join(repo, relative, 'extension.json'), 'utf8'))];
  }));
  const release = JSON.parse(fs.readFileSync(path.join(repo, 'release.json'), 'utf8'));
  const released = new Set([...release.plugins.map(id => `plugin:${id}`), ...release.services.map(id => `service:${id}`)]);
  const problems = [];
  for (const [ref, manifest] of manifests) {
    if (!isValidVersion(manifest.version)) problems.push(`${ref}: "version" must be MAJOR.MINOR.PATCH`);
    if (manifest.publisher !== 'atmos') problems.push(`${ref}: "publisher" must be "atmos"`);
    if (manifest.after !== undefined) problems.push(`${ref}: use "dependencies" instead of "after"`);
    const { list, errors } = normalizeDependencies(manifest);
    problems.push(...errors.map(error => `${ref}: ${error}`));
    const declared = new Set(list.map(dep => dep.ref));
    for (const target of manifest.permissions?.invokes || []) {
      if (!declared.has(target)) problems.push(`${ref}: invokes ${target} but does not list it in "dependencies"`);
    }
    for (const dep of list) {
      const target = manifests.get(dep.ref);
      if (!target) problems.push(`${ref}: depends on ${dep.ref}, which is not in the repo`);
      else if (!satisfies(target.version, dep.range)) problems.push(`${ref}: needs ${dep.ref} ${dep.range}, the repo has ${target.version}`);
      if (released.has(ref) && !dep.optional && !released.has(dep.ref)) problems.push(`${ref} is released but its dependency ${dep.ref} is not (release.json)`);
    }
  }
  assert.deepEqual(problems, []);
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

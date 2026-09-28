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
// The bundled plugins and services, and the system services (part of Core, in core/system).
const extensions = ['plugins', 'services', path.join('core', 'system')].flatMap(kind =>
  fs.readdirSync(path.join(repo, kind), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(repo, kind, entry.name, 'extension.json')))
    .map(entry => path.join(kind, entry.name)));
const refOf = relative => {
  const parts = relative.split(path.sep);
  return `${parts[0] === 'plugins' ? 'plugin' : 'service'}:${parts.at(-1)}`;
};

test('bundled extensions have a tier and declare their permissions', () => {
  for (const relative of extensions) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, relative, 'extension.json'), 'utf8'));
    const inCore = relative.startsWith(path.join('core', 'system'));
    assert.equal(manifest.tier, inCore ? 'system' : 'first-party', `${relative}: tier must be ${inCore ? 'system (it is in core/system)' : 'first-party (system services live in core/system)'}`);
    assert.ok(manifest.permissions && typeof manifest.permissions === 'object', `${relative}: missing "permissions"`);
  }
});

// A manifest without "exports" shares everything with official extensions
// (so packages from before 0.12 kept working). A bundled extension that has
// anything to share (main-process code or a boot frame) says what,
// even if it's nothing ("exports": {}).
test('bundled extensions with main-process code or a boot frame declare "exports"', () => {
  const problems = [];
  for (const relative of extensions) {
    if (relative.startsWith(path.join('core', 'system'))) continue;
    const dir = path.join(repo, relative);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    const hasBoot = fs.existsSync(path.join(dir, 'boot.js')) || !!manifest.contributes?.boot;
    const hasMain = fs.existsSync(path.join(dir, 'main.cjs'));
    if ((hasBoot || hasMain) && (manifest.exports === undefined || manifest.exports === null)) {
      problems.push(`${relative}: has ${hasMain ? 'main.cjs' : 'a boot frame'} but no "exports" (add "exports": {} to share nothing)`);
    }
  }
  assert.deepEqual(problems, []);
});

// Every bundled extension is a package: a version, a publisher, and every
// service it calls listed as a dependency whose range the repo's copy meets.
// A released extension's required dependencies are released too.
test('bundled extensions have a version, a publisher and complete dependencies', () => {
  const { isValidVersion, satisfies } = require('../core/js/core/extension-version.cjs');
  const { normalizeDependencies } = require('../core/js/core/extension-dependencies.cjs');
  const manifests = new Map(extensions.map(relative => [refOf(relative), JSON.parse(fs.readFileSync(path.join(repo, relative, 'extension.json'), 'utf8'))]));
  const release = JSON.parse(fs.readFileSync(path.join(repo, 'release.json'), 'utf8'));
  // The system services always go with Core.
  const system = extensions.filter(relative => relative.startsWith(path.join('core', 'system'))).map(refOf);
  const released = new Set([...release.plugins.map(id => `plugin:${id}`), ...release.services.map(id => `service:${id}`), ...system]);
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
    'window.atmos.getPathForFile();',
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

test('the audit checks that what an extension shares exists', t => {
  const os = require('node:os');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-exports-')), 'sharer');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'main.cjs'), "module.exports = context => { context.handle('read-tags', () => 1); };");
  const write = exportsBlock => fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ permissions: { ipc: true }, exports: exportsBlock }));
  write({ ipc: { 'read-tags': 'official' } });
  assert.deepEqual(auditExtension(dir), []);
  write({ ipc: { 'read-tags': 'official', 'read-any-file': 'all' }, resources: { art: 'official' } });
  assert.deepEqual(auditExtension(dir), [
    "sharer: shares IPC handler 'read-any-file' (\"exports.ipc\") but never registers it",
    "sharer: shares resource provider 'art' (\"exports.resources\") but doesn't declare it",
  ]);
  write({ ipc: { 'read-tags': 'everyone' } });
  assert.deepEqual(auditExtension(dir), ['sharer: exports.ipc.read-tags must be "official" or "all"']);
});

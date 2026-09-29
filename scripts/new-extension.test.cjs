'use strict';
// The extension template and the developer kit: what `npm run new:extension`
// makes is a valid extension Atmos would load, its own tests pass against the
// fake Atmos, and the typings describe the SDK Atmos actually serves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createExtension, SDK_FILES } = require('./new-extension.cjs');
const { auditExtension } = require('./extension-audit.cjs');
const { normalizePermissions } = require('../core/js/core/extension-permissions.cjs');
const { checkCompatibility } = require('../core/js/core/extension-host.cjs');
const { describeContributions } = require('../core/js/core/extension-frames.cjs');

const repo = path.resolve(__dirname, '..');
const atmosVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

function scaffold(t, name = 'hello-there', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-new-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createExtension(path.join(root, name), options);
}

test('a new extension is one this Atmos loads, declaring exactly what it uses', t => {
  const { id, folder, files } = scaffold(t, 'hello-there', { name: 'Hello "There"', publisher: 'someone' });
  assert.equal(id, 'hello-there');
  assert.ok(files.includes('extension.json') && files.includes('panel.js') && files.includes('sidebar.js'));
  for (const file of SDK_FILES) assert.ok(fs.existsSync(path.join(folder, '.atmos-sdk', file)), file);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'extension.json'), 'utf8'));
  assert.equal(manifest.displayName, 'Hello "There"');
  assert.equal(manifest.publisher, 'someone');
  assert.equal(manifest.apiVersion, 4);
  assert.deepEqual(manifest.engines, { atmos: `>=${atmosVersion}` });
  assert.equal(checkCompatibility(manifest, { appVersion: atmosVersion }).compatible, true);
  assert.equal(checkCompatibility(manifest, { appVersion: '0.14.1' }).compatible, false);
  normalizePermissions(manifest.permissions);
  assert.deepEqual(auditExtension(folder), []);
  const surfaces = describeContributions({ id, kind: 'plugin', tier: 'third-party', manifest }, files);
  assert.deepEqual(surfaces.map(surface => [surface.surface, surface.entry, surface.glass]), [['panel', 'panel.js', true], ['sidebar', 'sidebar.js', false]]);
  assert.match(fs.readFileSync(path.join(folder, 'panel.js'), 'utf8'), /'Hello from Hello "There"'/);
  assert.match(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), new RegExp(`--dev-extension="${folder.replace(/\\/g, '\\\\')}"`));
  assert.throws(() => createExtension(folder), /isn't empty/);
  assert.throws(() => createExtension(path.join(path.dirname(folder), 'Bad_Name')), /lowercase/);
});

test('a new extension\'s own tests pass, with the fake Atmos standing in', t => {
  const { folder } = scaffold(t);
  // Its own `npm test`, as a separate run (not a child of this test runner).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--import', './.atmos-sdk/testing/register.mjs', '--test', '--test-reporter=tap'], { cwd: folder, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /# pass 5/);
});

test('the typings name exactly what the SDK exports', () => {
  const source = fs.readFileSync(path.join(repo, 'core', 'js', 'sdk', 'atmos-sdk.js'), 'utf8');
  const typings = fs.readFileSync(path.join(repo, 'core', 'js', 'sdk', 'atmos-sdk.d.ts'), 'utf8');
  const runtime = source.match(/const atmos = Object\.freeze\(\{([\s\S]*?)\}\);/)[1]
    .split(',').map(part => part.trim().split(':')[0].trim()).filter(Boolean).sort();
  const typed = typings.match(/export interface Atmos \{([\s\S]*?)\n\}/)[1]
    .split('\n').map(line => line.match(/^\s+readonly (\w+):/)?.[1]).filter(Boolean).sort();
  assert.deepEqual(typed, runtime);
  const fake = fs.readFileSync(path.join(repo, 'core', 'js', 'sdk', 'testing', 'fake-atmos.mjs'), 'utf8');
  for (const name of runtime) assert.match(fake, new RegExp(`\\n    ${name}[:,( ]`), `the fake has ${name}`);
});

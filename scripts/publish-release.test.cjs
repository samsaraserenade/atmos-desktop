'use strict';
// publish:prepare's checks that need no public checkout or network:
// what in the checkout an export would overwrite (R31), and which tests
// it runs there (R32).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const publish = require('./publish-release.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-publish-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (dir, file, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

test('an exported path that is a file git does not track in the public checkout is found before anything changes (R31)', t => {
  const dest = tempDir(t);
  write(dest, 'docs/notes.md', 'my untracked notes'); // not tracked there
  write(dest, 'core/main.js');                        // tracked: replaced as usual
  write(dest, 'plugins/new');                         // a file where the export needs a folder
  const exported = ['docs/notes.md', 'core/main.js', 'plugins/new/extension.json', 'services/fresh.js'];
  assert.deepEqual(publish.collisions(dest, exported, ['core/main.js']), ['docs/notes.md', 'plugins/new/extension.json']);
  assert.equal(fs.readFileSync(path.join(dest, 'docs/notes.md'), 'utf8'), 'my untracked notes');
});

test('a folder git tracks that becomes a file, and a file renamed only in case where names ignore case, are not collisions (R31)', t => {
  const dest = tempDir(t);
  write(dest, 'docs/guide/a.md');                     // tracked; the release makes docs/guide a file
  write(dest, 'docs/other/a.md');
  write(dest, 'docs/other/mine.md');                  // not tracked: it would go with the folder
  write(dest, 'core/Guide.md');                       // tracked as Guide.md; released as guide.md
  const tracked = ['docs/guide/a.md', 'docs/other/a.md', 'core/Guide.md'];
  assert.deepEqual(publish.collisions(dest, ['docs/guide', 'docs/other'], tracked), ['docs/other']);
  // On Windows and macOS (core.ignorecase) core/guide.md is core/Guide.md.
  const sameFile = fs.existsSync(path.join(dest, 'core/guide.md'));
  assert.deepEqual(publish.collisions(dest, ['core/guide.md'], tracked, { ignoreCase: true }), []);
  assert.deepEqual(publish.collisions(dest, ['core/guide.md'], tracked), sameFile ? ['core/guide.md'] : []);
});

test('the released plugins\' tests: .test.mjs as well as .test.cjs, and a plugin\'s own test script with its dependencies (R32)', t => {
  const dest = tempDir(t);
  write(dest, 'plugins/browser/tests/engine.test.mjs');
  write(dest, 'plugins/browser/tests/notes.md');
  write(dest, 'plugins/finance/tests/totals.test.cjs');
  write(dest, 'plugins/finance/markets/tests/sidebar.test.mjs');
  write(dest, 'plugins/matrix-chat/package.json', JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } }));
  write(dest, 'plugins/matrix-chat/tests/client.test.mjs');
  write(dest, 'plugins/empty/extension.json', '{}');
  const run = id => publish.pluginTestRun(dest, id);
  const slash = file => file.split(path.sep).join('/');
  assert.deepEqual(run('browser').args.map(slash), ['--experimental-vm-modules', '--test', 'plugins/browser/tests/engine.test.mjs']);
  assert.equal(run('browser').cwd, dest);
  assert.deepEqual(run('finance').args.slice(2).map(slash).sort(), ['plugins/finance/markets/tests/sidebar.test.mjs', 'plugins/finance/tests/totals.test.cjs']);
  assert.deepEqual(run('matrix-chat'), { cmd: 'npm', args: ['test', '--silent'], cwd: path.join(dest, 'plugins', 'matrix-chat'), install: false }, 'no lockfile: nothing to npm ci');
  write(dest, 'plugins/matrix-chat/package-lock.json', '{}');
  assert.equal(run('matrix-chat').install, true);
  assert.equal(run('empty'), null);
});

test('the released services\' tests run too; an install cut short is installed again (R32)', t => {
  const dest = tempDir(t);
  write(dest, 'services/charting/tests/scale.test.cjs');
  write(dest, 'services/market-data/tests/feed.test.mjs');
  const slash = file => file.split(path.sep).join('/');
  assert.deepEqual(publish.pluginTestRun(dest, 'charting', 'services').args.slice(2).map(slash), ['services/charting/tests/scale.test.cjs']);
  assert.deepEqual(publish.pluginTestRun(dest, 'market-data', 'services').args.slice(2).map(slash), ['services/market-data/tests/feed.test.mjs']);
  // npm writes node_modules/.package-lock.json once an install is whole.
  const dir = path.join(dest, 'plugins', 'matrix-chat');
  assert.equal(publish.needsInstall(dir, false), true, 'never installed');
  write(dir, 'node_modules/matrix-js-sdk/package.json', '{}');
  assert.equal(publish.needsInstall(dir, false), true, 'an install cut short');
  write(dir, 'node_modules/.package-lock.json', '{}');
  assert.equal(publish.needsInstall(dir, false), false);
  assert.equal(publish.needsInstall(dir, true), true, 'its lockfile changed');
});

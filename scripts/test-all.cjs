#!/usr/bin/env node
'use strict';
/**
 * Every automated test in the repo, in one run (npm run test:all).
 *
 * The npm test:* scripts, then each extension's own tests/ folder, found by
 * looking, so an extension added or left out of an export needs no change
 * here. An extension with its own package.json "test" script (Matrix Chat)
 * runs that, after `npm ci` in its folder. The Finance backend's Python
 * tests run when Python 3 is on the PATH. The end-to-end scripts
 * (scripts/e2e) are not included: they need Electron and a display.
 *
 *   node scripts/test-all.cjs [--bail]
 *
 * Exits with 1 if any suite failed or couldn't run.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const bail = process.argv.includes('--bail');
const results = [];

/** node --test <files> (with ESM mocking support, as the Finance and service tests need). */
function nodeTests(files) {
  return [process.execPath, ['--experimental-vm-modules', '--test', ...files]];
}

function run(name, [command, args], { cwd = repo, shell = false } = {}) {
  console.log(`\n── ${name}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
  const ok = result.status === 0;
  results.push({ name, ok, note: result.error ? result.error.message : null });
  if (!ok && bail) finish();
}

function testFiles(dir) {
  const out = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (['node_modules', 'vendor', 'backend', 'mobile-android'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.(cjs|mjs)$/.test(entry.name)) out.push(path.relative(repo, full));
    }
  };
  walk(dir);
  return out.sort();
}

function python() {
  for (const candidate of ['python3', 'python', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  return null;
}

function finish() {
  console.log('\n── Summary');
  for (const { name, ok, note } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? ` (${note})` : ''}`);
  const failed = results.filter(result => !result.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} suites failed.` : `\nAll ${results.length} suites passed.`);
  process.exit(failed ? 1 : 0);
}

// Core, permissions, services' contracts, the build hook, the extension template and SDK kit.
const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
for (const script of ['test:core', 'test:services', 'test:permissions', 'test:build', 'test:sdk']) {
  if (packageJson.scripts?.[script]) run(script, ['npm', ['run', '-s', script]], { shell: process.platform === 'win32' });
}

// Each extension's own tests.
for (const kind of ['plugins', 'services']) {
  const root = path.join(repo, kind);
  if (!fs.existsSync(root)) continue;
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const own = path.join(dir, 'package.json');
    const ownScript = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')).scripts?.test : null;
    if (ownScript) {
      if (!fs.existsSync(path.join(dir, 'node_modules'))) {
        console.log(`\n── ${kind}/${id}\n  its dependencies aren't installed: run \`npm ci\` in ${path.relative(repo, dir)}`);
        results.push({ name: `${kind}/${id}`, ok: false, note: 'npm ci needed in its folder' });
        if (bail) finish();
        continue;
      }
      run(`${kind}/${id}`, ['npm', ['test', '--silent']], { cwd: dir, shell: process.platform === 'win32' });
      continue;
    }
    const files = testFiles(dir);
    if (files.length) run(`${kind}/${id}`, nodeTests(files));
  }
}

// The Finance backend (Python, standard library only).
const backend = path.join(repo, 'plugins', 'finance', 'backend');
if (fs.existsSync(backend)) {
  const py = python();
  if (py) run('plugins/finance/backend (Python)', [py, ['-m', 'unittest', 'discover', '-s', backend, '-p', 'test_*.py']]);
  else console.log('\n── plugins/finance/backend (Python)\n  skipped: no Python 3 on the PATH');
}

finish();

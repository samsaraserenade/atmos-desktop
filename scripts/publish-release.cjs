#!/usr/bin/env node
'use strict';
/**
 * `npm run publish:prepare [-- "commit message"]`
 *
 * Makes the public repo's checkout (release.json "export.dest", default
 * ../Atmos Public) match the released part of this repo's last commit, and
 * commits it there, ready for you to review and push. You never edit the
 * public checkout by hand.
 *
 *  0. Stops if the Electron in the last commit's package.json isn't the
 *     newest of its line on npm (scripts/electron-current.cjs): installed
 *     copies update themselves to each release, so a release on an older
 *     patch ships Chromium holes already fixed. --allow-old-electron goes
 *     ahead anyway; offline, it only warns.
 *  1. Refuses if the public checkout has uncommitted changes to its files,
 *     or a file git doesn't track there where the export puts one.
 *  2. Exports the last commit here (scripts/export-release.cjs) to a
 *     temporary folder; uncommitted work here is never included.
 *  3. Scans the export for anything private (scripts/release-guard.cjs) and
 *     stops, touching nothing, if it finds any.
 *  4. Updates only the files git tracks in the public checkout (its
 *     node_modules, dist and other ignored or untracked files are left alone).
 *  5. Runs Core, services, permission and the released plugins' and
 *     services' tests there (.test.cjs and .test.mjs; a plugin with its own
 *     test script, Matrix Chat, runs that in its folder, after `npm ci`
 *     there if it isn't installed whole or its lockfile changed); on
 *     failure it puts the checkout back as it was. If package-lock.json
 *     changed, `npm ci` runs there first, since the tests need a dependency
 *     new in this release (its node_modules is left as the new lockfile
 *     has it, even if the tests then fail).
 *  6. Commits as the public checkout's git user, which must be a GitHub
 *     no-reply address, and installs the pre-push guard
 *     (scripts/pre-push-guard.cjs) with the current list of terms.
 *
 * Then: review with `git show --stat` in the public checkout and `git push`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { exportTo } = require('./export-release.cjs');
const { forbiddenTerms, scanTree, isNoreply } = require('./release-guard.cjs');
const { checkElectron, fetchDistTags } = require('./electron-current.cjs');

const repo = path.resolve(__dirname, '..');
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const fail = message => { console.error(`publish: ${message}`); process.exit(1); };

async function main() {
  const flags = new Set(['--allow-old-electron']);
  const allowOldElectron = process.argv.includes('--allow-old-electron');
  const message = process.argv.slice(2).filter(arg => !flags.has(arg)).join(' ').trim();

  // 0. The Electron this release ships: the newest of its line?
  const pinned = JSON.parse(run(repo, 'git', ['show', 'HEAD:package.json'])).devDependencies?.electron;
  const tags = await fetchDistTags();
  if (!tags) console.log(`publish: couldn't reach npm to check that Electron ${pinned} is current; check it before releasing`);
  else {
    const electron = checkElectron(pinned, tags);
    if (!electron.ok && !allowOldElectron) fail(electron.message);
    console.log(`publish: ${electron.message}`);
  }

  const release = JSON.parse(run(repo, 'git', ['show', 'HEAD:release.json']));
  const dest = path.resolve(repo, (release.export && release.export.dest) || '../Atmos Public');
  if (!fs.existsSync(path.join(dest, '.git'))) fail(`${dest} is not a git checkout (set release.json "export.dest")`);
  const inDest = (...args) => run(dest, 'git', args);

  // 1. The public checkout must have nothing of its own in progress.
  const dirty = inDest('status', '--porcelain', '--untracked-files=no').trim();
  if (dirty) fail(`the public checkout has uncommitted changes; commit or discard them first:\n${dirty}`);

  const head = run(repo, 'git', ['log', '-1', '--format=%h %s']).trim();
  const pending = run(repo, 'git', ['status', '--porcelain', '--untracked-files=no']).trim().split('\n').filter(Boolean).length;
  console.log(`publish: exporting ${head}`);
  if (pending) console.log(`  (${pending} uncommitted change${pending === 1 ? '' : 's'} here are not included)`);

  // 2–3. Export to a temporary folder and scan it.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-publish-'));
  try {
    const out = path.join(staging, 'out');
    const { plan } = exportTo(out, 'HEAD');
    const terms = forbiddenTerms(repo, 'HEAD');
    const hits = scanTree(out, terms);
    if (hits.length) {
      for (const hit of hits.slice(0, 40)) console.error(`  ${hit.file}:${hit.line}  "${hit.term}"  ${hit.text}`);
      fail(`${hits.length} private mention${hits.length === 1 ? '' : 's'} in the export; nothing was changed in the public checkout.`);
    }

    // 4. Sync the tracked files only. A file git doesn't track where the
    // export puts one would be lost (and, on a failure, the copy put there
    // removed too): stop first, touching nothing (R31).
    const exported = new Set(plan.keep.concat([...plan.rewrite.keys()]));
    const tracked = inDest('ls-files', '-z').split('\0').filter(Boolean);
    const ignoreCase = (() => { try { return inDest('config', '--bool', 'core.ignorecase').trim() === 'true'; } catch { return false; } })();
    const clashes = collisions(dest, exported, tracked, { ignoreCase });
    if (clashes.length) fail(`the public checkout has files git doesn't track where this release puts its own; move them first:\n${clashes.slice(0, 40).map(file => `  ${file}`).join('\n')}`);
    const removed = tracked.filter(file => !exported.has(file));
    for (const file of removed) fs.rmSync(path.join(dest, file), { force: true });
    // Folders those removals leave empty go too: git doesn't track folders,
    // and a check that lists services/ would find, say, an empty
    // services/audio once Audio moved into Core.
    for (const file of removed) {
      for (let dir = path.dirname(file); dir && dir !== '.'; dir = path.dirname(dir)) {
        const full = path.join(dest, dir);
        try {
          if (fs.readdirSync(full).length) break;
          fs.rmdirSync(full);
        } catch { break; }
      }
    }
    for (const file of exported) {
      const target = path.join(dest, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(out, file), target);
    }
    const listFile = path.join(staging, 'paths.txt');
    fs.writeFileSync(listFile, [...exported, ...removed].join('\n'));
    inDest('add', '-A', `--pathspec-from-file=${listFile}`);
    const staged = inDest('diff', '--cached', '--name-status').trim();
    const added = inDest('diff', '--cached', '--name-only', '--diff-filter=A').split('\n').filter(Boolean);
    if (!staged) { console.log('publish: nothing changed since the last publish.'); installGuard(dest, terms); return; }
    console.log(`publish: ${staged.split('\n').length} file(s) changed in ${dest}`);

    // 5. Tests in the public checkout.
    const restore = () => {
      inDest('reset', '-q', '--hard', 'HEAD');
      for (const file of added) fs.rmSync(path.join(dest, file), { force: true });
    };
    // A dependency new in this release isn't in the checkout's node_modules
    // yet, and Core's tests load it (@ghostery/adblocker, 0.17.0).
    const lockChanged = staged.split('\n').some(line => line.split('\t').pop() === 'package-lock.json');
    if (needsInstall(dest, lockChanged)) {
      console.log(`publish: npm ci in the public checkout (${lockChanged ? 'package-lock.json changed' : 'not installed whole'})`);
      const install = spawnSync('npm', ['ci'], { cwd: dest, encoding: 'utf8', maxBuffer: 1 << 26, shell: process.platform === 'win32' });
      if (install.status !== 0) {
        console.error(`${install.stdout || ''}${install.stderr || ''}`.trim().split('\n').slice(-20).join('\n'));
        restore();
        fail('npm ci failed in the public checkout; its files have been put back as they were (run npm ci there again before a build).');
      }
    }
    const changed = new Set(staged.split('\n').map(line => line.split('\t').pop()));
    const tests = [
      { cmd: 'npm', args: ['run', '-s', 'test:core'], cwd: dest },
      { cmd: 'npm', args: ['run', '-s', 'test:services'], cwd: dest },
      { cmd: 'npm', args: ['run', '-s', 'test:permissions'], cwd: dest },
      ...release.plugins.map(id => pluginTestRun(dest, id)).filter(Boolean),
      ...(release.services || []).map(id => pluginTestRun(dest, id, 'services')).filter(Boolean),
    ];
    for (const { cmd, args, cwd, install } of tests) {
      const lockFile = path.relative(dest, path.join(cwd, 'package-lock.json')).split(path.sep).join('/');
      if (install && needsInstall(cwd, changed.has(lockFile))) {
        console.log(`publish: npm ci in ${path.relative(dest, cwd)} (its own dependencies, for its tests)`);
        const own = spawnSync('npm', ['ci'], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, shell: process.platform === 'win32' });
        if (own.status !== 0) {
          console.error(`${own.stdout || ''}${own.stderr || ''}`.trim().split('\n').slice(-20).join('\n'));
          restore();
          fail(`npm ci failed in ${path.relative(dest, cwd)} of the public checkout; its files have been put back as they were (the next publish tries it again).`);
        }
      }
      const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
      if (result.status !== 0) {
        console.error((result.stdout || '').split('\n').filter(line => /^not ok|^# (pass|fail)/.test(line)).join('\n'));
        restore();
        fail(`tests failed in the public checkout (${path.relative(dest, cwd) || '.'}: ${cmd} ${args.join(' ')}); it has been put back as it was.`);
      }
    }
    console.log('publish: tests pass');

    // 6. Commit as a no-reply identity, and (re)install the push guard.
    const email = (() => { try { return inDest('config', 'user.email').trim(); } catch { return ''; } })();
    if (!isNoreply(email)) {
      restore();
      fail(`the public checkout's git email is "${email || 'not set'}"; set it to your GitHub no-reply address:\n  git -C "${dest}" config user.email <id>+<user>@users.noreply.github.com`);
    }
    const version = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
    inDest('commit', '-q', '-m', message || `Atmos ${version}`);
    installGuard(dest, terms);
    console.log(`publish: committed ${inDest('log', '-1', '--format=%h %s').trim()}`);
    console.log(inDest('show', '--stat', '--format=', 'HEAD').trimEnd());
    console.log(`\nReview it, then push:\n  cd "${dest}"\n  git show --stat\n  git push`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The exported files that would overwrite something git doesn't track in
 * the public checkout (`tracked`: its `git ls-files`): a file at that path,
 * a folder with anything git doesn't track in it (one it tracks all of
 * goes with the release's removals), or a file where the export needs a
 * folder. `ignoreCase`: the checkout's names ignore case (core.ignorecase,
 * Windows and macOS), so a file renamed only in case is the same file.
 */
function collisions(dest, exported, tracked, { ignoreCase = false } = {}) {
  const fold = file => (ignoreCase ? file.toLowerCase() : file);
  const known = new Set(tracked.map(fold));
  const there = file => { try { return fs.lstatSync(path.join(dest, file)); } catch { return null; } };
  const trackedUnder = dir => [...known].some(file => file.startsWith(`${fold(dir)}/`));
  const untrackedIn = dir => fs.readdirSync(path.join(dest, dir), { recursive: true })
    .map(name => `${dir}/${String(name).split(path.sep).join('/')}`)
    .some(child => (there(child)?.isDirectory() ? !trackedUnder(child) : !known.has(fold(child))));
  return [...exported].filter(file => {
    if (known.has(fold(file))) return false;
    const stat = there(file);
    if (stat) return !stat.isDirectory() || untrackedIn(file);
    for (let dir = path.dirname(file); dir && dir !== '.'; dir = path.dirname(dir)) {
      const above = there(dir);
      if (above) return !above.isDirectory() && !known.has(fold(dir.split(path.sep).join('/')));
    }
    return false;
  });
}

/**
 * Whether `dir` needs `npm ci`: its lockfile changed, or it isn't
 * installed whole (npm writes node_modules/.package-lock.json once an
 * install is done; one cut short leaves node_modules without it).
 */
function needsInstall(dir, lockChanged) {
  return lockChanged || !fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'));
}

/**
 * How a released plugin's (or service's: `kind`) tests run in the public
 * checkout: its own package.json "test" script, in its folder, where it
 * has one (Matrix Chat's need its own dependencies: `install`, when it has
 * a lockfile to install from); else node --test on its test files,
 * .test.cjs and .test.mjs alike (R32: the .mjs ones, all of Atmos
 * Browser's, were never run); null when it has none.
 */
function pluginTestRun(dest, id, kind = 'plugins') {
  const root = path.join(dest, kind, id);
  let script = null;
  try { script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts?.test || null; } catch { /* none */ }
  if (script) return { cmd: 'npm', args: ['test', '--silent'], cwd: root, install: fs.existsSync(path.join(root, 'package-lock.json')) };
  // ES-module tests need --experimental-vm-modules.
  const files = pluginTests(dest, id, kind);
  return files.length ? { cmd: 'node', args: ['--experimental-vm-modules', '--test', ...files], cwd: dest } : null;
}

/** A released extension's test files: tests/*.test.{cjs,mjs} and <folder>/tests/*.test.{cjs,mjs} (Finance's markets/tests). */
function pluginTests(dest, id, kind = 'plugins') {
  const root = path.join(dest, kind, id);
  const dirs = ['tests'];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !['tests', 'node_modules'].includes(entry.name) && !entry.name.startsWith('.')) dirs.push(path.join(entry.name, 'tests'));
    }
  }
  return dirs.filter(dir => fs.existsSync(path.join(root, dir)))
    .flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(name => /\.test\.(cjs|mjs)$/.test(name))
      .map(name => path.join(kind, id, dir, name)));
}

function installGuard(dest, terms) {
  const gitDir = path.join(dest, '.git');
  fs.writeFileSync(path.join(gitDir, 'atmos-guard.json'), `${JSON.stringify({ terms }, null, 2)}\n`);
  fs.copyFileSync(path.join(__dirname, 'pre-push-guard.cjs'), path.join(gitDir, 'hooks', 'atmos-pre-push-guard.cjs'));
  fs.writeFileSync(path.join(gitDir, 'hooks', 'pre-push'),
    '#!/bin/sh\n# Installed by npm run publish:prepare in the private repo.\nexec node "$(dirname "$0")/atmos-pre-push-guard.cjs" "$@"\n');
  try { fs.chmodSync(path.join(gitDir, 'hooks', 'pre-push'), 0o755); } catch { /* Windows */ }
}

if (require.main === module) main().catch(error => fail(error.message));

module.exports = { collisions, pluginTestRun, needsInstall };

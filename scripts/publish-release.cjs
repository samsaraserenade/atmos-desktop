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
 *  1. Refuses if the public checkout has uncommitted changes to its files.
 *  2. Exports the last commit here (scripts/export-release.cjs) to a
 *     temporary folder; uncommitted work here is never included.
 *  3. Scans the export for anything private (scripts/release-guard.cjs) and
 *     stops, touching nothing, if it finds any.
 *  4. Updates only the files git tracks in the public checkout (its
 *     node_modules, dist and other ignored or untracked files are left alone).
 *  5. Runs Core, services, permission and the released plugins' tests there;
 *     on failure it puts the checkout back as it was.
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

const repo = path.resolve(__dirname, '..');
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const fail = message => { console.error(`publish: ${message}`); process.exit(1); };

function main() {
  const message = process.argv.slice(2).join(' ').trim();
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

    // 4. Sync the tracked files only.
    const exported = new Set(plan.keep.concat([...plan.rewrite.keys()]));
    const tracked = inDest('ls-files', '-z').split('\0').filter(Boolean);
    const removed = tracked.filter(file => !exported.has(file));
    for (const file of removed) fs.rmSync(path.join(dest, file), { force: true });
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
    const tests = [
      ['npm', ['run', '-s', 'test:core']],
      ['npm', ['run', '-s', 'test:services']],
      ['npm', ['run', '-s', 'test:permissions']],
      ...release.plugins.filter(id => fs.existsSync(path.join(dest, 'plugins', id, 'tests')))
        .map(id => ['node', ['--test', ...fs.readdirSync(path.join(dest, 'plugins', id, 'tests'))
          .filter(name => name.endsWith('.test.cjs')).map(name => path.join('plugins', id, 'tests', name))]]),
    ];
    for (const [cmd, args] of tests) {
      if (cmd === 'node' && args.length === 1) continue;
      const result = spawnSync(cmd, args, { cwd: dest, encoding: 'utf8', shell: process.platform === 'win32' });
      if (result.status !== 0) {
        console.error((result.stdout || '').split('\n').filter(line => /^not ok|^# (pass|fail)/.test(line)).join('\n'));
        restore();
        fail(`tests failed in the public checkout (${cmd} ${args.join(' ')}); it has been put back as it was.`);
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

function installGuard(dest, terms) {
  const gitDir = path.join(dest, '.git');
  fs.writeFileSync(path.join(gitDir, 'atmos-guard.json'), `${JSON.stringify({ terms }, null, 2)}\n`);
  fs.copyFileSync(path.join(__dirname, 'pre-push-guard.cjs'), path.join(gitDir, 'hooks', 'atmos-pre-push-guard.cjs'));
  fs.writeFileSync(path.join(gitDir, 'hooks', 'pre-push'),
    '#!/bin/sh\n# Installed by npm run publish:prepare in the private repo.\nexec node "$(dirname "$0")/atmos-pre-push-guard.cjs" "$@"\n');
  try { fs.chmodSync(path.join(gitDir, 'hooks', 'pre-push'), 0o755); } catch { /* Windows */ }
}

main();

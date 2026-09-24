'use strict';
/**
 * pre-push hook for the public repo, installed by `npm run publish:prepare`
 * (scripts/publish-release.cjs) as .git/hooks/pre-push. Refuses the push when
 * a commit being pushed has an author or committer email that is not a
 * GitHub no-reply address, or when its message or any file in it contains a
 * term from .git/atmos-guard.json (unreleased extension names, your own
 * email, release.json "export.forbid").
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const git = (...cmd) => execFileSync('git', cmd, { encoding: 'utf8', maxBuffer: 1 << 28 });
const gitDir = git('rev-parse', '--git-dir').trim();
let guard;
try { guard = JSON.parse(fs.readFileSync(path.join(gitDir, 'atmos-guard.json'), 'utf8')); }
catch { console.error('atmos guard: .git/atmos-guard.json is missing; run npm run publish:prepare in the private repo.'); process.exit(1); }
const terms = guard.terms || [];
const ZERO = /^0+$/;
const problems = [];

const input = fs.readFileSync(0, 'utf8').trim();
for (const line of input ? input.split('\n') : []) {
  const [, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // deleting a remote branch
  const range = ZERO.test(remoteSha) ? [localSha] : [localSha, `^${remoteSha}`];
  let commits = [];
  try { commits = git('rev-list', ...range).split('\n').filter(Boolean); }
  catch { commits = git('rev-list', localSha).split('\n').filter(Boolean); }
  for (const commit of commits) {
    const [author, committer, ...message] = git('show', '-s', '--format=%ae%n%ce%n%B', commit).split('\n');
    for (const email of [author, committer]) {
      if (!/@users\.noreply\.github\.com$/i.test(email)) problems.push(`${commit.slice(0, 7)}: email ${email} is not a GitHub no-reply address`);
    }
    const body = message.join('\n').toLowerCase();
    for (const term of terms) if (body.includes(term.toLowerCase())) problems.push(`${commit.slice(0, 7)}: commit message mentions "${term}"`);
    if (!terms.length) continue;
    let found = '';
    try { found = git('grep', '-I', '-i', '-n', '-F', ...terms.flatMap(term => ['-e', term]), commit, '--'); }
    catch { found = ''; } // git grep exits 1 when nothing matches
    for (const hit of found.split('\n').filter(Boolean).slice(0, 20)) problems.push(`${commit.slice(0, 7)}: ${hit.slice(commit.length + 1, commit.length + 161)}`);
  }
}

if (problems.length) {
  console.error('atmos guard: push refused. Not for the public repo:');
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  console.error('Fix it in the private repo and run npm run publish:prepare again.');
  process.exit(1);
}

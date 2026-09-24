'use strict';
/**
 * What must never reach the public repo, and a scan for it.
 *
 * Terms come from this repo at a commit: the id of every extension folder
 * that release.json does not release (and the same id with spaces, and its
 * displayName), your own git email when it is not a GitHub no-reply address,
 * and anything listed in release.json "export.forbid". Matching is
 * case-insensitive and on plain text files only.
 *
 * Used by scripts/publish-release.cjs before it commits, and written into
 * the public checkout's .git for its pre-push hook (scripts/pre-push-guard.cjs).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NOREPLY = /@users\.noreply\.github\.com$/i;

function forbiddenTerms(repo, ref = 'HEAD') {
  const git = (...cmd) => execFileSync('git', cmd, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  const release = JSON.parse(git('show', `${ref}:release.json`));
  const released = new Set([...release.plugins.map(id => `plugins/${id}`), ...release.services.map(id => `services/${id}`)]);
  const terms = new Set();
  const folders = new Set(git('ls-tree', '-r', '--name-only', ref).split('\n')
    .map(file => file.split('/')).filter(parts => (parts[0] === 'plugins' || parts[0] === 'services') && parts.length > 2)
    .map(parts => `${parts[0]}/${parts[1]}`));
  for (const folder of folders) {
    if (released.has(folder)) continue;
    const id = folder.split('/')[1];
    terms.add(id);
    if (id.includes('-')) terms.add(id.replace(/-/g, ' '));
    try {
      const name = JSON.parse(git('show', `${ref}:${folder}/extension.json`)).displayName;
      if (typeof name === 'string' && name.trim()) terms.add(name.trim());
    } catch { /* no manifest or no displayName */ }
  }
  let email = '';
  try { email = git('config', 'user.email').trim(); } catch { /* none set */ }
  if (email && !NOREPLY.test(email)) terms.add(email);
  for (const extra of (release.export && release.export.forbid) || []) if (extra) terms.add(String(extra));
  return [...terms].filter(term => term.length >= 3).sort();
}

/** Every file under <dir> (skipping .git, node_modules, dist) that contains a term. */
function scanTree(dir, terms) {
  const hits = [];
  const needles = terms.map(term => ({ term, lower: term.toLowerCase() }));
  const walk = (folder, rel) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
      const full = path.join(folder, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, name); continue; }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(full);
      if (bytes.subarray(0, 8000).includes(0)) continue; // binary
      const lines = bytes.toString('utf8').split('\n');
      lines.forEach((line, index) => {
        const lower = line.toLowerCase();
        for (const { term, lower: needle } of needles) {
          if (lower.includes(needle)) hits.push({ file: name, line: index + 1, term, text: line.trim().slice(0, 120) });
        }
      });
    }
  };
  walk(dir, '');
  return hits;
}

function isNoreply(email) { return NOREPLY.test(email || ''); }

module.exports = { forbiddenTerms, scanTree, isNoreply };

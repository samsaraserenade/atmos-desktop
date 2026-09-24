#!/usr/bin/env node
'use strict';
/**
 * Export the released part of this repo (release.json) into another folder,
 * for the public repository: Core, the released plugins and services, and
 * the tests, scripts and docs that go with them. Unreleased extensions, this
 * repo's working notes and the end-to-end checks of unreleased extensions
 * stay behind. Reads a commit (default HEAD), never uncommitted changes.
 *
 *   node scripts/export-release.cjs <dest> [--ref <commit>] [--commit "message"]
 *
 * <dest> is created if needed. Everything in it except .git is replaced, so
 * it can be the public repo's checkout: export, review `git diff`, commit.
 * With --commit, the export is committed there (a new repo is initialised
 * on branch main if <dest> has none).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');

function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
  const ref = option('--ref') || 'HEAD';
  const message = option('--commit');
  const dest = args[0] && path.resolve(args[0]);
  if (!dest) {
    console.error('usage: node scripts/export-release.cjs <dest> [--ref <commit>] [--commit "message"]');
    process.exit(1);
  }
  if (dest === repo || (dest.startsWith(repo + path.sep) && !isIgnored(path.relative(repo, dest)))) {
    // Inside this repo, the export would be committed here too.
    console.error('export-release: choose a folder outside this repo, or one git ignores here (e.g. .tmp/)');
    process.exit(1);
  }

  function isIgnored(rel) {
    // A path inside the folder, so a folder-only rule ("dir/") matches even before it exists.
    try { execFileSync('git', ['check-ignore', '-q', `${rel}/.export`], { cwd: repo }); return true; } catch { return false; }
  }
  const { release, plan } = exportTo(dest, ref);

  console.log(`exported ${plan.keep.length} files from ${ref} to ${dest}`);
  console.log(`  plugins:  ${release.plugins.join(', ')}`);
  console.log(`  services: ${release.services.join(', ')}`);
  console.log(`  left out: ${plan.dropped.join(', ')}`);

  if (message) {
    const inDest = (...cmd) => execFileSync('git', cmd, { cwd: dest, encoding: 'utf8' });
    if (!fs.existsSync(path.join(dest, '.git'))) inDest('init', '-q', '-b', 'main');
    inDest('add', '-A');
    const status = inDest('status', '--porcelain');
    if (status.trim()) {
      inDest('commit', '-q', '-m', message);
      console.log(`committed in ${dest}: ${inDest('log', '--oneline', '-1').trim()}`);
    } else {
      console.log('nothing changed since the last export');
    }
  }

}

/** Write the released files of <ref> into <dest> (everything there except .git is replaced). */
function exportTo(dest, ref = 'HEAD') {
  const git = (...cmd) => execFileSync('git', cmd, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  const release = JSON.parse(git('show', `${ref}:release.json`));
  const plan = planExport(git('ls-tree', '-r', '-z', '--name-only', ref).split('\0').filter(Boolean), release);

  // Copy the chosen files at <ref> into a fresh staging folder, then swap it in.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-export-'));
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', path.join(staging, 'export.tar'), ref], { cwd: repo, maxBuffer: 1 << 28 });
    const tree = path.join(staging, 'tree');
    fs.mkdirSync(tree);
    execFileSync('tar', ['-xf', path.join(staging, 'export.tar'), '-C', tree]);
    // Remove everything not chosen, then folders left empty.
    const chosen = new Set(plan.keep);
    const prune = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          prune(full, name);
          if (!fs.readdirSync(full).length) fs.rmdirSync(full);
        } else if (!chosen.has(name)) {
          fs.rmSync(full);
        }
      }
    };
    prune(tree);
    for (const [file, content] of plan.rewrite) {
      fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      fs.writeFileSync(path.join(tree, file), content(git('show', `${ref}:${plan.source.get(file) || file}`)));
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(dest)) if (entry !== '.git') fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
    for (const entry of fs.readdirSync(tree)) fs.cpSync(path.join(tree, entry), path.join(dest, entry), { recursive: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { release, plan };
}

/** Which files go, which are rewritten on the way, and what was left out. */
function planExport(files, release) {
  const released = new Set([
    ...release.plugins.map(id => `plugins/${id}`),
    ...release.services.map(id => `services/${id}`),
  ]);
  const settings = release.export || {};
  const exclude = settings.exclude || [];
  const e2eNeeds = settings.e2e || {};
  const droppedE2e = Object.entries(e2eNeeds)
    .filter(([, needs]) => needs.some(need => !released.has(need)))
    .map(([file]) => file);
  const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);
  const dropped = new Set();
  const keep = files.filter(file => {
    const parts = file.split('/');
    // Anything inside an extension's folder goes only if it is released.
    if ((parts[0] === 'plugins' || parts[0] === 'services') && parts.length > 2) {
      const id = `${parts[0]}/${parts[1]}`;
      if (!released.has(id)) { dropped.add(id); return false; }
    }
    if (exclude.some(dir => under(file, dir))) { dropped.add(exclude.find(dir => under(file, dir))); return false; }
    if (file.startsWith('scripts/e2e/') && droppedE2e.includes(path.basename(file))) { dropped.add(file); return false; }
    return true;
  });

  const rewrite = new Map();
  const source = new Map();
  // The public README describes what is released.
  if (settings.readme) {
    rewrite.set('README.md', text => text);
    source.set('README.md', settings.readme);
  }
  // release.json without the export settings (they name unreleased files).
  rewrite.set('release.json', text => {
    const { export: _unused, ...rest } = JSON.parse(text);
    return `${JSON.stringify(rest, null, 2)}\n`;
  });
  // .gitignore without the lines that name a left-out extension.
  const leftOut = [...dropped].filter(id => /^(plugins|services)\//.test(id)).map(id => id.split('/')[1]);
  if (keep.includes('.gitignore')) rewrite.set('.gitignore', text => pruneGitignore(text, leftOut));
  // The end-to-end README without the checks that stayed behind.
  if (keep.includes('scripts/e2e/README.md')) {
    rewrite.set('scripts/e2e/README.md', text => pruneE2eReadme(text, droppedE2e));
  }
  return { keep, rewrite, source, dropped: [...dropped].sort() };
}

/** Drop ignore rules that name a left-out extension, and comments left heading nothing. */
function pruneGitignore(text, ids) {
  if (!ids.length) return text;
  const lines = text.split('\n').filter(line => line.startsWith('#') || !ids.some(id => line.includes(id)));
  return lines.filter((line, i) => !line.startsWith('#') || (lines[i + 1] ?? '').trim() !== '' && !(lines[i + 1] ?? '').startsWith('#')).join('\n')
    .replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

/** Drop table rows, command lines and expectation blocks that name a left-out check. */
function pruneE2eReadme(text, left) {
  const names = left.map(file => file.replace(/\./g, '\\.'));
  if (!names.length) return text;
  const mention = new RegExp(`\\b(?:${names.join('|')})\\b`);
  const out = [];
  let skippingBlock = false;
  for (const line of text.split('\n')) {
    if (skippingBlock) {
      if (/^\s{2,}\S/.test(line)) continue;
      skippingBlock = false;
    }
    if (/^- `[^`]+`:\s*$/.test(line) && mention.test(line)) { skippingBlock = true; continue; }
    if (mention.test(line) && (/^\|/.test(line) || /^node scripts\/e2e\//.test(line))) continue;
    out.push(line);
  }
  return out.join('\n');
}

module.exports = { exportTo, planExport, pruneE2eReadme, pruneGitignore };
if (require.main === module) main();

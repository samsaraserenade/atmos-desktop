#!/usr/bin/env node
'use strict';
/**
 * Build signed .atmos packages.
 *
 *   npm run pack:extensions -- [--key <file>] [--out <dir>] [--from <folder>] [--all] [id ...]
 *
 * For each extension: copy the files an installer would bundle (the same
 * filters as package.json "build.extraResources"), sign the copy with the
 * package key (scripts/extension-keys.cjs), check the signature against
 * core/trusted-keys.json, and zip it to <out>/<id>-<version>.atmos.
 * Then write <out>/index.json listing every .atmos in <out>, signed with the
 * same key: <out> is a source Atmos can install from (a folder, or the same
 * files on a web server).
 *
 *   ids      plugin or service ids; default: the released ones in release.json.
 *            --all packs every extension except system ones (they are part of Core).
 *   --from   the tree to pack (default: this repo). Point it at an export
 *            (scripts/export-release.cjs) to sign exactly what is published.
 *   --out    default: dist/packages. Packages and index.json already there
 *            are cleared first, so the signed index lists only this run's
 *            packages; --keep adds to them instead.
 *   --key    default: $ATMOS_SIGNING_KEY. It must be an official key in
 *            core/trusted-keys.json (--untrusted allows another, for tests).
 *   --previous  a folder or https:// source to compare with (default: the
 *            official source in the tree's core/extension-sources.json). An
 *            extension whose files changed while its version didn't, or
 *            whose version went down, stops the run: existing installs would
 *            never see the change. --same-version allows it. Unreachable:
 *            a warning, and the run carries on.
 *
 * Extensions with uncommitted changes in --from (a git checkout) are
 * refused, so what is signed is what was pushed; --allow-dirty allows it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSigningKey, repo } = require('./signing-key.cjs');
const { createHasher, listFiles } = require('../core/js/core/extension-integrity.cjs');
const crypto = require('crypto');
const { signExtension, verifyExtension, loadTrustedKeys, signIndex, SIGNATURE_FILE } = require('../core/js/core/extension-signing.cjs');
const { packFolder, readPackage, PACKAGE_EXTENSION } = require('../core/js/core/extension-package.cjs');

const fail = message => { console.error(`pack: ${message}`); process.exit(1); };
const { spawnSync } = require('child_process');
const { keyIdFor } = require('../core/js/core/extension-signing.cjs');
const { compareVersions } = require('../core/js/core/extension-version.cjs');
const FLAGS = { '--all': 'all', '--keep': 'keep', '--untrusted': 'untrusted', '--same-version': 'sameVersion', '--allow-dirty': 'allowDirty' };

/** electron-builder style glob (relative to the kind folder) → RegExp. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Exclusion patterns per kind, from package.json build.extraResources. */
function bundleFilters(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const filters = {};
  for (const resource of pkg.build?.extraResources || []) {
    const kind = path.basename(resource.from);
    filters[kind] = (resource.filter || []).filter(glob => glob.startsWith('!')).map(glob => globToRegExp(glob.slice(1)));
  }
  return filters;
}

/** Copy the files of <root>/<kind>/<id> an installer would bundle into dest. */
function copyBundled(root, kind, id, dest, filters) {
  const src = path.join(root, kind, id);
  const excluded = filters[kind] || [];
  let count = 0;
  for (const rel of listFiles(src)) {
    if (excluded.some(re => re.test(`${id}/${rel}`))) continue;
    const target = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split('/')), target);
    count += 1;
  }
  return count;
}

function parseArgs(argv) {
  const args = {
    ids: [], all: false, keep: false, untrusted: false, sameVersion: false, allowDirty: false, previous: null,
    key: process.env.ATMOS_SIGNING_KEY || null, out: path.join(repo, 'dist', 'packages'), from: repo,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS[arg]) args[FLAGS[arg]] = true;
    else if (['--key', '--out', '--from', '--previous'].includes(arg)) {
      if (!argv[i + 1]) fail(`${arg} needs a value`);
      const value = argv[i += 1];
      args[arg.slice(2)] = /^https:\/\//i.test(value) ? value : path.resolve(value);
    } else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
    else args.ids.push(arg);
  }
  return args;
}

/** [{ kind: 'plugins'|'services', id }] to pack. */
function selectExtensions(root, { ids, all }) {
  const manifestOf = (kind, id) => {
    const file = path.join(root, kind, id, 'extension.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const present = kind => (fs.existsSync(path.join(root, kind)) ? fs.readdirSync(path.join(root, kind)) : []).filter(id => manifestOf(kind, id));
  let chosen;
  if (ids.length) {
    chosen = ids.map(id => {
      const kinds = ['plugins', 'services'].filter(kind => present(kind).includes(id));
      if (!kinds.length) fail(`no extension called '${id}' in ${root}`);
      if (kinds.length > 1) fail(`'${id}' is both a plugin and a service; rename one`);
      return { kind: kinds[0], id };
    });
  } else if (all) {
    chosen = ['plugins', 'services'].flatMap(kind => present(kind).map(id => ({ kind, id })));
  } else {
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    chosen = ['plugins', 'services'].flatMap(kind => (release[kind] || []).map(id => ({ kind, id })));
  }
  return chosen.filter(({ kind, id }) => {
    const manifest = manifestOf(kind, id);
    if (manifest.tier === 'system') {
      if (ids.includes(id)) console.log(`  skipping ${id}: system extensions are part of Core, not packages`);
      return false;
    }
    return true;
  }).map(item => ({ ...item, manifest: manifestOf(item.kind, item.id) }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectExtensions(args.from, args);
  if (!selected.length) fail('nothing to pack');
  for (const { kind, id, manifest } of selected) {
    if (!/^\d+\.\d+\.\d+/.test(manifest.version || '')) fail(`${kind}/${id} has no "version" in extension.json`);
    if (manifest.publisher !== 'atmos') fail(`${kind}/${id} must have "publisher": "atmos"`);
  }
  if (!args.allowDirty) {
    const dirty = uncommitted(args.from, selected);
    if (dirty.length) fail(`uncommitted changes in ${dirty.join(', ')} (commit them, or --allow-dirty)`);
  }
  const privateKey = await loadSigningKey(args.key);
  const trustedKeys = loadTrustedKeys([path.join(repo, 'core', 'trusted-keys.json')]);
  const keyId = keyIdFor(crypto.createPublicKey(privateKey));
  if (!trustedKeys.get(keyId)?.official && !args.untrusted) {
    fail(`key ${keyId} is not an official key in core/trusted-keys.json, so every Atmos would refuse these packages and their index (--untrusted to pack anyway, for tests)`);
  }
  const filters = bundleFilters(args.from);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pack-'));
  fs.mkdirSync(args.out, { recursive: true });
  if (!args.keep) {
    const old = fs.readdirSync(args.out).filter(file => file.endsWith(PACKAGE_EXTENSION) || file === 'index.json');
    for (const file of old) fs.rmSync(path.join(args.out, file));
    if (old.length) console.log(`  cleared ${old.length} file${old.length === 1 ? '' : 's'} from ${path.relative(process.cwd(), args.out) || '.'}`);
  }
  const written = [];
  let untrusted = false;
  try {
    for (const { kind, id, manifest } of selected) {
      const singular = kind === 'plugins' ? 'plugin' : 'service';
      const dir = path.join(staging, kind, id);
      const files = copyBundled(args.from, kind, id, dir, filters);
      const hasher = createHasher(null);
      signExtension(dir, { kind: singular, id, privateKey, hasher });
      const check = verifyExtension(dir, { kind: singular, id, manifest, trustedKeys, hasher });
      if (check.status !== 'verified') untrusted = true;
      const out = path.join(args.out, `${id}-${manifest.version}${PACKAGE_EXTENSION}`);
      const buffer = packFolder(dir, listFiles);
      fs.writeFileSync(out, buffer);
      written.push({ kind: singular, id, version: manifest.version, out, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      const size = fs.statSync(out).size;
      console.log(`  ${path.relative(process.cwd(), out)}  ${files} files, ${(size / 1024).toFixed(0)} KB${check.status === 'verified' ? '' : `  (${check.reason})`}`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const problems = await compareWithPrevious(args, written);
  if (problems.length && !args.sameVersion) {
    for (const { out } of written) fs.rmSync(out, { force: true });
    fail(`${problems.join('; ')}. Existing installs only update to a higher version: bump "version" in extension.json (or --same-version). Nothing was written.`);
  }
  const index = buildIndex(args.out, privateKey);
  console.log(`  ${path.relative(process.cwd(), path.join(args.out, 'index.json'))}  ${index.packages.length} packages, signed`);
  if (untrusted) console.log('pack: packed with --untrusted: Atmos will refuse these packages unless it trusts the key (--trusted-keys, unpackaged).');
}

/** Selected extensions (as "plugins/<id>") with uncommitted changes in `root`, if it is a git checkout. */
function uncommitted(root, selected) {
  const paths = selected.map(({ kind, id }) => `${kind}/${id}`);
  const status = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' });
  if (status.status !== 0) return []; // not a git checkout
  const changed = status.stdout.split('\n').filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, ''));
  return paths.filter(prefix => changed.some(file => file === prefix || file.startsWith(`${prefix}/`)));
}

/** The index a source published last, or null (with a warning) if it can't be read. */
async function readPreviousIndex(location) {
  try {
    if (/^https:\/\//i.test(location)) {
      const response = await fetch(new URL('index.json', location.endsWith('/') ? location : `${location}/`), { redirect: 'follow' });
      if (response.status === 404) return { packages: [] };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }
    const file = path.join(location, 'index.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { packages: [] };
  } catch (error) {
    console.log(`pack: couldn't read the previous index at ${location} (${error.message}); versions not compared`);
    return null;
  }
}

/**
 * Packages whose version stayed the same while their files changed, or went
 * down, compared with what the previous source published.
 */
async function compareWithPrevious(args, written) {
  let location = args.previous;
  if (!location) {
    try {
      location = JSON.parse(fs.readFileSync(path.join(args.from, 'core', 'extension-sources.json'), 'utf8')).sources?.[0]?.location || null;
    } catch { location = null; }
  }
  if (!location || (!/^https:\/\//i.test(location) && path.resolve(location) === path.resolve(args.out))) return [];
  const previous = await readPreviousIndex(location);
  if (!previous) return [];
  const problems = [];
  for (const item of written) {
    const before = (previous.packages || []).find(pkg => pkg.kind === item.kind && pkg.id === item.id);
    if (!before) continue;
    const order = compareVersions(item.version, before.version);
    if (order < 0) problems.push(`${item.id} ${item.version} is older than the published ${before.version}`);
    else if (order === 0 && before.sha256 && before.sha256 !== item.sha256) problems.push(`${item.id} changed but is still ${item.version}`);
  }
  if (!problems.length) console.log(`  compared with ${location}: versions ok`);
  return problems;
}

/**
 * index.json for every .atmos in `dir`: what the manager needs to choose a
 * package without downloading it (kind, id, version, compatibility,
 * dependencies) and to check it once downloaded (size, SHA-256).
 */
function buildIndex(dir, privateKey, name = 'Atmos') {
  const packages = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(PACKAGE_EXTENSION)).sort()) {
    const buffer = fs.readFileSync(path.join(dir, file));
    const entries = new Map(readPackage(buffer).map(entry => [entry.name, entry.data]));
    const manifest = JSON.parse(entries.get('extension.json').toString('utf8'));
    const signature = JSON.parse(entries.get(SIGNATURE_FILE).toString('utf8'));
    const item = {
      kind: signature.payload.kind,
      id: signature.payload.id,
      version: manifest.version,
      publisher: manifest.publisher,
      displayName: manifest.displayName || null,
      description: manifest.description || null,
      apiVersion: manifest.apiVersion,
      requires: manifest.requires || {},
      dependencies: manifest.dependencies || {},
      file,
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
    for (const key of Object.keys(item)) if (item[key] === null || item[key] === undefined) delete item[key];
    packages.push(item);
  }
  const index = signIndex({ format: 1, name, generated: new Date().toISOString(), packages }, privateKey);
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  return index;
}

module.exports = { globToRegExp, bundleFilters, copyBundled, buildIndex };

if (require.main === module) main().catch(error => fail(error.message));

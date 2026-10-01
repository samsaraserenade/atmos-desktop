'use strict';
/**
 * electron-builder afterPack hook: record a SHA-256 hash of every bundled
 * extension file in resources/extensions/integrity.json. At startup Core
 * refuses to load a bundled extension whose files no longer match (see
 * core/js/core/extension-trust.cjs).
 *
 * This makes changes to an installed copy of Atmos visible; it does not
 * stop someone who can also rewrite integrity.json. That needs a signed
 * installer and app, which is planned separately.
 *
 * Which extensions a build bundles: the built-in ones
 * (core/built-in-extensions.json: Atmos Browser) always; every other
 * released one is dropped from a release installer (downloaded instead) or
 * packed as a signed package in a personal build.
 */
const fs = require('fs');
const path = require('path');
const { writeIntegrityList } = require('../core/js/core/extension-integrity.cjs');

/**
 * Keep only the released extensions (release.json) in a packed build, so an
 * installer carries what is released and nothing else. Resolves the ids removed.
 */
function pruneUnreleased(extensionsRoot, release = readRelease()) {
  const removed = [];
  for (const kind of ['plugins', 'services']) {
    const keep = new Set(release[kind] || []);
    const dir = path.join(extensionsRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      if (keep.has(id)) continue;
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      removed.push(`${kind}/${id}`);
    }
    for (const id of keep) {
      if (!fs.existsSync(path.join(dir, id, 'extension.json'))) throw new Error(`after-pack: release.json lists ${kind}/${id}, which is not in the build`);
    }
  }
  return removed;
}

function readRelease() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release.json'), 'utf8'));
}

/**
 * The extensions Atmos itself ships with (core/built-in-extensions.json):
 * Atmos Browser. An installer carries them as they are, verified by
 * integrity.json like Core's own files, rather than as packages to choose
 * and download; they can be switched off, not removed, and a newer signed
 * package still updates them. Returns { plugins: Set, services: Set }.
 */
function readBuiltIn(file = path.join(__dirname, '..', 'core', 'built-in-extensions.json')) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    plugins: new Set(Array.isArray(list.plugins) ? list.plugins : []),
    services: new Set(Array.isArray(list.services) ? list.services : []),
  };
}

/**
 * Every bundled extension leaves the built-in folders (the system services
 * are part of Core, in core/system, not extensions a build bundles): each
 * is signed with the package key and packed into
 * resources/extensions/packages/<id>-<version>.atmos, with a signed
 * index.json. Atmos offers them in its first-run picker and installs them
 * like any other package (removable, updatable). Needs the signing key:
 * ATMOS_SIGNING_KEY (file) and its passphrase (asked, or
 * ATMOS_SIGNING_PASSPHRASE). Resolves [{ kind, id, version }].
 */
async function packOptionalExtensions(extensionsRoot, { privateKey = null, trustedKeys = null, builtIn = readBuiltIn() } = {}) {
  const { loadSigningKey, repo } = require('./signing-key.cjs');
  const { createHasher, listFiles } = require('../core/js/core/extension-integrity.cjs');
  const { signExtension, verifyExtension, loadTrustedKeys } = require('../core/js/core/extension-signing.cjs');
  const { packFolder, PACKAGE_EXTENSION } = require('../core/js/core/extension-package.cjs');
  const { buildIndex } = require('./pack-extensions.cjs');
  const chosen = [];
  for (const kind of ['plugins', 'services']) {
    const dir = path.join(extensionsRoot, kind);
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, id, 'extension.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.tier === 'system') throw new Error(`after-pack: ${kind}/${id} says "tier": "system", but system services live in core/system`);
      // Built in (Atmos Browser): stays where it is, part of the build.
      if (builtIn[kind]?.has(id)) continue;
      chosen.push({ kind, id, manifest });
    }
  }
  if (!chosen.length) return [];
  privateKey ||= await loadSigningKey(process.env.ATMOS_SIGNING_KEY).catch(error => {
    throw new Error(`after-pack: extensions are packed as signed packages, so the build needs the signing key (${error.message})`);
  });
  trustedKeys ||= loadTrustedKeys([path.join(repo, 'core', 'trusted-keys.json')], () => {});
  const out = path.join(extensionsRoot, 'packages');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const packed = [];
  for (const { kind, id, manifest } of chosen) {
    const singular = kind === 'plugins' ? 'plugin' : 'service';
    const dir = path.join(extensionsRoot, kind, id);
    const hasher = createHasher(null);
    signExtension(dir, { kind: singular, id, privateKey, hasher });
    const check = verifyExtension(dir, { kind: singular, id, manifest, trustedKeys, hasher });
    if (check.status !== 'verified' || !check.official) {
      throw new Error(`after-pack: ${kind}/${id} isn't signed by an official key in core/trusted-keys.json (${check.reason || check.status})`);
    }
    fs.writeFileSync(path.join(out, `${id}-${manifest.version}${PACKAGE_EXTENSION}`), packFolder(dir, listFiles));
    fs.rmSync(dir, { recursive: true, force: true });
    packed.push({ kind: singular, id, version: manifest.version });
  }
  buildIndex(out, privateKey, 'Comes with Atmos');
  return packed;
}

/**
 * Remove every bundled extension from a build but the built-in ones (a
 * release installer downloads the rest). Returns the ids removed. A built-in
 * extension missing from the build stops it: release.json must release it.
 */
function dropOptionalExtensions(extensionsRoot, builtIn = readBuiltIn()) {
  const dropped = [];
  for (const kind of ['plugins', 'services']) {
    const dir = path.join(extensionsRoot, kind);
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (builtIn[kind]?.has(id)) continue;
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      dropped.push(id);
    }
    for (const id of builtIn[kind] || []) {
      if (!fs.existsSync(path.join(dir, id, 'extension.json'))) {
        throw new Error(`after-pack: ${kind}/${id} is built in (core/built-in-extensions.json) but not in the build; release.json must release it`);
      }
    }
  }
  return dropped;
}

module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const extensionsRoot = path.join(resources, 'extensions');
  if (!fs.existsSync(extensionsRoot)) throw new Error(`after-pack: ${extensionsRoot} is missing`);
  // `npm run build:personal` (scripts/build-personal.cjs) keeps every
  // extension in the checkout, for your own everyday install.
  if (process.env.ATMOS_BUILD_ALL === '1') {
    console.log('  • personal build: every extension kept (release.json not applied)');
  } else {
    const removed = pruneUnreleased(extensionsRoot);
    if (removed.length) console.log(`  • not released (release.json), left out: ${removed.join(', ')}`);
  }
  const builtIn = readBuiltIn();
  if (process.env.ATMOS_BUILD_ALL === '1') {
    // A personal build carries its other extensions (released or not) as
    // signed packages, for the first-run picker and upgrades, offline.
    const packed = await packOptionalExtensions(extensionsRoot, { builtIn });
    console.log(`  • packages (first-run picker, offline): ${packed.map(item => `${item.id} ${item.version}`).join(', ') || 'none'}`);
  } else {
    // A release installer carries the built-in ones only: Atmos downloads
    // the rest from the official source (core/extension-sources.json, the
    // GitHub release).
    const dropped = dropOptionalExtensions(extensionsRoot, builtIn);
    console.log(`  • extensions downloaded, not bundled: ${dropped.join(', ') || 'none'}`);
  }
  console.log(`  • built in: ${[...builtIn.plugins, ...builtIn.services].join(', ') || 'none'}`);
  const list = writeIntegrityList(extensionsRoot);
  const files = Object.values(list.extensions).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
  console.log(`  • integrity.json: ${Object.keys(list.extensions).length} extensions, ${files} files`);
};

module.exports.pruneUnreleased = pruneUnreleased;
module.exports.packOptionalExtensions = packOptionalExtensions;
module.exports.dropOptionalExtensions = dropOptionalExtensions;
module.exports.readBuiltIn = readBuiltIn;

// `node scripts/after-pack.cjs <resources/extensions>` rewrites the list by hand.
if (require.main === module) {
  const root = process.argv[2];
  if (!root) { console.error('usage: node scripts/after-pack.cjs <extensions root>'); process.exit(1); }
  writeIntegrityList(path.resolve(root));
  console.log(`wrote ${path.join(root, 'integrity.json')}`);
}

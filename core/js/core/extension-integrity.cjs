'use strict';
/**
 * File fingerprints for extensions.
 *
 * - Bundled extensions: the build writes resources/extensions/integrity.json
 *   (scripts/after-pack.cjs) and Core checks every bundled extension against
 *   it at startup. A mismatch means the installed files were changed after
 *   the build, and the extension is not loaded. Without a signed installer
 *   this is tamper-evident, not tamper-proof: someone who can rewrite the
 *   files can also rewrite integrity.json.
 * - Third-party extensions: approving one records a fingerprint of all of
 *   its files; any later change (code or permissions) needs approval again.
 *
 * Source files are hashed on every check. Dependency folders (node_modules)
 * can be large, so their hashes are cached by path, size and modification
 * time between launches.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTEGRITY_FILE = 'integrity.json';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Files the OS or version control adds on its own; they are never served.
const IGNORED_NAMES = new Set(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Relative paths (forward slashes) of every file under root, sorted. */
function listFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * A hasher with an optional persistent cache for dependency files.
 * `cacheFile` may be null (no caching, e.g. at build time).
 */
function createHasher(cacheFile = null) {
  let cache = {};
  let dirty = false;
  if (cacheFile) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { cache = {}; }
  }

  function hashFile(full, rel) {
    const cacheable = cacheFile && /(^|\/)node_modules\//.test(rel);
    if (cacheable) {
      const stat = fs.statSync(full);
      const hit = cache[full];
      if (hit && hit[0] === stat.size && hit[1] === stat.mtimeMs) return hit[2];
      const hash = sha256(fs.readFileSync(full));
      cache[full] = [stat.size, stat.mtimeMs, hash];
      dirty = true;
      return hash;
    }
    return sha256(fs.readFileSync(full));
  }

  /** { files: { rel: sha256 }, digest } for everything under root. */
  function hashTree(root) {
    const files = {};
    for (const rel of listFiles(root)) files[rel] = hashFile(path.join(root, rel), rel);
    const digest = sha256(Buffer.from(Object.entries(files).map(([rel, hash]) => `${rel}\0${hash}`).join('\n')));
    return { files, digest };
  }

  function save() {
    if (!cacheFile || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
      dirty = false;
    } catch (error) {
      console.warn('[extensions] could not save the fingerprint cache:', error.message);
    }
  }

  return { hashTree, save };
}

/** Write integrity.json for a bundled extensions folder (plugins/ and services/ inside). */
function writeIntegrityList(extensionsRoot) {
  const hasher = createHasher(null);
  const extensions = {};
  for (const kind of ['plugins', 'services']) {
    const kindRoot = path.join(extensionsRoot, kind);
    if (!fs.existsSync(kindRoot)) continue;
    for (const entry of fs.readdirSync(kindRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      extensions[`${kind}/${entry.name}`] = hasher.hashTree(path.join(kindRoot, entry.name)).files;
    }
  }
  const list = { version: 1, algorithm: 'sha256', createdAt: new Date().toISOString(), extensions };
  fs.writeFileSync(path.join(extensionsRoot, INTEGRITY_FILE), JSON.stringify(list, null, 1));
  return list;
}

function readIntegrityList(extensionsRoot) {
  const file = path.join(extensionsRoot, INTEGRITY_FILE);
  if (!fs.existsSync(file)) return null;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (list?.version !== 1 || list.algorithm !== 'sha256' || typeof list.extensions !== 'object') {
    throw new Error('integrity.json has an unsupported format');
  }
  return list;
}

/** Compare a tree's hashes with the expected ones. Returns a short reason, or null when they match. */
function compareFiles(actual, expected) {
  if (!expected) return 'not listed in integrity.json';
  const added = Object.keys(actual).filter(rel => !(rel in expected));
  const removed = Object.keys(expected).filter(rel => !(rel in actual));
  const changed = Object.keys(actual).filter(rel => rel in expected && actual[rel] !== expected[rel]);
  const describe = (label, items) => (items.length ? `${label} ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}` : null);
  return [describe('changed', changed), describe('added', added), describe('missing', removed)].filter(Boolean).join('; ') || null;
}

module.exports = { INTEGRITY_FILE, createHasher, writeIntegrityList, readIntegrityList, compareFiles, listFiles };

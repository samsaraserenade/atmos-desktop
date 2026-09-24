'use strict';

/**
 * Extension discovery for the main process.
 *
 * Extensions come from two places:
 *
 *   bundled   — shipped with Atmos (resources/extensions in a build, or the
 *               repo's plugins/ and services/ when running from source).
 *               These are the only extensions that can be `system` or
 *               `first-party`.
 *   installed — %APPDATA%/atmos/{plugins,services}: anything added by the
 *               user. Always `third-party`, whatever its manifest says.
 *
 * When both places contain the same id, the bundled copy wins and the
 * installed one is ignored. `system` extensions are always enabled.
 */

const fs = require('fs');
const path = require('path');
const { orderExtensions } = require('./extension-host.cjs');

const TIERS = Object.freeze(['system', 'first-party', 'third-party']);
const KINDS = Object.freeze({ plugins: 'plugin', services: 'service' });
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The tier an extension actually gets, given where it was found. */
function resolveTier(manifest, source) {
  if (source !== 'bundled') return 'third-party';
  return manifest?.tier === 'system' ? 'system' : 'first-party';
}

function readManifest(extensionPath) {
  const manifestPath = path.join(extensionPath, 'extension.json');
  if (!fs.existsSync(manifestPath)) return null; // legacy extension
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest root must be an object');
    }
    return manifest;
  } catch (error) {
    return { invalid: true, error: error.message };
  }
}

function listFolders(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

/**
 * @param {object} options
 * @param {(kind: 'plugins'|'services') => string|null} options.bundledRoot
 * @param {(kind: 'plugins'|'services') => string|null} options.installedRoot
 * @param {(message: string) => void} [options.warn]
 */
function createExtensionCatalog({ bundledRoot, installedRoot, warn = message => console.warn(message) }) {
  const cache = new Map();

  function discover(kind) {
    if (!KINDS[kind]) throw new TypeError(`Unknown extension kind: ${kind}`);
    const found = new Map();
    for (const [source, root] of [['bundled', bundledRoot(kind)], ['installed', installedRoot(kind)]]) {
      for (const id of listFolders(root)) {
        const extensionPath = path.join(root, id);
        if (!VALID_ID.test(id)) {
          warn(`[extensions] ignoring ${KINDS[kind]} folder '${id}': ids use lowercase letters, numbers and hyphens`);
          continue;
        }
        if (found.has(id)) {
          warn(`[extensions] ignoring installed ${KINDS[kind]} '${id}' (${extensionPath}): a bundled copy is loaded instead`);
          continue;
        }
        const manifest = readManifest(extensionPath);
        if (manifest?.invalid) warn(`[extensions] ${KINDS[kind]} '${id}' has invalid extension.json: ${manifest.error}`);
        found.set(id, { id, kind: KINDS[kind], path: extensionPath, source, tier: resolveTier(manifest, source), manifest });
      }
    }
    return orderExtensions([...found.values()], warn);
  }

  function list(kind) {
    if (!cache.has(kind)) cache.set(kind, discover(kind));
    return cache.get(kind);
  }

  function find(kind, id) {
    return list(kind).find(entry => entry.id === id) || null;
  }

  return { list, find, refresh: () => cache.clear() };
}

module.exports = { createExtensionCatalog, resolveTier, readManifest, TIERS };

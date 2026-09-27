'use strict';

/**
 * Extension discovery for the main process.
 *
 * Extensions come from two places:
 *
 *   bundled   — shipped with Atmos (resources/extensions in a build, or the
 *               repo's plugins/ and services/ when running from source).
 *   installed — %APPDATA%/atmos/{plugins,services}: anything added later.
 *
 * Where an extension sits no longer decides who vouches for it; its
 * signature does (extension-signing.cjs). Each gets a tier:
 *
 *   system       bundled with "tier": "system": part of Core, always on.
 *   first-party  "Official": bundled, or installed with a valid signature
 *                from an official key in core/trusted-keys.json.
 *   third-party  "Community": installed and not signed by an official key.
 *
 * When several copies of an id exist:
 *   - a system extension always wins;
 *   - among official copies (bundled, or installed and signed), the highest
 *     version wins; on a tie the bundled one does. The next one down is kept
 *     as `fallback`, used if the winner turns out not to load;
 *   - an installed copy whose official signature is broken loses to a
 *     bundled one, and otherwise shows as not loadable (tampered);
 *   - a community copy never replaces an official one with the same id.
 *
 * A third place, `previousRoot`, holds the version an update replaced
 * (extension-manager.cjs keeps it until the new one has started once). Its
 * copies only count if officially signed, and lose ties, so they only load
 * when the newer copy can't.
 */

const fs = require('fs');
const path = require('path');
const { orderExtensions } = require('./extension-host.cjs');
const { checkSignature } = require('./extension-signing.cjs');
const { compareVersions, isValidVersion } = require('./extension-version.cjs');

const TIERS = Object.freeze(['system', 'first-party', 'third-party']);
const KINDS = Object.freeze({ plugins: 'plugin', services: 'service' });
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The tier a bundled or unsigned extension gets from where it was found.
 * Installed extensions with an official signature are first-party; the
 * catalog decides that with the signature (see candidateFor below).
 */
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

function versionOf(manifest) {
  return manifest && !manifest.invalid && isValidVersion(manifest.version) ? manifest.version : null;
}

const SOURCE_RANK = { bundled: 0, installed: 1, previous: 2 };

/** Higher version first; a missing version sorts lowest; bundled, then installed, wins ties. */
function compareCandidates(a, b) {
  const va = a.version;
  const vb = b.version;
  if (va && vb) {
    const order = compareVersions(vb, va);
    if (order) return order;
  } else if (va || vb) {
    return va ? -1 : 1;
  }
  return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
}

/**
 * @param {object} options
 * @param {(kind: 'plugins'|'services') => string|null} options.bundledRoot
 * @param {(kind: 'plugins'|'services') => string|null} options.installedRoot
 * @param {(kind: 'plugins'|'services') => string|null} [options.previousRoot]
 * @param {Map} [options.trustedKeys]  from loadTrustedKeys()
 * @param {(message: string) => void} [options.warn]
 */
function createExtensionCatalog({ bundledRoot, installedRoot, previousRoot = () => null, trustedKeys = new Map(), warn = message => console.warn(message) }) {
  const cache = new Map();

  function candidateFor(kind, id, source, extensionPath) {
    const manifest = readManifest(extensionPath);
    if (manifest?.invalid) warn(`[extensions] ${KINDS[kind]} '${id}' has invalid extension.json: ${manifest.error}`);
    const base = { id, kind: KINDS[kind], path: extensionPath, source, manifest, version: versionOf(manifest), signature: null };
    if (source === 'bundled') return { ...base, tier: resolveTier(manifest, source) };
    const check = checkSignature(extensionPath, {
      kind: KINDS[kind], id, manifest: manifest && !manifest.invalid ? manifest : null, trustedKeys,
    });
    if (!check.signed) return { ...base, tier: 'third-party' };
    const signature = { status: check.status, reason: check.reason, keyId: check.keyId, publisher: check.publisher || null };
    // A valid official signature makes it official. A broken one keeps its
    // claim (so it shows as tampered rather than quietly becoming a
    // community extension); an unknown or non-official key is ignored.
    if (check.status === 'valid' && check.official) return { ...base, tier: 'first-party', signature };
    if (check.status === 'invalid') return { ...base, tier: 'first-party', signature };
    return { ...base, tier: 'third-party', signature };
  }

  function choose(kind, id, candidates) {
    const label = `${KINDS[kind]} '${id}'`;
    const system = candidates.find(item => item.tier === 'system');
    const official = candidates
      .filter(item => item.tier === 'first-party' && item.signature?.status !== 'invalid')
      .sort(compareCandidates);
    const broken = candidates.filter(item => item.signature?.status === 'invalid');
    const community = candidates.filter(item => item.tier === 'third-party');

    let chosen = system || official[0] || broken[0] || community[0];
    const fallback = !system && official[0] ? official[1] || null : null;
    for (const item of candidates) {
      if (item === chosen || item === fallback || item.source === 'previous') continue;
      const why = item.signature?.status === 'invalid' ? `its signature is broken (${item.signature.reason})`
        : item.tier === 'third-party' && chosen.tier !== 'third-party' ? 'it is not signed, and an official copy is present'
          : `version ${chosen.version || '(none)'} from ${chosen.source === 'bundled' ? 'Atmos' : chosen.path} is loaded instead`;
      warn(`[extensions] ignoring ${item.source} ${label} (${item.path}): ${why}`);
    }
    if (fallback) chosen = { ...chosen, fallback };
    return chosen;
  }

  function discover(kind) {
    if (!KINDS[kind]) throw new TypeError(`Unknown extension kind: ${kind}`);
    const byId = new Map();
    for (const [source, root] of [['bundled', bundledRoot(kind)], ['installed', installedRoot(kind)], ['previous', previousRoot(kind)]]) {
      for (const id of listFolders(root)) {
        const extensionPath = path.join(root, id);
        if (!VALID_ID.test(id)) {
          if (source !== 'previous') warn(`[extensions] ignoring ${KINDS[kind]} folder '${id}': ids use lowercase letters, numbers and hyphens`);
          continue;
        }
        const candidate = candidateFor(kind, id, source, extensionPath);
        // A kept previous version counts only as an official fallback.
        if (source === 'previous' && !(candidate.tier === 'first-party' && candidate.signature?.status === 'valid')) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(candidate);
      }
    }
    // A previous version on its own (the extension was removed since) never loads.
    for (const [id, candidates] of byId) {
      if (candidates.every(item => item.source === 'previous')) byId.delete(id);
    }
    const chosen = [...byId].map(([id, candidates]) => choose(kind, id, candidates));
    return orderExtensions(chosen, warn);
  }

  function list(kind) {
    if (!cache.has(kind)) cache.set(kind, discover(kind));
    return cache.get(kind);
  }

  function find(kind, id) {
    return list(kind).find(entry => entry.id === id) || null;
  }

  /**
   * Replace an extension with its fallback copy (the next version down),
   * for when the chosen one can't load. Returns the new entry, or null.
   */
  function useFallback(kind, id) {
    const entries = list(kind);
    const index = entries.findIndex(entry => entry.id === id);
    if (index < 0 || !entries[index].fallback) return null;
    const replacement = { ...entries[index].fallback, replaced: { version: entries[index].version, path: entries[index].path } };
    entries[index] = replacement;
    return replacement;
  }

  return { list, find, useFallback, refresh: () => cache.clear() };
}

module.exports = { createExtensionCatalog, resolveTier, readManifest, TIERS };

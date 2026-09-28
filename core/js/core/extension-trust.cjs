'use strict';
/**
 * Whether each extension may load, by tier (extension-catalog.cjs decides
 * the tier: bundled, signed by an official key, or neither):
 *
 *   system, first-party bundled with Atmos
 *     verified    files match the build's integrity.json, or the
 *                 extension's own signature when there is no integrity.json
 *     unverified  neither (running from source, or an unpacked dev build)
 *     tampered    files differ from integrity.json or the signature — not loaded
 *
 *   first-party installed (an official signed package)
 *     verified    every file matches its signature
 *     tampered    the signature is broken or a file differs — not loaded
 *
 *   third-party (installed, not officially signed)
 *     approved    the user approved exactly these files and permissions
 *     pending     never approved — not loaded
 *     changed     files or permissions changed since approval — not loaded
 *     blocked     cannot be approved: it has main-process code (main.cjs),
 *                 asks for main-process permissions, or has a missing or
 *                 invalid extension.json — not loaded
 *
 * Approval is consent plus tamper detection. Containment comes from the
 * runtime: approved third-party extensions run only in sandboxed frames
 * (extension-frames.cjs, extension-frame-host.js), where their declared
 * permissions are enforced.
 */

const fs = require('fs');
const path = require('path');
const { normalizePermissions, describePermissions, normalizeExports } = require('./extension-permissions.cjs');
const { createHasher, readIntegrityList, compareFiles } = require('./extension-integrity.cjs');
const { verifyExtension, SIGNATURE_FILE } = require('./extension-signing.cjs');
const { readJson, writeJson } = require('./json-files.cjs');

const LOADABLE = new Set(['verified', 'unverified', 'approved']);
// Permissions only a main.cjs can use; third-party extensions cannot have one.
const MAIN_PROCESS_KEYS = ['node', 'electron', 'ipc', 'provides', 'uses', 'resources'];

function isLoadable(status) {
  return LOADABLE.has(status);
}

/** Permissions requested now that the approved set did not include, as readable lines. */
function newlyRequested(current, approved) {
  const before = new Set(describePermissions(approved || {}));
  return describePermissions(current).filter(line => !before.has(line) && line !== 'No special permissions');
}

/**
 * @param {object} options
 * @param {string} options.approvalsFile   userData/extension-approvals.json
 * @param {string} [options.hashCacheFile] userData/extension-hash-cache.json
 * @param {(kind: 'plugins'|'services') => string|null} options.bundledRoot
 * @param {Map} [options.trustedKeys]      from loadTrustedKeys()
 */
function createExtensionTrust({ approvalsFile, hashCacheFile = null, bundledRoot, trustedKeys = new Map(), warn = message => console.warn(message) }) {
  const hasher = createHasher(hashCacheFile);
  const integrityLists = new Map();
  const results = new Map();

  function integrityFor(kind) {
    // integrity.json sits beside plugins/ and services/ in the bundled root.
    const root = bundledRoot(kind) ? path.dirname(bundledRoot(kind)) : null;
    if (!root) return null;
    if (!integrityLists.has(root)) {
      let list = null;
      try { list = readIntegrityList(root); } catch (error) { list = { error: error.message }; }
      integrityLists.set(root, list);
    }
    return integrityLists.get(root);
  }

  function approvals() {
    const stored = readJson(approvalsFile, {});
    return stored && typeof stored === 'object' ? stored : {};
  }

  function signatureOf(entry) {
    const result = verifyExtension(entry.path, {
      kind: entry.kind, id: entry.id, manifest: entry.manifest && !entry.manifest.invalid ? entry.manifest : null, trustedKeys, hasher,
    });
    const { status, reason, keyId = null, publisher = null } = result;
    return { status, reason, keyId, publisher };
  }

  function assessBundled(entry, kind) {
    const list = integrityFor(kind);
    if (!list) {
      // No integrity.json: a signed extension is checked against its own
      // signature; otherwise it is running from source.
      if (fs.existsSync(path.join(entry.path, SIGNATURE_FILE))) {
        const signature = signatureOf(entry);
        if (signature.status === 'verified') return { status: 'verified', reason: null, signature };
        if (signature.status === 'tampered') return { status: 'tampered', reason: signature.reason, signature };
      }
      return { status: 'unverified', reason: 'No integrity list (running from source)' };
    }
    if (list.error) return { status: 'tampered', reason: `integrity.json is unreadable: ${list.error}` };
    const { files } = hasher.hashTree(entry.path);
    const mismatch = compareFiles(files, list.extensions[`${kind}/${entry.id}`]);
    return mismatch
      ? { status: 'tampered', reason: `Files differ from this build of Atmos (${mismatch})` }
      : { status: 'verified', reason: null };
  }

  /** An installed extension the catalog found an official signature on. */
  function assessSigned(entry) {
    const signature = signatureOf(entry);
    if (signature.status === 'verified') return { status: 'verified', reason: null, signature };
    return { status: 'tampered', reason: signature.reason || 'Its signature could not be checked', signature };
  }

  function assessInstalled(entry, permissions) {
    if (!entry.manifest) return { status: 'blocked', reason: 'It has no extension.json, so its permissions are unknown' };
    if (entry.manifest.invalid) return { status: 'blocked', reason: `Its extension.json is invalid: ${entry.manifest.error}` };
    if (!permissions) return { status: 'blocked', reason: `Its permissions are invalid: ${entry.permissionError}` };
    if (fs.existsSync(path.join(entry.path, 'main.cjs'))) {
      return { status: 'blocked', reason: 'Only official, signed extensions can run main-process code (main.cjs)' };
    }
    const mainOnly = MAIN_PROCESS_KEYS.filter(key => (key === 'ipc' ? permissions.ipc : permissions[key].length));
    if (mainOnly.length) {
      return { status: 'blocked', reason: `It asks for main-process permissions (${mainOnly.join(', ')}), which only official, signed extensions can have` };
    }
    const { digest } = hasher.hashTree(entry.path);
    const approval = approvals()[`${entry.kind}:${entry.id}`];
    if (!approval) return { status: 'pending', reason: 'Needs your approval before it can load', fingerprint: digest, newPermissions: newlyRequested(permissions, null) };
    if (approval.fingerprint !== digest) {
      const added = newlyRequested(permissions, approval.permissions);
      return {
        status: 'changed',
        reason: added.length ? 'Its files changed since you approved it, and it now asks for more' : 'Its files changed since you approved it',
        fingerprint: digest,
        newPermissions: added,
      };
    }
    return { status: 'approved', reason: null, fingerprint: digest, approvedAt: approval.approvedAt };
  }

  /** Assess one catalog entry. kind is 'plugins' or 'services'. */
  function assess(kind, entry) {
    let permissions = null;
    try {
      permissions = normalizePermissions(entry.manifest && !entry.manifest.invalid ? entry.manifest.permissions : undefined);
    } catch (error) {
      entry = { ...entry, permissionError: error.message };
    }
    let result;
    try {
      // The system services are part of Atmos's own files, like the rest of Core.
      result = entry.source === 'core' ? { status: 'verified', reason: null }
        : entry.source === 'bundled' ? assessBundled(entry, kind)
        : entry.tier === 'first-party' ? assessSigned(entry)
          : assessInstalled(entry, permissions);
    } catch (error) {
      result = { status: entry.tier === 'third-party' ? 'blocked' : 'tampered', reason: `Could not check its files: ${error.message}` };
    }
    // A bundled extension with a bad permissions block still loads if its
    // files are intact (the audit test keeps that from shipping), but it gets
    // no gated main-process access.
    const hasMain = fs.existsSync(path.join(entry.path, 'main.cjs'));
    // What it shares with other extensions; a malformed block shares
    // nothing, and no block at all is null (see reachOf()).
    const declared = entry.manifest && !entry.manifest.invalid ? entry.manifest.exports : undefined;
    let shared = declared === undefined || declared === null ? null : normalizeExports(undefined);
    try {
      if (shared) shared = normalizeExports(declared);
    } catch (error) {
      warn(`[extensions] ${entry.kind} '${entry.id}' shares nothing: ${error.message}`);
    }
    const full = {
      ...result,
      loadable: isLoadable(result.status),
      exports: shared,
      permissions: permissions || normalizePermissions(undefined),
      permissionSummary: describePermissions(permissions || {}, { hasMain }),
      hasMain,
    };
    return full;
  }

  function assessAll(catalog) {
    for (const kind of ['plugins', 'services']) {
      for (let entry of [...catalog.list(kind)]) {
        let result = assess(kind, entry);
        // A newer official copy that can't load falls back to the next one
        // (usually the copy bundled with Atmos), and says so.
        while (!result.loadable && entry.fallback) {
          warn(`[extensions] ${entry.kind} '${entry.id}' ${entry.version || ''} (${entry.path}) can't load (${result.status}: ${result.reason}); using version ${entry.fallback.version || '(none)'} instead`);
          const failed = { version: entry.version, status: result.status, reason: result.reason };
          entry = catalog.useFallback(kind, entry.id);
          result = { ...assess(kind, entry), fellBackFrom: failed };
        }
        if (!result.loadable) warn(`[extensions] not loading ${entry.kind} '${entry.id}' (${result.status}): ${result.reason}`);
        results.set(`${entry.kind}:${entry.id}`, result);
      }
    }
    hasher.save();
  }

  /**
   * The assessment made at startup, which decides what loads this session.
   * Approving or revoking only takes effect on the next launch; until then
   * the startup result carries `approvalChanged: true`.
   */
  function get(entry) {
    return results.get(`${entry.kind}:${entry.id}`) || null;
  }

  /**
   * Approve a third-party extension. `fingerprint` is the one the user was
   * shown; if the files changed since, approval is refused so the user
   * never approves something they have not seen. Takes effect on restart.
   */
  function approve(kind, entry, fingerprint) {
    if (!entry || entry.tier !== 'third-party') throw new Error('Only community extensions need approval');
    const fresh = assess(kind, entry);
    hasher.save();
    if (fresh.status === 'blocked') throw new Error(fresh.reason);
    if (!fingerprint || fresh.fingerprint !== fingerprint) {
      throw new Error('The extension changed while you were reviewing it. Review it again.');
    }
    const stored = approvals();
    stored[`${entry.kind}:${entry.id}`] = {
      fingerprint,
      permissions: entry.manifest.permissions || {},
      approvedAt: new Date().toISOString(),
    };
    writeJson(approvalsFile, stored);
    const startup = results.get(`${entry.kind}:${entry.id}`);
    if (startup) startup.approvalChanged = startup.status !== 'approved';
    return { status: 'approved', restartRequired: true };
  }

  /** Forget an approval; the extension goes back to pending on the next launch. */
  function revoke(entry) {
    const stored = approvals();
    delete stored[`${entry.kind}:${entry.id}`];
    writeJson(approvalsFile, stored);
    const startup = results.get(`${entry.kind}:${entry.id}`);
    if (startup) startup.approvalChanged = startup.status === 'approved';
  }

  return { assess, assessAll, get, approve, revoke };
}

module.exports = { createExtensionTrust };

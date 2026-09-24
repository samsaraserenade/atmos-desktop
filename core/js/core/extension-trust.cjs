'use strict';
/**
 * Whether each extension may load, by tier:
 *
 *   system, first-party (bundled)
 *     verified    files match the build's integrity.json
 *     unverified  no integrity.json (running from source, or an unpacked dev build)
 *     tampered    files differ from integrity.json — not loaded
 *
 *   third-party (installed in AppData)
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
const { normalizePermissions, describePermissions } = require('./extension-permissions.cjs');
const { createHasher, readIntegrityList, compareFiles } = require('./extension-integrity.cjs');

const LOADABLE = new Set(['verified', 'unverified', 'approved']);
// Permissions only a main.cjs can use; third-party extensions cannot have one.
const MAIN_PROCESS_KEYS = ['node', 'electron', 'ipc', 'provides', 'uses', 'resources'];

function isLoadable(status) {
  return LOADABLE.has(status);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
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
 */
function createExtensionTrust({ approvalsFile, hashCacheFile = null, bundledRoot, warn = message => console.warn(message) }) {
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

  function assessBundled(entry, kind) {
    const list = integrityFor(kind);
    if (!list) return { status: 'unverified', reason: 'No integrity list (running from source)' };
    if (list.error) return { status: 'tampered', reason: `integrity.json is unreadable: ${list.error}` };
    const { files } = hasher.hashTree(entry.path);
    const mismatch = compareFiles(files, list.extensions[`${kind}/${entry.id}`]);
    return mismatch
      ? { status: 'tampered', reason: `Files differ from this build of Atmos (${mismatch})` }
      : { status: 'verified', reason: null };
  }

  function assessInstalled(entry, permissions) {
    if (!entry.manifest) return { status: 'blocked', reason: 'It has no extension.json, so its permissions are unknown' };
    if (entry.manifest.invalid) return { status: 'blocked', reason: `Its extension.json is invalid: ${entry.manifest.error}` };
    if (!permissions) return { status: 'blocked', reason: `Its permissions are invalid: ${entry.permissionError}` };
    if (fs.existsSync(path.join(entry.path, 'main.cjs'))) {
      return { status: 'blocked', reason: 'Third-party extensions cannot run main-process code (main.cjs) yet' };
    }
    const mainOnly = MAIN_PROCESS_KEYS.filter(key => (key === 'ipc' ? permissions.ipc : permissions[key].length));
    if (mainOnly.length) {
      return { status: 'blocked', reason: `It asks for main-process permissions (${mainOnly.join(', ')}), which third-party extensions cannot have yet` };
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
      result = entry.source === 'bundled' ? assessBundled(entry, kind) : assessInstalled(entry, permissions);
    } catch (error) {
      result = { status: entry.source === 'bundled' ? 'tampered' : 'blocked', reason: `Could not check its files: ${error.message}` };
    }
    // A bundled extension with a bad permissions block still loads if its
    // files are intact (the audit test keeps that from shipping), but it gets
    // no gated main-process access.
    const hasMain = fs.existsSync(path.join(entry.path, 'main.cjs'));
    const full = {
      ...result,
      loadable: isLoadable(result.status),
      permissions: permissions || normalizePermissions(undefined),
      permissionSummary: describePermissions(permissions || {}, { hasMain }),
      hasMain,
    };
    return full;
  }

  function assessAll(catalog) {
    for (const kind of ['plugins', 'services']) {
      for (const entry of catalog.list(kind)) {
        const result = assess(kind, entry);
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
    if (!entry || entry.source !== 'installed') throw new Error('Only third-party extensions need approval');
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

module.exports = { createExtensionTrust, isLoadable, MAIN_PROCESS_KEYS };

'use strict';
/**
 * Is the Electron a release ships the newest of its line? Chromium's
 * security fixes reach Atmos Browser only through Electron, which backports
 * them to each supported line about weekly, and installed copies update
 * themselves to each Atmos release (core/js/core/atmos-update.cjs): a
 * release on an older patch ships known holes to everyone.
 * publish:prepare stops on one (--allow-old-electron to go ahead).
 */
const { compareVersions } = require('../core/js/core/extension-version.cjs');

/**
 * `version` (package.json's, pinned) against npm's dist-tags for electron:
 * { ok, line, newestInLine, newest, message }. A newer major is only
 * mentioned: moving to one needs its own testing.
 */
function checkElectron(version, distTags) {
  const exact = String(version || '').replace(/^[\^~=v]+/, '');
  const major = Number.parseInt(exact, 10);
  const line = `${major}-x-y`;
  const newestInLine = distTags?.[line] || null;
  const newest = distTags?.latest || null;
  if (!Number.isFinite(major) || !newestInLine) {
    return { ok: true, line, newestInLine, newest, message: `couldn't tell whether Electron ${exact} is current (no "${line}" on npm)` };
  }
  const behind = compareVersions(newestInLine, exact) > 0;
  const majorNote = newest && Number.parseInt(newest, 10) > major ? ` Electron ${newest} (a newer major) is out too; moving to it needs its own testing.` : '';
  return {
    ok: !behind,
    line, newestInLine, newest,
    message: behind
      ? `Electron ${exact} is behind ${newestInLine}, the newest ${major}.x, which may carry Chromium security fixes: npm install --save-dev --save-exact electron@${newestInLine}, test, commit, then publish (or --allow-old-electron).${majorNote}`
      : `Electron ${exact} is the newest ${major}.x.${majorNote}`,
  };
}

/** npm's dist-tags for electron, or null if the registry can't be reached. */
async function fetchDistTags({ timeoutMs = 15000 } = {}) {
  try {
    const response = await fetch('https://registry.npmjs.org/-/package/electron/dist-tags', { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

module.exports = { checkElectron, fetchDistTags };

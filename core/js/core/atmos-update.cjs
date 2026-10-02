'use strict';
/**
 * Atmos updating itself: an installed copy on Windows downloads the newer
 * installer, checks it, and runs it when Atmos quits or from "Restart to
 * update", as Chrome applies its updates.
 *
 * What to install comes from a source's signed index (extension-manager
 * readSource): "core": { "version", "installer": { file, size, sha256,
 * platform, arch } }. Only an official key can sign an index, so the
 * installer is trusted as far as its hash: it is fetched from the same
 * source as the index, never past the signed size, and run only if its
 * SHA-256 matches, checked when the download finishes and again just
 * before it runs. Whoever serves the files can withhold an update, not
 * change one. (Atmos 0.18 and older read only "core.version" and say
 * "Atmos X is available".)
 *
 * The installer is electron-builder's NSIS one, run the way its own
 * updater runs it: `--updated /S` (no pages; it gives Atmos a moment to
 * exit and then closes it, keeps the shortcuts and user data, and installs
 * where Atmos already is), plus `--force-run` to start Atmos again
 * afterwards. The main process starts it only once Atmos's windows have
 * closed (will-quit), so pages have had their last events. A per-machine
 * install needs Windows' permission, so it is never installed on quit,
 * only from "Restart to update", where the prompt is expected.
 *
 * "Update Atmos automatically" (on by default) downloads in the background
 * and installs on quit; off, Atmos only says a version is available and
 * downloads and installs when asked. An update still waiting two days
 * after it was ready (Atmos left open, Windows shut down around it) is
 * worth one notification (nudgeDue). The next start checks the attempt:
 * running the new version, the download is deleted; still on the old one,
 * the attempt is recorded as failed and not repeated on quit for that
 * version (Restart to update still offers it).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./json-files.cjs');
const { compareVersions, isValidVersion } = require('./extension-version.cjs');

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
// A file name, as the release lists it: no folders, no leading dot.
const INSTALLER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/;
// An installer still running when Atmos starts again (someone opened Atmos
// during an install on quit) isn't a failure yet.
const ATTEMPT_GRACE_MS = 3 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 1000;
// How long a downloaded update may wait before Atmos says so out loud.
const NUDGE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The installer an index's "core" entry names, checked, or null: a safe
 * file name, a size within bounds, a SHA-256, and this platform and
 * architecture.
 */
function readInstallerEntry(installer, { platform, arch }) {
  if (!installer || typeof installer !== 'object') return null;
  const { file, size, sha256: hash } = installer;
  if (typeof file !== 'string' || !INSTALLER_NAME.test(file) || file.includes('..')) return null;
  if (!Number.isInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) return null;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (installer.platform !== platform || installer.arch !== arch) return null;
  return { file, size, sha256: hash, platform, arch };
}

/** SHA-256 of a file, read in pieces (installers are ~100 MB). */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** The same, synchronously: for checking the installer while Atmos quits. */
function hashFileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const isUrl = location => /^https?:\/\//i.test(location);

/**
 * Start an installer on its own (detached, so it outlives Atmos, which it
 * then waits for). Node reports a program that can't start (missing,
 * blocked, needing elevation) only later, as an 'error' event, leaving no
 * process id now: that is checked here, so the caller can stay open.
 */
function spawnDetached(file, args, spawn = require('child_process').spawn, warn = message => console.error(message)) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  child.on('error', error => warn(`[update] the installer: ${error.message}`));
  if (child.pid === undefined) throw new Error("The installer couldn't be started");
  child.unref();
}

/**
 * @param {object} options
 * @param {string} options.appVersion      the running Atmos
 * @param {string} options.stateFile       user data's atmos-update.json (the setting and the last attempt)
 * @param {string} options.downloadDir     where installers are downloaded
 * @param {{ perMachine: boolean } | null} options.install
 *        how this copy is installed, or null when it can't update itself
 *        (running from source, portable, not Windows, not an NSIS install)
 * @param {(url: string, file: string, options: { maxBytes: number, signal: AbortSignal, onProgress: (bytes: number) => void }) => Promise<void>} options.download
 *        an https download written to `file`; refuses past maxBytes
 * @param {(file: string, args: string[]) => void} options.spawnInstaller  starts the installer, detached
 * @param {() => void} [options.onChange]   something Settings shows changed
 * @param {string} [options.platform] @param {string} [options.arch]
 * @param {() => number} [options.now]
 */
function createAtmosUpdater({
  appVersion, stateFile, downloadDir, install = null, download, spawnInstaller,
  onChange = () => {}, warn = message => console.warn(message),
  platform = process.platform, arch = process.arch, now = () => Date.now(),
}) {
  let offer = null;            // { version, installer, source } newer than this Atmos
  let phase = 'idle';          // idle | downloading | ready | error
  let progress = null;         // { bytes, total }
  let error = null;
  let readyFile = null;        // the verified installer
  let job = null;              // { version, controller, promise }
  let justInstalled = null;    // { version, from } when this start finished an update
  let lastProgressAt = 0;

  const saved = () => {
    const value = readJson(stateFile, null);
    return value && typeof value === 'object' ? value : {};
  };
  const save = changes => {
    try {
      writeJson(stateFile, { format: 1, ...saved(), ...changes });
    } catch (failure) {
      warn(`[update] could not save ${path.basename(stateFile)}: ${failure.message}`);
    }
  };
  const auto = () => saved().auto !== false;
  const failedVersion = () => (typeof saved().failed?.version === 'string' ? saved().failed.version : null);

  function changed({ throttle = false } = {}) {
    if (throttle) {
      const at = now();
      if (at - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = at;
    }
    try { onChange(); } catch (failure) { warn(`[update] ${failure.message}`); }
  }

  function clearDownloads({ keep = null } = {}) {
    let names = [];
    try { names = fs.readdirSync(downloadDir); } catch { return; }
    for (const name of names) {
      if (keep && name === keep) continue;
      try { fs.rmSync(path.join(downloadDir, name), { force: true, recursive: true }); } catch (failure) {
        warn(`[update] could not delete ${name}: ${failure.message}`);
      }
    }
  }

  /**
   * At start: how the last attempt went. Running the version it installed
   * (or newer): done, the download goes. Still older, and the attempt isn't
   * fresh: failed, and not tried on quit again for that version.
   */
  function startup() {
    const { attempt } = saved();
    if (!attempt || !isValidVersion(attempt.version) || !isValidVersion(appVersion)) return { installed: null, failed: null };
    if (compareVersions(appVersion, attempt.version) >= 0) {
      justInstalled = { version: appVersion, from: typeof attempt.from === 'string' ? attempt.from : null };
      save({ attempt: null, failed: null, installed: { ...justInstalled, at: new Date(now()).toISOString() } });
      clearDownloads();
      return { installed: justInstalled, failed: null };
    }
    const at = Date.parse(attempt.at || '');
    if (Number.isFinite(at) && now() - at < ATTEMPT_GRACE_MS) return { installed: null, failed: null, installing: attempt.version };
    save({ attempt: null, failed: { version: attempt.version, at: new Date(now()).toISOString() } });
    warn(`[update] Atmos ${attempt.version} didn't install; ${appVersion} is still running`);
    return { installed: null, failed: attempt.version };
  }

  /** Where the installer for `entry` is downloaded. */
  const targetFile = installer => path.join(downloadDir, installer.file);

  /** An installer already downloaded and still matching, or null. */
  async function verified(installer) {
    const file = targetFile(installer);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size !== installer.size) return null;
      return (await hashFile(file)) === installer.sha256 ? file : null;
    } catch {
      return null;
    }
  }

  async function fetchInstaller(current, signal) {
    const { installer, source } = current;
    if (signal.aborted) throw new Error('Cancelled');
    fs.mkdirSync(downloadDir, { recursive: true });
    const file = targetFile(installer);
    const partial = `${file}.part`;
    fs.rmSync(partial, { force: true });
    progress = { bytes: 0, total: installer.size };
    changed();
    try {
      if (isUrl(source)) {
        if (!/^https:\/\//i.test(source)) throw new Error('The source must use https://');
        const url = new URL(installer.file, source.endsWith('/') ? source : `${source}/`).toString();
        await download(url, partial, {
          maxBytes: installer.size,
          signal,
          onProgress: bytes => { progress = { bytes, total: installer.size }; changed({ throttle: true }); },
        });
      } else {
        // A folder source (offline, or a test): the same checks, by copy.
        const from = path.join(source, installer.file);
        const stat = await fs.promises.stat(from);
        if (stat.size > installer.size) throw new Error('The installer is larger than the index says');
        await fs.promises.copyFile(from, partial);
      }
      if (signal.aborted) throw new Error('Cancelled');
      const stat = await fs.promises.stat(partial);
      if (stat.size !== installer.size || (await hashFile(partial)) !== installer.sha256) {
        throw new Error("The download doesn't match the signed index");
      }
      await fs.promises.rename(partial, file);
      return file;
    } catch (failure) {
      fs.rmSync(partial, { force: true });
      throw failure;
    }
  }

  /** Download (or find already downloaded) the offered installer. */
  function startDownload() {
    if (!offer?.installer || !install) return Promise.resolve(false);
    if (job && job.version === offer.version) return job.promise;
    if (job) job.controller.abort();
    const current = offer;
    const controller = new AbortController();
    phase = 'downloading';
    error = null;
    readyFile = null;
    progress = null; // checking a download already there, if any
    const promise = (async () => {
      try {
        const file = (await verified(current.installer)) || (await fetchInstaller(current, controller.signal));
        if (offer !== current) return false;
        readyFile = file;
        phase = 'ready';
        progress = null;
        clearDownloads({ keep: path.basename(file) });
        if (saved().ready?.version !== current.version) save({ ready: { version: current.version, at: new Date(now()).toISOString() } });
        return true;
      } catch (failure) {
        if (offer !== current || controller.signal.aborted) return false;
        phase = 'error';
        progress = null;
        error = failure.message || String(failure);
        warn(`[update] Atmos ${current.version}: ${error}`);
        return false;
      } finally {
        if (job?.controller === controller) job = null;
        changed();
      }
    })();
    job = { version: current.version, controller, promise };
    changed();
    return promise;
  }

  /**
   * What the sources' newest signed "core" entry offers after a check
   * (extension-manager status().core.offer): { version, installer, source },
   * or null when nothing newer than this Atmos is named. `answered` lists
   * the sources that answered that check: an offer stands until its own
   * source answers without it (or something newer comes), so being offline,
   * or another source answering, doesn't throw a download away. A newer
   * version with an installer for this platform downloads at once when
   * "Update Atmos automatically" is on.
   */
  function consider(core, { answered = null } = {}) {
    const newer = core && isValidVersion(core.version) && isValidVersion(appVersion) && compareVersions(core.version, appVersion) > 0;
    const installer = newer ? readInstallerEntry(core.installer, { platform, arch }) : null;
    const next = newer ? { version: core.version, installer, source: typeof core.source === 'string' ? core.source : null } : null;
    if (next && !next.source) next.installer = null;
    const heard = answered ? new Set(answered) : null;
    if (offer && heard && !heard.has(offer.source) && (!next || compareVersions(next.version, offer.version) <= 0)) {
      return job?.promise || Promise.resolve(phase === 'ready');
    }
    const same = offer && next && offer.version === next.version && offer.installer?.sha256 === next.installer?.sha256 && offer.source === next.source;
    if (same) {
      // Checked again: a download that failed is tried again.
      if (['idle', 'error'].includes(phase) && offer.installer && install && auto()) return startDownload();
      return job?.promise || Promise.resolve(phase === 'ready');
    }
    if (job) job.controller.abort();
    job = null;
    const withdrawn = !!offer && !next;
    offer = next;
    phase = 'idle';
    progress = null;
    error = null;
    readyFile = null;
    // Only an offer its own source withdrew takes its download with it (at
    // a start, with no offer yet, an unreachable source says nothing).
    if (withdrawn) clearDownloads();
    changed();
    if (offer?.installer && install && auto()) return startDownload();
    return Promise.resolve(false);
  }

  /** The arguments the installer runs with. */
  const installerArgs = ({ relaunch }) => ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])];

  /** The downloaded installer, checked once more. Throws if it isn't ready or no longer matches. */
  function checkReady() {
    if (phase !== 'ready' || !readyFile || !offer?.installer || !install) throw new Error('No update is ready to install');
    let matches = false;
    try {
      matches = fs.statSync(readyFile).size === offer.installer.size && hashFileSync(readyFile) === offer.installer.sha256;
    } catch { matches = false; }
    if (!matches) {
      phase = 'error';
      error = 'The downloaded installer changed since it was checked';
      readyFile = null;
      changed();
      throw new Error(error);
    }
    return true;
  }

  /** Check the downloaded installer once more and start it. Throws if it can't. */
  function runInstaller({ relaunch }) {
    checkReady();
    save({ attempt: { version: offer.version, from: appVersion, at: new Date(now()).toISOString(), relaunch }, startFailed: null });
    try {
      spawnInstaller(readyFile, installerArgs({ relaunch }));
    } catch (failure) {
      // Kept, so Settings can say why after Atmos starts again.
      save({ attempt: null, startFailed: { version: offer.version, message: failure.message, at: new Date(now()).toISOString() } });
      throw failure;
    }
    return true;
  }

  /** "Restart to update": install now and start Atmos again. The caller quits. */
  function installNow() {
    return runInstaller({ relaunch: true });
  }

  /**
   * Atmos is quitting: install a downloaded update, without starting Atmos
   * again, when updating automatically, on a per-user install, and not
   * after this version already failed once. Never throws.
   */
  function installOnQuit() {
    if (phase !== 'ready' || !install || install.perMachine || !auto()) return false;
    if (failedVersion() === offer?.version) return false;
    try {
      return runInstaller({ relaunch: false });
    } catch (failure) {
      warn(`[update] not installed on quit: ${failure.message}`);
      return false;
    }
  }

  /**
   * The version to remind about, once: downloaded, still not installed two
   * days later, updating automatically. Recorded, so it's said only once.
   */
  function nudgeDue() {
    if (phase !== 'ready' || !install || !auto() || !offer) return null;
    const { ready, nudged } = saved();
    const at = Date.parse(ready?.at || '');
    if (ready?.version !== offer.version || !Number.isFinite(at) || now() - at < NUDGE_AFTER_MS || nudged === offer.version) return null;
    save({ nudged: offer.version });
    return offer.version;
  }

  /** Whether quitting now would install (Restart to apply uses it). */
  function wouldInstallOnQuit() {
    return phase === 'ready' && !!install && !install.perMachine && auto() && failedVersion() !== offer?.version;
  }

  function setAuto(on) {
    save({ auto: on === true });
    if (on === true && offer?.installer && install && phase === 'idle') void startDownload();
    changed();
    return state();
  }

  /** What Settings shows. */
  function state() {
    return {
      current: appVersion,
      auto: auto(),
      canInstall: !!install,
      perMachine: !!install?.perMachine,
      version: offer?.version || null,
      installable: !!(offer?.installer && install),
      phase: offer ? phase : 'idle',
      progress: phase === 'downloading' ? progress : null,
      error: phase === 'error' ? error : null,
      failedBefore: !!offer && failedVersion() === offer.version,
      // The installer couldn't be started last time (missing, blocked).
      startFailed: offer && saved().startFailed?.version === offer.version ? saved().startFailed.message : null,
      installsOnQuit: wouldInstallOnQuit(),
      justInstalled,
    };
  }

  return { startup, consider, download: startDownload, checkReady, installNow, installOnQuit, wouldInstallOnQuit, nudgeDue, setAuto, state };
}

module.exports = { createAtmosUpdater, readInstallerEntry, spawnDetached, hashFile, hashFileSync, INSTALLER_NAME, MAX_INSTALLER_BYTES, NUDGE_AFTER_MS };

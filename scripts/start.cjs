#!/usr/bin/env node
// `npm start`: Atmos from this folder, stopped the way closing its window
// stops it.
//
// Electron's own launcher (`electron .`) answers Ctrl+C by killing Atmos
// outright, and on Windows that's TerminateProcess: browser pages never get
// their last events, and Discord, which writes its sign-in back as its page
// closes, comes back signed out. Here Ctrl+C, closing the terminal, or a
// polite kill asks Atmos's window to close instead (taskkill without /F on
// Windows sends it WM_CLOSE; elsewhere SIGTERM, which Electron turns into a
// normal quit). A second Ctrl+C stops it at once.
//
// Usage: npm start [-- <Atmos arguments>]
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron');
const repo = path.resolve(__dirname, '..');

/**
 * The installed Atmos encrypts its cookie store (package.json "build"
 * "electronFuses"), and `npm start` uses the same profile, so the Electron
 * here must too: one without the fuse can't read encrypted cookies (every
 * sign-in gone) and writes plain ones. Electron's own binary, flipped once
 * (again after `npm install` replaces it). The setting can't be undone
 * without losing the cookies, as in the installed Atmos.
 */
async function encryptCookies() {
  const fs = require('fs');
  const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const ENABLED = 49; // FuseState.ENABLE ('1')
  const wire = await getCurrentFuseWire(electron);
  if (wire[FuseV1Options.EnableCookieEncryption] === ENABLED) return;
  const fuses = { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true };
  if (process.platform === 'darwin') {
    // The app bundle in place, re-signed ad hoc (Apple silicon kills an
    // app whose signature no longer matches).
    await flipFuses(electron, { ...fuses, resetAdHocDarwinSignature: true });
  } else {
    // A copy flipped, then put in its place: a stop halfway leaves the
    // original as it was.
    const copy = `${electron}.fuse-tmp`;
    fs.copyFileSync(electron, copy);
    try {
      await flipFuses(copy, fuses);
      fs.renameSync(copy, electron);
    } finally {
      fs.rmSync(copy, { force: true });
    }
  }
  console.log('start: Electron here now encrypts cookies, as the installed Atmos does');
}

function launch() {
  return spawn(electron, [repo, ...process.argv.slice(2)], { cwd: repo, stdio: 'inherit', windowsHide: false });
}

let child = null;
let closed = false;
let stopRequested = false;
encryptCookies().catch(error => {
  // Started without it, an encrypted profile looks signed out: stop instead.
  const busy = /EBUSY|EPERM|EACCES/.test(error.code || error.message) ? ' (is Atmos already running from here? Quit it first)' : '';
  console.error(`start: couldn't turn on cookie encryption in ${electron}${busy}: ${error.message}`);
  process.exit(1);
}).then(() => {
  if (stopRequested) process.exit(130);
  child = launch();
  child.on('close', (code, signal) => {
    closed = true;
    if (code === null) console.error(`Atmos stopped by ${signal}`);
    process.exit(code ?? 1);
  });
});

let asked = false;
function stop() {
  // Still flipping the fuse: stop once that's done, not halfway through it.
  if (!child) { stopRequested = true; return; }
  if (closed) return;
  if (asked) {
    child.kill('SIGKILL');
    return;
  }
  asked = true;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(signal, stop); } catch { /* not on this platform */ }
}

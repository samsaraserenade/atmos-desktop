// A throwaway home for an end-to-end run, so the checks never touch your real
// Atmos settings, approvals or installed extensions.
//
// Atmos finds its install folder from HOME / XDG_CONFIG_HOME on Linux and
// HOME on macOS, and Electron's user-data folder follows the same variables.
// On Windows both come from the real roaming AppData folder, which an
// environment variable cannot fully redirect, so the checks refuse to run
// there: use WSL or a Linux/macOS machine.
const fs = require('fs'), os = require('os'), path = require('path');

function isolatedEnv(prefix) {
  if (process.platform === 'win32') {
    console.error('scripts/e2e: run these on Linux/macOS or in WSL; on Windows they would use your real %APPDATA%\\atmos.');
    process.exit(2);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const installRoot = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'atmos')
    : path.join(home, '.config', 'atmos');
  fs.mkdirSync(installRoot, { recursive: true });
  return { home, installRoot, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } };
}

/**
 * An extension's saved atmos.state (Atmos 0.12 keeps each in a file of its
 * own in user data, which is the install folder here), or null.
 */
function savedFrameState(installRoot, kind, id) {
  try { return JSON.parse(fs.readFileSync(path.join(installRoot, 'extension-state', `${kind}-${id}.json`), 'utf8')).data ?? null; }
  catch { return null; }
}

/** Forget an extension's saved atmos.state, as if it had never run in frames. */
function forgetFrameState(installRoot, kind, id) {
  fs.rmSync(path.join(installRoot, 'extension-state', `${kind}-${id}.json`), { force: true });
}

/**
 * The Atmos window's page. Not app.firstWindow(): Atmos also opens hidden
 * pages of its own at startup (moving or cleaning up extension storage),
 * which Playwright lists as windows too, and they close again.
 */
async function atmosWindow(app, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const page = app.windows().find(w => !w.isClosed() && w.url().startsWith('atmos-app://local/index.html'));
    if (page) return page;
    if (Date.now() > deadline) throw new Error('the Atmos window did not open');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

module.exports = { isolatedEnv, savedFrameState, forgetFrameState, atmosWindow };

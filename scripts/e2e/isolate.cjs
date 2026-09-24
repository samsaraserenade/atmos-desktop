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

module.exports = { isolatedEnv };

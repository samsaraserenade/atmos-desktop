'use strict';
/**
 * `npm run build:personal`: a Windows installer with every extension in this
 * checkout, for your own everyday Atmos. `npm run build` stays the release
 * build (only what release.json lists).
 *
 * Same app as the release (same install folder and %APPDATA%\atmos), so
 * installing either replaces the other; only the installer's file name
 * differs: dist/Atmos Personal Setup <version>.exe.
 *
 * On Linux (or with --linux) it is an AppImage instead, the same way:
 * dist/Atmos-Personal-<version>.AppImage, sharing ~/.config/atmos with the
 * release's.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const cli = require.resolve('electron-builder/cli.js');
const rest = process.argv.slice(2);
const linux = rest.includes('--linux') || (process.platform === 'linux' && !rest.includes('--win'));
const target = linux
  ? ['--linux', 'AppImage', '--x64', '-c.appImage.artifactName=Atmos-Personal-${version}.${ext}']
  : ['--win', 'nsis', '--x64', '-c.nsis.artifactName=Atmos Personal Setup ${version}.${ext}'];
const args = [cli, ...target, ...rest.filter(arg => arg !== '--linux' && arg !== '--win')];
const result = spawnSync(process.execPath, args, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, ATMOS_BUILD_ALL: '1' },
});
process.exit(result.status ?? 1);

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const browser = process.env.MATRIX_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = await build({
  entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'fake-host', setup(build) {
    build.onResolve({ filter: /^(atmos-sdk$|.*\/(engine|settings-menu|login|room-view|empty-view|menu-dialogs)\.js$)/ }, () => ({ path: resolve('tests/browser-mocks.js') }));
  } }],
});
const directory = mkdtempSync(join(tmpdir(), 'matrix-chat-browser-'));
try {
  const file = join(directory, 'checks.html');
  writeFileSync(file, '<!doctype html><body>RUNNING<script type="module">' + output.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  // --out <file>: write the page for another browser (e.g. Playwright's Chromium) and stop.
  const outAt = process.argv.indexOf('--out');
  if (outAt !== -1) {
    writeFileSync(process.argv[outAt + 1], readFileSync(file));
    console.log('Wrote', process.argv[outAt + 1]);
    process.exit(0);
  }
  const result = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--user-data-dir=' + join(directory, 'profile'), '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (!result.stdout?.includes('PASS:')) throw new Error(result.stdout || result.stderr || String(result.error));
  console.log(result.stdout.match(/PASS:[^<]+/)[0]);
} finally {
  // This is the unique temporary directory created above, never a user profile.
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* browser may still hold its disposable profile */ }
}

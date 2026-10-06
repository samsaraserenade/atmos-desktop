// Atmos in the Atmos session on Linux (linux/atmos-run sets ATMOS_SESSION=1):
// the session starts Atmos again when it exits with 75, and ends when it
// exits with 0. So Restart to apply (the extensions' restart) exits with 75
// and starts no second Atmos itself; quitting exits with 0. Without
// ATMOS_SESSION, Restart to apply still exits with 0 (app.relaunch starts
// the next one).
// Usage: node scripts/e2e/session.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'session'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-session-');
const noBundled = path.join(home, 'no-bundled');
fs.mkdirSync(noBundled);

const checks = {};
const details = {};
const check = (name, ok, detail) => { checks[name] = !!ok; if (!ok && detail !== undefined) details[name] = detail; };

/** Start Atmos, wait for it, do `act` on its page, and resolve its exit code. */
async function exitCode(extraEnv, act) {
  const app = await electron.launch({
    executablePath: ELECTRON, args: [repo, `--extensions-root=${noBundled}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env: { ...env, ...extraEnv },
  });
  const page = await atmosWindow(app);
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  const exited = new Promise(resolve => app.process().once('exit', code => resolve(code)));
  await act(page, app).catch(() => {});
  const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still running'), 20000))]);
  await app.close().catch(() => {});
  return code;
}

(async () => {
  try {
    const restart = page => page.evaluate(() => window.atmosCore.restartAtmos());
    const quit = (_page, app) => app.evaluate(({ app: electronApp }) => electronApp.quit());
    const inSessionRestart = await exitCode({ ATMOS_SESSION: '1' }, restart);
    check('in the session, Restart to apply exits with 75 for the session to start Atmos again', inSessionRestart === 75, inSessionRestart);
    const inSessionQuit = await exitCode({ ATMOS_SESSION: '1' }, quit);
    check('in the session, quitting exits with 0 (the session ends)', inSessionQuit === 0, inSessionQuit);
    const outside = await exitCode({}, restart);
    check('outside it, Restart to apply exits with 0 (app.relaunch starts the next)', outside === 0, outside);
    // The Atmos app.relaunch started: found by its arguments (this run's
    // folder) once it's up, and stopped, with whatever it started.
    const { spawnSync } = require('child_process');
    const running = () => spawnSync('pgrep', ['-f', noBundled]).status === 0;
    let relaunched = false;
    for (let i = 0; i < 100 && !relaunched; i++) { relaunched = running(); if (!relaunched) await new Promise(resolve => setTimeout(resolve, 200)); }
    await new Promise(resolve => setTimeout(resolve, 2000));
    for (let i = 0; i < 20 && running(); i++) { spawnSync('pkill', ['-9', '-f', noBundled]); await new Promise(resolve => setTimeout(resolve, 250)); }
    check('…and it did start the next one', relaunched, relaunched);
  } catch (error) {
    details.error = error.stack || String(error);
  }
  const total = Object.keys(checks).length;
  const passed = Object.values(checks).filter(Boolean).length;
  const report = { summary: `${passed}/${total} checks passed`, failed: Object.keys(checks).filter(name => !checks[name]), details };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(passed === total && total > 0 && !details.error ? 0 : 1);
})();

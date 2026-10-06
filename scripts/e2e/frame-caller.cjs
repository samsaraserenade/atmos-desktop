// A main.cjs knows which frame called it, and hears when that frame goes
// (R17): every call comes through the Atmos page, so event.sender is the
// page whichever frame asked. A bundled probe's main.cjs records each
// calling frame (event.callerFrame) and its 'destroyed'; its panel calls,
// reloads (the old document goes), and calls again.
// Usage: node scripts/e2e/frame-caller.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'frame-caller'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-frame-caller-');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Bundled with this run only (--extensions-root), so its main.cjs runs.
const bundled = path.join(home, 'bundled');
const probe = path.join(bundled, 'plugins', 'caller-probe');
fs.mkdirSync(path.join(bundled, 'services'), { recursive: true });
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 4, displayName: 'Caller Probe', permissions: { ipc: true }, contributes: { panel: { label: 'Caller Probe' } },
}));
fs.writeFileSync(path.join(probe, 'main.cjs'), `
module.exports = context => {
  const log = [];
  context.handle('hello', event => {
    const frame = event.callerFrame;
    if (!frame) return null;
    if (!log.some(entry => entry.id === frame.id)) {
      const entry = { id: frame.id, destroyed: false };
      log.push(entry);
      frame.once('destroyed', () => { entry.destroyed = true; });
    }
    return frame.id;
  });
  context.handle('log', () => log);
};
`);
fs.writeFileSync(path.join(probe, 'panel.js'), `
import atmos from 'atmos-sdk';
window.__id = await atmos.invoke('plugin:caller-probe', 'hello');
`);

(async () => {
  const r = { home };
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${bundled}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await atmosWindow(app);
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('caller-probe'));
  const panel = async () => {
    for (let i = 0; i < 100; i++) {
      const frame = page.frames().find(f => f.url().includes('ext=plugin%3Acaller-probe') && f.url().includes('surface=panel'));
      const id = frame && await frame.evaluate(() => window.__id).catch(() => undefined);
      if (id) return { frame, id };
      await wait(100);
    }
    return {};
  };
  const log = () => page.evaluate(() => window.atmosCore.invokeExtensionAs('plugin:caller-probe', 'plugin', 'caller-probe', 'log'));
  const first = await panel();
  r.first = first.id ?? null;
  r.logBefore = await log();
  await first.frame?.evaluate(() => location.reload()).catch(() => {});
  await wait(500);
  const second = await panel();
  r.second = second.id ?? null;
  await wait(300);
  r.logAfter = await log();
  await app.close();
  const entry = id => r.logAfter.find(item => item.id === id);
  r.ok = !!r.first && !!r.second && r.first !== r.second
    && r.logBefore.length === 1 && r.logBefore[0].destroyed === false
    && entry(r.first)?.destroyed === true && entry(r.second)?.destroyed === false;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });

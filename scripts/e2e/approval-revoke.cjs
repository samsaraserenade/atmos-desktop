// Removing a community extension's approval stops it at once:
//
//  1. Approved, it loads without a restart: its panel, its sidebar widget
//     and its background frame are running (a counter the background frame
//     keeps ticking proves it), and the background frame plays a looping
//     tone on its audio channel.
//  2. Remove approval in Settings: every frame of it goes, its widget
//     leaves the sidebar, its panel says it stopped, its files are no
//     longer served, the counter stops, its audio stops (R37), and its card
//     says so with no "Restart to apply".
//  3. Approve again: "Approved again. It starts when Atmos restarts."
//  4. After a restart it runs again.
// Usage: node scripts/e2e/approval-revoke.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'approval-revoke'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-revoke-');

const probe = path.join(installRoot, 'plugins', 'stop-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 4, version: '1.0.0', publisher: 'someone', displayName: 'Stop Probe',
  permissions: { invokes: ['service:audio'] },
  contributes: { panel: { label: 'Stop Probe' }, sidebar: [{ label: 'Stop Probe widget' }], boot: {} },
}));
fs.writeFileSync(path.join(probe, 'panel.js'), "document.body.innerHTML = '<p style=\"padding:40px;font-size:24px\">Stop Probe panel</p>';\n");
fs.writeFileSync(path.join(probe, 'sidebar.js'), "document.body.innerHTML = '<p style=\"padding:8px\">Stop Probe widget</p>';\n");
fs.writeFileSync(path.join(probe, 'boot.js'), `import atmos from 'atmos-sdk';
let n = 0;
setInterval(() => { n += 1; atmos.state.set({ ticks: n }); }, 300);
// A second of a 440 Hz tone, looping.
const rate = 22050, samples = rate;
const bytes = new Uint8Array(44 + samples * 2);
const view = new DataView(bytes.buffer);
const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), true);
atmos.audio.load(new Blob([bytes], { type: 'audio/wav' }), { id: 'tone', loop: true, play: true }).catch(error => console.warn('stop-probe audio:', error.message));
`);

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const page = await atmosWindow(app);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page };
}
const status = page => page.evaluate(async () => {
  const p = (await window.atmosCore.listPlugins()).find(e => e.id === 'stop-probe');
  return p ? `${p.status}/${p.active ? 'active' : 'off'}${p.stoppedNow ? '/stopped' : ''}${p.approvalChanged ? '/changed' : ''}` : null;
});
const frames = page => page.evaluate(async () => (await import('atmos-core/core/extension-frame-host.js')).listExtensionFrames()
  .find(item => item.extension === 'plugin:stop-probe')?.frames ?? 0);
// What its background frame last saved (written to disk shortly after each change).
const ticks = page => page.evaluate(async () => {
  const all = await window.atmosCore.extensionState.loadAll();
  const entry = all?.['plugin:stop-probe'] ?? all?.['plugin-stop-probe'] ?? Object.entries(all || {}).find(([k]) => k.includes('stop-probe'))?.[1];
  return entry?.data?.ticks ?? entry?.ticks ?? null;
}).catch(() => null);
const widget = page => page.evaluate(() => [...document.querySelectorAll('.fin-section-name')].some(el => /Stop Probe widget/.test(el.textContent)));
// Whether its audio channel (in the Atmos page's Audio service) is playing.
const playing = page => page.evaluate(async () => (await import('atmos-core/core/renderer-capabilities.js')).getCapability('media.audio')
  ?.listChannels().find(item => item.owner === 'plugin:stop-probe')?.playing ?? null);

const r = { home };
(async () => {
  // 1. Approve: it loads now.
  let s = await launch();
  r['1-before'] = await status(s.page);
  r['1-approve'] = await s.page.evaluate(async () => {
    const p = (await window.atmosCore.listPlugins()).find(e => e.id === 'stop-probe');
    const result = await window.atmosCore.approveExtension('plugin', 'stop-probe', p.fingerprint);
    return result.loaded.map(item => item.id);
  });
  await s.page.waitForTimeout(1500);
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('stop-probe'));
  await s.page.evaluate(() => document.getElementById('settings-drawer')?.classList.add('open'));
  await s.page.waitForTimeout(1500);
  r['1-running'] = { status: await status(s.page), frames: await frames(s.page), widget: await widget(s.page), ticks: await ticks(s.page), playing: await playing(s.page) };
  await s.page.screenshot({ path: path.join(out, '10-running.png') });

  // 2. Remove approval from its card in Settings.
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionCard('plugin', 'stop-probe'));
  await s.page.waitForSelector('.sm-extension-card[data-key="plugin:stop-probe"] [data-trust-action="revoke"]', { state: 'attached', timeout: 10000 });
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"] [data-trust-action="revoke"]').click());
  await s.page.waitForFunction(() => /It has stopped/.test(document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"]')?.textContent || ''), null, { timeout: 10000 });
  r['2-card'] = await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"] .sm-extension-trust')?.innerText.replace(/\s+/g, ' ').trim());
  r['2-restartButton'] = await s.page.evaluate(() => !!document.querySelector('[data-manager-action="restart"]'));
  await s.page.screenshot({ path: path.join(out, '20-card.png') });
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());
  await s.page.waitForTimeout(2000); // the last save lands
  const t1 = await ticks(s.page);
  await s.page.waitForTimeout(2500);
  const t2 = await ticks(s.page);
  r['2-ticks'] = [t1, t2];
  r['2-stopped'] = {
    status: await status(s.page), frames: await frames(s.page), widget: await widget(s.page),
    note: await s.page.evaluate(() => document.querySelector('.atmos-extension-stopped')?.textContent || null),
    ticksStill: t1 !== null && t1 === t2,
    playing: await playing(s.page),
    served: await s.page.evaluate(async () => {
      const p = (await window.atmosCore.listPlugins()).find(e => e.id === 'stop-probe');
      try { return (await fetch(`${p.frame.origin}/panel.js`)).status; } catch (error) { return 'refused'; }
    }),
  };
  await s.page.screenshot({ path: path.join(out, '21-stopped.png') });

  // 3. Approve again: at the next start.
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openExtensionCard('plugin', 'stop-probe'));
  await s.page.waitForSelector('.sm-extension-card[data-key="plugin:stop-probe"] [data-trust-action="approve"]', { state: 'attached', timeout: 10000 }).catch(() => {});
  r['3-approveVisible'] = await s.page.evaluate(() => !!document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"] [data-trust-action="approve"]'));
  await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"] [data-trust-action="approve"]').click());
  await s.page.waitForFunction(() => /Approved again/.test(document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"]')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  r['3-card'] = await s.page.evaluate(() => document.querySelector('.sm-extension-card[data-key="plugin:stop-probe"] .sm-extension-trust')?.innerText.replace(/\s+/g, ' ').trim());
  r['3-status'] = await status(s.page);
  await s.page.screenshot({ path: path.join(out, '30-approved-again.png') });
  await s.app.close();

  // 4. After a restart it runs.
  s = await launch();
  await s.page.waitForTimeout(1500);
  r['4-after'] = { status: await status(s.page), frames: await frames(s.page) };
  await s.app.close();

  r.ok = r['1-approve'].includes('stop-probe') && r['1-running'].status === 'approved/active' && r['1-running'].frames >= 2 && r['1-running'].widget
    && /It has stopped/.test(r['2-card'] || '') && !r['2-restartButton']
    && r['2-stopped'].frames === 0 && !r['2-stopped'].widget && /Stop Probe stopped/.test(r['2-stopped'].note || '')
    && r['1-running'].ticks > 0 && r['2-stopped'].ticksStill && r['1-running'].playing === true && r['2-stopped'].playing !== true && r['3-approveVisible'] && /Approved again/.test(r['3-card'] || '') && r['2-stopped'].served !== 200 && /off\/stopped/.test(r['2-stopped'].status)
    && r['4-after'].status === 'approved/active' && r['4-after'].frames >= 1;
})().catch(error => { r.error = error.stack || String(error); }).finally(() => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error || !r.ok ? 1 : 0);
});

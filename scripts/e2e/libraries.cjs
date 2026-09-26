// Library services end to end: Currency and Media Metadata imported into a
// sandboxed frame, Audio Player using Media Metadata from its own frame,
// and the libraries listed under Settings → Services. (Finance's display
// currency is checked in finance.cjs.)
// Usage: node scripts/e2e/libraries.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'libraries'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-libraries-');

// A tagged MP3: an ID3v2.3 header with a TIT2 (title) frame, then a few
// bytes of MPEG frame header.
const title = 'Library Probe Song';
const text = Buffer.concat([Buffer.from([0]), Buffer.from(title, 'latin1')]);
const frameHeader = Buffer.alloc(10);
frameHeader.write('TIT2', 0, 'latin1');
frameHeader.writeUInt32BE(text.length, 4);
const body = Buffer.concat([frameHeader, text]);
const size = body.length;
const tagHeader = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
  (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
const song = path.join(home, 'probe.mp3');
fs.writeFileSync(song, Buffer.concat([tagHeader, body, Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(512)]));

// A third-party plugin that imports both libraries into its frame.
const probe = path.join(installRoot, 'plugins', 'library-probe');
fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(probe, 'extension.json'), JSON.stringify({
  apiVersion: 3,
  displayName: 'Library Probe',
  permissions: { invokes: ['service:currency', 'service:media-metadata'] },
  contributes: { panel: { label: 'Library Probe' } },
}));
fs.writeFileSync(path.join(probe, 'panel.js'), `
import atmos from 'atmos-sdk';
const results = window.__results = {};
try {
  const converter = await import(await atmos.library('service:currency', 'converter.js'));
  const rates = await import(await atmos.library('service:currency', 'rates.js'));
  results.currencyExports = Object.keys(converter).sort().join(',');
  results.ratesReady = rates.ratesReady();
  results.toGbp = converter.convertToGbp(10, 'GBP');
  results.fromGbpBeforeRates = converter.convertFromGbp(10, 'USD');
  results.symbol = converter.symbolForIso('EUR');
} catch (error) { results.currency = 'ERR ' + error.message; }
try {
  const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
  results.coverWithoutInvoke = (await metadata.writeCoverArt('/nope.mp3', 'AA==', 'image/png')).error;
  results.titleWithoutInvoke = (await metadata.readTags(${JSON.stringify(song)})).title ?? null;
  metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));
  const tags = await metadata.readTags(${JSON.stringify(song)});
  results.title = tags.title ?? null;
} catch (error) { results.metadata = 'ERR ' + error.message; }
results.done = true;
`);

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|VPS unavailable/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const frameFor = (page, ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`));

(async () => {
  const r = { home };

  // 1. Approve the probe.
  let s = await launch();
  await s.page.evaluate(async () => {
    const plugin = (await window.atmosCore.listPlugins()).find(p => p.id === 'library-probe');
    await window.atmosCore.approveExtension('plugin', plugin.id, plugin.fingerprint);
    const persist = await import('atmos-core/persist.js');
    persist.flushPendingSave();
  });
  await s.app.close();

  // 2. Libraries in the Atmos page.
  s = await launch();
  await s.page.waitForTimeout(1500);
  r.panels = await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).listPanelPlugins().map(p => p.id));
  // Audio Player (framed) hands Media Metadata atmos.invoke in its background frame.
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('audio-player'));
  await s.page.waitForTimeout(2000);
  const audioBoot = s.page.frames().find(f => f.url().includes('ext=plugin%3Aaudio-player') && f.url().includes('surface=boot'));
  r.audioPlayerTags = await audioBoot?.evaluate(async path => {
    const metadata = await import(new URL('/plugins/audio-player/src/media-metadata.js', location.href).href);
    return metadata.readTags(path).then(tags => tags.title ?? null);
  }, song).catch(e => `ERR ${e.message}`);

  // Settings → Services still lists the libraries, with no settings pages of their own.
  await s.page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
  await s.page.waitForTimeout(500);
  await s.page.getByText('Services', { exact: true }).first().click();
  await s.page.waitForTimeout(1000);
  r.servicesPage = await s.page.evaluate(() => {
    const text = [...document.querySelectorAll('.settings-overlay, [role="dialog"], body')].map(el => el.innerText).join('\n');
    return Object.fromEntries(['Currency', 'Media Metadata', 'Charting'].map(name => [name, text.includes(name)]));
  });
  await s.page.screenshot({ path: path.join(out, '81-services.png') });
  await s.page.keyboard.press('Escape');

  // 3. Both libraries inside a sandboxed frame.
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('library-probe'));
  let panel;
  for (let i = 0; i < 50 && !(panel = frameFor(s.page, 'plugin:library-probe', 'panel')); i++) await s.page.waitForTimeout(100);
  await panel?.waitForFunction(() => window.__results?.done === true, null, { timeout: 15000 }).catch(() => {});
  r.probe = await panel?.evaluate(() => window.__results).catch(e => e.message) ?? 'no panel frame';
  r.errors = s.errors;
  await s.app.close();

  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

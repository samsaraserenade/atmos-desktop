// SDK 1.1's system-service and surface changes, from a developer folder:
// an audio channel that loops (silence measured at the loop point, against
// the seek(0)-and-play() workaround it replaces), the audio id reported
// back; a wallpaper set by the extension, shown in Settings as its own and
// restored there; a settings page and a widget with an html, body { height:
// 100% } reset that still size to their content (and shrink); a widget
// whose content is all out of the flow warning in its console; and
// /__atmos/ui.css styling a settings row like Atmos's own.
// Usage: node scripts/e2e/system-services.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'system-services'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-system-services-');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 15000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(every);
  }
}

// The probe: a panel (audio, wallpaper), two widgets and a settings page.
const probe = path.join(home, 'dev', 'sky-probe');
fs.mkdirSync(probe, { recursive: true });
const files = {
  'extension.json': JSON.stringify({
    apiVersion: 4, engines: { atmos: '>=0.16.0' }, version: '0.1.0', displayName: 'Sky Probe',
    contributes: {
      panel: { label: 'Sky Probe' },
      sidebar: [{ label: 'Sky Widget', showIn: [] }, { id: 'ghost', entry: 'ghost.js', label: 'Ghost', showIn: [] }],
      settings: { label: 'Sky Probe' },
    },
    permissions: { invokes: ['service:audio', 'service:wallpaper'] },
  }, null, 2),
  // The reset that hid Skyloom's settings page, and Atmos's Settings rows.
  'reset.css': '@import url("/__atmos/ui.css");\nhtml, body { height: 100%; margin: 0; }\n',
  'settings.js': [
    '// Relative to the module: the document itself is /__atmos/frame.html.',
    "document.head.insertAdjacentHTML('beforeend', `<link rel=\"stylesheet\" href=\"${new URL('./reset.css', import.meta.url)}\">`);",
    "document.body.innerHTML = `<section class=\"atmos-section\">",
    "  <div class=\"atmos-row\"><span class=\"atmos-label\">Stars <small>Shown over the sky</small></span>",
    "  <span class=\"atmos-control\"><input type=\"checkbox\" class=\"atmos-switch\" checked aria-label=\"Stars\"></span></div>",
    "  <div class=\"atmos-row\"><span class=\"atmos-label\">Speed</span>",
    "  <span class=\"atmos-control\"><span class=\"atmos-slider\"><input type=\"range\" class=\"atmos-range\" value=\"40\"><output>40%</output></span></span></div>",
    "  <div class=\"atmos-row\"><span class=\"atmos-label\">Palette</span>",
    "  <span class=\"atmos-control\"><select class=\"atmos-select\"><option>Dusk</option></select><button class=\"atmos-button\">Reset</button></span></div>",
    '</section>`;',
  ].join('\n'),
  'sidebar.js': [
    "import atmos from 'atmos-sdk';",
    "document.head.insertAdjacentHTML('beforeend', `<link rel=\"stylesheet\" href=\"${new URL('./reset.css', import.meta.url)}\">`);",
    "document.body.innerHTML = '<div id=\"box\" style=\"height:40px\">box</div>';",
    "const apply = state => { document.getElementById('box').style.height = state.tall ? '120px' : '40px'; };",
    'apply(await atmos.state.get());',
    'atmos.state.onChange(apply);',
  ].join('\n'),
  // Everything out of the flow: 0 px tall, so the SDK warns.
  'ghost.js': "document.body.innerHTML = '<div style=\"position:absolute;top:0;left:0;height:50px;width:100px\">floating</div>';",
  'panel.js': [
    "import atmos from 'atmos-sdk';",
    '// A second of a 440 Hz tone: a loop point shows as samples near zero.',
    'function tone(seconds = 1, rate = 22050) {',
    '  const samples = Math.round(seconds * rate);',
    '  const bytes = new Uint8Array(44 + samples * 2);',
    '  const view = new DataView(bytes.buffer);',
    "  const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));",
    "  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');",
    '  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);',
    "  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);",
    '  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), true);',
    "  return new Blob([bytes], { type: 'audio/wav' });",
    '}',
    'window.__tone = tone;',
    'window.__atmos = atmos;',
    'window.__ready = true;',
    "document.body.textContent = 'Sky Probe panel';",
  ].join('\n'),
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(probe, name), text);

/**
 * Silence in the Atmos page's audio element for this extension, while it
 * plays: the longest run of near-zero output (ms) once sound has started,
 * and how many runs, over `ms`. Read from the element's own output
 * (createMediaElementSource, once per element: its sound goes through this
 * meter for the rest of the run), so no sound card is needed. Not
 * captureStream(), whose tracks show ~100 ms of silence at every loop point
 * that the element's output doesn't have.
 */
async function measureSilence(page, ms) {
  return page.evaluate(async duration => {
    const element = document.querySelector('audio[data-owner="plugin:sky-probe"]');
    if (!element) return { error: 'no audio element' };
    if (!window.__meter) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(element);
      const processor = context.createScriptProcessor(256, 1, 1);
      const meter = { context, blocks: [] };
      processor.onaudioprocess = event => {
        const data = event.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        meter.blocks.push(peak);
      };
      source.connect(processor);
      processor.connect(context.destination);
      window.__meter = meter;
    }
    const meter = window.__meter;
    await meter.context.resume();
    meter.blocks = [];
    await new Promise(resolve => setTimeout(resolve, duration));
    const blocks = meter.blocks;
    const blockMs = 256 / meter.context.sampleRate * 1000;
    const started = blocks.findIndex(peak => peak > 0.05);
    if (started === -1) return { error: 'no sound', blocks: blocks.length };
    let longest = 0, run = 0, gaps = 0;
    for (const peak of blocks.slice(started)) {
      if (peak < 0.01) { run += 1; if (run === 1) gaps += 1; longest = Math.max(longest, run); } else run = 0;
    }
    return { longestSilenceMs: Math.round(longest * blockMs), silences: gaps, blockMs: Math.round(blockMs * 10) / 10, measuredMs: Math.round((blocks.length - started) * blockMs) };
  }, ms);
}

(async () => {
  const noBundled = path.join(home, 'no-bundled');
  fs.mkdirSync(noBundled);
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${noBundled}`, `--dev-extension=${probe}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    cwd: repo, env,
  });
  const page = await atmosWindow(app);
  const errors = [];
  const consoleLines = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => consoleLines.push(message.text()));
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  const frameFor = (surface, extra = '') => page.frames().find(f => f.url().includes('ext=plugin%3Asky-probe') && f.url().includes(`surface=${surface}`) && f.url().includes(extra));
  const r = { home };

  // 1. Audio: loop, and the label back as id.
  await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('sky-probe'));
  const panel = await until(async () => { const frame = frameFor('panel'); return frame && await frame.evaluate(() => window.__ready) ? frame : null; });
  r.loopLoad = await panel.evaluate(async () => {
    const ended = [];
    window.__atmos.audio.onChange(state => { if (state.type === 'ended') ended.push(state.id); });
    window.__ended = ended;
    const loaded = await window.__atmos.audio.load(window.__tone(), { id: 'tone', loop: true, play: true });
    return { id: loaded.id, source: loaded.source, loop: loaded.loop };
  });
  await wait(500);
  r.loop = await measureSilence(page, 3200);
  r.loopState = await panel.evaluate(async () => {
    const state = await window.__atmos.audio.state();
    return { id: state.id, loop: state.loop, playing: state.playing, ended: state.ended, endedEvents: window.__ended.length };
  });
  // The workaround Skyloom used: no loop, seek(0) and play() on 'ended'.
  await panel.evaluate(async () => {
    window.__restarts = 0;
    window.__atmos.audio.onChange(state => {
      if (state.type !== 'ended' || state.id !== 'tone-once') return;
      window.__restarts += 1;
      window.__atmos.audio.seek(0).then(() => window.__atmos.audio.play());
    });
    await window.__atmos.audio.load(window.__tone(), { id: 'tone-once', play: true });
  });
  await wait(500);
  r.workaround = { ...await measureSilence(page, 3200), restarts: await panel.evaluate(() => window.__restarts) };
  await panel.evaluate(() => window.__atmos.audio.stop());

  // 2. Wallpaper: set by the extension, Settings says whose, Restore puts the default back.
  r.wallpaperBefore = await page.evaluate(async () => (await import('/system/wallpaper/engine.js')).imageKind());
  r.wallpaperSet = await panel.evaluate(async () => {
    const canvas = new OffscreenCanvas(64, 36);
    const context = canvas.getContext('2d');
    context.fillStyle = '#335577'; context.fillRect(0, 0, 64, 36);
    await window.__atmos.wallpaper.set(await canvas.convertToBlob({ type: 'image/png' }));
    return window.__atmos.wallpaper.get().then(summary => ({ canRestore: summary.canRestore, mode: summary.mode }));
  });
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsMenu());
  await page.evaluate(() => [...document.querySelectorAll('#settings-menu .sm-nav-item')].find(item => /Appearance/.test(item.textContent))?.click());
  r.wallpaperRow = await until(() => page.evaluate(() => {
    const status = document.querySelector('.wallpaper-image-status')?.textContent;
    const restore = document.querySelector('.wallpaper-restore');
    return status ? { status, restoreShown: !!restore && !restore.hidden, title: restore?.title } : null;
  }));

  // 3. The settings page, with the height: 100% reset: sized to its content.
  const settingsFrame = await until(async () => frameFor('settings'));
  r.settingsHeight = await until(() => page.evaluate(() => {
    const frame = document.querySelector('iframe[data-extension="plugin:sky-probe"].atmos-extension-frame-settings');
    const height = frame?.getBoundingClientRect().height;
    return height > 0 ? Math.round(height) : null;
  }), { timeout: 5000 }) ?? 0;
  r.uiCss = settingsFrame ? await settingsFrame.evaluate(() => {
    const row = getComputedStyle(document.querySelector('.atmos-row'));
    const toggle = getComputedStyle(document.querySelector('.atmos-switch'));
    const label = getComputedStyle(document.querySelector('.atmos-label'));
    return { rowDisplay: row.display, rowPadding: row.padding, switchWidth: toggle.width, switchAppearance: toggle.appearance, labelSize: label.fontSize, bodyHeight: getComputedStyle(document.body).height !== '0px' };
  }) : 'no settings frame';
  // Atmos's own Location row, for comparison.
  r.atmosRow = await page.evaluate(() => {
    const row = document.querySelector('.sa-row');
    return row ? { padding: getComputedStyle(row).padding, labelSize: getComputedStyle(row.querySelector('.sa-label')).fontSize } : null;
  });
  await page.screenshot({ path: path.join(out, '10-appearance.png') });
  await page.evaluate(() => document.querySelector('.wallpaper-restore')?.click());
  r.afterRestore = await until(() => page.evaluate(async () => {
    const kind = (await import('/system/wallpaper/engine.js')).imageKind();
    const status = document.querySelector('.wallpaper-image-status')?.textContent;
    return kind === 'default' && !/Set by/.test(status) ? { kind, status, restoreShown: !document.querySelector('.wallpaper-restore').hidden } : null;
  })) || await page.evaluate(async () => ({ kind: (await import('/system/wallpaper/engine.js')).imageKind(), status: document.querySelector('.wallpaper-image-status')?.textContent }));
  r.canRestoreAfter = await panel.evaluate(() => window.__atmos.wallpaper.get().then(summary => summary.canRestore));
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());

  // 4. The widgets: sized to content (and shrinking), and the one that measures 0 px warns.
  await page.evaluate(async () => (await import('atmos-core/core/sidebar-shell.js')).toggleSidebar?.());
  const widgetHeight = () => page.evaluate(() => Math.round(document.querySelector('iframe[data-extension="plugin:sky-probe"].atmos-extension-frame-sidebar')?.getBoundingClientRect().height ?? -1));
  r.widgetStart = await widgetHeight();
  await panel.evaluate(() => window.__atmos.state.update({ tall: true }));
  r.widgetTall = await until(async () => { const height = await widgetHeight(); return height >= 100 ? height : null; }, { timeout: 5000 }) ?? await widgetHeight();
  await panel.evaluate(() => window.__atmos.state.update({ tall: false }));
  r.widgetShrunk = await until(async () => { const height = await widgetHeight(); return height > 0 && height < 100 ? height : null; }, { timeout: 5000 }) ?? await widgetHeight();
  await wait(1500);
  r.ghostWarning = consoleLines.find(line => /measures 0 px tall/.test(line)) || null;
  await page.screenshot({ path: path.join(out, '20-sidebar.png') });

  r.errors = errors;
  await app.close();
  console.log(JSON.stringify(r, null, 2));
})().catch(error => { console.error(error); process.exit(1); });

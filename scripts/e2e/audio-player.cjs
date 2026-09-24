// Audio Player in frames and the background layer, end to end: the Wallpaper
// service carrying over what Background saved, Audio Player carrying over
// what the in-page version saved, the drawer Atmos moves, playback from the
// Audio service surviving panel switches, Space, menus with controls and
// icons, the three widgets, and state across a restart.
// Usage: node scripts/e2e/audio-player.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { isolatedEnv } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'audio-player'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-audio-');

// Three short tones in <music>/Tester/Test Album.
function wav(file, frequency, seconds = 2.5, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 12000 * (1 - i / samples)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}
const musicRoot = path.join(home, 'music');
const albumDir = path.join(musicRoot, 'Tester', 'Test Album');
fs.mkdirSync(albumDir, { recursive: true });
['one', 'two', 'three'].forEach((name, index) => wav(path.join(albumDir, `${name}.wav`), 330 + index * 110));

function png([r, g, b], size = 32) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|images\.unsplash\.com/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const frameFor = (page, surface, index = 0) => page.frames()
  .filter(f => f.url().includes('ext=plugin%3Aaudio-player') && f.url().includes(`surface=${surface}`))[index] || null;
async function waitFrame(page, surface, index = 0, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const frame = frameFor(page, surface, index);
    if (frame && await frame.evaluate(surface => surface === 'boot' || document.body?.children.length > 0, surface).catch(() => false)) return frame;
    await page.waitForTimeout(150);
  }
  return null;
}
const channelState = page => page.evaluate(async () => (await import('atmos-core/core/renderer-capabilities.js')).getCapability('media.audio')?.channel('plugin:audio-player').state());
const activate = (page, id) => page.evaluate(async id => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin(id), id);
async function widget(page, selector, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of page.frames().filter(f => f.url().includes('ext=plugin%3Aaudio-player') && f.url().includes('surface=sidebar'))) {
      if (await frame.evaluate(selector => !!document.querySelector(selector), selector).catch(() => false)) return frame;
    }
    await page.waitForTimeout(150);
  }
  return null;
}

const r = {};
(async () => {
  r.home = home;
  const albumKey = 'tester|test album';
  const trackKeys = ['Test Album/one.wav', 'Test Album/two.wav', 'Test Album/three.wav'];

  // 1. What the in-page versions left: Background's settings and image,
  //    Audio Player's settings, folders and library in the page.
  let s = await launch();
  await s.page.evaluate(async ({ albumKey, trackKeys, albumDir, musicRoot, image }) => {
    const persist = await import('atmos-core/persist.js');
    await persist.saveAsset('background:wallpaper', new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], { type: 'image/png' }));
    await persist.saveAsset('audio-player:library-meta', {
      albums: { [albumKey]: { album: 'Test Album', artist: 'Tester', year: 2024, cover: null, tracks: [
        { title: 'One', key: trackKeys[0], num: 1 }, { title: 'Two', key: trackKeys[1], num: 2 }, { title: 'Three', key: trackKeys[2], num: 3 },
      ] } },
      folders: [{ name: 'Test Album' }],
    });
    await persist.saveAsset('audio-player:waveform-cache', { [trackKeys[2]]: Array.from({ length: 500 }, (_, i) => (i % 50) / 50) });
    const blob = JSON.parse(localStorage.getItem('samsara_v4') || '{}');
    blob.extensionState ??= {};
    blob.extensionState.background = { version: 2, data: { mode: 'wallpaper', opacity: 100, vignette: 40, brightness: 80 } };
    delete blob.extensionState.wallpaper;
    blob.extensionState['audio-player'] = { version: 2, data: {
      vol: 40, shuffleOn: false, repeatMode: 'all', trackIdx: 0, trackKey: null, trackPos: null,
      seekStyle: 'waveform', waveformFps: 5, audioBarPlacement: 'top', drawerPlacement: 0,
      albumCoverSize: 120, albumCoverSaturation: 100, albumDim: 50, albumGridSort: 'artist',
      electronFolders: [{ name: 'Test Album', path: albumDir, root: 'music', rootPath: musicRoot }],
      seekColor: { mode: 'solid', stops: ['#c084fc', '#818cf8', '#38bdf8'], solid: '#ffffff' },
    } };
    localStorage.setItem('samsara_v4', JSON.stringify(blob));
    Storage.prototype.setItem = () => {}; // nothing else writes before closing
  }, { albumKey, trackKeys, albumDir, musicRoot, image: png([30, 90, 200]).toString('base64') });
  // This run already started the framed Audio Player, which copied nothing
  // yet and marked the copy done; clear that, as if starting for the first time.
  const setupBoot = await waitFrame(s.page, 'boot');
  await setupBoot?.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('audio-player', 1);
    request.onsuccess = () => {
      const transaction = request.result.transaction('assets', 'readwrite');
      transaction.objectStore('assets').clear();
      transaction.oncomplete = () => resolve(true);
    };
    request.onerror = () => resolve(false);
  })).catch(() => {});
  await s.app.close();

  // 2. The background layer and framed Audio Player.
  s = await launch();
  r.list = await s.page.evaluate(async () => {
    const plugins = await window.atmosCore.listPlugins();
    const services = await window.atmosCore.listServices();
    const player = plugins.find(p => p.id === 'audio-player');
    return {
      player: `${player.status}/${player.runtime}`,
      surfaces: player.frame?.contributions.map(c => `${c.surface}:${c.id}${c.drawer ? ':drawer' : ''}${c.keys?.length ? `:keys=${c.keys}` : ''}`),
      resourceProviders: player.frame?.resourceProviders,
      wallpaper: services.find(p => p.id === 'wallpaper')?.tier,
      audio: services.find(p => p.id === 'audio')?.tier,
      background: !!plugins.find(p => p.id === 'background'),
    };
  });
  r.wallpaper = await s.page.evaluate(async () => {
    const { getCapability } = await import('atmos-core/core/renderer-capabilities.js');
    const { loadAsset } = await import('atmos-core/persist.js');
    const state = getCapability('visual.wallpaper')?.getState();
    return {
      mode: state?.mode, vignette: state?.vignette, brightness: state?.brightness,
      image: String(state?.image || '').slice(0, 5),
      movedAsset: !!await loadAsset('wallpaper:image'), oldAsset: !!await loadAsset('background:wallpaper'),
      menu: [...document.querySelectorAll('#ctx-extension-items .ctx-item')].map(el => el.textContent.trim()),
    };
  });
  await activate(s.page, 'audio-player');
  const panel = await waitFrame(s.page, 'panel');
  const cardsStart = Date.now();
  await panel?.waitForFunction(() => document.querySelectorAll('.mp-alb-card').length > 0, null, { timeout: 40000 }).catch(() => {});
  r.cardsAfterMs = Date.now() - cardsStart;
  await s.page.waitForTimeout(1200);
  r.drawer = await s.page.evaluate(() => {
    const drawer = document.querySelector('.atmos-drawer');
    return { present: !!drawer, transform: drawer?.style.transform, open: drawer?.classList.contains('open'), glass: document.querySelectorAll('.atmos-drawer-glass').length };
  });
  r.panel = await panel?.evaluate(async () => {
    const atmos = (await import('atmos-sdk')).default;
    return {
      drawer: atmos.drawer.state && { open: atmos.drawer.state.open, expanded: atmos.drawer.state.expanded, locked: atmos.drawer.state.locked },
      cards: [...document.querySelectorAll('.mp-alb-card .mp-alb-name')].map(el => el.textContent),
      coverSize: getComputedStyle(document.documentElement).getPropertyValue('--alb-cover-size').trim(),
      volume: document.getElementById('mp-vol-pct')?.textContent,
      visible: getComputedStyle(document.documentElement).getPropertyValue('--atmos-drawer-visible-h').trim(),
    };
  }).catch(e => e.message);
  await s.page.screenshot({ path: path.join(out, '80-drawer-open.png') });

  // Double-click the album: it plays from the Audio service in the page.
  await panel?.evaluate(() => document.querySelector('.mp-alb-card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await s.page.waitForTimeout(1200);
  r.playing = await channelState(s.page);
  r.pageAudioElements = await s.page.evaluate(() => [...document.querySelectorAll('#atmos-audio-host audio')].map(a => a.dataset.owner));
  const queue = await widget(s.page, '#mp-side-queue');
  const nowPlaying = await widget(s.page, '#ap-mini-cover');
  const library = await widget(s.page, '#lib-folder-list');
  await s.page.waitForTimeout(500);
  r.queue = await queue?.evaluate(() => [...document.querySelectorAll('.mp-tl-row')].map(row => `${row.classList.contains('active') ? '*' : ''}${row.querySelector('.mp-tl-name').textContent}`)).catch(e => e.message);
  r.nowPlaying = await nowPlaying?.evaluate(() => ({ track: document.getElementById('ap-mini-track')?.textContent, artist: document.getElementById('ap-mini-artist')?.textContent })).catch(e => e.message);
  r.libraryWidget = await library?.evaluate(() => [...document.querySelectorAll('.lib-folder-row')].map(row => row.textContent.replace(/\s+/g, ' ').trim())).catch(e => e.message);
  r.waveform = await panel?.evaluate(async () => {
    const wave = await (await import('atmos-sdk')).default.call('plugin:audio-player', 'waveform');
    return { key: wave.key, length: wave.data?.length ?? 0 };
  }).catch(e => e.message);

  // Another panel: playback carries on. (A release with Audio Player alone
  // has no other panel, so the check brings a blank one.)
  const otherPanel = await s.page.evaluate(async () => {
    const registry = await import('atmos-core/core/panel-registry.js');
    const other = registry.listPanelPlugins().find(plugin => plugin.id !== 'audio-player');
    if (other) return other.id;
    registry.registerPanelPlugin('e2e-blank', { label: 'Blank', mount(surfaceEl) { surfaceEl.textContent = 'blank'; } });
    return 'e2e-blank';
  });
  await activate(s.page, otherPanel);
  await s.page.waitForTimeout(800);
  const before = await channelState(s.page);
  await s.page.waitForTimeout(700);
  const after = await channelState(s.page);
  r.whileOtherPanel = { playing: after.playing, advanced: after.currentTime > before.currentTime || after.source !== before.source, audioPlayerPanelFrame: !!frameFor(s.page, 'panel') };
  // The track ends and the next one starts (tones are 2.5 s long).
  await s.page.waitForTimeout(2500);
  r.advancedTo = (await channelState(s.page)).source;

  // Space in Atmos (focus outside any frame and field): play/pause through
  // the boot frame's key. (A panel that uses Space itself keeps it while
  // it has focus.)
  await s.page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
  await s.page.keyboard.press('Space');
  await s.page.waitForTimeout(500);
  r.afterSpace = (await channelState(s.page)).playing;
  await s.page.keyboard.press('Space');
  await s.page.waitForTimeout(500);
  r.afterSecondSpace = (await channelState(s.page)).playing;

  // Back to Music; the queue carries on.
  await activate(s.page, 'audio-player');
  const panel2 = await waitFrame(s.page, 'panel');
  await panel2?.waitForFunction(() => document.querySelectorAll('.mp-alb-card').length > 0, null, { timeout: 15000 }).catch(() => {});
  await s.page.waitForFunction(() => document.querySelector('.atmos-drawer')?.classList.contains('open'), null, { timeout: 5000 }).catch(() => {});
  await s.page.waitForTimeout(800);
  r.panelAfterReturn = await panel2?.evaluate(() => document.getElementById('mp-track-name')?.textContent).catch(e => e.message);

  // Album menu from the frame: icons and controls drawn by Atmos.
  const cardBox = await panel2?.evaluate(() => { const rect = document.querySelector('.mp-alb-card').getBoundingClientRect(); return { x: rect.x + 20, y: rect.y + 20 }; });
  const frameBox = await s.page.locator('.atmos-drawer iframe').boundingBox();
  await s.page.mouse.click(frameBox.x + cardBox.x, frameBox.y + cardBox.y, { button: 'right' });
  await s.page.waitForTimeout(500);
  r.albumMenu = await s.page.evaluate(() => {
    const menu = [...document.querySelectorAll('.ctx-menu-surface')].find(el => /Play Album/.test(el.textContent));
    return {
      items: [...(menu?.querySelectorAll('.ctx-item') || [])].map(el => el.textContent.trim()).slice(0, 8),
      icons: menu?.querySelectorAll('svg.ctx-ico').length ?? 0,
      scripts: menu?.querySelectorAll('script, foreignObject, [onload]').length ?? 0,
      ranges: menu?.querySelectorAll('input[type=range]').length ?? 0,
      toggles: menu?.querySelectorAll('input[type=checkbox]').length ?? 0,
    };
  });
  await s.page.evaluate(() => {
    const row = document.querySelector('.ctx-menu-surface [data-context-menu-item="cover-size"] input[type=range]');
    if (!row) return;
    row.value = '140';
    row.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await s.page.waitForTimeout(600);
  r.coverSizeAfterRange = await panel2?.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alb-cover-size').trim());
  await s.page.keyboard.press('Escape');

  // Seek menu: Dock Player moves the bar to the bottom (Atmos's drawer).
  // Low on the track: Atmos's window title bar covers the top 28px of the window.
  const seekBox = await panel2?.evaluate(() => { const rect = document.getElementById('mp-seek-track').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height * 0.8 }; });
  await s.page.mouse.click(frameBox.x + seekBox.x, frameBox.y + seekBox.y, { button: 'right' });
  await s.page.waitForTimeout(400);
  r.seekMenu = await s.page.evaluate(() => [...([...document.querySelectorAll('.ctx-menu-surface')].find(el => /Waveform Appearance/.test(el.textContent))?.querySelectorAll('.ctx-lbl, .ctx-item') || [])].map(el => el.textContent.trim()));
  await s.page.evaluate(() => {
    const toggle = document.querySelector('.ctx-menu-surface [data-context-menu-item="wave-dock"] input[type=checkbox]');
    if (!toggle) return;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await s.page.waitForTimeout(700);
  r.docked = await s.page.evaluate(() => ({ bar: document.querySelector('.atmos-drawer')?.dataset.barPlacement, clip: document.querySelector('.atmos-drawer')?.style.clipPath?.slice(0, 5) }));
  r.dockedInFrame = await panel2?.evaluate(() => document.querySelector('.ap-drawer')?.dataset.barPlacement);
  await s.page.keyboard.press('Escape');
  await s.page.screenshot({ path: path.join(out, '81-docked.png') });

  // Escape twice closes the drawer (the first only arms it), pressed inside
  // its frame: the frame passes Escape on to Atmos.
  await s.page.waitForTimeout(2200); // let any earlier Escape's arming lapse
  // (On the time label: clicking the track name would open the library search.)
  const frameBox2 = await s.page.locator('.atmos-drawer iframe').boundingBox();
  const timeLabel = await (await waitFrame(s.page, 'panel')).evaluate(() => { const rect = document.getElementById('mp-cur-fs').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await s.page.mouse.click(frameBox2.x + timeLabel.x, frameBox2.y + timeLabel.y);
  r.escape = {
    openBefore: await s.page.evaluate(() => document.querySelector('.atmos-drawer')?.classList.contains('open')),
    focus: await s.page.evaluate(() => document.activeElement?.tagName),
  };
  await s.page.keyboard.press('Escape');
  await s.page.waitForTimeout(200);
  r.escape.armed = await s.page.evaluate(() => document.querySelector('.atmos-drawer')?.classList.contains('pending-close'));
  await s.page.keyboard.press('Escape');
  await s.page.waitForTimeout(1500);
  r.escape.closed = await s.page.evaluate(() => !document.querySelector('.atmos-drawer')?.classList.contains('open'));
  // Wheel on the workspace brings it back.
  await s.page.mouse.move(640, 300);
  for (let i = 0; i < 6; i++) await s.page.mouse.wheel(0, -400);
  await s.page.waitForTimeout(1500);
  r.wheelReopened = await s.page.evaluate(() => document.querySelector('.atmos-drawer')?.classList.contains('open'));
  await s.page.screenshot({ path: path.join(out, '82-bar-after-wheel.png') });

  // Library widget: rescan the folder, the status reports back.
  await library?.evaluate(() => { window.__statuses = []; new MutationObserver(() => window.__statuses.push(document.getElementById('lib-status').textContent)).observe(document.getElementById('lib-status'), { childList: true, characterData: true, subtree: true }); });
  await library?.evaluate(() => document.querySelector('.lib-rescan-row-btn')?.click());
  await library?.waitForFunction(() => window.__statuses.some(text => /imported/.test(text)), null, { timeout: 15000 }).catch(() => {});
  r.rescanStatuses = await library?.evaluate(() => [...new Set(window.__statuses)].filter(Boolean)).catch(e => e.message);
  r.libraryAfterRescan = await library?.evaluate(() => [...document.querySelectorAll('.lib-folder-row')].map(row => row.textContent.replace(/\s+/g, ' ').trim())).catch(e => e.message);
  await s.page.waitForTimeout(3000);
  r.errors = s.errors;
  r.channelBeforeRestart = await channelState(s.page);
  await s.page.evaluate(async () => (await import('atmos-core/persist.js')).flushPendingSave?.());
  await s.page.waitForTimeout(400);
  await s.app.close();

  // 3. After a restart: the queue, volume, docked bar and wallpaper stay.
  s = await launch();
  await activate(s.page, 'audio-player');
  const panel3 = await waitFrame(s.page, 'panel');
  await s.page.waitForTimeout(2500);
  const restored = await channelState(s.page);
  r.afterRestart = {
    source: restored?.source, playing: restored?.playing, volume: restored?.volume,
    track: await panel3?.evaluate(() => document.getElementById('mp-track-name')?.textContent).catch(e => e.message),
    bar: await s.page.evaluate(() => document.querySelector('.atmos-drawer')?.dataset.barPlacement),
    wallpaperMode: await s.page.evaluate(async () => (await import('atmos-core/core/renderer-capabilities.js')).getCapability('visual.wallpaper')?.getState().mode),
    coverSize: await panel3?.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alb-cover-size').trim()).catch(e => e.message),
  };
  r.errorsAfterRestart = s.errors;
  await s.page.screenshot({ path: path.join(out, '83-after-restart.png') });
  await s.app.close();
  console.log(JSON.stringify(r, null, 1));
})().catch(e => { console.error(e); console.log(JSON.stringify(r, null, 1)); process.exit(1); });

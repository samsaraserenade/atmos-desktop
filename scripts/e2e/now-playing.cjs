// The Now Playing service with community extensions publishing to it, end
// to end (SDK 1.4, atmos.nowPlaying):
//
//  1. "Rain" (a community extension calling itself Music) publishes a
//     session with a PNG cover: the widget shows it, with its name marked
//     "· community" under the title, its cover as a blob: image, and no
//     dots for one session.
//  2. "Spoof" can't see what others play (sessions), can't send a control
//     to another's session, can't set SVG (even typed image/png) or an
//     address as artwork, and is stopped past 20 updates a second.
//  3. Spoof starts playing: it shows (nothing else plays), with two dots.
//     Rain's dot picks Rain. Spoof starting something else by itself
//     doesn't take its place; started from Spoof's panel (you clicked it),
//     it does, but not while the pointer moves on the widget, only once it
//     leaves.
//  4. A click on the cover goes to the extension whose session shows, and
//     only to it.
//
// Usage: node scripts/e2e/now-playing.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'now-playing'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env, installRoot } = isolatedEnv('atmos-now-playing-');

/** A size × size PNG of one colour. */
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

function plugin(id, displayName, boot, { panel = null } = {}) {
  const dir = path.join(installRoot, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({
    apiVersion: 4, version: '1.0.0', publisher: 'someone', displayName, engines: { atmos: '>=0.21.0' },
    permissions: { invokes: ['service:now-playing'] }, contributes: { boot: {}, ...(panel ? { panel: { label: displayName } } : {}) },
  }));
  fs.writeFileSync(path.join(dir, 'boot.js'), boot);
  if (panel) fs.writeFileSync(path.join(dir, 'panel.js'), panel);
}

plugin('rain', 'Music', `import atmos from 'atmos-sdk';
const r = window.__np = { controls: [] };
let playing = false;
const publish = () => atmos.nowPlaying.set({
  title: 'Rain on a tin roof', artist: 'Field recordings', playing, actions: ['toggle'],
  artwork: 'data:image/png;base64,${png([200, 40, 40]).toString('base64')}',
});
atmos.nowPlaying.onControl(control => {
  r.controls.push(control);
  if (control.action === 'toggle') { playing = !playing; publish(); }
});
r.set = await publish().then(() => 'ok', error => error.message);
r.ready = true;
`);

plugin('spoof', 'Spoof', `import atmos from 'atmos-sdk';
const r = window.__np = { controls: [], heard: 0 };
const attempt = run => run().then(() => 'done', error => \`\${error.name}: \${error.message}\`);
atmos.nowPlaying.onControl(control => r.controls.push(control));
atmos.nowPlaying.sessions(() => { r.heard += 1; });
r.control = await attempt(() => atmos.nowPlaying.control('plugin:rain|main', 'toggle'));
r.svg = await attempt(() => atmos.nowPlaying.set({ title: 'x', artwork: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }) }, 'probe'));
r.svgAsPng = await attempt(() => atmos.nowPlaying.set({ title: 'x', artwork: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/png' }) }, 'probe'));
r.address = await attempt(() => atmos.nowPlaying.set({ title: 'x', artwork: 'https://example.com/cover.png' }, 'probe'));
r.anotherKey = await attempt(() => atmos.nowPlaying.set({ title: 'x' }, 'plugin:rain|main'));
// Past 20 a second: none refused; the newest waits for the next second.
const started = Date.now();
r.flood = await Promise.all(Array.from({ length: 40 }, (_, i) => atmos.nowPlaying.set({ title: 'flood ' + i }, 'probe')))
  .then(() => Date.now() - started > 500 ? 'waited' : 'at once', error => error.message);
await atmos.nowPlaying.clear('probe');
window.play = (key, title) => atmos.nowPlaying.set({ title, playing: true, actions: ['toggle'] }, key);
r.ready = true;
`, { panel: `import atmos from 'atmos-sdk';
document.body.innerHTML = '<button id="later" style="margin:40px;font-size:20px">Play later</button>';
// A click here, then the session starts a moment after (time to point at the widget).
document.getElementById('later').addEventListener('click', () => setTimeout(() => atmos.nowPlaying.set({ title: 'Later', playing: true, actions: ['toggle'] }, 'later'), 1200));
` });

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [repo, `--extensions-root=${repo}`, '--no-sandbox', '--disable-gpu'], cwd: repo, env });
  const logs = []; app.process().stdout.on('data', d => logs.push(String(d))); app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (['error', 'warning'].includes(m.type()) && !/TUNNEL|rate fetch|save\(\) called before|Electron Security Warning|VPS unavailable|images\.unsplash\.com|cannot follow Now Playing/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}
const frameOf = (page, ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`)) || null;
async function waitFor(get, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await get();
    if (value || Date.now() > until) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const r = { home };
(async () => {
  // 1. Approve both.
  let s = await launch();
  await s.page.evaluate(async () => {
    for (const plugin of (await window.atmosCore.listPlugins()).filter(p => ['rain', 'spoof'].includes(p.id))) {
      await window.atmosCore.approveExtension('plugin', plugin.id, plugin.fingerprint);
    }
    (await import('atmos-core/persist.js')).flushPendingSave();
  });
  await s.app.close();

  s = await launch();
  const rain = await waitFor(() => frameOf(s.page, 'plugin:rain', 'boot'));
  const spoof = await waitFor(() => frameOf(s.page, 'plugin:spoof', 'boot'));
  await rain?.waitForFunction(() => window.__np?.ready, null, { timeout: 15000 }).catch(() => {});
  await spoof?.waitForFunction(() => window.__np?.ready, null, { timeout: 15000 }).catch(() => {});
  r.rainSet = await rain?.evaluate(() => window.__np.set).catch(e => e.message);
  r.spoof = await spoof?.evaluate(() => { const { controls, ...rest } = window.__np; return rest; }).catch(e => e.message);

  // The widget: its section open and on screen.
  const widget = await waitFor(() => frameOf(s.page, 'service:now-playing', 'sidebar'));
  await s.page.evaluate(() => {
    const section = document.getElementById('fin-section-audio-player');
    if (section && !section.classList.contains('open')) section.querySelector('.fin-section-label')?.click();
    section?.scrollIntoView({ block: 'center' });
  });
  await s.page.waitForTimeout(800);
  const look = () => widget.evaluate(() => ({
    title: document.getElementById('np-track').textContent,
    subtitle: document.getElementById('np-artist').textContent + (document.getElementById('np-community').hidden ? '' : ` ${document.getElementById('np-community').textContent}`),
    dots: document.getElementById('np-dots').hidden ? 0 : document.querySelectorAll('.np-dot').length,
    active: document.querySelector('.np-dot.is-active')?.dataset.id ?? null,
    cover: document.querySelector('#np-cover-img img')?.src.slice(0, 5) ?? null,
    hint: document.getElementById('np-cover').title,
  }));
  const titleIs = text => widget.waitForFunction(t => document.getElementById('np-track').textContent === t, text, { timeout: 8000 }).then(() => true, () => false);
  const frameBox = () => s.page.locator('#fin-section-audio-player iframe').boundingBox();
  const at = async selector => {
    const box = await frameBox();
    const rect = await widget.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, selector);
    return { x: box.x + rect.x, y: box.y + rect.y };
  };
  const away = () => s.page.mouse.move(700, 400);

  // 1. One session: Rain, marked as a community extension; no dots.
  await titleIs('Rain on a tin roof');
  r.one = await look();
  await s.page.screenshot({ path: path.join(out, '10-one.png') });

  // 3. Spoof plays: it shows, with two dots.
  await away();
  await spoof.evaluate(() => window.play('main', 'Second'));
  r.twoShows = await titleIs('Second');
  r.two = await look();
  await s.page.screenshot({ path: path.join(out, '20-two.png') });

  // Rain's dot picks Rain.
  const rainDot = await at('.np-dot[data-id="plugin:rain|main"]');
  await s.page.mouse.click(rainDot.x, rainDot.y);
  r.pickedShows = await titleIs('Rain on a tin roof');
  r.picked = await look();

  // Spoof starting something by itself doesn't take Rain's place.
  await spoof.evaluate(() => window.play('alone', 'By itself'));
  await s.page.waitForTimeout(2500);
  r.byItself = await look();

  // Started from Spoof's panel (a click there): on the widget, it doesn't
  // take the place; leaving, it does. (Moving a little, as a hand does: the
  // hold lasts 1.5 s from the last movement.)
  await s.page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('spoof'));
  const spoofPanel = await waitFor(() => frameOf(s.page, 'plugin:spoof', 'panel'));
  await spoofPanel?.waitForSelector('#later', { timeout: 10000 }).catch(() => {});
  const panelBox = await s.page.locator('iframe[src*="ext=plugin%3Aspoof"][src*="surface=panel"]').boundingBox().catch(() => null);
  const button = await spoofPanel?.evaluate(() => { const b = document.getElementById('later').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }).catch(() => null);
  if (panelBox && button) await s.page.mouse.click(panelBox.x + button.x, panelBox.y + button.y);
  const cover = await at('#np-cover');
  await s.page.mouse.move(cover.x, cover.y + 10);
  for (let i = 0; i < 6; i++) { await s.page.waitForTimeout(300); await s.page.mouse.move(cover.x + (i % 2 ? 2 : -2), cover.y + 10); }
  r.held = (await look()).title;
  r.laterArrived = (await look()).dots === 4;
  await away();
  r.releasedShows = await titleIs('Later');
  r.released = await look();
  await s.page.waitForTimeout(600); // a press just after it changed by itself is ignored

  // 4. A click goes to the session showing, and only to its extension.
  await s.page.mouse.click(cover.x, cover.y + 10);
  await s.page.waitForTimeout(500);
  r.clickLater = {
    spoof: await spoof.evaluate(() => window.__np.controls),
    rain: await rain.evaluate(() => window.__np.controls),
  };
  const rainDot2 = await at('.np-dot[data-id="plugin:rain|main"]');
  await s.page.mouse.click(rainDot2.x, rainDot2.y);
  await titleIs('Rain on a tin roof');
  await s.page.mouse.click(cover.x, cover.y + 10);
  await s.page.waitForTimeout(800);
  r.clickRain = {
    rain: await rain.evaluate(() => window.__np.controls),
    spoof: (await spoof.evaluate(() => window.__np.controls)).length,
    shown: await look(),
  };
  await away();
  await s.page.screenshot({ path: path.join(out, '30-after.png') });
  r.errors = s.errors;
  await s.app.close();

  const checks = {
    rainSet: r.rainSet === 'ok',
    oneShows: r.one?.title === 'Rain on a tin roof',
    oneMarked: r.one?.subtitle === 'Field recordings · Music · community',
    oneNoDots: r.one?.dots === 0,
    oneCover: r.one?.cover === 'blob:',
    oneHint: r.one?.hint === 'Click: play/pause',
    spoofHearsNothing: r.spoof?.heard === 0,
    spoofCantControl: /AtmosPermissionError|only Atmos's Now Playing service/.test(r.spoof?.control || ''),
    noSvg: /PNG, JPEG, WebP or GIF/.test(r.spoof?.svg || ''),
    noSvgAsPng: /PNG, JPEG, WebP or GIF/.test(r.spoof?.svgAsPng || ''),
    noAddress: /data: URL/.test(r.spoof?.address || ''),
    noOtherKey: /letters, digits/.test(r.spoof?.anotherKey || ''),
    flood: r.spoof?.flood === 'waited',
    twoShows: r.twoShows && r.two?.subtitle === 'Spoof · community' && r.two?.dots === 2 && r.two?.active === 'plugin:spoof|main',
    picked: r.pickedShows && r.picked?.active === 'plugin:rain|main',
    byItself: r.byItself?.title === 'Rain on a tin roof' && r.byItself?.dots === 3,
    held: r.held === 'Rain on a tin roof' && r.laterArrived,
    released: r.releasedShows && r.released?.dots === 4,
    clickLater: JSON.stringify(r.clickLater?.spoof) === JSON.stringify([{ key: 'later', action: 'toggle', value: null }]) && r.clickLater?.rain.length === 0,
    clickRain: JSON.stringify(r.clickRain?.rain) === JSON.stringify([{ key: 'main', action: 'toggle', value: null }]) && r.clickRain?.spoof === 1,
    rainPlaysAndShows: r.clickRain?.shown.title === 'Rain on a tin roof',
    noErrors: r.errors.length === 0,
  };
  r.failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  r.summary = `${Object.keys(checks).length - r.failed.length}/${Object.keys(checks).length} checks passed`;
  console.log(JSON.stringify(r, null, 1));
  if (r.failed.length) process.exit(1);
})().catch(e => { console.error(e); console.log(JSON.stringify(r, null, 1)); process.exit(1); });

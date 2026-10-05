// SDK 1.0 end to end: developer folders (--dev-extension), atmos.fetch()
// against a local HTTPS server (--fetch-test), atmos.location, the
// lifecycle, live reload, "engines", and the extension template running.
// Usage: node scripts/e2e/sdk.cjs [outDir]   (see scripts/e2e/README.md)
const { _electron: electron } = require('playwright-core');
const fs = require('fs'), https = require('https'), path = require('path');
const { isolatedEnv, atmosWindow } = require('./isolate.cjs');
const { cert, key } = require('../test-tls.cjs');
const { createExtension } = require('../new-extension.cjs');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.tmp', 'e2e', 'sdk'));
const ELECTRON = process.env.ELECTRON_PATH || require('electron');
fs.mkdirSync(out, { recursive: true });
const { home, env } = isolatedEnv('atmos-sdk-');

// A server for api.test.example and friends: no CORS headers anywhere.
const seen = [];
const server = https.createServer({ cert, key }, (request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const host = String(request.headers.host).split(':')[0];
    seen.push({ host, method: request.method, url: request.url, auth: request.headers.authorization || null, cookie: request.headers.cookie || null, agent: request.headers['user-agent'] });
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'tracker=1' }); response.end(JSON.stringify(value)); };
    if (host === 'api.github.com' && request.url === '/repos/samsaraserenade/atmos-desktop') return json(200, { stargazers_count: 7 });
    if (request.url === '/no-cors') return json(200, { hello: 'from the test server', host });
    if (request.url === '/echo') return json(200, { method: request.method, body: JSON.parse(body || 'null'), auth: request.headers.authorization || null });
    if (request.url === '/hop') { response.writeHead(302, { location: '/no-cors' }); return response.end(); }
    if (request.url === '/away') { response.writeHead(302, { location: 'https://elsewhere.example/' }); return response.end(); }
    if (request.url === '/slow') return; // never answers
    // The Location service's place search (Open-Meteo's geocoder).
    if (host === 'geocoding-api.open-meteo.com' && request.url.startsWith('/v1/search?name=London')) {
      return json(200, { results: [{ name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.5072, longitude: -0.1276 }] });
    }
    json(404, { error: 'not found' });
  });
});

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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const at = { address: '127.0.0.1', port };
  const fetchTest = path.join(home, 'fetch-test.json');
  fs.writeFileSync(fetchTest, JSON.stringify({
    hosts: { 'api.test.example': at, 'other.test.example': at, 'elsewhere.example': at, 'api.github.com': at, 'geocoding-api.open-meteo.com': at },
    ca: cert,
  }));

  // Three developer folders: the probe, the template as `npm run new:extension` makes it, and one for a later Atmos.
  const dev = path.join(home, 'dev');
  const probe = path.join(dev, 'sdk-probe');
  fs.cpSync(path.join(__dirname, 'fixtures-sdk', 'sdk-probe'), probe, { recursive: true });
  const template = createExtension(path.join(dev, 'hello-template')).folder;
  const future = path.join(dev, 'from-the-future');
  fs.mkdirSync(future);
  fs.writeFileSync(path.join(future, 'extension.json'), JSON.stringify({ apiVersion: 4, engines: { atmos: '>=99.0.0' }, permissions: {} }));
  fs.writeFileSync(path.join(future, 'panel.js'), 'document.body.textContent = "never";');
  // Nothing bundled but the Location service (official, since 0.21), which the probe reads.
  const noBundled = path.join(home, 'no-bundled');
  fs.mkdirSync(noBundled);
  fs.cpSync(path.join(repo, 'services', 'location'), path.join(noBundled, 'services', 'location'), { recursive: true, filter: source => !source.includes(`${path.sep}tests`) });

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [repo, `--extensions-root=${noBundled}`, `--dev-extension=${probe}`, `--dev-extension=${template}`, `--dev-extension=${future}`,
      `--fetch-test=${fetchTest}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo, env,
  });
  const logs = [];
  app.process().stdout.on('data', d => logs.push(String(d)));
  app.process().stderr.on('data', d => logs.push(String(d)));
  const page = await atmosWindow(app);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosBootComplete === true, null, { timeout: 30000 });
  const frameFor = (ext, surface) => page.frames().find(f => f.url().includes(`ext=${encodeURIComponent(ext)}`) && f.url().includes(`surface=${surface}`));
  const r = { home };

  // 1. Developer folders: no approval; the one for a later Atmos doesn't load.
  r.list = await page.evaluate(async () => Object.fromEntries((await window.atmosCore.listPlugins())
    .map(p => [p.id, { status: p.status, reason: p.statusReason, source: p.source, tier: p.tier, active: p.active }])));

  // 2. The probe's panel.
  await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('sdk-probe'));
  const panel = await until(async () => frameFor('plugin:sdk-probe', 'panel'));
  await panel.waitForFunction(() => window.__results?.done === true, null, { timeout: 20000 }).catch(() => {});
  r.probe = await panel.evaluate(() => window.__results).catch(error => `no panel: ${error.message}`);
  r.serverSaw = seen.map(({ host, method, url, auth, cookie, agent }) => `${method} ${host}${url} auth=${auth} cookie=${cookie} ua=${String(agent).split('/')[0]}`);
  await page.screenshot({ path: path.join(out, '10-probe.png') });

  // 3. The location, set on the Location service's own Settings page: a
  // place searched for and picked (the geocoder is the test server); the
  // page shows it at once, and its background frame publishes it.
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).openSettingsPage('appearance'));
  // (Settings may draw its page again, with a new frame: each step finds the frame there is then.)
  const inLocationPage = fn => until(async () => {
    const frame = frameFor('service:location', 'settings');
    if (!frame) return undefined;
    return frame.evaluate(fn).then(value => ({ value }), () => undefined);
  }, { timeout: 15000 }).then(answer => answer?.value);
  r.locationPageBefore = await until(() => inLocationPage(() => document.querySelector('#loc-current')?.textContent || undefined)) ?? 'no Location page';
  await page.evaluate(() => document.querySelector('iframe[src*="ext=service%3Alocation"][src*="surface=settings"]')?.scrollIntoView({ block: 'center' }));
  // Search, pick, and read the page in one go (a redrawn page starts again).
  r.locationPage = await inLocationPage(async () => {
    const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) { const value = check(); if (value) return value; } return null; };
    document.getElementById('loc-query').value = 'London';
    document.getElementById('loc-search').requestSubmit();
    const found = await until(() => document.querySelector('.loc-result'));
    if (!found) {
      const why = await (await import('atmos-sdk')).default.fetch('https://geocoding-api.open-meteo.com/v1/search?name=London').then(response => `status ${response.status}`, error => error.message);
      return `no result: ${document.getElementById('loc-status').textContent} (${why})`;
    }
    found.click();
    return (await until(() => (document.getElementById('loc-current').textContent === 'London' ? 'London' : null), 2000)) ?? `shows ${document.getElementById('loc-current').textContent}`;
  }) ?? 'not shown';
  await page.screenshot({ path: path.join(out, '15-location-page.png') });
  await page.evaluate(async () => (await import('atmos-core/core/settings-menu.js')).closeSettingsMenu());
  r.locationChanged = await until(() => panel.evaluate(() => window.__results.locationChanged), { timeout: 5000 });
  r.locationNow = await panel.evaluate(() => window.__atmos.location.get());

  // 4. Live reload: a saved file reloads the frame; the old one's cleanup ran.
  fs.writeFileSync(path.join(probe, 'panel.js'), fs.readFileSync(path.join(probe, 'panel.js'), 'utf8').replace('const BUILD = 1;', 'const BUILD = 2;'));
  r.reloaded = await until(async () => {
    const frame = frameFor('plugin:sdk-probe', 'panel');
    return frame && await frame.evaluate(() => window.__results?.done && window.__results.build === 2 ? window.__results : null);
  }, { timeout: 15000 });
  r.reload = r.reloaded ? { build: r.reloaded.build, cleanedUpBefore: r.reloaded.cleanedUpBefore, other: r.reloaded.other } : 'did not reload';

  // 5. A changed manifest: another host, taken without a restart.
  const manifestFile = path.join(probe, 'extension.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.permissions.network.push('other.test.example');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  r.afterManifest = await until(async () => {
    const frame = frameFor('plugin:sdk-probe', 'panel');
    const results = frame && await frame.evaluate(() => window.__results?.done ? window.__results : null);
    return results && results.other?.ok === 200 ? { other: results.other, build: results.build } : null;
  }, { timeout: 15000 }) || 'the new host was not taken';
  r.developerRestart = await page.evaluate(async () => (await window.atmosCore.listPlugins()).find(p => p.id === 'sdk-probe')?.developerRestart);

  // 6. The template, as a new extension starts.
  await page.evaluate(async () => (await import('atmos-core/core/panel-registry.js')).activatePanelPlugin('hello-template'));
  const templatePanel = await until(async () => frameFor('plugin:hello-template', 'panel'));
  r.templatePanel = await until(() => templatePanel.evaluate(() => {
    const button = document.querySelector('.hello-count');
    return button && { heading: document.querySelector('h1')?.textContent, button: button.textContent };
  }));
  if (r.templatePanel) {
    await templatePanel.click('.hello-count');
    await templatePanel.click('.hello-count');
    r.templateClicked = await until(() => templatePanel.evaluate(() => (/2 times/.test(document.querySelector('.hello-count').textContent) ? document.querySelector('.hello-count').textContent : null)));
  }
  r.templateGlass = await page.evaluate(() => document.querySelectorAll('.atmos-frame-glass').length);
  const widget = await until(async () => frameFor('plugin:hello-template', 'sidebar'), { timeout: 5000 });
  r.templateWidget = widget ? await until(() => widget.evaluate(() => (/★/.test(document.body.innerText) ? document.body.innerText.replace(/\s+/g, ' ').trim() : null)), { timeout: 10000 }) : 'no widget frame';
  await page.screenshot({ path: path.join(out, '20-template.png') });

  r.errors = errors.filter(message => !/rate fetch|save\(\) called before/.test(message));
  r.mainLog = logs.join('').split('\n').filter(line => /developing|extension\.json changed|dev-extension|fetch-test|incompatible|from-the-future/.test(line)).slice(0, 20);
  await app.close();
  server.close();
  console.log(JSON.stringify(r, null, 2));
})().catch(error => { console.error(error); server.close(); process.exit(1); });

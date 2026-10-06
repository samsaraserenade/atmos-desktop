'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frames = require('./extension-frames.cjs');
const { createAtmosExtHandler, createFrameAccess, SDK_FILES } = require('./atmos-ext-protocol.cjs');

// Extensions on disk: a community plugin, a first-party one in the shared
// origin, an isolated first-party one, and a first-party library service.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-ext-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
write('plugins/weather/panel.js', 'export const weather = 1;');
write('plugins/weather/styles/app.css', 'body{}');
write('plugins/weather/icon.SVG', '<svg/>');
write('plugins/weather/blob.bin', 'bytes');
write('plugins/weather/page.html', '<script>fetch("https://anywhere.example/")</script>');
write('plugins/weather/data/secret.json', '{"token":"weather"}');
write('plugins/weather/tests/a.test.js', 'x');
write('plugins/weather/.env', 'SECRET=1');
write('plugins/finance/panel.js', 'export const finance = 1;');
write('plugins/matrix/panel.js', 'export const matrix = 1;');
write('services/charting/chart.js', 'export const chart = 1;');
write('outside.txt', 'not an extension file');
write('sdk/atmos-sdk.js', '// sdk');
write('sdk/frame.js', '// frame');
write('sdk/frame.css', '/* frame */');
write('sdk/ui.css', '/* ui */');
write('move.js', '// move');
let symlinked = true;
try { fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'plugins/weather/escape.js')); } catch { symlinked = false; }
try { fs.symlinkSync(path.join(root, 'plugins/finance'), path.join(root, 'plugins/weather/finance-dir')); } catch { /* no symlinks here */ }
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ext = (kind, id, tier, more = {}) => ({ kind, id, tier, path: path.join(root, `${kind}s`, id), manifest: {}, ...more });
const weather = ext('plugin', 'weather', 'third-party', { source: 'developer' });
const finance = ext('plugin', 'finance', 'first-party');
const matrix = ext('plugin', 'matrix', 'first-party', { manifest: { isolation: 'origin' } });
const charting = ext('service', 'charting', 'first-party', { manifest: { library: true } });
const trust = new Map([
  [weather, { permissions: { network: ['api.open-meteo.com'], invokes: ['service:charting'], resources: ['weather-maps', 'weather-maps'] } }],
  [finance, { permissions: { invokes: ['service:charting'] } }],
  [matrix, { permissions: {} }],
  [charting, { permissions: {} }],
]);

const services = { charting };
function access({ entries = [weather, finance, matrix], inactive = [] } = {}) {
  return createFrameAccess({
    framedEntries: () => { if (entries === 'boom') throw new Error('catalog unreadable'); return entries; },
    trustOf: entry => trust.get(entry) || null,
    findService: id => services[id] || null,
    isActive: entry => !inactive.includes(entry),
  });
}

function handler({ move = null, entries = [weather, finance, matrix], inactive = [], errors = [] } = {}) {
  const rules = access({ entries, inactive });
  return createAtmosExtHandler({
    framedEntries: () => { if (entries === 'boom') throw new Error('catalog unreadable'); return entries; },
    trustOf: entry => trust.get(entry) || null,
    libraryService: rules.libraryService,
    libraryOriginsFor: rules.libraryOriginsFor,
    resourceProvidersFor: rules.resourceProvidersFor,
    originMayUseLibrary: rules.originMayUseLibrary,
    moveInProgress: () => move,
    sdkDir: path.join(root, 'sdk'),
    originMoveScript: path.join(root, 'move.js'),
    error: (...args) => errors.push(args.join(' ')),
  });
}

async function get(url, { origin, ...options } = {}) {
  const headers = new Headers(origin ? { origin } : {});
  const response = await handler(options).handle({ url, headers });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

const W = 'atmos-ext://plugin-weather';
const FP = 'atmos-ext://first-party';
const MX = 'atmos-ext://first-party-plugin-matrix';

test('the hosts are what Core gives each extension', () => {
  assert.equal(frames.frameOrigin(weather), W);
  assert.equal(frames.frameOrigin(finance), FP);
  assert.equal(frames.frameOrigin(matrix), MX);
  assert.equal(frames.frameOrigin(charting), FP);
});

test('an extension’s files from its own origin, typed, never sniffed', async () => {
  const js = await get(`${W}/plugins/weather/panel.js`);
  assert.equal(js.status, 200);
  assert.equal(js.body, 'export const weather = 1;');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get(`${W}/plugins/weather/styles/app.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await get(`${W}/plugins/weather/icon.SVG`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await get(`${W}/plugins/weather/blob.bin`)).headers.get('content-type'), 'application/octet-stream');
  assert.equal((await get(`${FP}/plugins/finance/panel.js`)).body, 'export const finance = 1;');
  assert.equal((await get(`${MX}/plugins/matrix/panel.js`)).body, 'export const matrix = 1;');
});

test('a developer folder is never cached; an installed extension may be', async () => {
  assert.equal((await get(`${W}/plugins/weather/panel.js`)).headers.get('cache-control'), 'no-store');
  assert.equal((await get(`${FP}/plugins/finance/panel.js`)).headers.get('cache-control'), null);
});

test('another extension’s files are not served from an origin that isn’t theirs', async () => {
  assert.equal((await get(`${W}/plugins/finance/panel.js`)).status, 404);
  assert.equal((await get(`${FP}/plugins/weather/panel.js`)).status, 404);
  assert.equal((await get(`${FP}/plugins/matrix/panel.js`)).status, 404); // isolated: its own origin only
  assert.equal((await get(`${MX}/plugins/finance/panel.js`)).status, 404);
  assert.equal((await get('atmos-ext://plugin-nobody/plugins/weather/panel.js')).status, 404);
});

test('an extension that isn’t running serves nothing', async () => {
  assert.equal((await get(`${W}/plugins/weather/panel.js`, { entries: [finance] })).status, 404);
  assert.equal((await get(`${W}/__atmos/sdk.js`, { entries: [finance] })).status, 404);
});

test('no way out of the extension’s folder, nor into what it keeps private', async () => {
  for (const tail of [
    '%2e%2e%2f%2e%2e%2foutside.txt', '..%2f..%2foutside.txt', '..%5c..%5coutside.txt', '%2e%2e/%2e%2e/outside.txt',
    'data/secret.json', 'tests/a.test.js', '.env', 'styles/../data/secret.json', 'styles%2f..%2fdata%2fsecret.json',
    '%2fetc%2fpasswd', encodeURIComponent(path.join(root, 'outside.txt')), 'x'.repeat(201),
    '', 'styles', 'styles/',
  ]) {
    const response = await get(`${W}/plugins/weather/${tail}`);
    assert.equal(response.status, 404, tail);
    assert.doesNotMatch(response.body, /not an extension file|token|SECRET/, tail);
  }
  // A path the URL parser resolves first still has to land in the right folder.
  assert.equal((await get(`${W}/plugins/weather/../finance/panel.js`)).status, 404);
  assert.equal((await get(`${W}/plugins/weather/styles/../panel.js`)).status, 200);
});

test('a symbolic link out of the extension’s folder is not followed', { skip: !symlinked && 'no symlinks here' }, async () => {
  assert.equal((await get(`${W}/plugins/weather/escape.js`)).status, 404);
  assert.equal((await get(`${W}/plugins/weather/finance-dir/panel.js`)).status, 404);
});

test('a kind or an id Atmos doesn’t have is not found', async () => {
  for (const url of [`${W}/themes/weather/panel.js`, `${W}/plugins/Weather/panel.js`, `${W}/plugins/-weather/panel.js`, `${W}/plugins/weather`, `${W}/`, `${W}/panel.js`]) {
    assert.equal((await get(url)).status, 404, url);
  }
});

test('a frame’s document carries its own extension’s policy, and only on its own origin', async () => {
  const doc = await get(`${W}/__atmos/frame.html?ext=plugin:weather`);
  assert.equal(doc.status, 200);
  assert.equal(doc.body, frames.frameDocument());
  assert.equal(doc.headers.get('cache-control'), 'no-store');
  const csp = doc.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.open-meteo\.com/);
  assert.match(csp, new RegExp(`script-src 'self' ${FP} 'sha256-`)); // the library it declared
  assert.equal((await get(`${W}/__atmos/frame.html?ext=plugin:finance`)).status, 403);
  assert.equal((await get(`${FP}/__atmos/frame.html?ext=plugin:weather`)).status, 403);
  assert.equal((await get(`${W}/__atmos/frame.html`)).status, 403);
  assert.equal((await get(`${W}/__atmos/frame.html?ext=service:weather`)).status, 403);
  const financeCsp = (await get(`${FP}/__atmos/frame.html?ext=plugin:finance`)).headers.get('content-security-policy');
  assert.doesNotMatch(financeCsp, /open-meteo/);
});

test('every file an extension serves carries its policy, so its own pages and workers are held to it too (R1)', async () => {
  const policy = (await get(`${W}/__atmos/frame.html?ext=plugin:weather`)).headers.get('content-security-policy');
  // A frame may navigate within its origin: its own HTML page, an SVG, or a
  // worker's script would otherwise run with no network limits.
  for (const file of ['page.html', 'icon.SVG', 'panel.js', 'blob.bin']) {
    const response = await get(`${W}/plugins/weather/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-security-policy'), policy, file);
  }
  const financePolicy = (await get(`${FP}/__atmos/frame.html?ext=plugin:finance`)).headers.get('content-security-policy');
  assert.equal((await get(`${FP}/plugins/finance/panel.js`)).headers.get('content-security-policy'), financePolicy);
  // A library's modules carry the library's own policy, never its importer's.
  const library = await get(`${FP}/services/charting/chart.js`, { origin: W });
  assert.doesNotMatch(library.headers.get('content-security-policy'), /open-meteo/);
  assert.match(library.headers.get('content-security-policy'), /default-src 'none'/);
});

test('Core’s SDK files, to origins that have an extension', async () => {
  for (const [rel, file] of Object.entries(SDK_FILES)) {
    const response = await get(`${W}${rel}`);
    assert.equal(response.status, 200, rel);
    assert.equal(response.body, fs.readFileSync(path.join(root, 'sdk', file), 'utf8'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'", rel);
  }
  assert.equal((await get(`${W}/__atmos/sdk.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get(`${W}/__atmos/ui.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await get('atmos-ext://plugin-nobody/__atmos/sdk.js')).status, 404);
  assert.equal((await get(`${W}/__atmos/other.js`)).status, 404);
});

test('a library’s modules, cross-origin only to frames that declared it', async () => {
  const declared = await get(`${FP}/services/charting/chart.js`, { origin: W });
  assert.equal(declared.status, 200);
  assert.equal(declared.headers.get('access-control-allow-origin'), W);
  assert.equal(declared.headers.get('vary'), 'Origin');
  // Served (it's on its own origin) but with no CORS grant, so another origin's import fails.
  const undeclared = await get(`${FP}/services/charting/chart.js`, { origin: MX });
  assert.equal(undeclared.status, 200);
  assert.equal(undeclared.headers.get('access-control-allow-origin'), null);
  assert.equal((await get(`${FP}/services/charting/chart.js`, { origin: 'null' })).headers.get('access-control-allow-origin'), null);
  // A library that isn't running, or a service that isn't a library, serves nothing.
  assert.equal((await get(`${FP}/services/charting/chart.js`, { origin: W, inactive: [charting] })).status, 404);
  // Only from the library's own origin.
  assert.equal((await get(`${W}/services/charting/chart.js`, { origin: W })).status, 404);
  assert.equal((await get(`${FP}/services/missing/chart.js`, { origin: W })).status, 404);
});

test('the storage move’s pages exist only while that move runs, on its two origins', async () => {
  assert.equal((await get(`${FP}/__atmos/move.html`)).status, 404);
  assert.equal((await get(`${FP}/__atmos/move.js`)).status, 404);
  const move = { host: 'first-party-plugin-matrix', removeHost: null };
  const exporting = await get(`${FP}/__atmos/move.html`, { move });
  assert.equal(exporting.status, 200);
  assert.equal(exporting.body, frames.moveDocument('export'));
  assert.equal(exporting.headers.get('content-security-policy'), frames.moveCsp('export'));
  const importing = await get(`${MX}/__atmos/move.html`, { move });
  assert.equal(importing.body, frames.moveDocument('import'));
  assert.equal(importing.headers.get('content-security-policy'), frames.moveCsp('import'));
  assert.equal((await get(`${MX}/__atmos/move.js`, { move })).body, '// move');
  // Anyone else: nothing, even during the move.
  assert.equal((await get(`${W}/__atmos/move.html`, { move })).status, 404);
  assert.equal((await get(`${W}/__atmos/move.js`, { move })).status, 404);
  // A removal: the origin whose storage is deleted exports.
  const removal = { host: null, removeHost: 'plugin-weather' };
  assert.equal((await get(`${W}/__atmos/move.html`, { move: removal })).body, frames.moveDocument('export'));
  assert.equal((await get(`${MX}/__atmos/move.html`, { move: removal })).status, 404);
});

test('the blank page is the shared origin’s only, and runs nothing', async () => {
  const blank = await get(`${FP}/__atmos/blank.html`);
  assert.equal(blank.status, 200);
  assert.equal(blank.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal((await get(`${W}/__atmos/blank.html`)).status, 404);
});

test('a failure is a 500, logged without the request’s details', async () => {
  const errors = [];
  const response = await get(`${W}/plugins/weather/panel.js`, { entries: 'boom', errors });
  assert.equal(response.status, 500);
  assert.equal(response.body, 'Error');
  assert.match(errors[0], /atmos-ext protocol error: catalog unreadable/);
  assert.equal((await get(`${W}/plugins/weather/%E0%A4%A`)).status, 500); // a malformed escape
});

test('frame access: libraries and resource providers, as main.js decides them', () => {
  const rules = access();
  assert.equal(rules.libraryService('charting'), charting);
  assert.equal(rules.libraryService('missing'), null);
  assert.equal(access({ inactive: [charting] }).libraryService('charting'), null);
  services.notLibrary = ext('service', 'not-library', 'first-party');
  try { assert.equal(rules.libraryService('notLibrary'), null); } finally { delete services.notLibrary; }
  // The library's origin goes into the CSP of frames that declared it, unless it is their own origin.
  assert.deepEqual(rules.libraryOriginsFor(weather), [FP]);
  assert.deepEqual(rules.libraryOriginsFor(finance), []); // same origin as the library
  assert.deepEqual(rules.libraryOriginsFor(matrix), []); // didn't declare it
  // CORS: only an origin whose running extension declared that library.
  assert.equal(rules.originMayUseLibrary(W, charting), true);
  assert.equal(rules.originMayUseLibrary(MX, charting), false);
  assert.equal(rules.originMayUseLibrary('atmos-ext://plugin-nobody', charting), false);
  assert.equal(access({ entries: [finance, matrix] }).originMayUseLibrary(W, charting), false); // not running
  // Resource providers: its own, once each; another origin's never.
  assert.deepEqual(rules.resourceProvidersFor(weather), ['weather-maps']);
  assert.deepEqual(rules.resourceProvidersFor(finance), []);
  assert.equal(rules.originMayUseResource(W, 'weather-maps'), true);
  assert.equal(rules.originMayUseResource(FP, 'weather-maps'), false);
  assert.equal(rules.originMayUseResource(W, 'other'), false);
});

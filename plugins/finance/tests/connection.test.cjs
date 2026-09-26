// Finance's portfolio server connection (main.cjs): which addresses are
// accepted, pairing codes, the sealed store and its one-time migration from
// portfolio-vps.json, and the IPC the Connections widget uses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const main = require('../main.cjs');
const { requireServer, parsePairingCode, createPairingCode, createConnectionStore, probeServer } = main;
const TOKEN = 't'.repeat(40);

// Stand-in for Electron's safeStorage: reversible, but not plain text.
const fakeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(text, 'utf8').map(byte => byte ^ 0x5a),
  decryptString: buffer => Buffer.from(buffer).map(byte => byte ^ 0x5a).toString('utf8'),
});

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-connection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('servers: https anywhere, http only on Tailscale or this computer, root address only', () => {
  assert.equal(requireServer('https://portfolio.test:8443/', TOKEN).baseUrl, 'https://portfolio.test:8443');
  assert.equal(requireServer('http://100.64.0.1:8787', TOKEN).baseUrl, 'http://100.64.0.1:8787');
  assert.equal(requireServer('http://127.0.0.1:8787', TOKEN).baseUrl, 'http://127.0.0.1:8787');
  assert.equal(requireServer('http://localhost:8787', TOKEN).baseUrl, 'http://localhost:8787');
  for (const bad of ['http://portfolio.test', 'http://192.168.1.5:8787', 'ftp://portfolio.test', 'https://portfolio.test/api', 'https://portfolio.test/?a=1', 'https://user:pw@portfolio.test', 'not a url']) {
    assert.throws(() => requireServer(bad, TOKEN), TypeError, bad);
  }
  assert.throws(() => requireServer('https://portfolio.test', 'short'), /too short/);
  assert.throws(() => requireServer('https://portfolio.test', `${'x'.repeat(20)} ${'y'.repeat(20)}`), /spaces/);
});

test('pairing codes round-trip and reject damage', () => {
  const code = createPairingCode('https://portfolio.test', TOKEN);
  assert.match(code, /^atmos-finance:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parsePairingCode(` ${code.slice(0, 30)}\n${code.slice(30)} `), { baseUrl: 'https://portfolio.test', token: TOKEN }, 'line breaks from copying are ignored');
  assert.throws(() => parsePairingCode('https://portfolio.test'), /starts with atmos-finance:/);
  assert.throws(() => parsePairingCode('atmos-finance:%%%'), /damaged/);
  const insecure = 'atmos-finance:' + Buffer.from(JSON.stringify({ url: 'http://portfolio.test', token: TOKEN })).toString('base64url');
  assert.throws(() => parsePairingCode(insecure), /https/);
});

test('the store seals the token, migrates portfolio-vps.json once and clears both', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'finance', 'connection.bin');
  const legacyFile = path.join(dir, 'portfolio-vps.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ baseUrl: 'http://100.86.0.9:8787', token: TOKEN }));

  const store = createConnectionStore({ file, legacyFile, storage: fakeStorage() });
  assert.deepEqual(store.get(), { baseUrl: 'http://100.86.0.9:8787', token: TOKEN, protected: true });
  assert.equal(fs.existsSync(legacyFile), false, 'the plain legacy file is removed once the sealed copy reads back');
  const sealed = fs.readFileSync(file);
  assert.equal(sealed[0], 1);
  assert.equal(sealed.includes(Buffer.from(TOKEN)), false, 'the token is not stored in plain text');

  const reopened = createConnectionStore({ file, legacyFile, storage: fakeStorage() });
  assert.equal(reopened.get().token, TOKEN);
  reopened.save({ baseUrl: 'https://portfolio.test', token: 'u'.repeat(40) });
  assert.equal(createConnectionStore({ file, legacyFile, storage: fakeStorage() }).get().baseUrl, 'https://portfolio.test');
  reopened.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(createConnectionStore({ file, legacyFile, storage: fakeStorage() }).get(), null);
});

test('without secure storage the token is kept plainly, then sealed once storage appears', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'finance', 'connection.bin');
  const legacyFile = path.join(dir, 'portfolio-vps.json');
  createConnectionStore({ file, legacyFile, storage: fakeStorage(false) }).save({ baseUrl: 'https://portfolio.test', token: TOKEN });
  assert.equal(fs.readFileSync(file)[0], 0);
  const later = createConnectionStore({ file, legacyFile, storage: fakeStorage(true) });
  assert.equal(later.get().protected, true);
  assert.equal(fs.readFileSync(file)[0], 1);
});

test('an unreadable connection file means no server rather than a crash', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'finance', 'connection.bin');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([7, 1, 2, 3]));
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(createConnectionStore({ file, legacyFile: path.join(dir, 'none.json'), storage: fakeStorage() }).get(), null); }
  finally { console.warn = warn; }
});

test('probing: /v1/info, older servers through /v1/portfolio, and plain-language failures', async () => {
  const server = { baseUrl: 'https://portfolio.test', token: TOKEN };
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const seen = [];
  const info = await probeServer(server, async (url, init) => {
    seen.push([String(url), init.headers.Authorization]);
    return respond(200, { name: 'atmos-portfolio', version: '0.6.0', sources: 3, lastUpdate: 5 });
  });
  assert.deepEqual(info, { ok: true, version: '0.6.0', sources: 3, lastUpdate: 5 });
  assert.deepEqual(seen, [['https://portfolio.test/v1/info', `Bearer ${TOKEN}`]]);

  const older = await probeServer(server, async url => String(url).endsWith('/v1/info')
    ? respond(404, {}) : respond(200, { timestamp: 9, sources: [{}, {}] }));
  assert.deepEqual(older, { ok: true, version: null, sources: 2, lastUpdate: 9 });

  assert.equal((await probeServer(server, async () => respond(401, {}))).error, 'The server refused the token');
  assert.match((await probeServer(server, async () => respond(200, { name: 'something-else' }))).error, /doesn.t look like/);
  assert.equal((await probeServer(server, async () => { throw new TypeError('fetch failed'); })).error, 'Couldn’t reach the server');
});

test('IPC: status never includes the token; connect saves only a server that answers; disconnect clears', async t => {
  const dir = tempDir(t);
  const handlers = new Map();
  await main({ app: { getPath: () => dir }, handle: (name, handler) => handlers.set(name, handler) });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  assert.deepEqual(await call('vps:status'), { configured: false });
  assert.deepEqual(await call('vps:connect', { baseUrl: 'http://portfolio.test', token: TOKEN }),
    { ok: false, error: 'Use an https:// address, or http:// only on Tailscale or this computer' });

  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const refused = await call('vps:connect', { code: createPairingCode('https://portfolio.test', TOKEN) });
  assert.equal(refused.ok, false);
  assert.deepEqual(await call('vps:status'), { configured: false }, 'a server that refuses is not saved');

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ name: 'atmos-portfolio', version: '0.6.0', sources: 1, lastUpdate: 1 }) });
  const tested = await call('vps:test', { code: createPairingCode('https://portfolio.test', TOKEN) });
  assert.equal(tested.ok, true);
  assert.deepEqual(await call('vps:status'), { configured: false }, 'testing does not save');
  const connected = await call('vps:connect', { code: createPairingCode('https://portfolio.test', TOKEN) });
  assert.equal(connected.ok, true);
  const status = await call('vps:status');
  assert.equal(status.configured, true);
  assert.equal(status.address, 'https://portfolio.test');
  assert.equal(JSON.stringify([status, tested, connected]).includes(TOKEN), false, 'the token never goes back to the renderer');

  await call('vps:disconnect');
  assert.deepEqual(await call('vps:status'), { configured: false });
});

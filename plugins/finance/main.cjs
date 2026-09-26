'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Absent when this file is loaded outside Electron (the unit tests).
let safeStorage = null;
try { safeStorage = require('electron').safeStorage; } catch { /* not in Electron */ }

// The watchlist reaches CoinGecko through here (src/network.js): cached, and
// the last good response is served while it rate-limits.
const NETWORK_HOSTS = new Set(['api.coingecko.com']);
const NETWORK_CACHE_MS = 30_000;
const NETWORK_STALE_MS = 15 * 60_000;

// ── Portfolio server connection ────────────────────────────────────────────
// Finance reads the portfolio from a server the user runs (backend/) or a
// hosted one. The address and token live only here in the main process:
// sealed with the system's secure storage in <userData>/finance/connection.bin
// (DPAPI on Windows, Keychain on macOS, the secret service on Linux). The
// renderer learns whether a server is set and its address, never the token.

const PAIRING_PREFIX = 'atmos-finance:';
const PROTECTED = 1;
const PLAIN = 0;

function isTailscaleIpv4(hostname) {
  const parts = String(hostname).split('.').map(Number);
  return parts.length === 4
    && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100
    && parts[1] >= 64
    && parts[1] <= 127;
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}

/**
 * A server address and token Finance will use: https:// anywhere, or plain
 * http:// only to this computer or a Tailscale address (both private links).
 * The address is the server's root: no path, query, fragment or credentials.
 */
function requireServer(baseUrl, token) {
  let url;
  try { url = new URL(String(baseUrl || '').trim()); }
  catch { throw new TypeError('That isn’t a server address'); }
  const privateHttp = url.protocol === 'http:' && (isTailscaleIpv4(url.hostname) || isLoopback(url.hostname));
  if (url.protocol !== 'https:' && !privateHttp) {
    throw new TypeError('Use an https:// address, or http:// only on Tailscale or this computer');
  }
  if (url.username || url.password) throw new TypeError('The address must not contain a user name or password');
  if (url.pathname !== '/' || url.search || url.hash) throw new TypeError('Use the server’s address without a path');
  const secret = String(token || '').trim();
  if (secret.length < 32 || !/^[\x21-\x7e]+$/.test(secret)) throw new TypeError('The token is too short or contains spaces');
  return { baseUrl: url.origin, token: secret };
}

/** `atmos-finance:` + base64url JSON { url, token }, as printed by the server's `pairing` command. */
function parsePairingCode(code) {
  const value = String(code || '').replace(/\s+/g, '');
  if (!value.startsWith(PAIRING_PREFIX)) throw new TypeError('A pairing code starts with atmos-finance:');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new TypeError('That pairing code is damaged; copy it again'); }
  return requireServer(decoded?.url, decoded?.token);
}

function createPairingCode(baseUrl, token) {
  const server = requireServer(baseUrl, token);
  return PAIRING_PREFIX + Buffer.from(JSON.stringify({ url: server.baseUrl, token: server.token })).toString('base64url');
}

function requireVpsRoute(value, baseUrl) {
  const route = String(value || '');
  if (!route.startsWith('/v1/')) throw new TypeError('Unsupported portfolio VPS route');
  const url = new URL(route, baseUrl + '/');
  if (url.origin !== new URL(baseUrl).origin
      || !['/v1/portfolio', '/v1/history', '/v1/holdings-history'].includes(url.pathname)) {
    throw new TypeError('Unsupported portfolio VPS route');
  }
  return url;
}

/**
 * The saved connection. `legacyFile` is the plain portfolio-vps.json earlier
 * versions read; it is moved into the sealed file once and deleted.
 */
function createConnectionStore({ file, legacyFile, storage = safeStorage, fsImpl = fs }) {
  let cached = null;

  function write(server) {
    const json = JSON.stringify({ baseUrl: server.baseUrl, token: server.token });
    const canProtect = !!storage?.isEncryptionAvailable?.();
    const body = canProtect
      ? Buffer.concat([Buffer.from([PROTECTED]), storage.encryptString(json)])
      : Buffer.concat([Buffer.from([PLAIN]), Buffer.from(json, 'utf8')]);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fsImpl.writeFileSync(temporary, body, { mode: 0o600 });
    fsImpl.renameSync(temporary, file);
    cached = { ...server, protected: canProtect };
    return cached;
  }

  function readSealed() {
    let stored;
    try { stored = fsImpl.readFileSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const json = stored[0] === PROTECTED ? storage.decryptString(stored.subarray(1))
      : stored[0] === PLAIN ? stored.subarray(1).toString('utf8')
      : null;
    if (json == null) throw new Error('connection file is not recognised');
    const saved = JSON.parse(json);
    const server = requireServer(saved.baseUrl, saved.token);
    // Secure storage became available since it was saved plainly: seal it now.
    if (stored[0] === PLAIN && storage?.isEncryptionAvailable?.()) return write(server);
    return { ...server, protected: stored[0] === PROTECTED };
  }

  function migrateLegacy() {
    let raw;
    try { raw = fsImpl.readFileSync(legacyFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const legacy = JSON.parse(raw);
    const saved = write(requireServer(legacy.baseUrl, legacy.token));
    // Only remove the old file once the sealed copy reads back the same.
    const check = readSealed();
    if (check?.baseUrl === saved.baseUrl && check?.token === saved.token) fsImpl.rmSync(legacyFile, { force: true });
    return check;
  }

  return {
    /** { baseUrl, token, protected } or null. */
    get() {
      // "Nothing saved" isn't cached: a file put in place later is still found.
      if (cached) return cached;
      try { cached = readSealed() ?? migrateLegacy(); }
      catch (error) {
        console.warn('[finance] saved portfolio server is unreadable:', error.message);
        cached = null;
      }
      return cached;
    },
    save(server) { return write(requireServer(server.baseUrl, server.token)); },
    clear() {
      cached = null;
      fsImpl.rmSync(file, { force: true });
      fsImpl.rmSync(legacyFile, { force: true });
    },
  };
}

/** Plain-language reason for a failed request. */
function describeFailure(status, error) {
  if (status === 401 || status === 403) return 'The server refused the token';
  if (status === 404) return 'That address doesn’t look like an Atmos portfolio server';
  if (status) return `The server answered with an error (HTTP ${status})`;
  return error?.name === 'TimeoutError' ? 'The server didn’t answer in time' : 'Couldn’t reach the server';
}

/** Ask a server who it is: /v1/info, or /v1/portfolio on servers from before /v1/info. */
async function probeServer(server, fetchImpl = fetch) {
  const request = route => fetchImpl(new URL(route, server.baseUrl + '/'), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(12_000),
  });
  try {
    let response = await request('/v1/info');
    if (response.status === 404) {
      response = await request('/v1/portfolio');
      if (!response.ok) return { ok: false, error: describeFailure(response.status) };
      const portfolio = await response.json();
      return { ok: true, version: null, sources: (portfolio.sources || []).length, lastUpdate: portfolio.timestamp ?? null };
    }
    if (!response.ok) return { ok: false, error: describeFailure(response.status) };
    const info = await response.json();
    if (info?.name !== 'atmos-portfolio') return { ok: false, error: describeFailure(404) };
    return { ok: true, version: info.version ?? null, sources: Number(info.sources) || 0, lastUpdate: info.lastUpdate ?? null };
  } catch (error) {
    return { ok: false, error: describeFailure(0, error) };
  }
}

/** The server a renderer asked about: a pairing code, or an address and token. */
function serverFromRequest(request = {}) {
  return request.code ? parsePairingCode(request.code) : requireServer(request.baseUrl, request.token);
}

module.exports = async function activate(context) {
  const { app } = context;
  const userData = app.getPath('userData');
  const connection = createConnectionStore({
    file: path.join(userData, 'finance', 'connection.bin'),
    legacyFile: path.join(userData, 'portfolio-vps.json'),
  });

  const networkCache = new Map();
  const networkPending = new Map();
  // Entries beyond the stale fallback window can never be served again.
  // Prune them opportunistically so variable GET URLs cannot make this
  // activation-scoped cache grow for the lifetime of the app.
  const pruneNetworkCache = now => {
    for (const [key, entry] of networkCache) {
      if (now - entry.savedAt >= NETWORK_STALE_MS) networkCache.delete(key);
    }
  };
  context.handle('network:fetch', async (_event, request = {}) => {
    const method = String(request.method || 'GET').toUpperCase();
    const url = new URL(String(request.url || ''));
    if (url.protocol !== 'https:' || !NETWORK_HOSTS.has(url.hostname)) {
      throw new TypeError('Network host is not allowed');
    }
    if (method !== 'GET') throw new TypeError('Network method is not allowed');

    const now = Date.now();
    pruneNetworkCache(now);
    const key = `${method} ${url.href}`;
    const cached = networkCache.get(key);
    if (method === 'GET' && cached && now - cached.savedAt < NETWORK_CACHE_MS) return cached.value;
    if (networkPending.has(key)) return networkPending.get(key);

    const pending = (async () => {
      try {
        const response = await fetch(url, {
          method,
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        const value = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        };
        if (method === 'GET' && response.ok) networkCache.set(key, { savedAt: Date.now(), value });
        if ((!response.ok || response.status === 429) && cached && Date.now() - cached.savedAt < NETWORK_STALE_MS) {
          return { ...cached.value, headers: { ...cached.value.headers, 'x-atmos-stale': '1' } };
        }
        return value;
      } catch (error) {
        if (cached && Date.now() - cached.savedAt < NETWORK_STALE_MS) {
          return { ...cached.value, headers: { ...cached.value.headers, 'x-atmos-stale': '1' } };
        }
        return { status: 502, statusText: 'Upstream request failed', headers: {}, body: JSON.stringify({ error: error.message }) };
      } finally {
        networkPending.delete(key);
      }
    })();
    networkPending.set(key, pending);
    return pending;
  });

  /** { configured, address?, protected? } — never the token. */
  context.handle('vps:status', () => {
    const server = connection.get();
    return server ? { configured: true, address: server.baseUrl, protected: server.protected } : { configured: false };
  });

  /** Check a server without saving it. */
  context.handle('vps:test', async (_event, request) => {
    let server;
    try { server = serverFromRequest(request); }
    catch (error) { return { ok: false, error: error.message }; }
    return { ...(await probeServer(server)), address: server.baseUrl };
  });

  /** Check a server, then save it if it answers. */
  context.handle('vps:connect', async (_event, request) => {
    let server;
    try { server = serverFromRequest(request); }
    catch (error) { return { ok: false, error: error.message }; }
    const result = await probeServer(server);
    if (!result.ok) return { ...result, address: server.baseUrl };
    const saved = connection.save(server);
    return { ...result, address: saved.baseUrl, protected: saved.protected };
  });

  context.handle('vps:disconnect', () => {
    connection.clear();
    return { configured: false };
  });

  context.handle('vps:fetch', async (_event, route) => {
    try {
      const server = connection.get();
      if (!server) return { ok: false, status: 0, body: '', error: 'No portfolio server is set up' };
      const url = requireVpsRoute(route, server.baseUrl);
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${server.token}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.text();
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, body: '', error: error.message };
    }
  });
};

module.exports.isTailscaleIpv4 = isTailscaleIpv4;
module.exports.requireServer = requireServer;
module.exports.requireVpsRoute = requireVpsRoute;
module.exports.parsePairingCode = parsePairingCode;
module.exports.createPairingCode = createPairingCode;
module.exports.createConnectionStore = createConnectionStore;
module.exports.probeServer = probeServer;

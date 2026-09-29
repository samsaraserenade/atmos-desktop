'use strict';
/**
 * atmos.fetch(): HTTP requests a framed extension makes through Atmos's main
 * process, for APIs a frame can't read itself (no CORS headers).
 *
 * The frame's own fetch() is limited by its Content-Security-Policy and by
 * CORS. This relay replaces CORS with Atmos's own rules, so it must not add
 * anything the extension couldn't otherwise reach:
 *
 *   - https only, on the default port, to hosts in "permissions.network"
 *     (the same list the frame's CSP is built from); every redirect is
 *     checked the same way;
 *   - never a private, loopback, link-local or otherwise local address,
 *     checked on the address actually connected to, so a name that
 *     resolves somewhere else a second time (DNS rebinding) gains nothing;
 *   - no cookies, no HTTP cache, no credentials of the user's: the relay
 *     has no ambient authority, only what the extension sends itself;
 *   - bounded: 30 s per request, 5 MB up, 10 MB down (after decompression),
 *     at most 6 requests at once per extension; up to 24 more (32 MB of
 *     bodies) wait their turn, and anything beyond that is refused at once.
 *
 * Node's https module is used rather than Electron's net: it lets the
 * address be checked at connect time. The system's certificate store is
 * trusted as well as Node's own.
 */

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { hostAllowed } = require('./extension-permissions.cjs');

const LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxRequestBytes: 5 * 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  maxConcurrent: 6,
  maxQueued: 24,
  maxQueuedBytes: 32 * 1024 * 1024,
  maxHeaders: 64,
  maxHeaderBytes: 8 * 1024,
  maxUrlLength: 8 * 1024,
});
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Request headers the relay sets itself, or that would make it something
// other than one plain request from the extension.
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'cookie2', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'origin', 'referer', 'expect',
  'via', 'accept-encoding', 'http2-settings',
]);
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

// Addresses no extension may reach: this computer, the local network,
// carrier-grade NAT (Tailscale among it), link-local, multicast, reserved.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
]) BLOCKED.addSubnet(address, prefix, 'ipv6');

/** The IPv4 address an IPv6 one carries (mapped, NAT64, 6to4), or null. */
function embeddedIPv4(address) {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^(?:0{0,4}:){0,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
    || lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  const parts = hex || sixToFour;
  if (!parts) return null;
  const high = parseInt(parts[1], 16);
  const low = parseInt(parts[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Whether an IP address is one extensions may never reach. */
function isBlockedAddress(address) {
  const text = String(address || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(text);
  if (family === 4) return BLOCKED.check(text, 'ipv4');
  if (family === 6) {
    const inner = embeddedIPv4(text);
    if (inner && net.isIP(inner) === 4) return BLOCKED.check(inner, 'ipv4');
    return BLOCKED.check(text, 'ipv6');
  }
  return true;
}

class FetchError extends Error {
  constructor(message, name = 'TypeError') {
    super(message);
    this.name = name;
  }
}

/** Trusted CAs: Node's own and the system's (where this Node can read them). */
function defaultCa() {
  try {
    if (typeof tls.getCACertificates !== 'function') return undefined;
    return [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
  } catch {
    return undefined;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.userAgent]
 * @param {Function} [options.lookup]      dns.lookup(hostname, options, callback) (tests)
 * @param {(address: string) => boolean} [options.blockAddress]
 * @param {string[]} [options.ca]          extra trusted certificates (tests)
 * @param {Record<string, { address: string, port: number }>} [options.testHosts]
 *        unpackaged end-to-end runs only: names answered by a local test
 *        server, allowed although local
 * @param {Partial<typeof LIMITS>} [options.limits]
 */
function createExtensionFetch({
  userAgent = 'Atmos', lookup = dns.lookup, blockAddress = isBlockedAddress, ca = null, testHosts = {}, limits = {},
} = {}) {
  const limit = { ...LIMITS, ...limits };
  const trusted = defaultCa();
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 16,
    ...(trusted || ca ? { ca: [...(trusted || []), ...(ca || [])] } : {}),
  });
  const running = new Map(); // caller -> number in flight
  const waiting = new Map(); // caller -> [{ start, bytes }]
  // Test hosts come from a file; only its own names count (never "constructor").
  const testHost = name => (Object.hasOwn(testHosts, name) ? testHosts[name] : null);

  /** net.connect's lookup: only addresses extensions may reach. */
  function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const test = testHost(hostname);
    if (test) {
      const family = net.isIP(test.address);
      return options?.all ? callback(null, [{ address: test.address, family }]) : callback(null, test.address, family);
    }
    lookup(hostname, { all: true, family: options?.family || 0, hints: options?.hints }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = (addresses || []).filter(item => !blockAddress(item.address));
      if (!allowed.length) {
        const refused = new Error(`${hostname} is on a private or local network, which extensions can't reach`);
        refused.code = 'ATMOS_PRIVATE_ADDRESS';
        return callback(refused);
      }
      if (options?.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    });
  }

  /** The URL of one hop, checked: https, default port, a declared host, no credentials. */
  function checkUrl(text, network) {
    let url;
    try { url = new URL(text); } catch { throw new FetchError(`'${String(text).slice(0, 200)}' is not a URL`); }
    if (url.protocol !== 'https:') throw new FetchError(`atmos.fetch() only reaches https:// addresses (${url.protocol}//${url.host})`);
    if (url.username || url.password) throw new FetchError('atmos.fetch() URLs can\'t carry a user name or password');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const test = testHost(hostname);
    if (url.port && url.port !== '443' && !test) throw new FetchError(`atmos.fetch() only reaches the default https port (${url.host})`);
    if (!hostAllowed(hostname, network)) {
      throw new FetchError(`${hostname} isn't in this extension's "permissions.network"`, 'AtmosPermissionError');
    }
    if (net.isIP(hostname) && blockAddress(hostname) && !test) {
      throw new FetchError(`${hostname} is on a private or local network, which extensions can't reach`);
    }
    return { url, hostname, test };
  }

  function cleanHeaders(headers, userAgentFallback) {
    if (!Array.isArray(headers) || headers.length > limit.maxHeaders) throw new FetchError(`at most ${limit.maxHeaders} request headers`);
    const out = {};
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        throw new FetchError('request headers are [name, value] pairs of strings');
      }
      const name = pair[0].toLowerCase();
      if (!TOKEN.test(name)) throw new FetchError(`'${pair[0].slice(0, 60)}' is not a header name`);
      if (/[\r\n\0]/.test(pair[1]) || pair[1].length > limit.maxHeaderBytes) throw new FetchError(`the '${name}' header's value isn't allowed`);
      if (DROPPED_REQUEST_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue;
      out[name] = name in out ? `${out[name]}, ${pair[1]}` : pair[1];
    }
    if (!out['user-agent']) out['user-agent'] = userAgentFallback;
    if (!out.accept) out.accept = '*/*';
    out['accept-encoding'] = 'gzip, deflate, br';
    return out;
  }

  /** One request and its response body (decoded, capped), without following redirects. */
  function once({ url, hostname, test }, method, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const options = {
        method,
        host: hostname,
        servername: net.isIP(hostname) ? undefined : hostname,
        port: test ? test.port : 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        agent,
        lookup: safeLookup,
        signal,
      };
      const request = https.request(options, response => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (REDIRECTS.has(status) && location) {
          // Close it rather than drain it: a redirect's body is never read,
          // and draining would let a server stream into Atmos past every limit.
          response.destroy();
          resolve({ status, statusText: response.statusMessage || '', headers: response.rawHeaders, location, body: Buffer.alloc(0) });
          return;
        }
        const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
        let stream = response;
        if (method !== 'HEAD' && status !== 204 && status !== 304) {
          if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip());
          else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate());
          else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress());
        }
        const chunks = [];
        let size = 0;
        let failed = false;
        const fail = error => {
          if (failed) return;
          failed = true;
          response.destroy();
          stream.destroy?.();
          reject(error);
        };
        if (stream !== response) response.on('error', error => fail(new FetchError(`couldn't read the response from ${hostname}: ${error.message}`)));
        stream.on('data', chunk => {
          size += chunk.length;
          if (size > limit.maxResponseBytes) {
            fail(new FetchError(`the response from ${hostname} is larger than ${Math.round(limit.maxResponseBytes / 1048576)} MB`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', error => fail(error.name === 'FetchError' || error instanceof FetchError ? error : new FetchError(`couldn't read the response from ${hostname}: ${error.message}`)));
        stream.on('end', () => resolve({
          status, statusText: response.statusMessage || http.STATUS_CODES[status] || '', headers: response.rawHeaders, body: Buffer.concat(chunks),
        }));
      });
      request.on('error', reject);
      if (body) request.end(body); else request.end();
    });
  }

  /**
   * Wait for a slot among this caller's requests. A full queue refuses at
   * once, and a request aborted while it waits leaves the queue.
   */
  async function slot(caller, bytes, signal) {
    if ((running.get(caller) || 0) >= limit.maxConcurrent) {
      const queue = waiting.get(caller) || [];
      const queuedBytes = queue.reduce((sum, item) => sum + item.bytes, 0);
      if (queue.length >= limit.maxQueued || queuedBytes + bytes > limit.maxQueuedBytes) {
        throw new FetchError(`too many atmos.fetch() requests at once (${limit.maxConcurrent} run and ${limit.maxQueued} wait; try again when some finish)`);
      }
      await new Promise((resolve, reject) => {
        const item = { bytes, start: resolve };
        const onAbort = () => {
          const list = waiting.get(caller) || [];
          const index = list.indexOf(item);
          if (index >= 0) list.splice(index, 1);
          if (!list.length) waiting.delete(caller);
          reject(signal.reason);
        };
        item.start = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
        if (!waiting.has(caller)) waiting.set(caller, []);
        waiting.get(caller).push(item);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    running.set(caller, (running.get(caller) || 0) + 1);
    return () => {
      const count = (running.get(caller) || 1) - 1;
      if (count) running.set(caller, count); else running.delete(caller);
      const next = waiting.get(caller)?.shift();
      if (!waiting.get(caller)?.length) waiting.delete(caller);
      next?.start();
    };
  }

  /**
   * Make `request` ({ url, method, headers: [[name, value]], body: Uint8Array
   * | null, redirect: 'follow' | 'error' | 'manual' }) for `caller`
   * ("plugin:<id>"), limited to `network` (its normalised
   * permissions.network). Resolves { url, status, statusText, headers,
   * body, redirected }, or rejects with an Error whose name is TypeError
   * (network failures, bad requests), AtmosPermissionError (an undeclared
   * host), AbortError or TimeoutError.
   */
  async function fetch(caller, network, request, { signal = null } = {}) {
    if (!request || typeof request !== 'object') throw new FetchError('atmos.fetch() needs a request');
    if (typeof request.url !== 'string' || request.url.length > limit.maxUrlLength) throw new FetchError('the URL is missing or too long');
    let method = String(request.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new FetchError(`atmos.fetch() doesn't send ${method} requests`);
    const redirect = ['follow', 'error', 'manual'].includes(request.redirect) ? request.redirect : 'follow';
    let body = request.body == null ? null : Buffer.from(request.body.buffer ?? request.body, request.body.byteOffset ?? 0, request.body.byteLength);
    if (body && body.length > limit.maxRequestBytes) throw new FetchError(`a request body is at most ${Math.round(limit.maxRequestBytes / 1048576)} MB`);
    if (body && (method === 'GET' || method === 'HEAD')) throw new FetchError(`a ${method} request can't have a body`);
    let headers = cleanHeaders(request.headers || [], userAgent);
    let target = checkUrl(request.url, network);

    const controller = new AbortController();
    const onAbort = () => controller.abort(new FetchError('The request was aborted', 'AbortError'));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let release;
    try {
      release = await slot(caller, body ? body.length : 0, controller.signal);
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      throw error;
    }
    // The 30 s count from when the request gets its turn.
    const timer = setTimeout(() => controller.abort(new FetchError(`${target.hostname} didn't answer within ${Math.round(limit.timeoutMs / 1000)} s`, 'TimeoutError')), limit.timeoutMs);
    try {
      for (let hops = 0; ; hops += 1) {
        let result;
        try {
          result = await once(target, method, headers, body, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof FetchError) throw error;
          const reason = error.code === 'ATMOS_PRIVATE_ADDRESS' ? error.message
            : error.code === 'ENOTFOUND' ? `${target.hostname} wasn't found`
              : `couldn't reach ${target.hostname} (${error.code || error.message})`;
          throw new FetchError(reason);
        }
        if (result.location && redirect !== 'manual') {
          if (redirect === 'error') throw new FetchError(`${target.hostname} redirected, and the request said redirect: 'error'`);
          if (hops >= limit.maxRedirects) throw new FetchError(`more than ${limit.maxRedirects} redirects`);
          let next;
          try { next = new URL(result.location, target.url).href; } catch { throw new FetchError(`${target.hostname} redirected to an invalid address`); }
          const previousHost = target.hostname;
          target = checkUrl(next, network);
          // As fetch() does: 303 (and 301/302 after a POST) become a GET without a body.
          if (result.status === 303 ? method !== 'HEAD' : (result.status === 301 || result.status === 302) && method === 'POST') {
            method = 'GET';
            body = null;
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith('content-')));
          }
          // Credentials meant for one host don't follow it to another.
          if (target.hostname !== previousHost) {
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'authorization'));
          }
          continue;
        }
        const out = [];
        for (let i = 0; i + 1 < result.headers.length; i += 2) {
          if (!DROPPED_RESPONSE_HEADERS.has(result.headers[i].toLowerCase())) out.push([result.headers[i], result.headers[i + 1]]);
        }
        return {
          url: target.url.href,
          status: result.status,
          statusText: result.statusText,
          headers: out,
          body: result.body,
          redirected: hops > 0,
        };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  return { fetch, limits: limit, close: () => agent.destroy() };
}

module.exports = { createExtensionFetch, isBlockedAddress, LIMITS };

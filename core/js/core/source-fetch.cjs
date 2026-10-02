'use strict';
/**
 * Downloads from an extension source (its index.json and packages, and the
 * Atmos installer an index names), over Electron's net.request:
 *
 * - Atmos's own protocol handlers are bypassed, so a source can't point
 *   Atmos at atmos-app: or atmos-ext: (Chromium itself refuses a redirect
 *   to file:).
 * - An https request stays https through every redirect. Redirects are
 *   followed one at a time for that: net.fetch doesn't say where one went
 *   (its Response.url is empty in Electron 44), and refuses manual ones.
 * - Never more than maxBytes, and a server that keeps Atmos waiting for
 *   stallMs (for its answer, or between parts of it) is given up on. A file
 *   being written that fails (a full disk) ends the download with that
 *   error.
 *
 * Integrity doesn't rest on any of this: an index is signed, and packages
 * and the installer are checked against its sizes and hashes. This keeps
 * what is fetched, and from where, private and bounded.
 */

const fs = require('fs');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const isHttps = url => /^https:\/\//i.test(url);
const fileName = url => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || url; } catch { return url; }
};

/**
 * @param {object} options
 * @param {{ request: Function }} options.net  Electron's net (or a stand-in in tests)
 * @param {number} [options.stallMs]          stop a download that sends nothing for this long
 * @param {number} [options.maxRedirects]
 */
function createSourceFetch({ net, stallMs = 60 * 1000, maxRedirects = 10 }) {
  /**
   * Open `url`: resolves with { status, ok, headers: { get }, body (a
   * readable stream), abort() } once the response starts.
   */
  function open(url, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled'));
      let settled = false;
      let timer = null;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { request.abort(); } catch { /* already gone */ }
        reject(error);
      };
      // No answer (Chromium also holds a response back while it sniffs the
      // first bytes of one without a Content-Type).
      const wait = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new Error(`${fileName(url)}: the server didn't answer`)), stallMs);
      };
      const request = net.request({ url, redirect: 'manual', bypassCustomProtocolHandlers: true, cache: 'no-store' });
      let hops = 0;
      request.on('redirect', (_status, _method, location) => {
        if (isHttps(url) && !isHttps(location)) return fail(new Error(`${fileName(url)}: redirected away from https`));
        if ((hops += 1) > maxRedirects) return fail(new Error(`${fileName(url)}: too many redirects`));
        wait();
        request.followRedirect();
      });
      request.on('response', response => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const headers = response.headers || {};
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: { get: name => { const value = headers[String(name).toLowerCase()]; return Array.isArray(value) ? value[0] : (value ?? null); } },
          body: response,
          abort: () => { try { request.abort(); } catch { /* already gone */ } },
        });
      });
      request.on('error', error => fail(error));
      signal?.addEventListener('abort', () => fail(new Error('Cancelled')), { once: true });
      wait();
      request.end();
    });
  }

  /** Check the status and declared length; refuse past maxBytes. */
  async function start(url, maxBytes, signal) {
    const response = await open(url, { signal });
    if (!response.ok) {
      response.abort();
      throw new Error(`${fileName(url)}: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.abort();
      throw new Error(`${fileName(url)} is larger than expected`);
    }
    return response;
  }

  /**
   * The body through a byte limit and a stall timer, into `destination`
   * (a writable stream), ending with the first error from either side.
   */
  async function transfer(response, destination, { url, maxBytes, signal, onProgress }) {
    const stall = new AbortController();
    let timer = null;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), stallMs);
    };
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        kick();
        size += chunk.length;
        if (size > maxBytes) return callback(new Error(`${fileName(url)} is larger than expected`));
        onProgress?.(size);
        callback(null, chunk);
      },
    });
    const stop = AbortSignal.any([stall.signal, ...(signal ? [signal] : [])]);
    // Electron's response ends only once its request is aborted.
    const abortRequest = () => response.abort();
    stop.addEventListener('abort', abortRequest, { once: true });
    kick();
    try {
      await pipeline(response.body, limit, destination, { signal: stop });
    } catch (error) {
      response.abort();
      if (stall.signal.aborted) throw new Error(`${fileName(url)}: the download stalled`);
      if (signal?.aborted) throw new Error('Cancelled');
      throw error;
    } finally {
      clearTimeout(timer);
      stop.removeEventListener('abort', abortRequest);
    }
    return size;
  }

  /** A file from a web source, in memory (an index, a package). */
  async function fetchBuffer(url, maxBytes, { signal } = {}) {
    const response = await start(url, maxBytes, signal);
    const chunks = [];
    const collect = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    await transfer(response, collect, { url, maxBytes, signal });
    return Buffer.concat(chunks);
  }

  /** A file from a web source, written to `file` (the installer). */
  async function downloadToFile(url, file, { maxBytes, signal, onProgress } = {}) {
    const response = await start(url, maxBytes, signal);
    await transfer(response, fs.createWriteStream(file), { url, maxBytes, signal, onProgress });
  }

  return { open, fetchBuffer, downloadToFile };
}

module.exports = { createSourceFetch };

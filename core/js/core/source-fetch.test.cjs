'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createSourceFetch } = require('./source-fetch.cjs');

/**
 * A stand-in for Electron's net: `routes` maps a URL to
 * { redirect: url } or { status, headers, chunks, stall }.
 */
function fakeNet(routes) {
  const requests = [];
  return {
    requests,
    request(options) {
      const request = new EventEmitter();
      let url = options.url;
      let aborted = false;
      requests.push(options);
      const answer = () => {
        if (aborted) return;
        const route = routes[url];
        if (!route) return request.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'));
        if (route.silent) return; // never answers
        if (route.redirect) {
          const next = route.redirect;
          request.followRedirect = () => { url = next; setImmediate(answer); };
          request.emit('redirect', 302, 'GET', next, {});
          return;
        }
        const chunks = route.chunks || [];
        const body = route.stall
          ? new Readable({ read() {} })
          : Readable.from(chunks.map(chunk => Buffer.from(chunk)));
        if (route.stall) body.push(Buffer.from(chunks[0] || 'x'));
        body.statusCode = route.status ?? 200;
        body.headers = route.headers || {};
        request.emit('response', body);
      };
      request.end = () => setImmediate(answer);
      request.abort = () => { aborted = true; };
      return request;
    },
  };
}

test('redirects are followed while they stay https, and refused when they leave it', async () => {
  const net = fakeNet({
    'https://a.example/index.json': { redirect: 'https://cdn.example/index.json' },
    'https://cdn.example/index.json': { chunks: ['{"ok":1}'] },
    'https://a.example/down.json': { redirect: 'http://cdn.example/index.json' },
    'http://cdn.example/index.json': { chunks: ['plain'] },
  });
  const source = createSourceFetch({ net });
  assert.equal((await source.fetchBuffer('https://a.example/index.json', 100)).toString(), '{"ok":1}');
  await assert.rejects(source.fetchBuffer('https://a.example/down.json', 100), /redirected away from https/);
  assert.deepEqual(net.requests.map(r => [r.redirect, r.bypassCustomProtocolHandlers]), [['manual', true], ['manual', true]]);
});

test('too many redirects are refused', async () => {
  const routes = {};
  for (let i = 0; i < 15; i += 1) routes[`https://a.example/${i}`] = { redirect: `https://a.example/${i + 1}` };
  const source = createSourceFetch({ net: fakeNet(routes), maxRedirects: 10 });
  await assert.rejects(source.fetchBuffer('https://a.example/0', 100), /too many redirects/);
});

test('an error status, a declared length past the limit, and a body past it are refused', async () => {
  const source = createSourceFetch({ net: fakeNet({
    'https://a.example/missing': { status: 404 },
    'https://a.example/declared': { headers: { 'content-length': '1000' }, chunks: ['x'] },
    'https://a.example/long': { chunks: ['12345', '67890', 'abc'] },
  }) });
  await assert.rejects(source.fetchBuffer('https://a.example/missing', 100), /HTTP 404/);
  await assert.rejects(source.fetchBuffer('https://a.example/declared', 100), /larger than expected/);
  await assert.rejects(source.fetchBuffer('https://a.example/long', 10), /larger than expected/);
});

test('a download is written to its file, with progress', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSourceFetch({ net: fakeNet({ 'https://a.example/setup.exe': { chunks: ['abc', 'def'] } }) });
  const seen = [];
  await source.downloadToFile('https://a.example/setup.exe', path.join(dir, 'setup.exe'), { maxBytes: 6, onProgress: size => seen.push(size) });
  assert.equal(fs.readFileSync(path.join(dir, 'setup.exe'), 'utf8'), 'abcdef');
  assert.deepEqual(seen, [3, 6]);
});

test('a file that can\'t be written ends the download with that error (no hang)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSourceFetch({ net: fakeNet({ 'https://a.example/setup.exe': { chunks: ['abc', 'def'] } }) });
  await assert.rejects(source.downloadToFile('https://a.example/setup.exe', path.join(dir, 'missing', 'setup.exe'), { maxBytes: 100 }), /ENOENT/);
  if (fs.existsSync('/dev/full')) {
    await assert.rejects(source.downloadToFile('https://a.example/setup.exe', '/dev/full', { maxBytes: 100 }), /ENOSPC/);
  }
});

test('a download that stops sending is stopped', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSourceFetch({ net: fakeNet({ 'https://a.example/slow.exe': { stall: true, chunks: ['first'] } }), stallMs: 100 });
  await assert.rejects(source.downloadToFile('https://a.example/slow.exe', path.join(dir, 'slow.exe'), { maxBytes: 100 }), /stalled/);
});

test('an abort stops it, before or during the transfer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSourceFetch({ net: fakeNet({ 'https://a.example/slow.exe': { stall: true, chunks: ['first'] } }), stallMs: 10000 });
  const before = new AbortController();
  before.abort();
  await assert.rejects(source.downloadToFile('https://a.example/slow.exe', path.join(dir, 'a.exe'), { maxBytes: 100, signal: before.signal }), /Cancelled/);
  const during = new AbortController();
  const pending = source.downloadToFile('https://a.example/slow.exe', path.join(dir, 'b.exe'), { maxBytes: 100, signal: during.signal });
  setTimeout(() => during.abort(), 50);
  await assert.rejects(pending, /Cancelled/);
});

test('a server that never answers is given up on', async () => {
  const source = createSourceFetch({ net: fakeNet({ 'https://a.example/index.json': { silent: true } }), stallMs: 100 });
  await assert.rejects(source.fetchBuffer('https://a.example/index.json', 100), /didn't answer/);
});

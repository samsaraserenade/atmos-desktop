'use strict';
// atmos.fetch()'s main-process relay (extension-fetch.cjs) against a local
// HTTPS server that stands in for api.test.example and other.test.example.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const zlib = require('node:zlib');
const { createExtensionFetch, isBlockedAddress } = require('./extension-fetch.cjs');
const { cert, key } = require('../../../scripts/test-tls.cjs');

function startServer(handler) {
  return new Promise(resolve => {
    const server = https.createServer({ cert, key }, handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function relayFor(server, options = {}) {
  const port = server.address().port;
  return createExtensionFetch({
    userAgent: 'Atmos/test',
    ca: [cert],
    testHosts: {
      'api.test.example': { address: '127.0.0.1', port },
      'other.test.example': { address: '127.0.0.1', port },
      'elsewhere.example': { address: '127.0.0.1', port },
    },
    ...options,
  });
}

const NETWORK = ['api.test.example', 'other.test.example'];
const text = result => Buffer.from(result.body).toString('utf8');
const header = (result, name) => result.headers.find(([key]) => key.toLowerCase() === name)?.[1];

test('private, local and reserved addresses are blocked; public ones are not', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.4', '100.100.1.1', '169.254.1.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1', '[::1]', 'not-an-address']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('a GET reaches a declared host, with its own headers and none of the user\'s', async t => {
  let seen = null;
  const server = await startServer((request, response) => {
    seen = request.headers;
    const body = zlib.gzipSync(JSON.stringify({ ok: true, path: request.url }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'session=1', 'x-rate-limit': '59' });
    response.end(body);
  });
  const relay = relayFor(server);
  t.after(() => { relay.close(); server.close(); });
  const result = await relay.fetch('plugin:hello', NETWORK, {
    url: 'https://api.test.example/v1/things?x=1',
    method: 'GET',
    headers: [['Accept', 'application/json'], ['Cookie', 'stolen=1'], ['Authorization', 'Bearer key'], ['Sec-Fetch-Site', 'none']],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(text(result)), { ok: true, path: '/v1/things?x=1' });
  assert.equal(result.url, 'https://api.test.example/v1/things?x=1');
  assert.equal(result.redirected, false);
  assert.equal(header(result, 'set-cookie'), undefined, 'cookies never come back');
  assert.equal(header(result, 'content-encoding'), undefined, 'the body arrives decoded');
  assert.equal(header(result, 'x-rate-limit'), '59');
  assert.equal(seen['user-agent'], 'Atmos/test');
  assert.equal(seen.authorization, 'Bearer key');
  assert.equal(seen.cookie, undefined);
  assert.equal(seen['sec-fetch-site'], undefined);
  assert.equal(seen.accept, 'application/json');
});

test('bodies go up; redirects are followed like fetch() and checked at every hop', async t => {
  const log = [];
  const server = await startServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      log.push({ host: request.headers.host.split(':')[0], method: request.method, url: request.url, body, auth: request.headers.authorization ?? null });
      if (request.url === '/see-other') { response.writeHead(303, { location: '/done' }); response.end(); return; }
      if (request.url === '/temporary') { response.writeHead(307, { location: '/done' }); response.end(); return; }
      if (request.url === '/away') { response.writeHead(302, { location: 'https://other.test.example/done' }); response.end(); return; }
      if (request.url === '/undeclared') { response.writeHead(302, { location: 'https://elsewhere.example/done' }); response.end(); return; }
      if (request.url === '/plain') { response.writeHead(302, { location: 'http://api.test.example/done' }); response.end(); return; }
      if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return; }
      response.writeHead(201, { 'content-type': 'text/plain' });
      response.end(`${request.method} ${body}`);
    });
  });
  const relay = relayFor(server);
  t.after(() => { relay.close(); server.close(); });
  const post = (url, extra = {}) => relay.fetch('plugin:hello', NETWORK, {
    url, method: 'POST', headers: [['content-type', 'text/plain'], ['authorization', 'Bearer key']], body: new TextEncoder().encode('hello'), ...extra,
  });

  const direct = await post('https://api.test.example/done');
  assert.equal(direct.status, 201);
  assert.equal(text(direct), 'POST hello');

  const seeOther = await post('https://api.test.example/see-other');
  assert.equal(text(seeOther), 'GET ', '303 becomes a GET without the body');
  assert.equal(seeOther.redirected, true);
  assert.equal(seeOther.url, 'https://api.test.example/done');

  assert.equal(text(await post('https://api.test.example/temporary')), 'POST hello', '307 keeps the method and body');

  log.length = 0;
  await post('https://api.test.example/away');
  assert.deepEqual(log.map(item => [item.host, item.auth]), [['api.test.example', 'Bearer key'], ['other.test.example', null]],
    'the Authorization header doesn\'t follow a redirect to another host');

  await assert.rejects(post('https://api.test.example/undeclared'), { name: 'AtmosPermissionError', message: /elsewhere\.example isn't in/ });
  await assert.rejects(post('https://api.test.example/plain'), { name: 'TypeError', message: /only reaches https/ });
  await assert.rejects(post('https://api.test.example/loop'), { name: 'TypeError', message: /more than 5 redirects/ });
  await assert.rejects(post('https://api.test.example/away', { redirect: 'error' }), { name: 'TypeError', message: /redirected/ });
  const manual = await post('https://api.test.example/away', { redirect: 'manual' });
  assert.equal(manual.status, 302);
  assert.equal(header(manual, 'location'), 'https://other.test.example/done');
});

test('requests to anything but a declared public https host are refused before they leave', async t => {
  const relay = createExtensionFetch({
    lookup: (hostname, options, callback) => callback(null, [{ address: hostname === 'mixed.test.example' ? '10.0.0.8' : '127.0.0.1', family: 4 }]),
  });
  t.after(() => relay.close());
  const network = ['rebind.test.example', 'mixed.test.example', '127.0.0.1', 'api.test.example'];
  const get = url => relay.fetch('plugin:hello', network, { url, method: 'GET', headers: [] });
  await assert.rejects(get('https://rebind.test.example/'), { name: 'TypeError', message: /private or local network/ });
  await assert.rejects(get('https://mixed.test.example/'), { name: 'TypeError', message: /private or local network/ });
  await assert.rejects(get('https://127.0.0.1/'), { name: 'TypeError', message: /private or local network/ });
  await assert.rejects(get('http://api.test.example/'), { name: 'TypeError', message: /only reaches https/ });
  await assert.rejects(get('https://api.test.example:8443/'), { name: 'TypeError', message: /default https port/ });
  await assert.rejects(get('https://user:pass@api.test.example/'), { name: 'TypeError', message: /user name or password/ });
  await assert.rejects(get('https://undeclared.example/'), { name: 'AtmosPermissionError' });
  await assert.rejects(get('atmos-app://local/index.html'), { name: 'TypeError', message: /only reaches https/ });
  await assert.rejects(get('file:///etc/passwd'), { name: 'TypeError', message: /only reaches https/ });
  await assert.rejects(relay.fetch('plugin:hello', network, { url: 'https://api.test.example/', method: 'CONNECT', headers: [] }), /doesn't send CONNECT/);
  await assert.rejects(relay.fetch('plugin:hello', network, { url: 'https://api.test.example/', method: 'GET', headers: [], body: new Uint8Array(1) }), /can't have a body/);
  await assert.rejects(relay.fetch('plugin:hello', network, { url: 'https://api.test.example/', method: 'GET', headers: [['x\r\nevil', '1']] }), /not a header name/);
  // "*" is any public host, never a private one.
  await assert.rejects(relay.fetch('plugin:hello', ['*'], { url: 'https://rebind.test.example/', method: 'GET', headers: [] }), /private or local network/);
});

test('sizes, time and concurrency are bounded; a request can be aborted', async t => {
  let active = 0;
  let most = 0;
  const server = await startServer((request, response) => {
    if (request.url === '/big') { response.end(Buffer.alloc(4096, 1)); return; }
    if (request.url === '/never') return; // no answer
    active += 1;
    most = Math.max(most, active);
    setTimeout(() => { active -= 1; response.end('ok'); }, 60);
  });
  const relay = relayFor(server, { limits: { maxResponseBytes: 1024, maxRequestBytes: 16, timeoutMs: 300, maxConcurrent: 2 } });
  t.after(() => { relay.close(); server.closeAllConnections?.(); server.close(); });
  const get = (url, options) => relay.fetch('plugin:hello', NETWORK, { url, method: 'GET', headers: [] }, options);

  await assert.rejects(get('https://api.test.example/big'), { name: 'TypeError', message: /larger than/ });
  await assert.rejects(relay.fetch('plugin:hello', NETWORK, { url: 'https://api.test.example/', method: 'POST', headers: [], body: new Uint8Array(17) }), /at most/);
  await assert.rejects(get('https://api.test.example/never'), { name: 'TimeoutError' });

  const controller = new AbortController();
  const aborted = get('https://api.test.example/never', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(aborted, { name: 'AbortError' });

  const results = await Promise.all(Array.from({ length: 5 }, () => get('https://api.test.example/slow')));
  assert.deepEqual(results.map(text), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(most, 2, 'at most two at once for one extension');
});

test('a redirect\'s body is closed, not drained, so a server can\'t stream past the limits', async t => {
  let redirectClosed = null;
  const server = await startServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(302, { location: '/here' });
      // An endless body: it must be cut off once the relay has the Location.
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => { while (response.write(chunk)) { /* fill */ } };
      response.on('drain', pump);
      pump();
      redirectClosed = new Promise(resolve => response.on('close', resolve));
      return;
    }
    response.end('arrived');
  });
  const relay = relayFor(server);
  t.after(() => { relay.close(); server.closeAllConnections?.(); server.close(); });
  const result = await relay.fetch('plugin:hello', NETWORK, { url: 'https://api.test.example/moved', method: 'GET', headers: [] });
  assert.equal(text(result), 'arrived');
  assert.equal(result.redirected, true);
  await Promise.race([redirectClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('the redirect is still being read')), 2000))]);
});

test('the queue is bounded: a full one refuses at once, and an aborted wait leaves it', async t => {
  const held = [];
  const server = await startServer((request, response) => {
    request.resume();
    request.on('end', () => held.push(() => response.end('ok')));
  });
  const relay = relayFor(server, { limits: { maxConcurrent: 1, maxQueued: 2, maxQueuedBytes: 1024 } });
  t.after(() => { relay.close(); server.closeAllConnections?.(); server.close(); });
  const send = (caller, options = {}, body = null) => relay.fetch(caller, NETWORK, {
    url: 'https://api.test.example/', method: body ? 'POST' : 'GET', headers: [], body,
  }, options);
  const arrived = async count => { while (held.length < count) await new Promise(resolve => setTimeout(resolve, 5)); };
  // Answer everything the server holds until `promises` settle.
  const answerAll = async promises => {
    let settled = false;
    const all = Promise.allSettled(promises).then(results => { settled = true; return results; });
    while (!settled) {
      held.splice(0).forEach(answer => answer());
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return all;
  };

  const running = send('plugin:hello');
  await arrived(1);
  const controller = new AbortController();
  const abandoned = send('plugin:hello', { signal: controller.signal });
  const queued = send('plugin:hello');
  await assert.rejects(send('plugin:hello'), { name: 'TypeError', message: /too many atmos\.fetch\(\) requests/ });
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  const roomAgain = send('plugin:hello'); // the aborted request left the queue
  const results = await answerAll([running, queued, roomAgain]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(results.map(result => text(result.value)), ['ok', 'ok', 'ok']);

  // What waits is bounded in bytes too, per extension.
  const first = send('plugin:bodies', {}, new Uint8Array(10));
  await arrived(1);
  const second = send('plugin:bodies', {}, new Uint8Array(1000));
  await assert.rejects(send('plugin:bodies', {}, new Uint8Array(100)), /too many/);
  const bodies = await answerAll([first, second]);
  assert.deepEqual(bodies.map(result => result.status), ['fulfilled', 'fulfilled']);
});

test('test host names are only the ones given, never an object\'s own properties', async () => {
  const relay = createExtensionFetch({ testHosts: {} });
  try {
    await assert.rejects(relay.fetch('plugin:hello', ['*'], { url: 'https://constructor:8443/', method: 'GET', headers: [] }), /default https port/);
    await assert.rejects(relay.fetch('plugin:hello', ['*'], { url: 'https://__proto__:8443/', method: 'GET', headers: [] }), /default https port/);
  } finally {
    relay.close();
  }
});

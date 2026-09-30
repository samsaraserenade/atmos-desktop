'use strict';
// The SDK a frame imports (core/js/sdk/atmos-sdk.js), run in Node against a
// stand-in for Core on the other end of its message port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SDK = path.join(__dirname, '..', 'sdk', 'atmos-sdk.js');

/** A frame's globals: its window, parent, document, and the page lifecycle. */
function fakeFrameGlobals() {
  const windowTarget = new EventTarget();
  const globalTarget = new EventTarget();
  const sentToParent = [];
  const parent = { postMessage: message => sentToParent.push(message), frames: [] };
  const window = {
    parent,
    addEventListener: (...args) => windowTarget.addEventListener(...args),
    removeEventListener: (...args) => windowTarget.removeEventListener(...args),
    dispatch: (type, detail) => {
      const event = new Event(type);
      Object.assign(event, detail);
      windowTarget.dispatchEvent(event);
    },
  };
  const documentElement = { dataset: {}, style: { setProperty() {}, colorScheme: '' } };
  const document = { documentElement, addEventListener() {}, body: {} };
  return { window, parent, document, globalTarget, sentToParent };
}

/** Load a fresh copy of the SDK, connect it, and give back Core's end of the port. */
async function connectedSdk(t, { extension = { id: 'hello', kind: 'plugin', tier: 'third-party', version: '1.0.0' }, surface = { type: 'boot' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-sdk-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(SDK, path.join(dir, 'atmos-sdk.js'));
  const env = fakeFrameGlobals();
  const saved = {};
  for (const name of ['window', 'document', 'addEventListener', 'removeEventListener']) saved[name] = globalThis[name];
  globalThis.window = env.window;
  globalThis.document = env.document;
  globalThis.addEventListener = (...args) => env.globalTarget.addEventListener(...args);
  globalThis.removeEventListener = (...args) => env.globalTarget.removeEventListener(...args);
  const channel = new MessageChannel();
  t.after(() => {
    channel.port1.close();
    channel.port2.close();
    Object.assign(globalThis, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sdk = await import(pathToFileURL(path.join(dir, 'atmos-sdk.js')).href);
  const connected = sdk.__connect();
  env.window.dispatch('message', {
    source: env.parent,
    data: { type: 'atmos:connect', init: { sdkVersion: '1.0.0', extension, surface, appearance: null, shortcutKeys: [] } },
    ports: [channel.port2],
  });
  await connected;
  // Core's side: every request the frame sends, and a way to answer it.
  const received = [];
  const waiters = [];
  channel.port1.onmessage = event => {
    received.push(event.data);
    for (const waiter of waiters.splice(0)) waiter();
  };
  const next = async predicate => {
    for (;;) {
      const found = received.find(predicate);
      if (found) { received.splice(received.indexOf(found), 1); return found; }
      await new Promise(resolve => waiters.push(resolve));
    }
  };
  return { sdk, atmos: sdk.default, core: channel.port1, next, env };
}

test('SDK 1.0: a semver version, the same one Core tells frames', async () => {
  const source = fs.readFileSync(SDK, 'utf8');
  const host = fs.readFileSync(path.join(__dirname, 'extension-frame-host.js'), 'utf8');
  const sdkVersion = source.match(/export const SDK_VERSION = '([^']+)'/)?.[1];
  assert.match(sdkVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(host.match(/export const SDK_VERSION = '([^']+)'/)?.[1], sdkVersion);
});

test('the SDK surface: stable, experimental and first-party calls, nothing else', async t => {
  const { atmos } = await connectedSdk(t);
  assert.ok(Object.isFrozen(atmos));
  assert.deepEqual(Object.keys(atmos).sort(), [
    'SDK_VERSION', 'appearance', 'audio', 'background', 'call', 'clipboard', 'contextMenu', 'drawer', 'events', 'expose',
    'extension', 'fetch', 'invoke', 'legacy', 'library', 'lifecycle', 'listen', 'location', 'notifications', 'panel',
    'ready', 'state', 'surface', 'wallpaper', 'web',
  ]);
  assert.equal(atmos.surface.onFileDrop, undefined, 'file drops went with SDK 1.0');
  assert.deepEqual({ ...atmos.extension }, { id: 'hello', kind: 'plugin', tier: 'third-party', version: '1.0.0' });
});

test('fetch(): fetch()\'s arguments in, a Response out', async t => {
  const { atmos, core, next } = await connectedSdk(t);
  const pending = atmos.fetch('https://api.test.example/things?x=1', {
    method: 'POST',
    headers: { 'X-Key': 'secret' },
    body: JSON.stringify({ hello: 'world' }),
  });
  const request = await next(message => message.method === 'fetch');
  const [sent] = request.args;
  assert.equal(sent.url, 'https://api.test.example/things?x=1');
  assert.equal(sent.method, 'POST');
  assert.ok(sent.body instanceof ArrayBuffer);
  assert.deepEqual(JSON.parse(Buffer.from(sent.body).toString()), { hello: 'world' });
  const headers = Object.fromEntries(sent.headers);
  assert.equal(headers['x-key'], 'secret');
  assert.match(headers['content-type'], /^text\/plain/);
  core.postMessage({
    reply: request.id,
    result: {
      url: 'https://api.test.example/final', status: 201, statusText: 'Created', redirected: true,
      headers: [['content-type', 'application/json'], ['x-rate', '9']], body: new TextEncoder().encode('{"ok":true}').buffer,
    },
  });
  const response = await pending;
  assert.ok(response instanceof Response);
  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.url, 'https://api.test.example/final');
  assert.equal(response.redirected, true);
  assert.equal(response.headers.get('x-rate'), '9');
  assert.deepEqual(await response.json(), { ok: true });

  // A 204 has no body, whatever arrives.
  const empty = atmos.fetch('https://api.test.example/none', { method: 'DELETE' });
  const deletion = await next(message => message.method === 'fetch');
  assert.equal(deletion.args[0].body, null);
  core.postMessage({ reply: deletion.id, result: { url: 'https://api.test.example/none', status: 204, statusText: '', headers: [], body: new ArrayBuffer(0) } });
  assert.equal((await empty).status, 204);
});

test('fetch(): refusals keep their names; an abort rejects at once and tells Core', async t => {
  const { atmos, core, next } = await connectedSdk(t);
  const refused = atmos.fetch('https://elsewhere.example/');
  const request = await next(message => message.method === 'fetch');
  core.postMessage({ reply: request.id, error: { name: 'AtmosPermissionError', message: 'plugin:hello may not connect to elsewhere.example' } });
  await assert.rejects(refused, { name: 'AtmosPermissionError' });

  const failed = atmos.fetch('https://api.test.example/');
  const second = await next(message => message.method === 'fetch');
  core.postMessage({ reply: second.id, error: { name: 'TypeError', message: 'api.test.example wasn\'t found' } });
  await assert.rejects(failed, error => error instanceof TypeError);

  await assert.rejects(atmos.fetch('https://api.test.example/', { method: 'GET', body: 'x' }), TypeError, 'fetch()\'s own argument checks');

  const controller = new AbortController();
  const slow = atmos.fetch('https://api.test.example/slow', { signal: controller.signal });
  const third = await next(message => message.method === 'fetch');
  controller.abort();
  await assert.rejects(slow, { name: 'AbortError' });
  const abort = await next(message => message.method === 'fetch.abort');
  assert.deepEqual(abort.args, [third.args[0].id]);
  await assert.rejects(atmos.fetch('https://api.test.example/', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('location: get() and onChange() through Core', async t => {
  const { atmos, core, next } = await connectedSdk(t);
  const got = atmos.location.get();
  const request = await next(message => message.method === 'location.get');
  core.postMessage({ reply: request.id, result: { lat: 51.5, lon: -0.12, label: 'London', mode: 'manual' } });
  assert.deepEqual(await got, { lat: 51.5, lon: -0.12, label: 'London', mode: 'manual' });

  const seen = [];
  const stop = atmos.location.onChange(value => seen.push(value));
  const subscribe = await next(message => message.method === 'location.subscribe');
  core.postMessage({ reply: subscribe.id, result: undefined });
  core.postMessage({ topic: 'location', payload: null });
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  core.postMessage({ topic: 'location', payload: { lat: 1, lon: 2, label: 'x', mode: 'auto' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(seen, [null]);
});

test('lifecycle: one signal, cleanups last-first, timers and listeners gone when the frame goes', async t => {
  const { atmos, env } = await connectedSdk(t);
  const order = [];
  atmos.lifecycle.onCleanup(() => order.push('first'));
  const cancelled = atmos.lifecycle.onCleanup(() => order.push('cancelled'));
  atmos.lifecycle.onCleanup(() => order.push('last'));
  cancelled();
  let ticks = 0;
  atmos.lifecycle.setInterval(() => { ticks += 1; }, 5);
  let fired = false;
  atmos.lifecycle.setTimeout(() => { fired = true; }, 60_000);
  const target = new EventTarget();
  let heard = 0;
  atmos.lifecycle.listen(target, 'ping', () => { heard += 1; });
  target.dispatchEvent(new Event('ping'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(ticks > 0);
  assert.equal(atmos.lifecycle.signal.aborted, false);

  env.globalTarget.dispatchEvent(new Event('pagehide'));
  assert.equal(atmos.lifecycle.signal.aborted, true);
  assert.deepEqual(order, ['last', 'first']);
  const ticksThen = ticks;
  target.dispatchEvent(new Event('ping'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ticks, ticksThen, 'the interval stopped');
  assert.equal(heard, 1, 'the listener was removed');
  assert.equal(fired, false);
  let late = false;
  atmos.lifecycle.onCleanup(() => { late = true; });
  assert.equal(late, true, 'a cleanup added after the frame went runs at once');
});

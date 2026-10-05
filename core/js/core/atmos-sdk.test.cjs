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
    'SDK_VERSION', 'appearance', 'audio', 'background', 'call', 'clipboard', 'commands', 'contextMenu', 'drawer', 'events', 'expose',
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

test('commands (SDK 1.3): a handled command runs and lists in this frame when Core asks, and answers once', async t => {
  const { atmos, core, next } = await connectedSdk(t);
  assert.deepEqual(Object.keys(atmos.commands).sort(), ['bar', 'field', 'handle', 'open', 'refresh']);
  const ran = [];
  const stop = atmos.commands.handle('roll', input => { ran.push(input); return { done: `Rolled ${input.args}` }; }, {
    suggest: ({ args }) => [{ title: `Roll ${args || 'a die'}`, value: args }],
  });
  const handle = await next(message => message.method === 'commands.handle');
  assert.deepEqual(handle.args, ['roll', { suggests: true }]);
  core.postMessage({ reply: handle.id, result: undefined });

  core.postMessage({ command: 7, action: 'suggest', name: 'roll', input: { args: '2d6', options: {} } });
  assert.deepEqual(await next(message => message.commandReply === 7), { commandReply: 7, result: [{ title: 'Roll 2d6', value: '2d6' }] });
  core.postMessage({ command: 8, action: 'run', name: 'roll', input: { args: '2d6', value: '2d6', options: { loud: true } } });
  assert.deepEqual(await next(message => message.commandReply === 8), { commandReply: 8, result: { done: 'Rolled 2d6' } });
  assert.deepEqual(ran, [{ args: '2d6', value: '2d6', options: { loud: true } }]);

  // One it doesn't handle, or a handler that throws: an error, with its message.
  core.postMessage({ command: 9, action: 'run', name: 'flip', input: {} });
  const unhandled = await next(message => message.commandReply === 9);
  assert.match(unhandled.error.message, /rev\/flip isn't handled in this frame/);
  atmos.commands.handle('fail', () => { throw new Error('No dice'); });
  core.postMessage({ reply: (await next(message => message.method === 'commands.handle')).id, result: undefined });
  core.postMessage({ command: 10, action: 'run', name: 'fail', input: {} });
  assert.equal((await next(message => message.commandReply === 10)).error.message, 'No dice');
  core.postMessage({ command: 11, action: 'suggest', name: 'fail', input: {} });
  assert.match((await next(message => message.commandReply === 11)).error.message, /isn't handled/, 'no suggest given');

  stop();
  assert.deepEqual((await next(message => message.method === 'commands.unhandle')).args, ['roll']);
  core.postMessage({ command: 12, action: 'run', name: 'roll', input: {} });
  assert.ok((await next(message => message.commandReply === 12)).error, 'stopped');

  const opened = atmos.commands.open('rev/roll ', { loud: true });
  const open = await next(message => message.method === 'commands.open');
  assert.deepEqual(open.args, ['rev/roll ', { loud: true }]);
  core.postMessage({ reply: open.id, result: undefined });
  await opened;
  atmos.commands.refresh();
  assert.ok(await next(message => message.method === 'commands.refresh'));
  assert.throws(() => atmos.commands.handle('', () => {}), TypeError);
  assert.throws(() => atmos.commands.handle('roll', 'not a function'), TypeError);
  assert.throws(() => atmos.commands.handle('roll', () => {}, { suggest: 42 }), TypeError);
  assert.throws(() => atmos.commands.bar(null), TypeError);
});

test('commands.bar: where the panel\'s bar is, one at a time, nothing sent once stopped', async t => {
  const { atmos, next, env } = await connectedSdk(t, { surface: { type: 'panel' } });
  // The browser's observers and frame callbacks, by hand.
  const frames = [];
  const observers = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver, requestAnimationFrame: globalThis.requestAnimationFrame };
  class Observer {
    constructor(callback) { this.callback = callback; this.on = true; observers.push(this); }
    observe() {}
    disconnect() { this.on = false; }
  }
  Object.assign(globalThis, { ResizeObserver: Observer, MutationObserver: Observer, requestAnimationFrame: fn => frames.push(fn) });
  env.document.removeEventListener = () => {};
  t.after(() => Object.assign(globalThis, saved));
  const flush = () => { for (const fn of frames.splice(0)) fn(); };
  const element = top => ({ isConnected: true, getBoundingClientRect: () => ({ left: 0, top, width: 800, height: 54 }) });

  const first = element(600);
  const stopFirst = atmos.commands.bar(first);
  assert.deepEqual((await next(message => message.method === 'commands.bar')).args, [{ x: 0, y: 600, width: 800, height: 54 }]);
  // It moves: told again, once per frame.
  first.getBoundingClientRect = () => ({ left: 0, top: 580, width: 800, height: 54 });
  observers[0].callback();
  observers[1].callback();
  flush();
  assert.deepEqual((await next(message => message.method === 'commands.bar')).args, [{ x: 0, y: 580, width: 800, height: 54 }]);

  // Another bar (the next room's) takes over; the first's late callbacks send nothing.
  observers[0].callback();
  const stopSecond = atmos.commands.bar(element(500));
  assert.deepEqual((await next(message => message.method === 'commands.bar')).args, [null], 'the first one stops');
  assert.deepEqual((await next(message => message.method === 'commands.bar')).args, [{ x: 0, y: 500, width: 800, height: 54 }]);
  assert.equal(observers[0].on, false);
  flush();
  stopFirst(); // already stopped: nothing
  stopSecond();
  assert.deepEqual((await next(message => message.method === 'commands.bar')).args, [null]);
  stopSecond();
  atmos.commands.refresh();
  const after = await next(message => message.method === 'commands.bar' || message.method === 'commands.refresh');
  assert.equal(after.method, 'commands.refresh', 'nothing more about bars came first');
});

test('commands.field: rev/ typed in a field goes to the bar, keys right after follow it, Enter then sends nothing', async t => {
  const { atmos, core, next } = await connectedSdk(t, { surface: { type: 'panel' } });
  const field = Object.assign(new EventTarget(), { value: '' });
  const seen = [];
  field.addEventListener('input', () => seen.push(field.value));
  const type = value => { field.value = value; field.dispatchEvent(new Event('input')); };
  const enter = () => { const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter' }); field.dispatchEvent(event); return event.defaultPrevented; };
  const stop = atmos.commands.field(field, { options: { size: 'small' } });
  // The field's own Enter (sending a message). In a page, field()'s capturing
  // listener runs first whenever this was added; Node's EventTarget keeps order.
  let sent = 0;
  field.addEventListener('keydown', () => { sent += 1; });

  type('hello');
  assert.equal(field.value, 'hello', 'not a command: the field\'s own');
  type('rev/');
  const opened = await next(message => message.method === 'commands.open');
  assert.deepEqual(opened.args, ['rev/', { size: 'small' }, false]);
  assert.equal(field.value, '', 'handed over');
  assert.deepEqual(seen.slice(-1), [''], 'the field\'s listeners saw it emptied');
  core.postMessage({ reply: opened.id, result: undefined });
  // Keys that landed here before the bar had the keyboard follow it, the whole text each time.
  type('g');
  assert.deepEqual((await next(message => message.method === 'commands.open')).args, ['rev/g', null, true]);
  type('o');
  assert.deepEqual((await next(message => message.method === 'commands.open')).args, ['rev/go', null, true]);
  assert.equal(field.value, '');
  assert.equal(enter(), true, 'Enter in that moment isn\'t a message');
  assert.equal(sent, 0);
  // The bar closed and gave the keyboard back: what's typed is the field's own again.
  core.postMessage({ topic: 'keyboardBack' });
  await new Promise(resolve => setTimeout(resolve, 20));
  type('hi');
  assert.equal(field.value, 'hi');
  assert.equal(enter(), false, 'Enter is the field\'s again');
  assert.equal(sent, 1);

  // Keys Atmos doesn't take (typed in the bar meanwhile) stay in the field.
  type('rev/');
  core.postMessage({ reply: (await next(message => message.method === 'commands.open')).id, result: undefined });
  type('q');
  const follow = await next(message => message.method === 'commands.open' && message.args[2] === true);
  core.postMessage({ reply: follow.id, error: { name: 'Error', message: 'the command bar isn’t taking text from this frame now' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(field.value, 'q');

  // The keyboard given back for an earlier bar, arriving after rev/ was
  // handed over (this frame was busy) but before Atmos answered: it isn't
  // this bar's, so keys typed next still follow it.
  core.postMessage({ topic: 'keyboardBack' });
  await new Promise(resolve => setTimeout(resolve, 20));
  type('rev/');
  const late = await next(message => message.method === 'commands.open' && message.args[2] === false);
  core.postMessage({ topic: 'keyboardBack' });
  core.postMessage({ reply: late.id, result: undefined });
  await new Promise(resolve => setTimeout(resolve, 20));
  type('p');
  assert.equal(field.value, '', 'followed the bar');
  assert.deepEqual((await next(message => message.method === 'commands.open' && message.args[2] === true)).args, ['rev/p', null, true]);
  core.postMessage({ topic: 'keyboardBack' });
  await new Promise(resolve => setTimeout(resolve, 20));

  // Refused (the frame wasn't focused, say): the text comes back.
  type('rev/roll');
  const refused = await next(message => message.method === 'commands.open' && message.args[2] === false);
  core.postMessage({ reply: refused.id, error: { name: 'Error', message: 'only the frame you’re typing in can open the command bar' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(field.value, 'rev/roll');
  stop();
  type('rev/x');
  assert.equal(field.value, 'rev/x', 'stopped: the field\'s own');
  assert.throws(() => atmos.commands.field({}), TypeError);
});

test('commands: a handler Core refuses (not declared) is dropped and says why', async t => {
  const { atmos, core, next } = await connectedSdk(t);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = original; });
  atmos.commands.handle('nope', () => 'ran');
  const handle = await next(message => message.method === 'commands.handle');
  core.postMessage({ reply: handle.id, error: { name: 'TypeError', message: 'rev/nope isn\'t a command plugin:hello declares' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(errors.join('\n'), /cannot handle rev\/nope: rev\/nope isn't a command/);
  core.postMessage({ command: 1, action: 'run', name: 'nope', input: {} });
  assert.ok((await next(message => message.commandReply === 1)).error, 'dropped');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { SessionRuntime, SessionCoordinator } from '../src/session-runtime.js';
import { createMediaService } from '../src/media-service.js';
import { createMessagingService } from '../src/messaging-service.js';
import { createTimelineController } from '../src/ui/timeline-controller.js';
import { createComposerController } from '../src/ui/composer-controller.js';
import { createPreference } from '../src/preference-store.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const fakeClient = () => Object.assign(new EventEmitter(), { stopClient() {} });

test('retired sessions detach listeners and reject captured late callbacks', () => {
  const client = fakeClient();
  const runtime = new SessionRuntime(client);
  let events = 0;
  runtime.listen('timeline', () => events++);
  const lateCallback = client.listeners('timeline')[0];
  client.emit('timeline');
  runtime.dispose();
  runtime.dispose();
  lateCallback();
  assert.equal(events, 1);
  assert.equal(client.listenerCount('timeline'), 0);
  assert.equal(runtime.signal.aborted, true);
});

test('overlapping activation cannot start a superseded account', async () => {
  const coordinator = new SessionCoordinator();
  const crypto = deferred();
  const starts = [];
  const old = coordinator.run(async ticket => {
    const runtime = ticket.attach(fakeClient());
    await crypto.promise;
    runtime.assertCurrent();
    starts.push('old');
  });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await tick();
  const next = coordinator.run(async ticket => {
    ticket.attach(fakeClient());
    starts.push('next');
  });
  assert.deepEqual(starts, []);
  crypto.resolve();
  await Promise.all([rejected, next]);
  assert.deepEqual(starts, ['next']);
});

test('logout cancels queued activation and delayed login', async () => {
  const coordinator = new SessionCoordinator();
  const login = deferred();
  const work = coordinator.run(async ticket => {
    await login.promise;
    ticket.attach(fakeClient());
  });
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await tick();
  coordinator.clear();
  login.resolve();
  await rejected;
  assert.equal(coordinator.current, null);
});

test('failed additional login preserves the current connection', async () => {
  const coordinator = new SessionCoordinator();
  await coordinator.run(ticket => ticket.attach(fakeClient()));
  const original = coordinator.current;
  await assert.rejects(coordinator.run(() => { throw new Error('bad password'); }, { retire: false }), /bad password/);
  assert.equal(coordinator.current, original);
  assert.equal(original.signal.aborted, false);
});

for (const encrypted of [false, true]) {
  test(`account switch during ${encrypted ? 'encrypted' : 'plain'} upload prevents event send`, async () => {
    const upload = deferred();
    const calls = [];
    const client = Object.assign(fakeClient(), {
      isRoomEncrypted: () => encrypted,
      uploadContent: () => { calls.push('upload'); return upload.promise; },
      sendEvent: () => calls.push('send'),
    });
    const runtime = new SessionRuntime(client);
    const service = createMediaService(runtime, {
      probe: async () => ({}),
      encryptAttachment: async data => ({ data, info: {} }),
    });
    const result = service.sendFileMessage('!room', new File(['bytes'], 'file.txt', { type: 'text/plain' }));
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await tick();
    runtime.dispose();
    upload.resolve({ content_uri: 'mxc://example/file' });
    await rejected;
    assert.deepEqual(calls, ['upload']);
  });
}

test('account switch during file preparation prevents upload', async () => {
  const reading = deferred();
  const client = Object.assign(fakeClient(), { isRoomEncrypted: () => true, uploadContent: () => assert.fail('must not upload') });
  const runtime = new SessionRuntime(client);
  const result = createMediaService(runtime, { probe: async () => ({}) }).sendFileMessage('!room', { type: 'text/plain', arrayBuffer: () => reading.promise });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await tick();
  runtime.dispose();
  reading.resolve(new ArrayBuffer(0));
  await rejected;
});

test('plain uploads avoid an extra full-file buffer and use session cancellation', async () => {
  let uploadOptions;
  const client = Object.assign(fakeClient(), {
    isRoomEncrypted: () => false,
    uploadContent: async (_file, options) => { uploadOptions = options; return { content_uri: 'mxc://test/file' }; },
    sendEvent: async () => {},
  });
  const runtime = new SessionRuntime(client);
  await createMediaService(runtime, { probe: async () => ({}) }).sendFileMessage('!room', {
    type: 'text/plain', name: 'large.txt', size: 100_000_000,
    arrayBuffer: () => assert.fail('plain attachments should not be copied here'),
  });
  runtime.dispose();
  assert.equal(uploadOptions.abortController.signal.aborted, true);
});

test('preferences see late hydration, normalize values, and skip unchanged saves', () => {
  const state = {};
  let saves = 0;
  const preference = createPreference(state, 'sound', value => value !== false, () => saves++);
  assert.equal(preference.get(), true);
  state.sound = false;
  assert.equal(preference.get(), false);
  const changes = [];
  const off = preference.subscribe(value => changes.push(value));
  preference.set(false);
  preference.set('yes');
  preference.set(true);
  preference.set(false);
  off();
  preference.set(true);
  assert.deepEqual(changes, [true, false]);
  assert.equal(saves, 3);
  assert.equal(state.sound, true);
});

test('messaging preserves replies and escaped intentional mentions', async () => {
  let sent;
  const client = Object.assign(fakeClient(), { sendEvent: (...args) => { sent = args; } });
  const runtime = new SessionRuntime(client);
  const service = createMessagingService(runtime);
  await service.sendTextMessage('!room', 'Hi @A <hello>', { replyToEventId: '$parent', mentions: [{ userId: '@a:server', offset: 3, length: 2 }] });
  assert.equal(sent[2]['m.relates_to']['m.in_reply_to'].event_id, '$parent');
  assert.deepEqual(sent[2]['m.mentions'].user_ids, ['@a:server']);
  assert.match(sent[2].formatted_body, /&lt;hello&gt;/);
  runtime.dispose();
  assert.throws(() => service.sendReaction('!room', '$event', '👍'), { name: 'AbortError' });
});

test('closing a timeline during pagination suppresses rendering', async () => {
  const request = deferred();
  let count = 50;
  let renders = 0;
  const timeline = createTimelineController({ pageSize: 50, count: () => count, paginate: () => request.promise, prepend: () => renders++, nearTop: () => true, needsFill: () => false });
  const result = timeline.load();
  timeline.dispose();
  count = 100;
  request.resolve(true);
  await result;
  assert.equal(renders, 0);
});

test('timeline collapses concurrent pagination and retries failures', async () => {
  let calls = 0;
  let count = 50;
  const request = deferred();
  const timeline = createTimelineController({ pageSize: 50, count: () => count, paginate: () => { calls++; return request.promise; }, prepend: () => {}, nearTop: () => true, needsFill: () => false });
  const first = timeline.load();
  await timeline.load();
  assert.equal(calls, 1);
  request.resolve(false);
  await first;
  await timeline.load();
  assert.equal(calls, 2);
  count = 100;
  await timeline.load();
  assert.equal(timeline.windowSize, 100);
});

test('composer releases previews once and stops a disposed attachment batch', async () => {
  const released = [];
  const composer = createComposerController({ createUrl: file => file.name, revokeUrl: url => released.push(url) });
  composer.add([{ name: 'one', type: 'image/png' }, { name: 'two', type: 'image/png' }]);
  const batch = composer.take();
  const upload = deferred();
  let sends = 0;
  const work = composer.run(async assertActive => {
    for (const item of batch) {
      assertActive();
      sends++;
      await upload.promise;
      composer.release(item);
    }
  });
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await composer.run(() => assert.fail('duplicate send'));
  composer.dispose();
  upload.resolve();
  await rejected;
  assert.equal(sends, 1);
  assert.deepEqual(released, ['one', 'two']);
});

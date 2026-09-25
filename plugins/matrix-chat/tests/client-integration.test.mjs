import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { matrixState, controls, clients } from './fake-environment.mjs';

const fakeUrl = new URL('./fake-environment.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './state.js' || specifier === './vault.js' || specifier === 'atmos-sdk' || specifier.includes('/vendor/')) return { url: fakeUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const api = await import('../src/client.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = name => ({ userId: '@' + name + ':test', accessToken: name + '-token', homeserver: 'https://test', deviceId: name });

test('public facade handles overlapping switches, old events and logout', async () => {
  matrixState.matrixSessions = [session('a'), session('b')];
  let finish;
  controls.init = client => client.getUserId() === '@a:test' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  const first = api.switchAccount('@a:test');
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  const old = clients.at(-1);
  let events = 0;
  const off = api.onTimeline(() => events++);
  const oldEvent = old.listeners('timeline')[0];
  const second = api.switchAccount('@b:test');
  oldEvent({}, {});
  finish();
  await Promise.all([rejected, second]);
  assert.equal(old.starts, 0);
  assert.equal(api.getClient().starts, 1);
  assert.equal(api.getUserId(), '@b:test');
  assert.equal(events, 0);
  assert.equal(old.listenerCount('timeline'), 0);
  off();
  api.logout();
  assert.equal(api.getClient(), null);
});

test('late authentication cannot undo logout', async () => {
  let finish;
  controls.login = () => new Promise(resolve => { finish = resolve; });
  const login = api.login('https://test', 'user', 'password');
  const rejected = assert.rejects(login, { name: 'AbortError' });
  await tick();
  api.logout();
  finish({ user_id: '@late:test', access_token: 'late', device_id: 'late' });
  await rejected;
  assert.equal(api.getClient(), null);
  assert.equal(matrixState.matrixSessions.some(s => s.userId === '@late:test'), false);
});

test('token invalidation preserves unrelated accounts and rejects old token errors', async () => {
  controls.init = async () => {};
  matrixState.matrixSessions = [session('a'), session('b')];
  await api.switchAccount('@a:test');
  assert.equal(api.handleInvalidAccessToken(new Error('offline')), false);
  assert.equal(api.handleInvalidAccessToken({ errcode: 'M_UNKNOWN_TOKEN' }, { ...session('a'), accessToken: 'old' }), false);
  assert.equal(api.handleInvalidAccessToken({ errcode: 'M_UNKNOWN_TOKEN' }), true);
  assert.deepEqual(matrixState.matrixSessions.map(s => s.userId), ['@b:test']);
  assert.equal(api.getClient(), null);
  assert.equal(api.getSessionIssue().userId, '@a:test');
});

test('removing a subscription during emission prevents its stale callback', async () => {
  matrixState.matrixSessions = [session('b')];
  let calls = 0;
  let offSecond;
  const offFirst = api.onAccountChange(() => offSecond());
  offSecond = api.onAccountChange(() => calls++);
  await api.switchAccount('@b:test');
  assert.equal(calls, 0);
  offFirst();
  api.logout();
});

test('invalid-token detection handles nested and circular errors', () => {
  assert.equal(api.isInvalidAccessTokenError({ data: { errcode: 'M_UNKNOWN_TOKEN' } }), true);
  assert.equal(api.isInvalidAccessTokenError({ cause: new Error('[401] Invalid access token passed.') }), true);
  assert.equal(api.isInvalidAccessTokenError({ statusCode: 401, errcode: 'M_FORBIDDEN' }), false);
  const circular = { message: 'offline' };
  circular.cause = circular;
  assert.equal(api.isInvalidAccessTokenError(circular), false);
});

test('signing out queues that device’s encryption database for deletion, never a saved one', async () => {
  const gone = session('gone');
  const kept = session('kept');
  matrixState.matrixSessions = [gone, kept];
  matrixState.pendingStoreDeletions = [];
  await api.restoreSession(gone);
  api.logout();
  assert.deepEqual(matrixState.pendingStoreDeletions, [{ userId: '@gone:test', deviceId: 'gone' }]);

  // Left over from a previous run, but that device is saved again: dropped, not deleted.
  matrixState.pendingStoreDeletions = [{ userId: '@kept:test', deviceId: 'kept' }];
  api.finishPendingStoreDeletions();
  assert.deepEqual(matrixState.pendingStoreDeletions, []);
});

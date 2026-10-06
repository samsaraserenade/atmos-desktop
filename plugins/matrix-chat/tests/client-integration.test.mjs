import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { matrixState, controls, clients, writes, revoked } from './fake-environment.mjs';

const fakeUrl = new URL('./fake-environment.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './state.js' || specifier === './vault.js' || specifier === './oauth.js' || specifier === 'atmos-sdk' || specifier.includes('/vendor/')) return { url: fakeUrl, shortCircuit: true };
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

test('signing out or removing an account is written at once; a refreshed token before it is used (R21)', async () => {
  matrixState.matrixSessions = [session('c'), session('d')];
  await api.switchAccount('@c:test');
  writes.length = 0;
  const removal = api.removeAccount('@d:test');
  assert.ok(writes.includes('flush'), 'removed now, not 100 ms later');
  await removal;
  writes.length = 0;
  const signedOut = api.logout();
  assert.ok(writes.includes('flush'));
  await signedOut;
  const client = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'));
  assert.match(client, /await storeRefreshedTokens\(session, tokens\);/, 'the new refresh token is on disk before the SDK uses it');
});

test('a browser sign-in that finishes after logging out is dropped, and ended on the server (R34)', async () => {
  let finish;
  controls.authMetadata = async () => ({ issuer: 'https://auth.test/' });
  controls.authorize = () => new Promise(resolve => { finish = resolve; });
  controls.whoami = async () => ({ user_id: '@oauth:test', device_id: 'oauth-device' });
  const signIn = api.loginWithOAuth('https://test');
  const rejected = assert.rejects(signIn, { name: 'AbortError' });
  await tick();
  await api.logout();
  finish({ accessToken: 'late-access', refreshToken: 'late-refresh' });
  await rejected;
  assert.equal(api.getClient(), null);
  assert.equal(matrixState.matrixSessions.some(saved => saved.userId === '@oauth:test'), false, 'not saved again');
  assert.deepEqual(revoked, ['late-refresh'], 'the device it made is ended');
  controls.authMetadata = null;
});

test("switching away from an account whose start is stuck isn't held up by it (R35)", { timeout: 5_000 }, async () => {
  matrixState.matrixSessions = [session('e'), session('f')];
  let finish;
  controls.init = client => client.getUserId() === '@e:test' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  const first = api.switchAccount('@e:test');
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  await api.switchAccount('@f:test'); // E's encryption setup still stuck
  assert.equal(api.getUserId(), '@f:test');
  finish();
  await rejected;
  assert.equal(api.getUserId(), '@f:test', "E's late finish doesn't take over");
  controls.init = async () => {};
});

test('logging out of an account whose start is stuck, then signing in, is not held up either (R35)', { timeout: 5_000 }, async () => {
  matrixState.matrixSessions = [session('g')];
  let finish;
  controls.init = client => client.getUserId() === '@g:test' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  const stuck = api.switchAccount('@g:test');
  const rejected = assert.rejects(stuck, { name: 'AbortError' });
  await tick();
  await api.logout();
  controls.login = async () => ({ user_id: '@h:test', access_token: 'h-token', device_id: 'h' });
  await api.login('https://test', '@h:test', 'password'); // G's setup still stuck
  assert.equal(api.getUserId(), '@h:test');
  finish();
  await rejected;
  controls.init = async () => {};
});

test('a sign-in is written before it is used, and a logout while it is written takes it back out (R21, R34)', { timeout: 5_000 }, async () => {
  matrixState.matrixSessions = [];
  controls.login = async () => ({ user_id: '@i:test', access_token: 'i-token', device_id: 'i' });
  writes.length = 0;
  await api.login('https://test', '@i:test', 'password');
  assert.ok([0, 1].includes(writes.indexOf('flush')), 'written before it is used');
  // An invalid token: the account goes, written at once.
  writes.length = 0;
  api.handleInvalidAccessToken(Object.assign(new Error('gone'), { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 }));
  assert.ok(writes.includes('flush'));
  // A browser sign-in whose save is under way when you log out.
  let release;
  controls.flush = () => new Promise(resolve => { release = resolve; });
  controls.authMetadata = async () => ({ issuer: 'https://auth.test/' });
  controls.authorize = async () => ({ accessToken: 'j-access', refreshToken: 'j-refresh' });
  controls.whoami = async () => ({ user_id: '@j:test', device_id: 'j' });
  revoked.length = 0;
  const signIn = api.loginWithOAuth('https://test');
  const rejected = assert.rejects(signIn, { name: 'AbortError' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  controls.flush = null;
  const loggedOut = api.logout();
  release();
  await loggedOut;
  await rejected;
  assert.equal(matrixState.matrixSessions.some(saved => saved.userId === '@j:test'), false, 'not left saved');
  assert.deepEqual(revoked, ['j-refresh'], 'its device ended');
  controls.authMetadata = null;
});

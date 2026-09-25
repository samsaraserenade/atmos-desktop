import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { handlers, calls } from './fake-oauth-atmos.mjs';

const fakeAtmos = new URL('./fake-oauth-atmos.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeAtmos, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const oauth = await import('../src/oauth.js');
const state = await import('../src/state.js');
const { createOAuthCallbacks } = createRequire(import.meta.url)('../oauth-callback.cjs');

const get = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
  }).on('error', reject);
});

const METADATA = {
  issuer: 'https://auth.test/',
  authorization_endpoint: 'https://auth.test/authorize',
  token_endpoint: 'https://auth.test/oauth2/token',
  registration_endpoint: 'https://auth.test/oauth2/registration',
  revocation_endpoint: 'https://auth.test/oauth2/revoke',
  account_management_uri: 'https://auth.test/account',
  prompt_values_supported: ['create'],
};

// A fetch-shaped reply as main.cjs's 'fetch' handler returns it.
const reply = (status, json) => ({
  ok: true, url: '', status, statusText: '', headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode(JSON.stringify(json)),
});
const bodyOf = request => new TextDecoder().decode(request.body);

test('loopback listener ignores wrong state, then hands back the code and closes', async () => {
  const opened = [];
  const callbacks = createOAuthCallbacks({ http, shell: { openExternal: async url => { opened.push(url); } } });
  const flowState = 'a'.repeat(32);
  const { flowId, port, path } = await callbacks.listen(null, { state: flowState });
  const base = `http://127.0.0.1:${port}${path}`;

  await assert.rejects(callbacks.open(flowId, 'http://auth.test/authorize'), /https/);
  await callbacks.open(flowId, 'https://auth.test/authorize?x=1');
  assert.deepEqual(opened, ['https://auth.test/authorize?x=1']);

  const waiting = callbacks.wait(flowId);
  assert.equal((await get(`${base}?code=evil&state=wrong`)).status, 400);
  assert.equal((await get(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  const ok = await get(`${base}?code=the-code&state=${flowState}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /return to Atmos/);
  assert.deepEqual(await waiting, { code: 'the-code', state: flowState });
  await assert.rejects(get(base)); // listener is gone
});

test('loopback listener reports browser cancellation, timeouts and superseded flows', async () => {
  const callbacks = createOAuthCallbacks({ http, shell: { openExternal: async () => {} }, timeoutMs: 50 });
  const s = 'b'.repeat(32);
  const first = await callbacks.listen(null, { state: s });
  const second = await callbacks.listen(null, { state: s }); // starting again cancels the first
  assert.deepEqual(await callbacks.wait(first.flowId), { error: 'cancelled' });
  const denied = await get(`http://127.0.0.1:${second.port}/callback?error=access_denied&state=${s}`);
  assert.match(denied.body, /cancelled/i);
  assert.equal((await callbacks.wait(second.flowId)).error, 'access_denied');
  const third = await callbacks.listen(null, { state: s });
  assert.deepEqual(await callbacks.wait(third.flowId), { error: 'timeout' });
  await assert.rejects(callbacks.listen(null, { state: 'short' }), /state/);
});

test('authorize runs PKCE through the browser and exchanges the code', async () => {
  let listened;
  let openedUrl;
  const tokenRequests = [];
  handlers['oauth-listen'] = payload => { listened = payload; return { flowId: 'f1', port: 5555, path: '/callback' }; };
  handlers['oauth-open'] = ({ url }) => { openedUrl = new URL(url); };
  handlers['oauth-wait'] = () => ({ code: 'code-1', state: listened.state });
  handlers['oauth-cancel'] = () => {};
  handlers.fetch = request => {
    tokenRequests.push(request);
    return reply(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 300, token_type: 'bearer' });
  };

  const before = Date.now();
  const tokens = await oauth.authorize({ metadata: METADATA, clientId: 'client-1', deviceId: 'DEVICE1234', prompt: 'create' });
  assert.equal(tokens.accessToken, 'at-1');
  assert.equal(tokens.refreshToken, 'rt-1');
  assert.equal(tokens.deviceId, 'DEVICE1234');
  assert.ok(tokens.expiresAt >= before + 299_000);

  const q = openedUrl.searchParams;
  assert.equal(openedUrl.origin + openedUrl.pathname, METADATA.authorization_endpoint);
  assert.equal(q.get('response_mode'), 'query');
  assert.equal(q.get('prompt'), 'create');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  assert.equal(q.get('state'), listened.state);
  assert.equal(q.get('scope'), 'urn:matrix:client:api:* urn:matrix:client:device:DEVICE1234');

  const [token] = tokenRequests;
  assert.equal(token.url, METADATA.token_endpoint);
  const form = new URLSearchParams(bodyOf(token));
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-1');
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
  assert.equal(q.get('code_challenge'), challenge);
});

test('authorize rejects a mismatched state and surfaces cancellation', async () => {
  handlers['oauth-wait'] = () => ({ code: 'code-1', state: 'someone-else' });
  await assert.rejects(oauth.authorize({ metadata: METADATA, clientId: 'c' }), { code: 'state_mismatch' });
  handlers['oauth-wait'] = () => ({ error: 'cancelled' });
  await assert.rejects(oauth.authorize({ metadata: METADATA, clientId: 'c' }), { code: 'cancelled' });
});

test('refresh keeps a non-rotated refresh token and maps server rejections', async () => {
  const auth = oauth.sessionAuthFields(METADATA, 'client-1');
  assert.equal(auth.accountUrl, 'https://auth.test/account');
  handlers.fetch = () => reply(200, { access_token: 'at-2', expires_in: 300, token_type: 'Bearer' });
  assert.equal((await oauth.refreshTokens(auth, 'rt-1')).refreshToken, 'rt-1');
  handlers.fetch = () => reply(400, { error: 'invalid_grant', error_description: 'expired' });
  await assert.rejects(oauth.refreshTokens(auth, 'rt-1'), { name: 'OAuthSignInError', code: 'invalid_grant' });
});

test('client registration sends Atmos metadata as a native app', async () => {
  let sent;
  handlers.fetch = request => { sent = JSON.parse(bodyOf(request)); return reply(201, { client_id: 'new-client' }); };
  assert.equal(await oauth.registerClient(METADATA), 'new-client');
  assert.equal(sent.client_uri, 'https://github.com/samsaraserenade/atmos-desktop');
  assert.equal(sent.application_type, 'native');
  assert.deepEqual(sent.redirect_uris, ['http://127.0.0.1/callback']);
  assert.equal(sent.token_endpoint_auth_method, 'none');
});

test('sealed session payload keeps OAuth session fields; client registrations stay in plain state', () => {
  const target = structuredClone(state.defaults);
  const oauthSession = {
    homeserver: 'https://matrix.org', userId: '@a:matrix.org', accessToken: 'at', deviceId: 'D',
    refreshToken: 'rt', expiresAt: 123, auth: { ...oauth.sessionAuthFields(METADATA, 'client-1'), junk: 1 },
  };
  state.applySessionPayload(target, { active: '@a:matrix.org', sessions: [oauthSession, { homeserver: 'https://x', userId: '@b:x', accessToken: 'pw', deviceId: 'E' }] });
  assert.equal(target.matrixSession, target.matrixSessions[0]); // one object, not two copies
  const payload = state.sessionPayload(target);
  assert.equal(payload.active, '@a:matrix.org');
  assert.equal(payload.sessions[0].refreshToken, 'rt');
  assert.equal(payload.sessions[0].expiresAt, 123);
  assert.equal(payload.sessions[0].auth.tokenEndpoint, METADATA.token_endpoint);
  assert.equal(payload.sessions[0].auth.junk, undefined);
  assert.equal(payload.sessions[1].auth, undefined); // password session unchanged

  state.applySaved(target, { oauthClients: { 'https://auth.test/': { clientId: 'client-1', clientUri: 'u' }, bad: {} } });
  const saved = state.serialize(target);
  assert.deepEqual(Object.keys(saved.oauthClients), ['https://auth.test/']);
  assert.equal(JSON.stringify(saved).includes('"at"'), false); // no tokens in the plain part
  assert.ok(calls.length > 0);
});

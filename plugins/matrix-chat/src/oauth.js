/**
 * Matrix's OAuth 2.0 sign-in ("next-generation auth", MSC3861 / Matrix
 * spec v1.15), used by matrix.org and any homeserver that runs the Matrix
 * Authentication Service. Signing in and creating an account both happen on
 * the homeserver's own web page in the system browser, so captchas, terms,
 * email checks and "Continue with GitHub/Google" all work without Atmos
 * having to implement any of them.
 *
 *   1. registerClient()   — tell the auth server about Atmos once per server
 *   2. authorize()        — PKCE + state, browser round-trip via main.cjs's
 *                           127.0.0.1 listener (oauth-callback.cjs), code
 *                           exchange for tokens
 *   3. refreshTokens()    — access tokens are short-lived; the refresh token
 *                           is rotated on every use, so callers must save it
 *   4. revokeToken()      — sign-out for OAuth sessions (not /logout)
 *
 * Every request goes through matrixFetch (the main-process network stack),
 * same as the rest of Matrix traffic, so auth servers never have to allow
 * Atmos's atmos-app:// origin via CORS.
 */
import atmos from 'atmos-sdk';
import { matrixFetch } from './matrix-fetch.js';

const invoke = (name, ...args) => atmos.invoke('plugin:matrix-chat', name, ...args);

/** Atmos's public identity with auth servers. Shown on their consent page. */
export const CLIENT_URI = 'https://github.com/samsaraserenade/atmos-desktop';
const LOOPBACK_REDIRECT = 'http://127.0.0.1/callback';

export class OAuthSignInError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OAuthSignInError';
    this.code = code;
  }
}

export function clientMetadata() {
  return {
    client_name: 'Atmos',
    client_uri: CLIENT_URI,
    application_type: 'native',
    // Loopback redirects may use any port (RFC 8252 §7.3); each sign-in
    // listens on a fresh one.
    redirect_uris: [LOOPBACK_REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** The parts of the server's auth metadata a session keeps, so tokens can be
 *  refreshed on launch before anything else talks to the server. */
export function sessionAuthFields(metadata, clientId) {
  return {
    issuer: String(metadata.issuer),
    clientId: String(clientId),
    tokenEndpoint: String(metadata.token_endpoint),
    revocationEndpoint: metadata.revocation_endpoint ? String(metadata.revocation_endpoint) : undefined,
    accountUrl: metadata.account_management_uri ? String(metadata.account_management_uri) : undefined,
  };
}

export function supportsSignUp(metadata) {
  return Array.isArray(metadata?.prompt_values_supported) && metadata.prompt_values_supported.includes('create');
}

export function randomString(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(data);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** A device id in the style other Matrix clients mint (10 upper-case letters/digits). */
export function newDeviceId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const data = crypto.getRandomValues(new Uint8Array(10));
  return [...data].map(byte => alphabet[byte % alphabet.length]).join('');
}

export function scopeFor(deviceId) {
  return `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function post(url, body, { json = false } = {}) {
  const response = await matrixFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
    },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const code = data?.error || data?.errcode || `http_${response.status}`;
    throw new OAuthSignInError(code, data?.error_description || data?.error || `The sign-in server answered ${response.status}.`);
  }
  return data;
}

function requireEndpoint(metadata, name) {
  const value = metadata?.[name];
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new OAuthSignInError('unsupported_server', `This homeserver's sign-in service is missing its ${name.replace(/_/g, ' ')}.`);
  }
  return value;
}

/** Register Atmos with the auth server (dynamic client registration). Returns client_id. */
export async function registerClient(metadata) {
  const endpoint = requireEndpoint(metadata, 'registration_endpoint');
  const data = await post(endpoint, clientMetadata(), { json: true });
  if (typeof data?.client_id !== 'string' || !data.client_id) {
    throw new OAuthSignInError('registration_invalid', 'The sign-in server did not register Atmos.');
  }
  return data.client_id;
}

function normalizeTokens(data) {
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw new OAuthSignInError('invalid_token_response', 'The sign-in server did not return an access token.');
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

/**
 * Run one browser sign-in. `prompt: 'create'` opens the server's account
 * creation page instead of its sign-in page. Resolves with
 * { accessToken, refreshToken, expiresAt, deviceId }.
 *
 * `onFlow(cancel)` receives a function that abandons the wait (the
 * listener closes and this rejects with code 'cancelled').
 */
export async function authorize({ metadata, clientId, deviceId = newDeviceId(), prompt, loginHint, onFlow }) {
  const authorizationEndpoint = requireEndpoint(metadata, 'authorization_endpoint');
  const tokenEndpoint = requireEndpoint(metadata, 'token_endpoint');
  const state = randomString(24);
  const verifier = randomString(48);

  const { flowId, port, path } = await invoke('oauth-listen', { state });
  onFlow?.(() => invoke('oauth-cancel', flowId).catch(() => {}));
  const redirectUri = `http://127.0.0.1:${port}${path}`;

  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  // The listener is a server: it can only see query parameters, not a #fragment.
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopeFor(deviceId));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  if (prompt) url.searchParams.set('prompt', prompt);
  if (loginHint) url.searchParams.set('login_hint', loginHint);

  try {
    await invoke('oauth-open', { flowId, url: url.href });
  } catch (error) {
    await invoke('oauth-cancel', flowId).catch(() => {});
    throw error;
  }

  const result = await invoke('oauth-wait', flowId);
  if (result?.error) {
    const messages = {
      cancelled: 'Sign-in was cancelled.',
      access_denied: 'Sign-in was cancelled in the browser.',
      timeout: 'Sign-in timed out. Try again.',
    };
    throw new OAuthSignInError(result.error, messages[result.error] || result.errorDescription || 'Sign-in failed.');
  }
  if (result?.state !== state || !result?.code) {
    throw new OAuthSignInError('state_mismatch', 'The browser returned an unexpected sign-in response. Try again.');
  }

  const data = await post(tokenEndpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: result.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return { ...normalizeTokens(data), deviceId };
}

/** Swap a refresh token for new tokens. The old refresh token stops working. */
export async function refreshTokens(auth, refreshToken) {
  const data = await post(auth.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: refreshToken,
  });
  const tokens = normalizeTokens(data);
  // Servers that don't rotate keep the same refresh token.
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

/** End an OAuth session on the server. Revoking the refresh token ends the whole session. */
export async function revokeToken(auth, token, hint) {
  if (!auth?.revocationEndpoint || !token) return;
  await post(auth.revocationEndpoint, {
    token,
    client_id: auth.clientId,
    ...(hint ? { token_type_hint: hint } : {}),
  });
}

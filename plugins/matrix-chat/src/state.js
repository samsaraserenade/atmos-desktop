/**
 * Matrix Chat's saved state, kept by Atmos in the `matrix-chat` namespace
 * (the same one the in-page version used, so display preferences carry
 * over). Only the background frame (boot.js) loads and saves it; the panel
 * and the Rooms widget read and change it through the engine.
 *
 * Secrets are never saved as plain text: the saved sessions (access and
 * refresh tokens, sign-in server details) are sealed with the vault's
 * sessions key (src/vault.js) into one `sealedSessions` value. Everything
 * else here is display preferences.
 */
import atmos from 'atmos-sdk';
import { seal, unseal } from './vault.js';

/** 2: sessions sealed, encryption databases encrypted, own frame origin. */
export const STORAGE_VERSION = 2;
const SESSIONS_PURPOSE = 'matrix-chat/sessions';

export const defaults = Object.freeze({
  matrixSession: null,
  matrixSessions: [],
  notificationSound: true,
  railOrder: [],
  // Which groups in the Matrix Chat widget are open (Direct Messages to start).
  openSpaces: ['__direct__'],
  // The room each account had open last, so the Chat panel reopens it.
  lastRooms: {},
  // Set once the frames version has started afresh (see boot.js).
  framesFreshStart: false,
  // OAuth sign-in: Atmos's client id with each auth server it has
  // registered with, keyed by issuer ({ clientId, clientUri }). See src/oauth.js.
  oauthClients: {},
  // How secrets are stored (see STORAGE_VERSION and boot.js secureStart()).
  storageVersion: 0,
  // Encryption databases of signed-out devices still to delete
  // ([{ userId, deviceId }]): deleting waits for the database to close, so
  // a deletion interrupted by quitting is finished on the next launch.
  pendingStoreDeletions: [],
});

export const matrixState = structuredClone({ ...defaults, legacySessions: [], sessionsUnreadable: false });

const optionalString = value => (typeof value === 'string' && value ? value : undefined);

// Sessions from OAuth sign-in (src/oauth.js) also carry a refresh token,
// when the access token expires, and the auth server details needed to
// refresh or revoke it. Password sessions leave these out.
const cleanAuth = auth => (auth && typeof auth === 'object' && optionalString(auth.clientId) && optionalString(auth.tokenEndpoint) ? {
  issuer: String(auth.issuer || ''),
  clientId: auth.clientId,
  tokenEndpoint: auth.tokenEndpoint,
  revocationEndpoint: optionalString(auth.revocationEndpoint),
  accountUrl: optionalString(auth.accountUrl),
} : undefined);

const cleanSession = session => (session?.accessToken ? {
  homeserver: String(session.homeserver || ''),
  userId: String(session.userId || ''),
  accessToken: String(session.accessToken),
  deviceId: session.deviceId ? String(session.deviceId) : undefined,
  refreshToken: optionalString(session.refreshToken),
  expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : undefined,
  auth: cleanAuth(session.auth),
} : null);

const cleanOAuthClients = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
  .filter(([issuer, entry]) => issuer && typeof entry?.clientId === 'string' && entry.clientId)
  .map(([issuer, entry]) => [issuer, { clientId: entry.clientId, clientUri: String(entry.clientUri || '') }]));

const cleanLastRooms = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
  .filter(([userId, roomId]) => typeof userId === 'string' && typeof roomId === 'string' && roomId.startsWith('!')));

const cleanStoreDeletions = value => (Array.isArray(value) ? value : [])
  .filter(item => typeof item?.userId === 'string' && item.userId && typeof item?.deviceId === 'string' && item.deviceId)
  .map(item => ({ userId: item.userId, deviceId: item.deviceId }))
  .slice(0, 50);

/** Non-secret saved state. Sessions saved as plain text by older versions go
 *  to `legacySessions`, for boot.js to sign out — never back into use. */
export function applySaved(target, saved) {
  if (!saved || typeof saved !== 'object') return;
  const legacy = [saved.matrixSession, ...(Array.isArray(saved.matrixSessions) ? saved.matrixSessions : [])].map(cleanSession).filter(Boolean);
  target.legacySessions = legacy.filter((session, i) => legacy.findIndex(other => other.accessToken === session.accessToken) === i);
  target.notificationSound = saved.notificationSound !== false;
  target.lastRooms = cleanLastRooms(saved.lastRooms);
  target.openSpaces = Array.isArray(saved.openSpaces) ? saved.openSpaces.filter(id => typeof id === 'string').slice(0, 200) : ['__direct__'];
  target.railOrder = Array.isArray(saved.railOrder) ? saved.railOrder.filter(id => typeof id === 'string') : [];
  target.framesFreshStart = saved.framesFreshStart === true;
  target.oauthClients = cleanOAuthClients(saved.oauthClients);
  target.storageVersion = Number.isInteger(saved.storageVersion) ? saved.storageVersion : 0;
  target.pendingStoreDeletions = cleanStoreDeletions(saved.pendingStoreDeletions);
}

/** What gets sealed: every saved account, and which one is active. */
export function sessionPayload(state = matrixState) {
  const sessions = (Array.isArray(state.matrixSessions) ? state.matrixSessions : []).map(cleanSession).filter(Boolean);
  const active = cleanSession(state.matrixSession);
  if (active && !sessions.some(session => session.userId === active.userId)) sessions.unshift(active);
  return { active: active?.userId || null, sessions };
}

/** Put unsealed sessions into `target`; the active session is the same object as its list entry. */
export function applySessionPayload(target, payload) {
  const sessions = (Array.isArray(payload?.sessions) ? payload.sessions : []).map(cleanSession).filter(Boolean);
  target.matrixSessions = sessions;
  target.matrixSession = sessions.find(session => session.userId === payload?.active) || null;
}

/** Non-secret state to save (sessions are sealed separately; see flush()). */
export function serialize(state = matrixState) {
  return {
    notificationSound: state.notificationSound !== false,
    railOrder: Array.isArray(state.railOrder) ? [...state.railOrder] : [],
    openSpaces: Array.isArray(state.openSpaces) ? [...state.openSpaces] : [],
    lastRooms: cleanLastRooms(state.lastRooms),
    framesFreshStart: state.framesFreshStart === true,
    oauthClients: cleanOAuthClients(state.oauthClients),
    storageVersion: Number.isInteger(state.storageVersion) ? state.storageVersion : 0,
    pendingStoreDeletions: cleanStoreDeletions(state.pendingStoreDeletions),
  };
}

/** Load saved state. The vault must be open (boot.js opens it first). */
export async function loadState() {
  const saved = await atmos.state.get();
  applySaved(matrixState, saved);
  matrixState.sessionsUnreadable = false;
  applySessionPayload(matrixState, null);
  if (typeof saved?.sealedSessions === 'string') {
    try {
      applySessionPayload(matrixState, await unseal(saved.sealedSessions, SESSIONS_PURPOSE));
    } catch (error) {
      // Sealed with a vault key this computer no longer has (see vault.cjs).
      console.warn('[matrix-chat] saved sessions could not be opened; sign in again:', error?.message || error);
      applySessionPayload(matrixState, null);
      matrixState.sessionsUnreadable = true;
    }
  }
}

let timer = null;
let writing = Promise.resolve();

/** Save soon (several changes in a row write once). */
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 100);
}

/** Save now. Saves run one after another, so an older one can't land last. */
export function flush() {
  clearTimeout(timer);
  timer = null;
  writing = writing.then(async () => {
    const payload = serialize();
    payload.sealedSessions = await seal(sessionPayload(matrixState), SESSIONS_PURPOSE);
    await atmos.state.set(payload);
  }).catch(error => console.error('[matrix-chat] could not save state:', error));
  return writing;
}

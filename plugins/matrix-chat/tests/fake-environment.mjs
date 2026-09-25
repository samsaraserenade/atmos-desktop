import { EventEmitter } from 'node:events';

export const matrixState = { matrixSession: null, matrixSessions: [], pendingStoreDeletions: [] };
// Stand-in for src/vault.js.
export const cryptoStoreKey = () => new Uint8Array(32);
export const save = () => {};
export const flush = async () => {};
// Stand-in for the atmos-sdk module (matrix-fetch.js, notifications.js).
export default {
  invoke: async () => ({ ok: false, name: 'TypeError', message: 'offline in tests' }),
  audio: { load: async () => {} },
  state: { get: async () => ({}), set: async () => {} },
};
export const clients = [];
export const controls = { init: async () => {}, login: async () => ({ user_id: '@login:test', access_token: 'login-token', device_id: 'device' }) };
export const ClientEvent = { Sync: 'sync', Room: 'room' };
export const RoomEvent = { Timeline: 'timeline', TimelineReset: 'reset', Redaction: 'redaction', RedactionCancelled: 'unredaction', Receipt: 'receipt', LocalEchoUpdated: 'echo' };
export const MatrixEventEvent = { Decrypted: 'decrypted' };
export const HttpApiEvent = { SessionLoggedOut: 'Session.logged_out' };
export class TokenRefreshLogoutError extends Error {}
export const decryptAttachment = async bytes => bytes;
export const encryptAttachment = async data => ({ data, info: {} });
export function createClient(options) {
  const client = Object.assign(new EventEmitter(), {
    options, starts: 0, stops: 0,
    getUserId: () => options.userId,
    getRooms: () => [],
    getUser: () => null,
    getHomeserverUrl: () => options.baseUrl,
    initRustCrypto: () => controls.init(client),
    login: (...args) => controls.login(...args),
    startClient: async () => { client.starts++; },
    stopClient: () => { client.stops++; },
    // Stubs for logout()/removeAccount()'s best-effort server-side cleanup
    // (see src/client.js) — real matrix-js-sdk clients return promises
    // from both, and that code .catch()es them, so these must too.
    logout: async () => {},
    clearStores: async () => {},
  });
  clients.push(client);
  return client;
}

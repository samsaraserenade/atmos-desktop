/**
 * Matrix Chat's background frame: the Matrix connection (sync, encryption,
 * unread counts, the notification ping), alive for the whole session so
 * rooms are warm whenever the panel opens.
 *
 * The panel and the Rooms widget are first-party frames on the same origin
 * as this one, so they use this frame's engine directly
 * (atmos.background() → window.__matrixEngine) rather than copying rooms
 * and timelines across by message; see src/ui/engine.js.
 */
import atmos from 'atmos-sdk';
import { loadState, matrixState, flush, save, STORAGE_VERSION } from './src/state.js';
import { openVault } from './src/vault.js';
import { revokeToken } from './src/oauth.js';
import * as client from './src/client.js';
import * as preferences from './src/preferences.js';
import * as relations from './src/relation-index.js';
import { matrixFetch } from './src/matrix-fetch.js';
import { initNotifications } from './src/notifications.js';

// The vault key (OS secure storage, via main.cjs) unlocks saved sessions
// and encryption databases, so it comes before anything else.
await openVault();
await loadState();

/**
 * Secure storage, once. Before storage version 2, sessions (tokens) were
 * saved as plain text and encryption databases unencrypted, in an origin
 * other first-party extensions shared. Neither can be carried over safely:
 * those devices are signed out of the homeserver (best effort), their saved
 * sessions dropped, and you sign in again; your recovery key or another
 * device unlocks message history for the new device. Core deletes the old
 * databases from the shared origin (extension.json "legacyStorage"), and the
 * in-page version's are deleted here. Display preferences are kept.
 */
async function secureStart() {
  if (matrixState.storageVersion >= STORAGE_VERSION) return;
  const old = matrixState.legacySessions || [];
  matrixState.legacySessions = [];
  matrixState.matrixSession = null;
  matrixState.matrixSessions = [];
  matrixState.framesFreshStart = true;
  matrixState.storageVersion = STORAGE_VERSION;
  await flush(); // the plain-text tokens leave the disk here
  atmos.legacy.deleteIndexedDB()
    .then(names => { if (names.length) console.info('[matrix-chat] deleted old key stores:', names.join(', ')); })
    .catch(error => console.warn('[matrix-chat] could not delete old key stores:', error));
  for (const session of old) void signOut(session);
  if (old.length) {
    client.setSignInNotice('Matrix Chat now keeps your sign-in and encryption keys encrypted on this computer. Sign in again to continue, then use your recovery key or another device to unlock your message history.');
  }
}

async function signOut(session) {
  try {
    if (session.auth?.revocationEndpoint) {
      await revokeToken(session.auth, session.refreshToken || session.accessToken, session.refreshToken ? 'refresh_token' : 'access_token');
      return;
    }
    const url = new URL('/_matrix/client/v3/logout', session.homeserver).href;
    const response = await matrixFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 401) console.warn('[matrix-chat] old device sign-out returned', response.status);
  } catch (error) {
    console.warn('[matrix-chat] could not sign an old device out:', error?.message || error);
  }
}

/**
 * What the Chat panel shows: a room, or nothing yet ({ type: 'none' }).
 * Shared so the sidebar widget can follow and change it. The room each
 * account had open is remembered, so the panel reopens it.
 *
 * Requests are for the panel to act on once it's there: the widget's "+"
 * puts rev/ in the message bar ({ action: 'command', text, parentSpaceId }).
 */
function createView() {
  let current = { type: 'none' };
  const listeners = new Set();
  let request = null;
  const requestListeners = new Set();
  const notify = (set, ...args) => {
    for (const fn of [...set]) {
      try { fn(...args); } catch (error) { console.error('[matrix-chat] view listener failed:', error); }
    }
  };
  function set(next) {
    if (next.type === current.type && next.roomId === current.roomId) return;
    current = Object.freeze(next);
    notify(listeners, current);
  }
  return {
    get: () => current,
    showRoom(roomId) {
      const userId = client.getUserId();
      if (userId && matrixState.lastRooms[userId] !== String(roomId)) {
        matrixState.lastRooms = { ...matrixState.lastRooms, [userId]: String(roomId) };
        save();
      }
      set({ type: 'room', roomId: String(roomId) });
    },
    showNone() { set({ type: 'none' }); },
    /** The signed-in account's last room, or nothing. */
    showLast() {
      const roomId = matrixState.lastRooms[client.getUserId()];
      set(roomId ? { type: 'room', roomId } : { type: 'none' });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ask(next) {
      request = Object.freeze({
        action: String(next?.action || ''),
        text: String(next?.text || ''),
        section: String(next?.section || ''),
        parentSpaceId: next?.parentSpaceId ? String(next.parentSpaceId) : '',
      });
      notify(requestListeners);
    },
    /** The pending request, once. */
    takeRequest() { const next = request; request = null; return next; },
    subscribeRequests(fn) {
      requestListeners.add(fn);
      return () => requestListeners.delete(fn);
    },
  };
}

await secureStart();
if (matrixState.sessionsUnreadable) {
  client.setSignInNotice('Your saved Matrix sessions couldn\'t be unlocked on this computer. Sign in again to continue.');
}
client.finishPendingStoreDeletions();

const view = createView();
// Switching account reopens that account's last room; signing out shows nothing.
client.onAccountChange(() => view.showLast());

Object.defineProperty(window, '__matrixEngine', {
  value: Object.freeze({ client, preferences, relations, state: { matrixState, save }, view }),
});

initNotifications();

if (matrixState.matrixSession?.accessToken) {
  try {
    const restored = await client.restoreSession(matrixState.matrixSession);
    view.showLast();
    await client.startClient(restored);
  } catch (error) {
    if (client.handleInvalidAccessToken(error, matrixState.matrixSession)) {
      console.warn('[matrix-chat] saved access token was rejected; sign in again');
    } else {
      console.error('[matrix-chat] could not restore the session:', error);
    }
  }
}

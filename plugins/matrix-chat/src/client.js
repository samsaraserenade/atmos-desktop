import { createRoomService } from './room-service.js';
import { createSpaceService } from './space-service.js';
import { SessionCoordinator } from './session-runtime.js';
import { createMessagingService } from './messaging-service.js';
import { createMediaService } from './media-service.js';
import { createCryptoService, initCryptoForSession, createSecretStorageCallbacks, deleteCryptoStore } from './crypto-service.js';
import { cryptoStoreKey } from './vault.js';
import { createTrustService } from './trust-service.js';
import { WorkQueue } from './work-queue.js';
import { invalidateRoomRelations, clearRelationIndexes } from './relation-index.js';
import { BoundedCache } from './bounded-cache.js';
import { matrixFetch } from './matrix-fetch.js';
import * as oauth from './oauth.js';
import atmos from 'atmos-sdk';
/** Public Matrix facade. SessionCoordinator owns account transitions; services
 * implement account-bound messaging, media, room actions and crypto recovery. */

import * as sdk from '../vendor/matrix-sdk.bundle.js';
import { decryptAttachment, encryptAttachment } from '../vendor/matrix-encrypt-attachment.bundle.js';
import { matrixState, save, flush } from './state.js';

let client = null;
const sessions = new SessionCoordinator();
const secretStorageKeyHolders = new WeakMap();
let lastSessionIssue = null;
const cryptoInitialization = new WeakMap();

const listeners = {
  room: [],
  timeline: [],
  timelineReset: [],
  decrypted: [],
  sync: [],
  receipt: [],
  unread: [],
  localEcho: [],
  account: [],
  deviceTrust: [],
  trust: [],
};

// Listeners belong to the panel and the Rooms widget too, which live in
// other frames: one that fails (or whose frame has just gone) must not
// stop the others, or the engine's own handler that called emit().
function emit(kind, ...args) {
  for (const fn of [...listeners[kind]]) {
    if (!listeners[kind].includes(fn)) continue;
    try { fn(...args); } catch (error) { console.error(`[matrix-chat] ${kind} listener failed:`, error); }
  }
}

function on(kind, fn) {
  listeners[kind].push(fn);
  return () => {
    listeners[kind] = listeners[kind].filter(f => f !== fn);
  };
}

/** Subscribe to new/updated rooms. Returns an unsubscribe function. */
export function onRoom(fn) { return on('room', fn); }

/** Subscribe to timeline (message) events across all rooms. fn receives
 *  (event, room, toStartOfTimeline) — that third flag is true for
 *  backfilled/history events (initial sync's timeline replay, a gappy-sync
 *  reset, scrollback landing events) and false for a genuinely new live
 *  event. Subscribers that mean "a new message just arrived" (as opposed
 *  to "the SDK reshuffled its in-memory history") need this to tell the
 *  two apart — see room-view.js's onTimeline handler for why. Returns an
 *  unsubscribe function. */
export function onTimeline(fn) { return on('timeline', fn); }

/** Subscribe to replacement of a room's live timeline. This happens after
 *  limited/gappy sync responses; the SDK then replays the replacement's
 *  events as history, so consumers must reconcile rather than append them. */
export function onTimelineReset(fn) { return on('timelineReset', fn); }

/** Subscribe to an encrypted event becoming readable. RoomEvent.Timeline may
 *  have already fired while its public type was still m.room.encrypted, so
 *  this is a separate render signal rather than another timeline insertion. */
export function onDecrypted(fn) { return on('decrypted', fn); }

/** Subscribe to SDK sync-state changes ('PREPARED', 'SYNCING', etc). Returns an unsubscribe function. */
export function onSync(fn) { return on('sync', fn); }

/** Subscribe to read-receipt updates. fn receives (event, room) straight
 *  from the SDK — call getReadReceipts(room, eventId) inside your handler
 *  to get the actual list for whichever event you're rendering, since a
 *  single receipt event can move receipts for several timeline events at
 *  once. Returns an unsubscribe function. */
export function onReceipt(fn) { return on('receipt', fn); }

/** Subscribe to a room's total/highlight notification counters changing. */
export function onUnreadNotifications(fn) { return on('unread', fn); }

/** Subscribe to local-echo id swaps. Sending a message drops a local
 *  echo into the timeline immediately, under a temporary id (assigned
 *  before the server has responded) — RoomEvent.Timeline fires once for
 *  that. When the server confirms and hands back the real event id, the
 *  SDK updates that same event in place rather than emitting another
 *  RoomEvent.Timeline for it; RoomEvent.LocalEchoUpdated is the only
 *  signal that happens at all. Skipping it (as this file did before)
 *  means any DOM built from that first temporary id — e.g. a message
 *  row's data-msg-id — goes stale forever the moment the real id lands,
 *  since nothing ever tells the UI to swap it in. fn receives (event,
 *  room, oldEventId, oldStatus); oldEventId is undefined on the very
 *  first status change (there's no "old" id yet), so callers should
 *  guard on it being present before treating this as an id swap.
 *  Returns an unsubscribe function. */
export function onLocalEcho(fn) { return on('localEcho', fn); }

/** Subscribe to the active account changing — fired by switchAccount()
 *  (and by login()/addAccount() the same way, since those also make
 *  their new session the active one). fn receives { userId, homeserver }
 *  for the newly-active session. Fired right after the new client is
 *  created and wired but BEFORE startClient() resolves, deliberately —
 *  room-list.js/room-view.js want this as a "the account under you just
 *  changed, drop whatever you were rendering" signal, and waiting for
 *  the first sync to land would mean showing the previous account's
 *  rooms for a beat after the switch was already committed. Returns an
 *  unsubscribe function. */
export function onAccountChange(fn) { return on('account', fn); }

/** Subscribe to own-device or cross-signing trust changes. */
export function onDeviceTrustChange(fn) { return on('deviceTrust', fn); }

/** Subscribe to anyone's device or identity changes (message warnings, identity notices). */
export function onTrustChange(fn) { return on('trust', fn); }

function wireEvents(runtime) {
  const c = runtime.client;
  runtime.listen(sdk.ClientEvent.Sync, (syncState, _previousState, data) => {
    // A token can be revoked while the app is already running, not only
    // while boot.js is restoring it. Matrix reports that through the sync
    // error payload; retire only the client that is still active so a late
    // event from an account being switched away from cannot clear the new
    // account by accident.
    if (syncState === 'ERROR' && c === client && handleInvalidAccessToken(data?.error)) return;
    emit('sync', syncState);
  });
  runtime.listen(sdk.ClientEvent.Room, (room) => emit('room', room));
  runtime.listen('crypto.devicesUpdated', (userIds) => {
    if (c !== client) return;
    if (userIds?.includes?.(c.getUserId())) emit('deviceTrust');
    emit('trust');
  });
  runtime.listen('crossSigning.keysChanged', () => {
    if (c !== client) return;
    emit('deviceTrust');
    emit('trust');
  });
  runtime.listen('userTrustStatusChanged', (userId) => {
    if (c !== client) return;
    if (userId === c.getUserId()) emit('deviceTrust');
    emit('trust');
  });
  runtime.listen(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    invalidateRoomRelations(room);
    emit('timeline', event, room, !!toStartOfTimeline);
  });
  runtime.listen(sdk.RoomEvent.TimelineReset, (room, timelineSet, resetAllTimelines) => {
    invalidateRoomRelations(room);
    emit('timelineReset', room, timelineSet, resetAllTimelines);
  });
  runtime.listen(sdk.RoomEvent.Redaction, (_event, room) => invalidateRoomRelations(room));
  runtime.listen(sdk.RoomEvent.RedactionCancelled, (_event, room) => invalidateRoomRelations(room));
  runtime.listen(sdk.MatrixEventEvent.Decrypted, event => {
    const room = c.getRoom(event.getRoomId());
    invalidateRoomRelations(room);
    emit('decrypted', event, room);
  });
  runtime.listen(sdk.RoomEvent.Receipt, (event, room) => emit('receipt', event, room));
  runtime.listen(sdk.RoomEvent.LocalEchoUpdated, (event, room, oldEventId, oldStatus) => {
    invalidateRoomRelations(room);
    emit('localEcho', event, room, oldEventId, oldStatus);
  });
}

/** Whether a saved session exists in state — does NOT mean the client has connected yet. */
export function hasSession() {
  return !!matrixState.matrixSession?.accessToken;
}

let signInNotice = null;

/** A one-off explanation for the sign-in screen (e.g. after a security
 *  upgrade signed old sessions out); cleared once someone signs in. */
export function setSignInNotice(text) { signInNotice = text ? String(text) : null; }
export function getSignInNotice() { return signInNotice; }

/** Details for the last locally-retired session, used by the logged-out
 * view to explain why it appeared. Kept in memory only: this is status,
 * not another credential-shaped piece of persisted state. */
export function getSessionIssue() {
  return lastSessionIssue;
}

/** Matrix errors are not consistent about where they expose errcode: SDK
 * request errors usually put it directly on the error, while wrappers can
 * leave it under data or cause. Match the explicit Matrix code (plus the
 * SDK's own canonical message) rather than treating every 401 as an expired
 * login — a homeserver can use 401 for other recoverable auth flows. */
export function isInvalidAccessTokenError(error) {
  const pending = [error];
  const seen = new Set();

  while (pending.length) {
    const value = pending.shift();
    if (value == null || seen.has(value)) continue;
    if (typeof value === 'object') seen.add(value);

    if (typeof value === 'string') {
      if (/\bM_UNKNOWN_TOKEN\b|invalid access token passed/i.test(value)) return true;
      continue;
    }

    if (value.errcode === 'M_UNKNOWN_TOKEN' || value.code === 'M_UNKNOWN_TOKEN') return true;
    if (/\bM_UNKNOWN_TOKEN\b|invalid access token passed/i.test(value.message || '')) return true;

    pending.push(value.data, value.cause);
  }

  return false;
}

export function getClient() {
  return client;
}

export function getRooms() {
  return client ? client.getRooms() : [];
}

/** The local user's own Matrix id (e.g. "@alice:example.org"), or null
 *  before a client exists. Exposed mainly so callers can tell "did I
 *  send this" — e.g. room-view.js uses it to know which reaction pills
 *  are its own, for toggle-off-on-click. */
export function getUserId() {
  return client?.getUserId?.() ?? null;
}

/** The homeserver base URL the current session is connected to (e.g.
 *  "https://matrix.org"), or null before a client exists. Read straight
 *  off the SDK client rather than matrixState.matrixSession so this always
 *  matches whichever session (fresh login or restored) is actually
 *  live — settings-menu.js's account panel uses this. */
export function getHomeserverUrl() {
  return client?.getHomeserverUrl?.() ?? null;
}

/** Display name for any user id the client already knows about (self or
 *  someone else), or null if unknown / no client yet. Thin wrapper
 *  around the same client.getUser() fetchAvatarBytes() already uses
 *  above — kept as its own export so callers (settings-menu.js,
 *  room-view.js's sender-label resolution) don't need getClient() just
 *  for this one field. */
export function getDisplayName(userId) {
  if (!client || !userId) return null;
  return client.getUser(userId)?.displayName ?? null;
}

/** Fetch the active account's authoritative public profile. The SDK's
 * in-memory User object is often still empty while the first sync is
 * starting, so settings screens should use this when they need the name
 * immediately after a reload. */
export async function fetchOwnProfile() {
  const requestClient = client;
  const userId = requestClient?.getUserId?.();
  if (!requestClient || !userId) throw new Error('matrix-chat: no active client');
  const profile = await requestClient.getProfileInfo(userId);
  if (client !== requestClient) throw new Error('matrix-chat: active account changed');
  return {
    displayName: profile?.displayname || userId,
    avatarUrl: profile?.avatar_url || null,
  };
}

/**
 * Set of room ids the account's m.direct account-data event marks as
 * actual direct messages — the same signal Element and other clients
 * use to decide what shows up in their own DM section, as opposed to
 * room-list.js's previous member-count-based guess. m.direct's content
 * shape is { [otherUserId]: roomId[] } (one bucket per person you've
 * DMed, value is every room you've had a DM with them in — a person can
 * have more than one, e.g. from re-inviting on a different occasion), so
 * this just flattens every bucket into one Set of room ids; which user
 * each id came from doesn't matter to callers, only "is this room a DM
 * at all". Returns an empty Set (not null/undefined) when there's no
 * client yet or no m.direct account data has ever been set, so callers
 * (room-list.js) can use it unconditionally without a null-check.
 */
function roomService() {
  const runtime = sessions.require();
  if (!runtime.resources.has('rooms')) runtime.resources.set('rooms', createRoomService(runtime, emit));
  return runtime.resources.get('rooms');
}

export function getDirectRoomIds() {
  return sessions.current && !sessions.current.signal.aborted ? roomService().getDirectRoomIds() : new Set();
}
export async function acceptDirectRequest(roomId) {
  return roomService().acceptDirectRequest(roomId);
}

export async function addFriend(userId) {
  return roomService().addFriend(userId);
}

function spaceService() {
  const runtime = sessions.require();
  if (!runtime.resources.has('spaces')) runtime.resources.set('spaces', createSpaceService(runtime));
  return runtime.resources.get('spaces');
}

/** A space's direct children, joined or not: { rooms, nextBatch }. */
export async function getSpaceChildren(spaceId, options) { return spaceService().getSpaceChildren(spaceId, options); }
/** Join a room by ID or alias, trying the given servers (from a space's child link). */
export async function joinSpaceRoom(roomId, via) { return spaceService().joinRoom(roomId, via); }
/** Join by a pasted #alias, !id or matrix.to link. */
export async function joinByAddress(value) { return spaceService().joinByAddress(value); }
export function canAddToSpace(spaceId) {
  return sessions.current && !sessions.current.signal.aborted ? spaceService().canAddToSpace(spaceId) : false;
}
export async function createRoom(options) { return spaceService().createRoom(options); }
export async function createSpace(options) { return spaceService().createSpace(options); }
export async function addToSpace(spaceId, roomId) { return spaceService().addToSpace(spaceId, roomId); }
export async function removeFromSpace(spaceId, roomId) { return spaceService().removeFromSpace(spaceId, roomId); }
export async function inviteToRoom(roomId, userId) { return spaceService().inviteToRoom(roomId, userId); }
/** What you may change in a room or space: { name, avatar }. */
export function getRoomPermissions(roomId) {
  return sessions.current && !sessions.current.signal.aborted ? spaceService().roomPermissions(roomId) : { name: false, avatar: false };
}
export async function setRoomName(roomId, name) { return spaceService().setRoomName(roomId, name); }
export async function setRoomAvatar(roomId, image) { return spaceService().setRoomAvatar(roomId, image); }
export async function removeRoomAvatar(roomId) { return spaceService().removeRoomAvatar(roomId); }
/** Invites to rooms and spaces; direct message requests are listed separately. */
export function getInvites() {
  return sessions.current && !sessions.current.signal.aborted ? spaceService().getInvites(getDirectRoomIds()) : [];
}
export async function acceptInvite(roomId) { return spaceService().acceptInvite(roomId); }
export async function declineInvite(roomId) { return spaceService().declineInvite(roomId); }
export async function markRoomRead(room) {
  if (!client || client.getRoom(room?.roomId) !== room) return;
  return roomService().markRoomRead(room);
}

/**
 * Fetch older messages into room's live timeline (room-view.js calls this
 * when the user scrolls near the top). matrix-js-sdk doesn't paginate
 * automatically — getLiveTimeline().getEvents() only ever returns what's
 * already been fetched (the initial sync's timeline limit, or whatever's
 * been scrolled back so far), so without this call the timeline is
 * permanently capped at that initial handful of events with no way to
 * load more. Returns false on failure (network blip, etc — caller can
 * retry on a later scroll); true doesn't guarantee new events actually
 * arrived (could genuinely be at the start of the room), so callers
 * should compare event counts before/after to detect "no more history".
 */
export async function paginateBack(room, limit = 30) {
  if (!client || !room || client.getRoom(room.roomId) !== room) return false;
  const runtime = sessions.require();
  try {
    await runtime.client.scrollback(room, limit);
    runtime.assertCurrent();
    return true;
  } catch (err) {
    console.error('[matrix-chat] scrollback failed', err);
    return false;
  }
}

// Keyed by `${roomId}:${eventId}`. Holds promises, not resolved values,
// so two things rendering the same reply target at once (e.g. the
// message list re-rendering while a fetch is still in flight) share the
// one request rather than firing a second /rooms/{roomId}/event/{eventId}
// for it. Reply targets expire and are bounded across rooms.
let eventFetchCache = new BoundedCache({ maxEntries: 256, ttl: 5 * 60_000 });
const SYNC_OPTIONS = { lazyLoadMembers: true, disablePresence: true, initialSyncLimit: 20 };
let sessionGeneration = 0;
let mediaAbort = new AbortController();
function clearSessionCaches() {
  sessionGeneration++;
  mediaAbort.abort();
  mediaAbort = new AbortController();
  mediaCache.clear();
  decryptedAttachmentCache.clear();
  eventFetchCache.clear();
  mediaCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128 });
  decryptedAttachmentCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128 });
  eventFetchCache = new BoundedCache({ maxEntries: 256, ttl: 5 * 60_000 });
  clearRelationIndexes();
}


/**
 * Resolve the event a reply (m.in_reply_to) points at, for room-view.js's
 * quote UI. This is the "fetch it properly" half of rich-reply support:
 * room.findEventById() — used elsewhere in this file for things like
 * read receipts — only ever looks at whatever's already loaded into the
 * room's in-memory timeline (the initial sync window, plus whatever
 * scrollback has pulled in since). A reply to anything older than that
 * — which is the common case, not an edge case — just isn't there, and
 * findEventById quietly returns undefined rather than fetching it.
 *
 * This wraps that same local check, then falls back to a direct
 * client.fetchRoomEvent() (GET /rooms/{roomId}/event/{eventId}) when the
 * local lookup misses. fetchRoomEvent returns raw event JSON, not a
 * MatrixEvent, so the result is run through client.getEventMapper() —
 * the same mapper the SDK uses internally — which builds a real
 * MatrixEvent (decrypting it first if the room is encrypted) and, per
 * its own contract, merges it into the SDK's existing event map if it
 * already knows the event by this id. This is the identical pattern
 * matrix-js-sdk itself uses to resolve thread roots that have scrolled
 * out of view (see Thread.fetchRootEvent in the SDK source) — reply
 * targets have the exact same "may not be loaded" problem thread roots
 * do, so the fix is the same.
 *
 * Call this from room-view.js when a message with m.in_reply_to is
 * rendered, not just once at startup — it needs to run per-message,
 * on-demand, since which events are "missing locally" depends on
 * whatever's scrolled into view. Resolves to a MatrixEvent, or null if
 * the fetch failed (event redacted, never existed, or a network error —
 * room-view.js should treat all three as "show an unavailable
 * placeholder" rather than distinguishing them, since the SDK doesn't
 * give a clean way to tell "redacted" apart from "404" here).
 */
export async function getEventById(roomId, eventId) {
  if (!client || !roomId || !eventId) return null;

  const requestClient = client;
  const generation = sessionGeneration;
  const room = requestClient.getRoom(roomId);
  const local = room?.findEventById(eventId);
  if (local) return local;

  const cacheKey = `${roomId}:${eventId}`;
  if (eventFetchCache.has(cacheKey)) return eventFetchCache.get(cacheKey);

  const promise = (async () => {
    try {
      const raw = await requestClient.fetchRoomEvent(roomId, eventId);
      if (generation !== sessionGeneration) return null;
      const mapper = requestClient.getEventMapper();
      return mapper(raw);
    } catch (err) {
      console.error('[matrix-chat] failed to fetch reply target', eventId, err);
      return null;
    }
  })();

  eventFetchCache.set(cacheKey, promise);
  return promise;
}

/**
 * Drop a cached reply-target lookup — call after a redaction (or an
 * edit, if room-view.js wants the quote to pick up new content) so the
 * next render of that reply re-fetches instead of reusing a stale
 * result. Not wired to redactEvent()/localEcho automatically: redactions
 * arrive over the timeline like any other event, and room-view.js is
 * already the thing deciding when a re-render is warranted, so it's in
 * the better position to call this than this file guessing at it.
 */
export function invalidateEventCache(roomId, eventId) {
  eventFetchCache.delete(`${roomId}:${eventId}`);
}

/**
 * Who has read up to (and including) a given event, for rendering a
 * receipt stack under/beside that message. Filters out m.read.private
 * (a user's own private read marker — not meant to be shown to anyone
 * else) and the local user (no point showing your own avatar on your
 * own read position). Order isn't guaranteed by the SDK, so callers that
 * care about a stable stack order should sort by ts themselves.
 */
export function getReadReceipts(room, eventId) {
  if (!room || !eventId) return [];
  const event = room.findEventById(eventId);
  if (!event) return [];
  const selfId = client?.getUserId?.();
  return (room.getReceiptsForEvent(event) || [])
    .filter(r => r.type === 'm.read' && r.userId !== selfId)
    .map(r => ({ userId: r.userId, ts: r.data?.ts ?? 0 }));
}

function parseMxc(mxcUrl) {
  const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl || '');
  return m ? { serverName: m[1], mediaId: m[2] } : null;
}

/**
 * Fetch raw bytes for an mxc:// URL via the homeserver's *authenticated*
 * media API (/_matrix/client/v1/media/...). The old unauthenticated
 * endpoints (/_matrix/media/v3/...) that mxcUrlToHttp() used to build a
 * plain <img src>-able URL from now 404 on matrix.org and other updated
 * homeservers (MSC3916) — media now requires an Authorization header,
 * which a bare URL can't carry. So this always does a real fetch() with
 * the access token attached and hands back bytes, rather than a URL;
 * callers (room-view.js) turn those bytes into an object URL themselves.
 * Pass width/height for a scaled thumbnail; omit for a full download.
 * Pass animated:true to keep a GIF source moving — the thumbnail endpoint
 * flattens to a static first frame by default regardless of source
 * format, so an unmodified call here would silently kill animation on
 * any animated avatar/image that happens to go through the thumbnail
 * path. animated:true asks for MSC2705 behaviour instead (supported by
 * Synapse and other current homeservers); servers that don't support it
 * just ignore the param and fall back to their normal static thumbnail,
 * so this is safe to pass unconditionally wherever animation matters.
 */
// Most homeservers (Synapse in particular) only pre-generate thumbnails
// at a fixed set of preset [width, height] PAIRS and reject anything else
// with a 400 — `dynamic_thumbnails` (arbitrary sizes) is off by default.
// These are Synapse's own defaults. Note these are genuine pairs, not
// independently-chosen width/height values: 640x640 is NOT one of the
// presets even though 640 and (a different entry's) height both appear
// in the list, only 640x480 is. Different homeservers can configure a
// different set entirely, so even matching these exactly is a best
// effort, not a guarantee — see the download fallback below for what
// actually makes this reliable.
const THUMBNAIL_PRESETS = [[32, 32], [96, 96], [320, 240], [640, 480], [800, 600]];

function snapThumbnailSize(width, height) {
  // Prefer the smallest preset whose both dimensions cover what was
  // asked for (so the thumbnail is never smaller than requested).
  return THUMBNAIL_PRESETS.find(([w, h]) => w >= width && h >= height)
    // No preset covers both — fall back to the smallest whose width
    // alone covers it (still a reasonable preview, just not the same
    // aspect ratio as requested).
    ?? THUMBNAIL_PRESETS.find(([w]) => w >= width)
    // Requested size is bigger than every preset — use the largest.
    ?? THUMBNAIL_PRESETS[THUMBNAIL_PRESETS.length - 1];
}

const downloadQueue = new WorkQueue(3);
const decryptQueue = new WorkQueue(2);
let mediaCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128 });

export function fetchMediaBytes(mxcUrl, { width, height, animated = false } = {}) {
  const generation = sessionGeneration;
  const signal = mediaAbort.signal;
  const mediaClient = client;
  // Media is fetched outside the SDK, so an OAuth session's short-lived
  // access token can expire under it: on a 401, any authed SDK request
  // (whoami) refreshes the token, then the download is tried once more.
  const authedFetch = async url => {
    const request = () => matrixFetch(url, { signal, headers: { Authorization: `Bearer ${mediaClient?.getAccessToken()}` } });
    const response = await request();
    if (response.status !== 401 || !mediaClient?.getRefreshToken?.()) return response;
    await mediaClient.whoami().catch(() => {});
    return request();
  };
  const key = `${mxcUrl}|${width ?? ''}x${height ?? ''}|${animated}`;

  const cached = mediaCache.get(key);
  if (cached) return cached;

  const promise = downloadQueue.run(async () => {
    if (!client) throw new Error('matrix-chat: no active client');
    const parsed = parseMxc(mxcUrl);
    if (!parsed) throw new Error(`matrix-chat: not an mxc url: ${mxcUrl}`);

    const base = client.getHomeserverUrl();
    const downloadPath = `/_matrix/client/v1/media/download/${parsed.serverName}/${parsed.mediaId}`;

    if (width && height) {
      const [w, h] = snapThumbnailSize(width, height);
      const thumbPath = `/_matrix/client/v1/media/thumbnail/${parsed.serverName}/${parsed.mediaId}?width=${w}&height=${h}&method=scale${animated ? '&animated=true' : ''}`;
      const thumbRes = await authedFetch(base + thumbPath);
      if (thumbRes.ok) return thumbRes.arrayBuffer();
      // Thumbnail rejected — could be a dimension/method this particular
      // server doesn't generate (its thumbnail_sizes config doesn't have
      // to match Synapse's defaults, even on Synapse), or a content-type
      // it won't thumbnail at all. Rather than fail the whole attachment
      // over a thumbnail-specific limitation, fall through to the real
      // file below — costs more bandwidth than a proper small preview,
      // but every homeserver serves a plain download of its own media.
    }

    const res = await authedFetch(base + downloadPath);
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    return res.arrayBuffer();
  }, { signal }).then(bytes => {
    if (generation !== sessionGeneration) throw new Error('Account changed');
    return bytes;
  });

  mediaCache.set(key, promise);
  return promise;
}

// Cache plaintext separately from ciphertext with the same byte budget.
// Failed requests are removed immediately so later attempts can retry.
let decryptedAttachmentCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128 });

/**
 * Fetch + decrypt an encrypted attachment (content.file from an m.image/
 * m.video/m.file event in an encrypted room). Encrypted events carry
 * content.file (url/key/iv/hashes) instead of a plain content.url — the
 * ciphertext still has to be fetched (now via fetchMediaBytes, since the
 * media API requires auth — see that function's comment), then decrypted
 * client-side via matrix-encrypt-attachment. Returns a plaintext
 * ArrayBuffer. Cached by URL and encryption metadata, since a given
 * encrypted upload's ciphertext+key pairing is fixed — the same fileInfo
 * always decrypts to the same plaintext, so re-running the decrypt on a
 * later hydrate pass is pure waste.
 */
export async function decryptAttachmentFile(fileInfo) {
  const signal = mediaAbort.signal;
  const generation = sessionGeneration;
  const key = fileInfo?.url && JSON.stringify([fileInfo.url, fileInfo.key, fileInfo.iv, fileInfo.hashes]);
  const cached = key && decryptedAttachmentCache.get(key);
  if (cached) return cached;

  const promise = decryptQueue.run(async () => {
    const ciphertext = await fetchMediaBytes(fileInfo.url);
    signal.throwIfAborted();
    const plaintext = await decryptAttachment(ciphertext, fileInfo);
    if (generation !== sessionGeneration) throw new Error("Account changed");
    return plaintext;
  }, { signal });

  if (key) {
    decryptedAttachmentCache.set(key, promise);
  }

  return promise;
}

/**
 * Resolve a user's current avatar to displayable bytes. Pass a numeric size
 * for a thumbnail (receipt/message avatars), or null for the original file.
 * Thumbnails use animated:true so a GIF avatar
 * keeps playing instead of freezing on its first frame — see
 * fetchMediaBytes's comment on why that flag matters. Throws if the user
 * is unknown to the SDK or has no avatar set; callers rendering a stack
 * of many users should expect some of these to reject and fall back to
 * a placeholder per-user rather than failing the whole render.
 */
export async function fetchAvatarBytes(userId, size = 24) {
  if (!client) throw new Error('matrix-chat: no active client');
  const user = client.getUser(userId);
  if (!user?.avatarUrl) throw new Error(`matrix-chat: no avatar for ${userId}`);
  return size == null
    ? fetchMediaBytes(user.avatarUrl)
    : fetchMediaBytes(user.avatarUrl, { width: size, height: size, animated: true });
}

/** Search a homeserver's public room directory. The server field accepts a
 * Matrix server name (for example matrix.org), not an arbitrary URL. */
export async function browsePublicRooms({ server = '', search = '', limit = 24 } = {}) {
  const runtime = sessions.require();
  const remote = String(server).trim();
  if (remote && !/^[a-z0-9.-]+(?::\d+)?$/i.test(remote)) {
    throw new Error('Enter a server name such as matrix.org.');
  }
  const response = await runtime.client.publicRooms({
    ...(remote ? { server: remote } : {}),
    limit: Math.min(50, Math.max(1, Number(limit) || 24)),
    ...(String(search).trim() ? { filter: { generic_search_term: String(search).trim() } } : {}),
  });
  runtime.assertCurrent();
  return response?.chunk || [];
}

export async function joinPublicRoom(roomIdOrAlias) {
  if (!client) throw new Error('matrix-chat: no active client');
  const target = String(roomIdOrAlias || '').trim();
  if (!target) throw new Error('Room identifier is missing.');
  return client.joinRoom(target);
}

/** Update the active account's public profile. Matrix IDs are permanent;
 * callers may change the display name and avatar associated with that ID. */
export async function updateOwnProfile({ displayName, avatarFile } = {}) {
  const runtime = sessions.require();
  const requestClient = runtime.client;
  const userId = requestClient.getUserId?.();
  const user = userId ? requestClient.getUser(userId) : null;

  if (displayName !== undefined) {
    const value = String(displayName).trim();
    if (!value) throw new Error('Display name cannot be empty.');
    if (value.length > 255) throw new Error('Display name is too long.');
    await requestClient.setDisplayName(value);
    runtime.assertCurrent();
    user?.setDisplayName?.(value);
  }

  let avatarUrl = null;
  if (avatarFile) {
    if (!avatarFile.type?.startsWith('image/')) throw new Error('Choose an image file.');
    if (avatarFile.size > 10 * 1024 * 1024) throw new Error('Profile pictures must be 10 MB or smaller.');
    const uploaded = await requestClient.uploadContent(avatarFile, {
      abortController: runtime.controller,
      name: avatarFile.name || 'profile-picture',
      type: avatarFile.type,
    });
    avatarUrl = uploaded?.content_uri;
    runtime.assertCurrent();
    if (!avatarUrl) throw new Error('The homeserver did not return an avatar URL.');
    await requestClient.setAvatarUrl(avatarUrl);
    runtime.assertCurrent();
    user?.setAvatarUrl?.(avatarUrl);
  }

  return { displayName: getDisplayName(userId), avatarUrl };
}

// Per-room serialization prevents two rapidly arriving messages from racing
// their HTTP read-marker requests and leaving the older marker as the winner.
// ─── Multi-account support ──────────────────────────────────────────────
//
// matrixState.matrixSessions is the new piece of persisted state: an array of
// every account that's been logged into on this device and not since
// removed, same shape as matrixState.matrixSession itself (homeserver, userId,
// accessToken, deviceId). matrixState.matrixSession keeps its original meaning
// unchanged — "whichever one of these is currently active" — so every
// pre-existing reader of it (authedFetch, hasSession, state.js's
// serialize(), boot.js's restore-on-launch, this file's own logout())
// keeps working exactly as before with no changes on their end.
// state.js saves both.
function ensureSessionsList() {
  if (!Array.isArray(matrixState.matrixSessions)) matrixState.matrixSessions = [];
  return matrixState.matrixSessions;
}

// Reassigns matrixState.matrixSessions to a new array (rather than just
// mutating the existing one in place) after every change, on the
// assumption that state is a reactive object some UI layer might be
// watching by reference — same defensive habit as matrixState.matrixSession
// already being replaced wholesale on every login()/switchAccount()
// rather than having its fields poked individually.
function saveSessionsList(list) {
  matrixState.matrixSessions = [...list];
  save();
}

// ─── Encryption databases of ended devices ──────────────────────────────
//
// Each account-and-device has its own encrypted database (see
// crypto-service.js). When a device ends — signed out, removed, its token
// rejected, or replaced by signing in again — its database is deleted, so
// its keys don't stay on disk. Deleting waits for the database to close,
// so the pending deletion is saved and finished on the next launch if
// Atmos quits first. A device that's still saved is never deleted.
const sameDevice = (a, b) => a.userId === b.userId && a.deviceId === b.deviceId;

function stillSaved(device) {
  return ensureSessionsList().some(saved => sameDevice(saved, device))
    || (matrixState.matrixSession && sameDevice(matrixState.matrixSession, device));
}

function deletePendingStore(device) {
  deleteCryptoStore(device.userId, device.deviceId).then(deleted => {
    if (!deleted) return;
    matrixState.pendingStoreDeletions = (matrixState.pendingStoreDeletions || []).filter(entry => !sameDevice(entry, device));
    save();
  }).catch(error => console.warn('[matrix-chat] could not delete an encryption database:', error));
}

function forgetDeviceStore(session) {
  if (!session?.userId || !session?.deviceId) return;
  const device = { userId: session.userId, deviceId: session.deviceId };
  if (stillSaved(device)) return;
  const pending = matrixState.pendingStoreDeletions || [];
  if (!pending.some(entry => sameDevice(entry, device))) {
    matrixState.pendingStoreDeletions = [...pending, device];
    save();
  }
  deletePendingStore(device);
}

/** Finish deletions a previous run couldn't. boot.js calls this before any client starts. */
export function finishPendingStoreDeletions() {
  for (const device of [...(matrixState.pendingStoreDeletions || [])]) {
    if (stillSaved(device)) {
      matrixState.pendingStoreDeletions = matrixState.pendingStoreDeletions.filter(entry => !sameDevice(entry, device));
      save();
      continue;
    }
    deletePendingStore(device);
  }
}

function upsertSession(session) {
  const list = ensureSessionsList();
  const i = list.findIndex(s => s.userId === session.userId);
  if (i === -1) list.push(session);
  else list[i] = session;
  saveSessionsList(list);
}

/** Retire a saved session only when `error` proves its bearer token is no
 * longer accepted. Returns true when it handled the error so callers can
 * distinguish this from network failures, which deliberately leave the
 * session saved for a later retry. The token comparison is important: if
 * the same account has already logged in again, a late failure carrying
 * its old token must not remove the fresh session. */
export function handleInvalidAccessToken(error, session = matrixState.matrixSession) {
  if (!isInvalidAccessTokenError(error) || !session?.accessToken) return false;

  const active = matrixState.matrixSession;
  if (!active || active.accessToken !== session.accessToken) return false;

  saveSessionsList(ensureSessionsList().filter(saved => saved.accessToken !== session.accessToken));
  sessions.clear();
  clearSessionCaches();
  client = null;
  matrixState.matrixSession = null;
  save();
  lastSessionIssue = {
    code: 'M_UNKNOWN_TOKEN',
    userId: session.userId,
    homeserver: session.homeserver,
  };
  // The server has ended this device; its keys are no use to anyone now.
  forgetDeviceStore(session);
  emit('account', { userId: null, homeserver: null, reason: 'invalid-token' });
  return true;
}

/** Every saved account (active one first), for settings-menu.js's
 *  account-switcher row. Entries for accounts other than the active one
 *  are just the bare session shape — there's no live SDK client for them
 *  to pull a display name/avatar from until they're switched to, so
 *  callers should expect to fall back to raw userId for those, same as
 *  getDisplayName() already returning null for anyone the active client
 *  doesn't know about. */
export function getSavedAccounts() {
  const list = ensureSessionsList();
  const activeId = getUserId();
  return [...list].sort((a, b) => (a.userId === activeId ? -1 : b.userId === activeId ? 1 : 0));
}

// ─── OAuth sessions: token refresh and sign-out ─────────────────────────
//
// OAuth access tokens last minutes, not forever. The SDK refreshes them
// when the server rejects one (or just before a known expiry) by calling
// tokenRefreshFunction. The auth server replaces the refresh token on every
// refresh, so the new one is saved at once: if Atmos quit holding only the
// old one, the account would be signed out on next launch.

function storeRefreshedTokens(session, tokens) {
  const next = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
  const apply = target => {
    if (target && target.userId === session.userId && target.deviceId === session.deviceId) Object.assign(target, next);
  };
  apply(session);
  apply(matrixState.matrixSession);
  ensureSessionsList().forEach(apply);
  flush();
}

function refreshOptionsFor(session) {
  if (!session.refreshToken || !session.auth) return {};
  return {
    refreshToken: session.refreshToken,
    tokenRefreshFunction: async refreshToken => {
      let tokens;
      try {
        tokens = await oauth.refreshTokens(session.auth, refreshToken);
      } catch (error) {
        // The server turned the refresh token down: the session has been
        // ended (signed out elsewhere, revoked, expired). Anything else,
        // like being offline, is left for the SDK to retry.
        if (error instanceof oauth.OAuthSignInError && /^(invalid_grant|invalid_client|unauthorized_client|invalid_token)$/.test(error.code)) {
          throw new sdk.TokenRefreshLogoutError(error);
        }
        throw error;
      }
      storeRefreshedTokens(session, tokens);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiry: tokens.expiresAt ? new Date(tokens.expiresAt) : undefined,
      };
    },
  };
}

/** Best-effort server-side sign-out for a session that's already been
 *  forgotten locally. OAuth sessions are ended by revoking their refresh
 *  token (the /logout endpoint is for password sessions). */
function endServerSession(session, liveClient = null) {
  if (!session?.accessToken) return;
  if (session.auth?.revocationEndpoint) {
    const token = session.refreshToken || session.accessToken;
    oauth.revokeToken(session.auth, token, session.refreshToken ? 'refresh_token' : 'access_token').catch(error => {
      console.warn('[matrix-chat] could not end the OAuth session on the server (already signed out locally):', error);
    });
    return;
  }
  const endingClient = liveClient || sdk.createClient({
    baseUrl: session.homeserver, fetchFn: matrixFetch,
    userId: session.userId, accessToken: session.accessToken, deviceId: session.deviceId,
  });
  endingClient.logout(false).catch(error => {
    console.warn('[matrix-chat] server-side logout failed (already signed out locally):', error);
  });
}

/** Where the active account's password, email and devices are managed,
 *  for OAuth accounts (e.g. account.matrix.org); null for password sessions. */
export function getAccountManagementUrl() {
  return matrixState.matrixSession?.auth?.accountUrl || null;
}

/** Open an https page in the system browser (never an Atmos window). */
export function openLink(url) {
  return atmos.invoke('plugin:matrix-chat', 'open-link', String(url));
}

/** Shared construction path; crypto is ready before synchronization starts. */
async function activateSession(session, ticket, start = true) {
  ticket.assertCurrent();
  clearSessionCaches();
  const secretStorage = createSecretStorageCallbacks();
  const nextClient = sdk.createClient({
    baseUrl: session.homeserver, fetchFn: matrixFetch,
    userId: session.userId, accessToken: session.accessToken, deviceId: session.deviceId,
    cryptoCallbacks: secretStorage.callbacks, verificationMethods: ['m.sas.v1'],
    ...refreshOptionsFor(session),
  });
  const runtime = ticket.attach(nextClient);
  runtime.cleanups.add(() => { secretStorage.holder.key = null; });
  const sessionMediaAbort = mediaAbort;
  runtime.cleanups.add(() => sessionMediaAbort.abort());
  runtime.resources.set('media', mediaCache);
  runtime.resources.set('attachments', decryptedAttachmentCache);
  runtime.resources.set('events', eventFetchCache);
  client = nextClient;
  matrixState.matrixSession = session;
  save();
  secretStorageKeyHolders.set(nextClient, secretStorage.holder);
  wireEvents(runtime);
  // An OAuth session whose refresh token the server has rejected is over:
  // show the sign-in screen rather than a client that silently can't sync.
  if (session.auth) runtime.listen(sdk.HttpApiEvent.SessionLoggedOut, error => handleInvalidAccessToken(error, session));
  const cryptoReady = initCryptoForSession(nextClient, session, cryptoStoreKey());
  cryptoInitialization.set(nextClient, cryptoReady);
  emit('account', { userId: session.userId, homeserver: session.homeserver });
  try {
    await cryptoReady;
    runtime.assertCurrent();
    if (start) await nextClient.startClient(SYNC_OPTIONS);
    runtime.assertCurrent();
    lastSessionIssue = null;
    signInNotice = null;
    return nextClient;
  } catch (error) {
    const retired = runtime.signal.aborted;
    runtime.dispose();
    // Crypto initialization may finish after the first stop; release it too.
    if (retired) {
      nextClient.stopClient();
      throw new DOMException('The Matrix session has changed.', 'AbortError');
    }
    throw error;
  }
}

function transitionSession(work, options) {
  const result = sessions.run(work, options);
  if (options?.retire !== false) {
    client = null;
    clearSessionCaches();
  }
  return result;
}

// Best-effort match of a saved session's device_id against what's typed
// into the login form, so login() (below) can ask the server to reactivate
// that device instead of minting a brand-new one on every call. Matches an
// exact saved userId first (the common case: logging back in after a
// revoked token, or into an account previously removed locally), then
// falls back to deriving the likely mxid from a bare username + this
// homeserver's host, since most people type "alice" rather than
// "@alice:example.org". Email-address logins can't be matched this way (the
// mxid isn't derivable from the email) — those just get a normal fresh
// device, same as before this fix.
function findDeviceIdForLogin(homeserverUrl, typedUserId) {
  const list = ensureSessionsList();
  const normalized = typedUserId.trim();
  const exact = list.find(s => s.userId === normalized);
  if (exact?.deviceId) return exact.deviceId;

  if (!normalized.startsWith('@') && !normalized.includes('@')) {
    try {
      const host = new URL(homeserverUrl).host;
      const candidate = `@${normalized}:${host}`;
      const match = list.find(s => s.userId === candidate);
      if (match?.deviceId) return match.deviceId;
    } catch { /* invalid homeserver URL — let loginClient.login() surface that error itself */ }
  }
  return null;
}

/**
 * Log in with a homeserver + username/password, save the resulting
 * session into matrixState.matrixSessions (and make it matrixState.matrixSession,
 * the active one), and start syncing. Also how "add another account"
 * works — login.js's form doesn't need a separate mode/function for
 * that, since an account that isn't already saved just gets appended
 * here rather than replacing anything, and one that IS already saved
 * (logging back into an account you'd previously removed, or after a
 * token expired) gets its stored session refreshed in place.
 */
export function login(homeserverUrl, userId, password) {
  return transitionSession(async ticket => {
  // A short-lived, credential-less client just to perform the login call —
  // matrix-js-sdk's documented pattern is to create the "real" client with
  // the resulting access token afterward, rather than mutating one client
  // in place from anonymous to authenticated.
  homeserverUrl = normalizeHomeserverUrl(homeserverUrl);
  const loginClient = sdk.createClient({ baseUrl: homeserverUrl, fetchFn: matrixFetch });

  // Reuse this account's last known device_id when we have one on file
  // (see findDeviceIdForLogin above), so a repeated login — a retry, a
  // revoked token, signing back into a removed account — reactivates that
  // same device instead of the homeserver minting a brand-new one every
  // single call. Without this, every login silently orphaned its previous
  // device's identity (and whatever one-time keys it had already uploaded)
  // on the server forever, since nothing ever told the server that device
  // was done — see logout()/removeAccount() further down for the other
  // half of this fix.
  const existingDeviceId = findDeviceIdForLogin(homeserverUrl, userId);

  const res = await loginClient.login('m.login.password', {
    identifier: !userId.startsWith('@') && userId.includes('@')
      ? { type: 'm.id.thirdparty', medium: 'email', address: userId }
      : { type: 'm.id.user', user: userId },
    password,
    // How this sign-in is listed in your other apps' session lists.
    initial_device_display_name: 'Atmos',
    ...(existingDeviceId ? { device_id: existingDeviceId } : {}),
  });

  const session = {
    homeserver: homeserverUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };

  ticket.assertCurrent();
  upsertSession(session);

  try {
    const activeClient = await activateSession(session, ticket);
    lastSessionIssue = null;
    return activeClient;
  } catch (err) {
    handleInvalidAccessToken(err, session);
    throw err;
  }
  }, { retire: false });
}

// ─── OAuth sign-in and sign-up ──────────────────────────────────────────
//
// Homeservers on the Matrix Authentication Service (matrix.org and a
// growing number of others) do sign-in and account creation on their own
// web page. getSignInOptions() says what a homeserver offers so login.js
// can show the right buttons; loginWithOAuth() runs the browser round-trip
// (src/oauth.js + main.cjs) and then activates the session like login().

/** "matrix.org", "https://matrix.org/" → "https://matrix.org". */
export function normalizeHomeserverUrl(value) {
  let text = String(value ?? '').trim();
  if (!text) throw new Error('Enter a homeserver.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  // Plain http would send your password and tokens unencrypted; it's only
  // allowed for a homeserver on this computer (local testing).
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The homeserver must be an https:// address.');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

async function fetchAuthMetadata(homeserver) {
  const probe = sdk.createClient({ baseUrl: homeserver, fetchFn: matrixFetch });
  try {
    return await probe.getAuthMetadata();
  } catch {
    return null; // this homeserver doesn't use OAuth sign-in
  }
}

/**
 * What a homeserver offers: { homeserver, oauth, signUp, password }.
 * `oauth` — sign in on the server's page; `signUp` — it can also open
 * straight to account creation; `password` — the classic form works.
 * Throws when the homeserver can't be reached at all.
 */
export async function getSignInOptions(homeserverInput) {
  const homeserver = normalizeHomeserverUrl(homeserverInput);
  const probe = sdk.createClient({ baseUrl: homeserver, fetchFn: matrixFetch });
  const [metadata, flows] = await Promise.all([
    fetchAuthMetadata(homeserver),
    probe.loginFlows().then(result => result?.flows || [], error => ({ error })),
  ]);
  if (!metadata && flows.error) {
    throw new Error(`Couldn't reach a Matrix homeserver at ${homeserver.replace(/^https?:\/\//, '')}.`);
  }
  return {
    homeserver,
    oauth: Boolean(metadata),
    signUp: Boolean(metadata) && oauth.supportsSignUp(metadata),
    password: Array.isArray(flows) && flows.some(flow => flow?.type === 'm.login.password'),
  };
}

async function ensureOAuthClient(metadata) {
  const saved = matrixState.oauthClients?.[metadata.issuer];
  if (saved?.clientId && saved.clientUri === oauth.CLIENT_URI) return saved.clientId;
  const clientId = await oauth.registerClient(metadata);
  matrixState.oauthClients = { ...matrixState.oauthClients, [metadata.issuer]: { clientId, clientUri: oauth.CLIENT_URI } };
  save();
  return clientId;
}

let pendingSignIn = null;

/** Abandon a browser sign-in that's still waiting (login.js's Cancel). */
export function cancelSignIn() {
  pendingSignIn?.cancel();
}

/**
 * Sign in (or, with createAccount, sign up) on the homeserver's own page in
 * the system browser, then save and activate the session. Also how "add
 * another account" works for OAuth homeservers, same as login().
 */
export async function loginWithOAuth(homeserverInput, { createAccount = false } = {}) {
  const homeserver = normalizeHomeserverUrl(homeserverInput);
  const metadata = await fetchAuthMetadata(homeserver);
  if (!metadata) throw new oauth.OAuthSignInError('unsupported_server', 'This homeserver doesn\'t support signing in through the browser. Use your password instead.');
  const clientId = await ensureOAuthClient(metadata);

  // The browser part happens outside the session queue: it can take
  // minutes, and account switches shouldn't wait behind it.
  const flow = { cancel: () => {} };
  pendingSignIn = flow;
  let tokens;
  try {
    tokens = await oauth.authorize({
      metadata,
      clientId,
      prompt: createAccount && oauth.supportsSignUp(metadata) ? 'create' : undefined,
      onFlow: cancel => { flow.cancel = cancel; },
    });
  } finally {
    if (pendingSignIn === flow) pendingSignIn = null;
  }

  const who = await sdk.createClient({ baseUrl: homeserver, fetchFn: matrixFetch, accessToken: tokens.accessToken }).whoami();
  const session = {
    homeserver,
    userId: who.user_id,
    accessToken: tokens.accessToken,
    deviceId: who.device_id || tokens.deviceId,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    auth: oauth.sessionAuthFields(metadata, clientId),
  };

  return transitionSession(async ticket => {
    ticket.assertCurrent();
    // Signing in again to an account that's already saved here replaces
    // its old device; end that one on the server so it isn't left behind.
    const replaced = ensureSessionsList().find(saved => saved.userId === session.userId);
    upsertSession(session);
    flush(); // the refresh token must survive a quit from here on
    try {
      const activeClient = await activateSession(session, ticket);
      lastSessionIssue = null;
      if (replaced && replaced.deviceId !== session.deviceId) {
        endServerSession(replaced);
        forgetDeviceStore(replaced);
      }
      return activeClient;
    } catch (error) {
      handleInvalidAccessToken(error, session);
      throw error;
    }
  }, { retire: false });
}

/**
 * Switch the live client to an already-saved account (one already
 * present in matrixState.matrixSessions — e.g. picked from settings-menu.js's
 * account-switcher row) without re-prompting for a password. Throws if
 * asked to switch to a userId that was never logged into on this device
 * (or has since been removed via removeAccount()) — settings-menu.js
 * should never be able to trigger that from its own UI since it only
 * ever renders entries getSavedAccounts() actually returned, but a
 * throw here is still the right behavior for a stale reference (e.g. a
 * popover left open across a removeAccount() in another tab/window)
 * rather than silently doing nothing. No-ops (returns the current
 * client) if the requested account is already the active one.
 */
export async function switchAccount(userId) {
  const session = ensureSessionsList().find(s => s.userId === userId);
  if (!session) throw new Error('matrix-chat: no saved session for ' + userId);
  if (userId === client?.getUserId() && !sessions.current?.signal.aborted) return client;
  return transitionSession(async ticket => {
    try { return await activateSession(session, ticket); }
    catch (error) { handleInvalidAccessToken(error, session); throw error; }
  });
}

/**
 * Drop a saved account from matrixState.matrixSessions without touching
 * whichever account is currently active — e.g. the "×" on a non-active
 * avatar in settings-menu.js's switcher row, same as Discord letting you
 * remove a cached account from the switcher without logging out of the
 * one you're using. Also fires a best-effort server-side logout for the
 * removed account (see the network call below) — this account might not
 * be the live client (the common case per this function's own purpose),
 * so a short-lived client is built from its saved credentials just to make
 * that one call. If userId happens to be the *active* account, this stops
 * and clears the live client too (same as logout()) but does NOT
 * auto-switch to another saved account afterward — matches logout()'s
 * existing behavior of always landing back on the login screen rather than
 * silently picking a new active account on the caller's behalf;
 * settings-menu.js's own remove-button only ever offers this for
 * non-active avatars for that reason.
 */
export function removeAccount(userId) {
  const list = ensureSessionsList();
  const idx = list.findIndex(s => s.userId === userId);
  if (idx === -1) return;

  const [removed] = list.splice(idx, 1);
  saveSessionsList(list);
  pendingRecoveryKeys.delete(userId);

  // Best-effort: tell the homeserver this device is done, so it frees the
  // access token and can reclaim whatever one-time keys this device had
  // already uploaded, instead of leaving it registered as an orphan
  // forever. Fire-and-forget — a network failure here must never block
  // removing the account locally, which has already happened above.
  endServerSession(removed);

  if (userId !== getUserId()) {
    forgetDeviceStore(removed);
    return;
  }

  sessions.clear();
  clearSessionCaches();
  client = null;
  matrixState.matrixSession = null;
  save();
  lastSessionIssue = null;
  forgetDeviceStore(removed);
  emit('account', { userId: null, homeserver: null });
}

/**
 * Rebuild a client from a previously-saved session (state.js's
 * hydrate() already put this on state by the time boot.js calls this).
 * Does not start syncing — call startClient() separately, matching
 * boot.js's two-step restore/start so a caller could restore without
 * immediately syncing if that's ever useful.
 */
export function restoreSession(session) {
  if (!session?.accessToken) return Promise.resolve(null);
  return transitionSession(ticket => activateSession(session, ticket, false));
}

export async function startClient(expectedClient = client) {
  const runtime = sessions.require();
  if (runtime.client !== expectedClient) return;
  await cryptoInitialization.get(expectedClient);
  runtime.assertCurrent();
  await expectedClient.startClient(SYNC_OPTIONS);
  runtime.assertCurrent();
}

// Legacy (MSC2676) reply fallback: a "> quoted" block prepended to body,
// plus the equivalent <mx-reply> wrapper in formatted_body, so clients
// that don't understand m.in_reply_to would still show *something*
// legible. MSC2781 removed this from the spec — clients should no
// longer send it (see https://github.com/matrix-org/matrix-spec/pull/1994),
// on the reasoning that every client capable of sending rich replies is
// now expected to be capable of rendering them properly (looking the
// real event up, live or via fetch — see getEventById below), so the
// fallback is dead weight: it doubles the body of every reply, and
// historically has been a source of its own bugs (stale quotes when the
// original is edited, awkward nesting on reply-of-reply, HTML injection
// via the hand-built <mx-reply> block). We still need to be able to
// *read* one, though — old clients (and this one's own history, before
// this change) are still full of them, and a reply-of-a-reply must not
// re-quote a fallback that's already baked into the body it's quoting.
// Exported so room-view.js can strip it before displaying the body of
// any message that turns out to carry one.
export { stripReplyFallback } from './messaging-service.js';

export async function sendTextMessage(...args) {
  const runtime = sessions.require();
  const result = await createMessagingService(runtime).sendTextMessage(...args);
  runtime.assertCurrent();
  return result;
}

export async function editTextMessage(...args) {
  const runtime = sessions.require();
  const result = await createMessagingService(runtime).editTextMessage(...args);
  runtime.assertCurrent();
  return result;
}

export async function sendReaction(...args) {
  const runtime = sessions.require();
  const result = await createMessagingService(runtime).sendReaction(...args);
  runtime.assertCurrent();
  return result;
}

export async function redactEvent(...args) {
  const runtime = sessions.require();
  const result = await createMessagingService(runtime).redactEvent(...args);
  runtime.assertCurrent();
  return result;
}

export async function leaveRoom(...args) {
  const runtime = sessions.require();
  const result = await createMessagingService(runtime).leaveRoom(...args);
  runtime.assertCurrent();
  return result;
}

export async function sendFileMessage(...args) {
  const runtime = sessions.require();
  const result = await createMediaService(runtime, { encryptAttachment }).sendFileMessage(...args);
  runtime.assertCurrent();
  return result;
}

export async function restoreFromRecoveryKey(...args) {
  const runtime = sessions.require();
  const result = await createCryptoService(runtime, { sdk, holder: secretStorageKeyHolders.get(runtime.client) }).restoreFromRecoveryKey(...args);
  runtime.assertCurrent();
  return result;
}

export async function importRoomKeyFile(...args) {
  const runtime = sessions.require();
  const result = await createCryptoService(runtime, { sdk, holder: secretStorageKeyHolders.get(runtime.client) }).importRoomKeyFile(...args);
  runtime.assertCurrent();
  return result;
}

export async function crossSignThisDevice(...args) {
  const runtime = sessions.require();
  const result = await createCryptoService(runtime, { sdk, holder: secretStorageKeyHolders.get(runtime.client) }).crossSignThisDevice(...args);
  runtime.assertCurrent();
  return result;
}

// Recovery keys from setUpSecureMessaging(), kept in memory only until the
// person confirms they've saved it (acknowledgeRecoveryKey), so closing the
// menu before then doesn't lose it. Never written to disk.
const pendingRecoveryKeys = new Map();

async function cryptoServiceForCurrent() {
  const runtime = sessions.require();
  await cryptoInitialization.get(runtime.client);
  runtime.assertCurrent();
  return createCryptoService(runtime, { sdk, holder: secretStorageKeyHolders.get(runtime.client) });
}

/** { needsSetup, hasServerKeys, secretStorageReady } for the active account. */
export async function getSecureMessagingStatus() {
  return (await cryptoServiceForCurrent()).getSecureMessagingStatus();
}

/** First-time encryption set-up for an account that has none: cross-signing
 *  keys, secret storage and key backup. Resolves with { recoveryKey }. */
export async function setUpSecureMessaging() {
  const userId = getUserId();
  const service = await cryptoServiceForCurrent();
  const result = await service.setUpSecureMessaging();
  if (userId) pendingRecoveryKeys.set(userId, result.recoveryKey);
  emit('deviceTrust');
  return result;
}

/** The recovery key just created for the active account, until it's acknowledged. */
export function getPendingRecoveryKey() {
  return pendingRecoveryKeys.get(getUserId()) || null;
}

export function acknowledgeRecoveryKey() {
  pendingRecoveryKeys.delete(getUserId());
  emit('deviceTrust');
}

/** Save text to a file the person picks (frames can't download). */
export function saveTextFile(name, text) {
  return atmos.invoke('plugin:matrix-chat', 'save-file', { name, bytes: new TextEncoder().encode(String(text)) });
}

/** Stops the client, clears the active session, and — now that there
 *  can be more than one saved account — also drops it from
 *  matrixState.matrixSessions entirely. This is deliberately not "switch to
 *  another saved account if one exists": Discord's own "Log out" always
 *  lands you back on the login screen even with other accounts cached
 *  on the device, rather than silently picking one for you, and
 *  switching between still-saved accounts without logging out of either
 *  is exactly what switchAccount() above is for instead. Wired from
 *  settings-menu.js's "Log out" button (via panel.js's onLogout).
 *
 *  Also fires a best-effort server-side logout (see the network call
 *  below) so the device's access token actually dies on the homeserver
 *  and its one-time keys can be reclaimed, instead of leaving an orphaned
 *  device registered forever — the local teardown above always happens
 *  first and synchronously either way, so this never blocks the UI from
 *  returning to the login screen. */
export function logout() {
  const userId = getUserId();
  if (userId) pendingRecoveryKeys.delete(userId);
  const endingClient = client; // captured before we clear it below, so the network call further down still has credentials
  const endingSession = matrixState.matrixSession;
  if (userId) {
    const list = ensureSessionsList();
    const idx = list.findIndex(s => s.userId === userId);
    if (idx !== -1) {
      list.splice(idx, 1);
      saveSessionsList(list);
    }
  }
  sessions.clear();
  clearSessionCaches();
  client = null;
  matrixState.matrixSession = null;
  save();
  lastSessionIssue = null;
  emit('account', { userId: null, homeserver: null });

  if (endingSession) {
    endServerSession(endingSession, endingSession.auth ? null : endingClient);
    forgetDeviceStore(endingSession);
  }
}

// ─── Who sent what (trust-service.js) ───────────────────────────────────

async function trustServiceForCurrent() {
  const runtime = sessions.current;
  if (!runtime || runtime.signal.aborted) return null;
  await cryptoInitialization.get(runtime.client);
  if (runtime.signal.aborted) return null;
  return createTrustService(runtime);
}

/** A warning about who sent `event` ({ level, text }), or null. */
export async function getEventTrust(event) {
  try {
    return await (await trustServiceForCurrent())?.eventTrust(event) ?? null;
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('[matrix-chat] could not check who sent a message:', error);
    return null;
  }
}

/** Members of `room` whose identity changed: [{ userId, name, wasVerified }]. */
export async function getIdentityChanges(room) {
  try {
    return await (await trustServiceForCurrent())?.identityChanges(room) ?? [];
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('[matrix-chat] could not check identity changes:', error);
    return [];
  }
}

export async function acceptIdentityChange(userId) {
  const service = await trustServiceForCurrent();
  if (!service) throw new Error('matrix-chat: no active client');
  await service.acceptIdentityChange(userId);
  emit('trust');
}

async function getInitializedCrypto() {
  const verificationClient = client;
  if (!verificationClient) throw new Error('matrix-chat: no active client');
  await cryptoInitialization.get(verificationClient);
  if (client !== verificationClient) throw new DOMException('The Matrix session has changed.', 'AbortError');
  sessions.require().assertCurrent();
  const crypto = verificationClient.getCrypto?.();
  if (!crypto) throw new Error('matrix-chat: encryption is not initialized on this client');
  return { verificationClient, crypto };
}

/** Return the trust state for the device running Atmos. */
export async function getCurrentDeviceVerification() {
  const { verificationClient, crypto } = await getInitializedCrypto();

  const deviceId = verificationClient.getDeviceId?.();
  const userId = verificationClient.getUserId?.();
  if (!deviceId || !userId) throw new Error('matrix-chat: current device information is unavailable');

  const [status, crossSigningReady] = await Promise.all([
    crypto.getDeviceVerificationStatus(userId, deviceId),
    crypto.isCrossSigningReady(),
  ]);

  return {
    deviceId,
    // `isVerified()` also accepts local-only trust. Element's device list
    // uses the stronger account-owner signature, so report that same state
    // here rather than claiming verification that other clients cannot see.
    verified: Boolean(status?.signedByOwner),
    locallyTrusted: Boolean(status?.localVerified || status?.crossSigningVerified),
    crossSigningReady: Boolean(crossSigningReady),
  };
}

/** Ask another logged-in device for this account to verify this one. */
export async function requestCurrentDeviceVerification() {
  const { crypto } = await getInitializedCrypto();
  return crypto.requestOwnUserVerification();
}

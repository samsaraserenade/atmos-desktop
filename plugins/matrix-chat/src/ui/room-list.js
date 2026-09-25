import { buildRoomEntries, DIRECT_ENTRY_ID } from '../room-projection.js';
import { reconcileMarkup } from './reconcile-markup.js';
/** Persistent room-list controller. Coalesces SDK changes into keyed DOM updates
 * and releases view subscriptions and event handlers on unmount. */

import { getRooms, fetchMediaBytes, getDirectRoomIds, getUserId, leaveRoom, acceptDirectRequest, onAccountChange, onTimeline, onReceipt, onUnreadNotifications, onSync, onRoom, getSpaceChildren, joinSpaceRoom, getInvites, acceptInvite, declineInvite, getRoomPermissions, setRoomName, setRoomAvatar, removeRoomAvatar, removeFromSpace, canAddToSpace } from './engine.js';
import { menuIcon } from './menu-icons.js';
import atmos from 'atmos-sdk';
import { matrixState, save } from './engine.js';
import { tellInMenu } from './menu-dialogs.js';

// Resolved the same way room-view.js resolves EMOJI_ICON_URL: against
// this module's own real atmos-plugin://.../ui/room-list.js location
// (import.meta.url), not the document's base URL, since this ends up
// baked into an HTML string assigned via innerHTML rather than used as
// an actual ES module specifier.
const DM_ICON_URL = new URL('../../assets/direct-messages.png', import.meta.url).href;

// Fixed id for the synthetic "actual DMs only" rail entry built in
// buildEntries() below — a real room/space id can never collide with
// this (Matrix ids are always !opaque:server or #alias:server, never a
// bare double-underscore token), so it's safe to use directly as the
// entry's `id` and as the button's data-id.

const requestActions = new Map();
// A membership request can finish before the next sync updates the Room.
// Hide its old membership during that gap, then drop the override once the
// SDK catches up. Failed requests remove the override and repaint instead.
const pendingMembershipChanges = new Map();
onAccountChange(() => {
  requestActions.clear();
  pendingMembershipChanges.clear();
});

function roomsForList() {
  return getRooms().filter((room) => {
    const previousMembership = pendingMembershipChanges.get(room.roomId);
    if (!previousMembership) return true;
    if (room.getMyMembership?.() === previousMembership) return false;
    pendingMembershipChanges.delete(room.roomId);
    return true;
  });
}

// ── Display names vs. usernames ─────────────────────────────────────────
//
// Whether a DM's channel row shows the other person's display name (the
// default — same as room.name, which matrix-js-sdk already derives from
// the other member's display name for a 2-person room) or their raw
// Matrix user id instead. Only meaningful for actual DMs — a space or a
// solo group room's name is a room name someone set, not a stand-in for
// a single person, so this never touches those (see labelForRoom below).
function otherDirectMember(room) {
  if (typeof room.getJoinedMembers !== 'function') return null;
  const selfId = getUserId();
  const others = room.getJoinedMembers().filter((m) => m.userId !== selfId);
  return others.length === 1 ? others[0] : null;
}

// The label a channel row (or anything else naming a room) shows: the
// room's name, which for a DM is the other person's display name.
function labelForRoom(room) {
  return room.name || room.roomId;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Deterministic initial + hue for an avatar swatch, derived from the
// room id. Rendered immediately (synchronously, no network) so there's
// never a blank slot while a real avatar is still being fetched, and
// kept permanently for anything with no avatar set at all — see
// getAvatarUrl below, which only ever tries to replace this with a
// photo, never removes it as a fallback. Used for both rail icons
// (spaces and single-room pseudo-servers) and channel rows — same
// swatch logic either way, just at two different sizes in CSS.
function initialAndHue(room) {
  const label = room.name || room.roomId;
  const initial = (label.trim()[0] || '?').toUpperCase();
  let hue = 0;
  for (const c of room.roomId) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return { initial, hue };
}

// roomId -> { mxcUrl, url, failed, ts }. Kept for the module's lifetime
// so re-rendering (this fires on every panel/onSync re-render, per this
// file's header comment) doesn't re-fetch a photo that hasn't changed,
// but a failed fetch only sticks for AVATAR_RETRY_COOLDOWN_MS rather
// than forever, and the cache entry also records which mxc URL it
// resolved — so if an avatar changes server-side, the next render sees
// the mxc URL no longer matches the cached one and fetches the new one
// instead of quietly keeping the old (or a stale failure) around. One
// shared cache for spaces, orphan rooms, and channel rows alike — a
// room's avatar is the same photo whether it's being drawn as a rail
// icon or a channel row.
const avatarUrlCache = new Map();
let avatarGeneration = 0;
onAccountChange(() => {
  avatarGeneration++;
  for (const entry of avatarUrlCache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  avatarUrlCache.clear();
});
function cacheRoomAvatar(key, entry) {
  const previous = avatarUrlCache.get(key);
  if (previous?.url && previous.url !== entry.url) URL.revokeObjectURL(previous.url);
  avatarUrlCache.delete(key);
  avatarUrlCache.set(key, entry);
  while (avatarUrlCache.size > 256) {
    const oldest = avatarUrlCache.keys().next().value;
    const value = avatarUrlCache.get(oldest);
    if (value.url) URL.revokeObjectURL(value.url);
    avatarUrlCache.delete(oldest);
  }
}
const AVATAR_RETRY_COOLDOWN_MS = 30000;

// The mxc:// URL to actually fetch a photo from for a given room. For a
// real DM, that's the OTHER member's own profile picture, not the
// room's — a 1:1 DM room essentially never has its own m.room.avatar
// set (there's nothing for a human to point it at; the room IS the
// other person), so room.getMxcAvatarUrl() was silently returning null
// for every DM and leaving the initial-letter swatch up forever. This
// mirrors what any Matrix client shows in a DM list: the peer's
// account avatar. RoomMember exposes the same getMxcAvatarUrl() shape
// as Room does (member-level avatar_url off their m.room.member state,
// which is exactly the "profile picture" concept — same field a
// server's own icon comes from). Not a DM, or no other-member avatar
// found: falls back to the room's own avatar, same as before.
function avatarMxcUrl(room, isDM) {
  if (isDM) {
    const other = otherDirectMember(room);
    const memberMxc = other && typeof other.getMxcAvatarUrl === 'function'
      ? other.getMxcAvatarUrl()
      : null;
    if (memberMxc) return memberMxc;
  }
  return typeof room.getMxcAvatarUrl === 'function' ? room.getMxcAvatarUrl() : null;
}

// Resolves a room's (or a DM peer's, or a space's) actual avatar photo,
// or null if none is set / the fetch fails — callers leave the initial
// swatch in place for null rather than treating it as an error.
// fetchMediaBytes is the same generic mxc-resolver room-view.js already
// uses for inline images and message attachments. isDM (default false)
// only changes which mxc URL avatarMxcUrl resolves above; everything
// else here — caching, retry cooldown — is unchanged and still keyed by
// room.roomId, since a given room is consistently DM or not-DM across
// calls.
async function getAvatarUrl(room, isDM = false) {
  const mxcUrl = avatarMxcUrl(room, isDM);
  if (!mxcUrl) return null; // no avatar set — keep the initial

  const cached = avatarUrlCache.get(room.roomId);
  if (cached && cached.mxcUrl === mxcUrl
      && (!cached.failed || Date.now() - cached.ts < AVATAR_RETRY_COOLDOWN_MS)) {
    cacheRoomAvatar(room.roomId, cached);
    return cached.url;
  }

  const generation = avatarGeneration;
  try {
    const bytes = await fetchMediaBytes(mxcUrl, { width: 48, height: 48 });
    if (generation !== avatarGeneration) return null;
    const url = URL.createObjectURL(new Blob([bytes]));
    cacheRoomAvatar(room.roomId, { mxcUrl, url, failed: false, ts: Date.now() });
    return url;
  } catch (err) {
    if (generation !== avatarGeneration) return null;
    console.error('[matrix-chat] failed to load avatar', room.roomId, err);
    cacheRoomAvatar(room.roomId, { mxcUrl, url: null, failed: true, ts: Date.now() });
    return null;
  }
}

// Same-day → time only ("14:32"), otherwise a short date ("Aug 21") —
// mirrors how the reference panels keep numeric columns short and
// tabular rather than spelling out a full date on every row.
function formatRoomTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function lastMessage(room) {
  const events = room.getLiveTimeline()?.getEvents() || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.getType() === 'm.room.message') {
      return { body: ev.getContent().body || '', ts: ev.getTs() };
    }
  }
  return { body: '', ts: null };
}

// The rail dot is an actionable-alert indicator, not a generic unread
// marker. DMs count every notification; rooms/spaces count only Matrix
// highlights (user/room mentions). The sound separately follows the account's
// Matrix push rules, including any custom notification rules the user set.
function alertCount(room, isDirect) {
  return typeof room.getUnreadNotificationCount === 'function'
    ? (room.getUnreadNotificationCount(isDirect ? 'total' : 'highlight') || 0)
    : 0;
}

// ── Space hierarchy → rail entries ──────────────────────────────────────
//
// Turns the flat Room[] from getRooms() (spaces and regular rooms mixed
// together, exactly as matrix-js-sdk hands them back) into the rail's
// entry list: one entry per space room plus one per orphan room, each
// carrying the channel rows that belong under it. See this file's
// header comment for the nesting/orphan rules.
function buildEntries(rooms) { return buildRoomEntries(rooms, getDirectRoomIds()); }

// ── Adjustable rail order ───────────────────────────────────────────────
//
// buildEntries() above always returns the same default order (DMs, then
// spaces, then solo rooms — see its own header comment). This layer sits
// on top of that and lets the user drag rail icons into whatever order
// they actually want, persisted across reloads.
//
// Stored as a plain array of entry ids, most-recently-arranged order.
// railOrder is module-level (like selectedEntryId/currentPaint above) so
// it survives panel.js's wholesale re-renders — a fresh renderRoomList()
// call rebuilds `entries` from scratch every time, but always reapplies
// whatever order is currently here.
const RAIL_ORDER_STORAGE_KEY = 'matrix-chat:rail-order';

function loadRailOrder() {
  return Array.isArray(matrixState.railOrder) ? [...matrixState.railOrder] : [];
}

function saveRailOrder(order) {
  matrixState.railOrder = [...order];
  save();
}

let railOrder = loadRailOrder();

// Reorders `entries` (buildEntries' output) to match railOrder, wherever
// railOrder and entries actually agree on an id. Anything in railOrder
// but no longer in entries (a space that's since been left) is silently
// dropped rather than left dangling. Anything in entries but not yet in
// railOrder — every id, on first run before any drag has happened, or
// just a newly-joined space/room — keeps buildEntries' own relative
// order and is appended after everything the user has explicitly
// arranged, so a new space shows up at the end of the rail rather than
// jumping in front of things the user already positioned.
function applyRailOrder(entries) {
  const remaining = new Map(entries.map((e) => [e.id, e]));
  const ordered = [];
  for (const id of railOrder) {
    const entry = remaining.get(id);
    if (entry) {
      ordered.push(entry);
      remaining.delete(id);
    }
  }
  for (const entry of entries) {
    if (remaining.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

function entryUnreadCount(entry) {
  const directRoomIds = getDirectRoomIds();
  return (entry.requests?.length || 0) + entry.channels.reduce(
    (sum, room) => sum + alertCount(room, directRoomIds.has(room.roomId)),
    0,
  );
}

// Persists which rail entry is showing in the channel pane across
// re-renders — see this file's header comment for why this can't just
// live in a local variable inside renderRoomList.
let selectedEntryId = null;
// Which groups (Direct Messages, each space, Other rooms) are open is
// saved, so a reload keeps them.
const expandedSpaceIds = new Set(Array.isArray(matrixState.openSpaces) ? matrixState.openSpaces : [DIRECT_ENTRY_ID]);
function saveListState() {
  matrixState.openSpaces = [...expandedSpaceIds];
  save();
}
const OTHER_ROOMS_ENTRY_ID = '__other_rooms__';

// ── Rooms in a space you haven't joined ─────────────────────────────────
// m.space.child only gives IDs; names, topics and member counts come from
// the space hierarchy API, fetched when a space is opened and kept for a
// minute. spaceId -> { rooms, at, loading, error }
const SPACE_CHILDREN_TTL = 60_000;
const spaceChildCache = new Map();
const joiningChildIds = new Map(); // roomId -> error message, or '' while joining

function loadSpaceChildren(spaceId) {
  const cached = spaceChildCache.get(spaceId);
  if (cached?.loading || (cached && Date.now() - cached.at < SPACE_CHILDREN_TTL)) return;
  const state = { rooms: cached?.rooms || [], at: Date.now(), loading: true, error: '' };
  spaceChildCache.set(spaceId, state);
  getSpaceChildren(spaceId).then(page => { state.rooms = page.rooms; })
    .catch(error => { state.error = error?.message || 'Couldn\'t load this space\'s rooms.'; })
    .finally(() => {
      state.loading = false;
      state.at = Date.now();
      if (spaceChildCache.get(spaceId) === state) currentPaint?.();
    });
}

// Invites to rooms and spaces (DM requests are in Direct Messages).
// roomId -> 'accept' | 'decline' while answering, or an error message.
const inviteStates = new Map();

function invitesHtml() {
  const invites = getInvites();
  if (!invites.length) return '';
  return `
    <div class="mx-channel-rows mx-invite-rows">
      <div class="mx-request-heading mx-eyebrow">Invites <span>${invites.length}</span></div>
      ${invites.map(invite => {
        const state = inviteStates.get(invite.roomId);
        const busy = state === 'accept' || state === 'decline';
        const initial = (String(invite.name).replace(/^[#!]/, '').trim()[0] || '#').toUpperCase();
        return `
          <div class="mx-room-row mx-request-row" data-id="invite:${escapeHtml(invite.roomId)}" data-invite-id="${escapeHtml(invite.roomId)}">
            <div class="mx-room-avatar" style="--mx-avatar-hue: ${childHue(invite.roomId)}">${escapeHtml(initial)}</div>
            <div class="mx-room-main">
              <div class="mx-room-top"><span class="mx-room-name">${escapeHtml(invite.name)}</span></div>
              <div class="mx-room-preview">${invite.isSpace ? 'Space' : 'Room'}${invite.inviterName ? ` · from ${escapeHtml(invite.inviterName)}` : ''}</div>
              <div class="mx-request-actions">
                <button type="button" data-invite-action="accept"${busy ? ' disabled' : ''}>${state === 'accept' ? 'Joining…' : 'Accept'}</button>
                <button type="button" data-invite-action="decline"${busy ? ' disabled' : ''}>${state === 'decline' ? 'Declining…' : 'Decline'}</button>
              </div>
              ${state && !busy ? `<div class="mx-request-error" role="alert">${escapeHtml(state)}</div>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

function childHue(id) {
  let hue = 0;
  for (const c of String(id)) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return hue;
}

function unjoinedRowHtml(child, spaceId) {
  const joining = joiningChildIds.get(child.roomId);
  const initial = (String(child.name).replace(/^[#!]/, '').trim()[0] || '#').toUpperCase();
  const action = child.joinRule === 'invite'
    ? '<span class="mx-room-join-note">Invite only</span>'
    : `<button type="button" class="mx-room-join" data-join-child="${escapeHtml(child.roomId)}"${joining === '' ? ' disabled' : ''}>${joining === '' ? 'Joining…' : 'Join'}</button>`;
  const preview = joining ? joining : [child.isSpace ? 'Space' : null, `${child.members} member${child.members === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return `
    <div class="mx-room-row mx-room-row-unjoined" data-id="unjoined:${escapeHtml(child.roomId)}" data-child-id="${escapeHtml(child.roomId)}" data-child-space="${escapeHtml(spaceId)}">
      <div class="mx-room-avatar" style="--mx-avatar-hue: ${childHue(child.roomId)}">${escapeHtml(initial)}</div>
      <div class="mx-room-main">
        <div class="mx-room-top"><span class="mx-room-name" title="${escapeHtml(child.topic || child.name)}">${escapeHtml(child.name)}</span></div>
        <div class="mx-room-preview${joining ? ' mx-room-preview-error' : ''}">${escapeHtml(preview)}</div>
      </div>
      ${action}
    </div>`;
}

/** Rows for the rooms in a space that you're not in yet. */
function unjoinedRowsHtml(group) {
  if (!group.iconRoom?.isSpaceRoom?.()) return '';
  const state = spaceChildCache.get(group.id);
  if (!state) return '';
  const joined = new Set(getRooms().filter(room => room.getMyMembership?.() === 'join').map(room => room.roomId));
  const rows = state.rooms.filter(child => !joined.has(child.roomId));
  return `
    ${rows.length ? `<div class="mx-space-more-heading mx-eyebrow">More in this space</div>${rows.map(child => unjoinedRowHtml(child, group.id)).join('')}` : ''}
    ${state.loading && !state.rooms.length ? '<div class="mx-empty">Loading rooms…</div>' : ''}
    ${state.error ? `<div class="mx-empty">${escapeHtml(state.error)}</div>` : ''}`;
}

function railItemHtml(entry, isActive) {
  // The synthetic Direct-Messages entry has no single backing room to
  // derive an initial/hue from (entry.iconRoom is null — see
  // buildEntries), so it gets a fixed icon in a neutral swatch instead.
  // hydrateAvatars() skips it for the same reason: there's no room to
  // fetch a photo for.
  const avatarInner = entry.iconRoom
    ? (() => {
        const { initial, hue } = initialAndHue(entry.iconRoom);
        return `<span class="mx-rail-avatar" data-avatar-source="${escapeHtml(avatarMxcUrl(entry.iconRoom, false) || '')}" style="--mx-avatar-hue: ${hue}">${escapeHtml(initial)}</span>`;
      })()
    : `<span class="mx-rail-avatar mx-rail-avatar-generic"><img src="${DM_ICON_URL}" alt="" draggable="false"></span>`;
  const unread = entryUnreadCount(entry);
  return `
    <button type="button" class="mx-rail-item${isActive ? ' active' : ''}" data-id="${escapeHtml(entry.id)}" title="${escapeHtml(entry.name)}" draggable="true">
      ${avatarInner}
      ${unread > 0 ? '<span class="mx-rail-unread-dot"></span>' : ''}
    </button>
  `;
}

function channelRowHtml(room, { showAvatar = true, isDM = false, isActive = false } = {}) {
  const { body, ts } = lastMessage(room);
  const name = escapeHtml(labelForRoom(room, isDM));
  const time = formatRoomTime(ts);
  // showAvatar defaults to true and is always passed true now — every
  // pane uses the same plain eyebrow header (see channelPaneHtml), so
  // there's no banner establishing "which space" up top any more and
  // every row needs its own avatar again, spaces included. The param
  // stays in place (rather than deleting it outright) in case a future
  // pane type wants to opt out again. mx-room-avatar-dm strips the
  // hue-swatch background in CSS (a DM fallback is just the initial, no
  // color, per this file's DM-avatar work — see styles.css) — the
  // class is set purely from isDM, not from whether a photo actually
  // loads, since getAvatarUrl's async photo swap-in (see
  // hydrateAvatars) replaces this div's *contents* via innerHTML but
  // never touches its class list.
  const avatarHtml = showAvatar
    ? (() => {
        const { initial, hue } = initialAndHue(room);
        const dmClass = isDM ? ' mx-room-avatar-dm' : '';
        return `<div class="mx-room-avatar${dmClass}" data-avatar-source="${escapeHtml(avatarMxcUrl(room, isDM) || '')}" style="--mx-avatar-hue: ${hue}">${escapeHtml(initial)}</div>`;
      })()
    : '';
  return `
    <div class="mx-room-row${isActive ? ' active' : ''}" data-room-id="${escapeHtml(room.roomId)}">
      ${avatarHtml}
      <div class="mx-room-main">
        <div class="mx-room-top">
          <span class="mx-room-name">${name}</span>
          ${time ? `<span class="mx-room-time">${time}</span>` : ''}
        </div>
        <div class="mx-room-preview">${escapeHtml(body)}</div>
      </div>
    </div>
  `;
}

/** The list's groups: Direct Messages first, then each space, then Other rooms. */
function spaceGroups(entries) {
  const direct = entries.find(entry => entry.id === DIRECT_ENTRY_ID);
  const spaces = entries.filter(entry => entry.id !== DIRECT_ENTRY_ID
    && entry.iconRoom?.isSpaceRoom?.());
  const looseRooms = entries.filter(entry => entry.id !== DIRECT_ENTRY_ID
    && !entry.iconRoom?.isSpaceRoom?.()).flatMap(entry => entry.channels);
  return [
    ...(direct ? [direct] : []),
    ...spaces,
    ...(looseRooms.length ? [{ id: OTHER_ROOMS_ENTRY_ID, name: 'Other rooms', iconRoom: null, channels: looseRooms }] : []),
  ];
}

function spaceGroupIdForRoom(entries, roomId) {
  const groups = spaceGroups(entries);
  return groups.find(group => group.channels.some(room => room.roomId === roomId))?.id || null;
}

function spacesPaneHtml(entries, activeRoomId) {
  const groups = spaceGroups(entries);
  if (!groups.length) return '<div class="mx-empty">No rooms yet</div>';
  return `
    <div class="mx-channel-rows mx-space-groups">
      ${groups.map(group => {
        const open = expandedSpaceIds.has(group.id);
        const unread = entryUnreadCount(group);
        const isDirect = group.id === DIRECT_ENTRY_ID;
        const more = open ? unjoinedRowsHtml(group) : '';
        const requests = isDirect ? group.requests || [] : [];
        // Direct Messages stays first; spaces can be dragged into any order.
        const draggable = !isDirect && group.id !== OTHER_ROOMS_ENTRY_ID;
        return `
          <section class="mx-space-group${open ? ' open' : ''}${isDirect ? ' mx-space-group-direct' : ''}" data-entry-id="${escapeHtml(group.id)}">
            <button type="button" class="mx-space-group-toggle" data-space-id="${escapeHtml(group.id)}" aria-expanded="${open}" draggable="${draggable}">
              <span class="mx-space-group-name">${escapeHtml(group.name)}</span>
              <span class="mx-space-group-count">${group.channels.length}${requests.length ? ` · ${requests.length} request${requests.length === 1 ? '' : 's'}` : ''}${unread ? ` · ${unread} new` : ''}</span>
              <span class="mx-space-group-chevron" aria-hidden="true">›</span>
            </button>
            <div class="mx-space-group-rooms"${open ? '' : ' hidden'}>
              ${requests.map(requestRowHtml).join('')}
              ${group.channels.map(room => channelRowHtml(room, {
                showAvatar: true,
                isDM: isDirect,
                isActive: room.roomId === activeRoomId,
              })).join('')}
              ${more}
              ${!group.channels.length && !requests.length && !more.trim() ? `<div class="mx-empty">${isDirect ? 'No direct messages yet' : 'No rooms in this space'}</div>` : ''}
            </div>
          </section>`;
      }).join('')}
    </div>`;
}

function requestRowHtml(room) {
  const state = requestActions.get(room.roomId);
  const sender = room.getDMInviter?.() || room.roomId;
  const label = room.getMember?.(sender)?.name || room.name || sender;
  return `<div class="mx-room-row mx-request-row" data-room-id="${escapeHtml(room.roomId)}">
    <div class="mx-room-avatar mx-room-avatar-dm" data-avatar-source="${escapeHtml(avatarMxcUrl(room, true) || '')}">${escapeHtml((label.trim()[0] || '?').toUpperCase())}</div>
    <div class="mx-room-main">
      <div class="mx-room-top"><span class="mx-room-name" title="${escapeHtml(sender)}">${escapeHtml(label)}</span></div>
      <div class="mx-room-preview">Wants to chat with you</div>
      <div class="mx-request-actions">
        <button type="button" data-request-action="accept" ${state?.busy ? 'disabled' : ''}>${state?.busy === 'accept' ? 'Accepting…' : 'Accept'}</button>
        <button type="button" data-request-action="decline" ${state?.busy ? 'disabled' : ''}>${state?.busy === 'decline' ? 'Declining…' : 'Decline'}</button>
      </div>
      ${state?.error ? `<div class="mx-request-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
    </div>
  </div>`;
}

// Hydrates every avatar under contentEl — rail icons and channel rows
// alike — with its real photo once getAvatarUrl() resolves.
// Fire-and-forget per element, same as the original flat list: a slow
// or failed fetch for one never blocks the others. Looked up by
// data-id (rail items) / data-room-id (channel rows) against a flat
// id->Room map built fresh from entries each call, since which channel
// rows are even in the DOM changes with the current selection.
function hydrateAvatars(contentEl, entries) {
  const roomById = new Map();
  for (const entry of entries) {
    // entry.iconRoom is null for the synthetic Direct-Messages entry
    // (see buildEntries) — skip it rather than mapping id -> null, so
    // the querySelectorAll loop below's `if (!room ...) return` guard
    // reads as "no room found" for exactly the right reason.
    if (entry.iconRoom) roomById.set(entry.id, entry.iconRoom);
    for (const room of entry.channels) roomById.set(room.roomId, room);
    for (const room of entry.requests || []) roomById.set(room.roomId, room);
  }

  contentEl.querySelectorAll('.mx-rail-item').forEach((btn) => {
    const room = roomById.get(btn.dataset.id);
    const avatarEl = btn.querySelector('.mx-rail-avatar');
    if (!room || !avatarEl) return;
    const source = avatarEl.dataset.avatarSource;
    getAvatarUrl(room).then((url) => {
      if (!url || !avatarEl.isConnected || avatarEl.dataset.avatarSource !== source) return;
      if (avatarEl.firstElementChild?.getAttribute('src') === url) return;
      avatarEl.innerHTML = `<img src="${url}" alt="" draggable="false">`;
      avatarEl.style.background = 'transparent';
    });
  });

  // Needed here (not just in buildEntries) so this loop knows which
  // rows are actual DMs and should resolve the other member's avatar
  // instead of the room's own — see avatarMxcUrl/getAvatarUrl above.
  const directRoomIds = getDirectRoomIds();
  contentEl.querySelectorAll('.mx-room-row').forEach((row) => {
    const room = roomById.get(row.dataset.roomId);
    const avatarEl = row.querySelector('.mx-room-avatar');
    if (!room || !avatarEl) return;
    const source = avatarEl.dataset.avatarSource;
    getAvatarUrl(room, directRoomIds.has(room.roomId)).then((url) => {
      if (!url || !avatarEl.isConnected || avatarEl.dataset.avatarSource !== source) return;
      if (avatarEl.firstElementChild?.getAttribute('src') === url) return;
      avatarEl.innerHTML = `<img src="${url}" alt="">`;
      avatarEl.style.background = 'transparent'; // see .mx-rail-avatar note above
    });
  });

}

// Current mounted controller, also used by room action completions.
let currentPaint = null;
// ── Drag-to-reorder state ────────────────────────────────────────────────
//
// Module-scoped for the same reason as railOrder/selectedEntryId/
// currentPaint above: it needs to survive across renderRoomList() calls
// and be shared by every rail item's dragstart/dragover/drop handlers,
// not scoped to one item's own listener closure.
let dragSourceId = null;

// ── Right-click "Leave" context menu ────────────────────────────────────
//
// Used to reuse room-view.js's own .mx-reaction-picker/.mx-reaction-picker-
// action classes by hand (a single Leave button styled like that menu's
// Reply/Edit rows). Now an Atmos menu (atmos.contextMenu) instead — one shared action-row look across the whole app,
// rather than this plugin matching room-view.js's popover matching Core's
// #ctx-menu by hand, two links down the copy chain.
function closeContextMenu() {
  atmos.contextMenu.close().catch(() => {});
}

// room: the actual Room (or Space, which is just a Room per matrix-js-sdk)
// being right-clicked. label: 'Space' or 'Room', used in the menu text and
// confirm prompt — spaceEntries/soloRoomEntries's iconRoom and individual
// channel rows all resolve to a real backing room, so this never needs a
// null-room case (see the two call sites below, which already guard that).
const plural = (count, word) => `${Number(count).toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

/**
 * What a room or space is, for the foot of its menu, in the Audio Player's
 * album-menu style: "Room  ·  42 members  ·  encrypted", then its address,
 * who can join and your role.
 */
function roomDetails(room, isDM) {
  const members = plural(room.getJoinedMemberCount?.() ?? 0, 'member');
  let summary;
  if (room.isSpaceRoom?.()) {
    const rooms = (room.currentState?.getStateEvents('m.space.child') || [])
      .filter(event => (event.getContent?.().via || []).length).length;
    summary = ['Space', plural(rooms, 'room'), members];
  } else {
    summary = [isDM ? 'Direct message' : 'Room', members, room.hasEncryptionStateEvent?.() ? 'encrypted' : null];
  }
  const power = room.getMember?.(getUserId())?.powerLevel ?? 0;
  const about = [
    room.getCanonicalAlias?.() || null,
    isDM ? null : ({ public: 'Anyone can join', restricted: 'Space members can join', knock: 'Ask to join' }[room.getJoinRule?.()] || 'Invite only'),
    power >= 100 ? 'Admin' : power >= 50 ? 'Moderator' : null,
  ];
  return [summary, about].map(parts => parts.filter(Boolean).join('  ·  ')).filter(Boolean);
}

/**
 * A room's or space's menu (right-click): its name and icon if you may
 * change them, a link to share, Leave, and at the foot what it is. Atmos draws it; a
 * destructive or failed action says so in a second menu at the same spot.
 */
function openContextMenu(container, x, y, room, label) {
  const isDM = getDirectRoomIds().has(room.roomId);
  const kind = isDM ? 'chat' : label.toLowerCase();
  const name = room.name || room.roomId;
  const can = isDM ? { name: false, avatar: false } : getRoomPermissions(room.roomId);
  const alias = room.getCanonicalAlias?.();
  const fail = (what, error) => {
    console.error(`[matrix-chat] couldn't ${what}:`, error);
    tellInMenu(x, y, `Couldn't ${what}: ${error?.message || error}`);
  };

  const items = [];
  if (can.name) {
    items.push({
      id: 'name', type: 'text', label: 'Name', value: room.name || '', maxLength: 255, placeholder: `Name this ${kind}`,
      run: async value => {
        if (!value || value === room.name) return;
        try { await setRoomName(room.roomId, value); } catch (error) { fail(`rename this ${kind}`, error); }
      },
    });
  }
  if (can.avatar) {
    items.push({
      id: 'icon', label: 'Change icon…', icon: menuIcon('image'),
      run: async () => {
        try {
          const image = await atmos.invoke('plugin:matrix-chat', 'pick-image');
          if (image) await setRoomAvatar(room.roomId, image);
        } catch (error) { fail(`change the icon`, error); }
      },
    });
    if (room.getMxcAvatarUrl?.()) {
      items.push({
        id: 'remove-icon', label: 'Remove icon', icon: menuIcon('delete'),
        run: async () => {
          try { await removeRoomAvatar(room.roomId); } catch (error) { fail('remove the icon', error); }
        },
      });
    }
  }
  items.push({
    id: 'copy-link', label: 'Copy link', icon: menuIcon('link'),
    run: () => atmos.clipboard.writeText(`https://matrix.to/#/${encodeURIComponent(alias || room.roomId)}`)
      .catch(error => fail('copy the link', error)),
  });
  // Spaces it's in that you look after: take it out of them.
  const parentSpaces = isDM || room.isSpaceRoom?.() ? [] : getRooms()
    .filter(space => space.getMyMembership?.() === 'join' && space.isSpaceRoom?.() && canAddToSpace(space.roomId))
    .filter(space => (space.currentState?.getStateEvents('m.space.child') || [])
      .some(event => event.getStateKey?.() === room.roomId && (event.getContent?.().via || []).length));
  items.push({ type: 'separator' });
  for (const space of parentSpaces) {
    items.push({
      id: `unlink:${space.roomId}`, label: `Remove from ${space.name || 'space'}`, icon: menuIcon('unlink'),
      hold: true, tone: 'danger',
      run: async () => {
        try { await removeFromSpace(space.roomId, room.roomId); } catch (error) { fail(`remove it from ${space.name || 'the space'}`, error); }
      },
    });
  }
  // Leaving is destructive (a private room or space needs a fresh invite to
  // rejoin), so it takes a press and hold rather than a click.
  items.push({
    id: 'leave',
    label: `Leave ${kind}`,
    icon: menuIcon('leave'),
    hold: true,
    tone: 'danger',
    run: async () => {
      pendingMembershipChanges.set(room.roomId, room.getMyMembership?.() || 'join');
      currentPaint?.();
      try {
        await leaveRoom(room.roomId);
      } catch (err) {
        pendingMembershipChanges.delete(room.roomId);
        currentPaint?.();
        fail(`leave that ${kind}`, err);
      }
    },
  });
  // What it is, at the foot, like the Audio Player's album menu.
  const [summary, about] = roomDetails(room, isDM);
  items.push({ type: 'separator' }, { type: 'meta', label: `${name}  ·  ${summary}`, icon: menuIcon('info') });
  if (about) items.push({ type: 'meta', label: about });
  atmos.contextMenu.open(x, y, items).catch(error => console.error('[matrix-chat] room menu:', error));
}

export function renderRoomList(contentEl, { onSelectRoom, activeRoomId = null } = {}) {
  let entries = applyRailOrder(buildEntries(roomsForList()));

  let disposed = false;
  let paintQueued = false;
  let handlers = new AbortController();
  // Opening a room opens its group, so it's in view; the room Atmos reopens
  // on start leaves its group however you left it (open or closed).
  let restoredRoomId = matrixState.lastRooms?.[getUserId()] || null;
  let autoExpandedRoomId = restoredRoomId;
  if (activeRoomId && activeRoomId !== restoredRoomId) {
    const groupId = spaceGroupIdForRoom(entries, activeRoomId);
    if (groupId) {
      expandedSpaceIds.add(groupId);
      autoExpandedRoomId = activeRoomId;
    }
  }


  function queuePaint() {
    if (disposed || paintQueued) return;
    paintQueued = true;
    queueMicrotask(() => {
      paintQueued = false;
      if (!disposed) paint();
    });
  }
  const subscriptions = [
    onRoom(queuePaint),
    onTimeline((_event, _room, toStart) => { if (!toStart) queuePaint(); }),
    onReceipt(queuePaint), onUnreadNotifications(queuePaint),
    onSync(state => { if (['PREPARED', 'SYNCING'].includes(state)) queuePaint(); }),
  ];

  // Space order is still user-controlled, but the drag targets are now the
  // nested space headings rather than the removed icon rail.
  function reorderRail(sourceId, targetId) {
    const sourceIndex = entries.findIndex((e) => e.id === sourceId);
    const targetIndex = entries.findIndex((e) => e.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) return;
    const [moved] = entries.splice(sourceIndex, 1);
    entries.splice(targetIndex, 0, moved);
    railOrder = entries.map((e) => e.id);
    saveRailOrder(railOrder);
    paint();
  }

  function paint() {
    if (disposed) return;
    if (dragSourceId) return;
    handlers.abort();
    handlers = new AbortController();
    const listen = (element, type, callback) => element?.addEventListener(type, callback, { signal: handlers.signal });
    entries = applyRailOrder(buildEntries(roomsForList()));
    if (activeRoomId && autoExpandedRoomId !== activeRoomId) {
      const groupId = spaceGroupIdForRoom(entries, activeRoomId);
      if (groupId) {
        const added = !expandedSpaceIds.has(groupId);
        expandedSpaceIds.add(groupId);
        autoExpandedRoomId = activeRoomId;
        if (added) saveListState();
      }
    }
    // The settings popover is mounted at document.body level and can safely
    // survive this routine repaint. Closing it here made every sync update
    // (including an incoming message) dismiss a form the user was using.
    // The right-click menu is position/action-specific, so it still closes.
    closeContextMenu();

    reconcileMarkup(contentEl, `
      <div class="mx-room-list mx-room-list-spaces"><div class="mx-channel-pane">${invitesHtml()}${spacesPaneHtml(entries, activeRoomId)}</div></div>
    `);

    contentEl.querySelectorAll('.mx-space-group-toggle[draggable="true"]').forEach(toggle => {
      listen(toggle, 'dragstart', (e) => {
        dragSourceId = toggle.dataset.spaceId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceId);
        toggle.closest('.mx-space-group')?.classList.add('mx-space-group-dragging');
      });
      listen(toggle, 'dragend', () => {
        dragSourceId = null;
        queuePaint();
        contentEl.querySelectorAll('.mx-space-group-dragging, .mx-space-group-drag-over')
          .forEach(el => el.classList.remove('mx-space-group-dragging', 'mx-space-group-drag-over'));
      });
    });

    contentEl.querySelectorAll('.mx-space-group[data-entry-id]').forEach(group => {
      const targetId = group.dataset.entryId;
      listen(group, 'dragover', e => {
        if (!dragSourceId || targetId === OTHER_ROOMS_ENTRY_ID || dragSourceId === targetId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        group.classList.add('mx-space-group-drag-over');
      });
      listen(group, 'dragleave', () => group.classList.remove('mx-space-group-drag-over'));
      listen(group, 'drop', e => {
        e.preventDefault();
        group.classList.remove('mx-space-group-drag-over');
        const source = dragSourceId;
        dragSourceId = null;
        if (source && source !== targetId) reorderRail(source, targetId);
      });
    });

    contentEl.querySelectorAll('.mx-space-group-toggle').forEach(toggle => {
      listen(toggle, 'click', () => {
        const id = toggle.dataset.spaceId;
        if (expandedSpaceIds.has(id)) expandedSpaceIds.delete(id);
        else expandedSpaceIds.add(id);
        saveListState();
        paint();
      });
      listen(toggle, 'contextmenu', e => {
        const entry = entries.find(item => item.id === toggle.dataset.spaceId);
        if (!entry?.iconRoom) return;
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(contentEl, e.clientX, e.clientY, entry.iconRoom, 'Space');
      });
    });

    const roomById = new Map(entries.flatMap(entry => entry.channels.map(room => [room.roomId, room])));
    contentEl.querySelectorAll('.mx-room-row').forEach((row) => {
      const room = roomById.get(row.dataset.roomId);
      if (!room) return;
      listen(row, 'click', () => {
        contentEl.querySelector('.mx-room-row.active')?.classList.remove('active');
        row.classList.add('active');
        activeRoomId = room.roomId;
        onSelectRoom(room);
      });
      listen(row, 'contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(contentEl, e.clientX, e.clientY, room, 'Room');
      });
    });

    // Opening a space fetches the rooms in it you're not in yet.
    for (const id of expandedSpaceIds) {
      if (entries.find(entry => entry.id === id)?.iconRoom?.isSpaceRoom?.()) loadSpaceChildren(id);
    }

    contentEl.querySelectorAll('[data-join-child]').forEach(button => {
      listen(button, 'click', async event => {
        event.stopPropagation();
        const row = button.closest('[data-child-id]');
        const roomId = row.dataset.childId;
        const child = spaceChildCache.get(row.dataset.childSpace)?.rooms.find(room => room.roomId === roomId);
        if (!child || joiningChildIds.get(roomId) === '') return;
        joiningChildIds.set(roomId, '');
        paint();
        try {
          await joinSpaceRoom(child.roomId, child.via);
          joiningChildIds.delete(roomId);
          if (!disposed && !child.isSpace) onSelectRoom({ roomId });
        } catch (error) {
          joiningChildIds.set(roomId, `Couldn't join: ${error?.message || 'try again.'}`);
        }
        currentPaint?.();
      });
    });

    contentEl.querySelectorAll('[data-invite-action]').forEach(button => {
      listen(button, 'click', async event => {
        event.stopPropagation();
        const roomId = button.closest('[data-invite-id]').dataset.inviteId;
        const action = button.dataset.inviteAction;
        if (inviteStates.get(roomId) === 'accept' || inviteStates.get(roomId) === 'decline') return;
        inviteStates.set(roomId, action);
        paint();
        try {
          if (action === 'accept') await acceptInvite(roomId);
          else await declineInvite(roomId);
          inviteStates.delete(roomId);
          if (action === 'accept' && !disposed && !getRooms().find(room => room.roomId === roomId)?.isSpaceRoom?.()) onSelectRoom({ roomId });
        } catch (error) {
          inviteStates.set(roomId, `Couldn't ${action}: ${error?.message || 'try again.'}`);
        }
        currentPaint?.();
      });
    });

    contentEl.querySelectorAll('[data-request-action]').forEach(button => {
      listen(button, 'click', async () => {
        const roomId = button.closest('[data-room-id]').dataset.roomId;
        if (requestActions.get(roomId)?.busy) return;
        const action = button.dataset.requestAction;
        const state = { busy: action };
        requestActions.set(roomId, state);
        paint();
        try {
          pendingMembershipChanges.set(roomId, 'invite');
          paint();
          if (action === 'accept') await acceptDirectRequest(roomId);
          else await leaveRoom(roomId);
          if (requestActions.get(roomId) !== state) return;
          requestActions.delete(roomId);
        } catch (error) {
          if (requestActions.get(roomId) !== state) return;
          pendingMembershipChanges.delete(roomId);
          requestActions.set(roomId, { error: `Could not ${action}: ${error.message || 'Please try again.'}` });
        }
        currentPaint?.();
      });
    });

    hydrateAvatars(contentEl, entries);
  }

  currentPaint = paint;
  paint();

  // The switcher (settings-menu.js) can swap the live client at any
  // time, independent of panel.js's own onSync-driven re-render loop
  // (see this file's header comment on why that loop is the only thing
  // that normally repaints this view). Waiting for the next sync to
  // land would leave the OLD account's rooms on screen for however long
  // the new client takes to reach its first sync — rebuilding `entries`
  // straight from getRooms() here (already returns [] for a client that
  // hasn't synced yet) makes the switch itself feel instant, matching
  // Discord's own switcher. selectedEntryId is deliberately reset to
  // null rather than left alone: leaving it would either point at a
  // room id that happens not to exist in the new account (harmless —
  // the existing fallback below already catches that) or, on a
  // same-homeserver-different-user setup, coincidentally match a room
  // the new account is ALSO in, silently landing on the wrong channel
  // instead of visibly resetting to the top entry.
  const offAccountChange = onAccountChange(() => {
    spaceChildCache.clear();
    joiningChildIds.clear();
    inviteStates.clear();
    selectedEntryId = null;
    activeRoomId = null;
    dragSourceId = null;
    closeContextMenu();
    paint();
  });
  const cleanup = () => {
    disposed = true;
    handlers.abort();
    if (currentPaint === paint) currentPaint = null;
    offAccountChange();
    subscriptions.forEach(off => off());
  };
  cleanup.update = roomId => {
    const changed = roomId !== activeRoomId;
    activeRoomId = roomId;
    if (roomId && roomId === restoredRoomId) restoredRoomId = null;
    else if (roomId && changed) {
      const groupId = spaceGroupIdForRoom(entries, roomId);
      if (groupId) {
        expandedSpaceIds.add(groupId);
        autoExpandedRoomId = roomId;
        saveListState();
      }
    }
    queuePaint();
  };
  return cleanup;
}

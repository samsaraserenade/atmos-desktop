/**
 * Matrix Chat's rev/ commands, run in Atmos's command bar (SDK 1.3). They're
 * declared in extension.json ("contributes.commands") and handled here, in
 * the background frame (boot.js), so they work whether or not the Chat panel
 * is showing; what they open shows in the panel (the engine's shared view,
 * then atmos.panel.show()). The message bar hands rev/ over to Atmos's bar
 * (room-view.js, empty-view.js), so there's one list, in one look.
 *
 *   go             your rooms and chats, by name
 *   join           rooms in your spaces, public rooms, or an address or link
 *   dm             someone by Matrix ID, or one of your chats
 *   create-room    with options: which space, who can join, encryption, an address
 *   create-space   the same; then its first room
 *   notifications  the ping for new messages, on or off
 *   invite         someone to the open room
 *   leave          the open room
 *
 * Rows and options are plain text: Atmos draws (and escapes) them.
 */
import atmos from 'atmos-sdk';
import {
  addFriend, browsePublicRooms, canAddToSpace, createRoom, createSpace, currentView, getDirectRoomIds,
  getNotificationSound, getRooms, getSpaceChildren, getUserId, hasSession, inviteToRoom, joinByAddress,
  joinPublicRoom, joinSpaceRoom, leaveRoom, onAccountChange, setNotificationSound, showRoom,
} from './engine.js';
import { isMatrixId, isRoomAddress, slugOf } from './commands.js';

const lower = value => String(value || '').toLowerCase();
const plural = (count, word) => `${Number(count).toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function serverName() {
  const id = getUserId() || '';
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : '';
}

function joinedRooms() {
  return getRooms().filter(room => room.getMyMembership?.() === 'join');
}

function joinedSpaces() {
  return joinedRooms().filter(room => room.isSpaceRoom?.())
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** A DM's name is the other person's; everything else uses the room name. */
function roomLabel(room, directIds) {
  if (!directIds.has(room.roomId)) return room.name || room.roomId;
  const self = getUserId();
  const other = room.getJoinedMembers?.().find(member => member.userId !== self);
  return other?.name || room.name || room.roomId;
}

/** Spaces the room belongs to (its parents that you're in). */
function parentSpacesOf(roomId) {
  return joinedSpaces().filter(space => (space.currentState?.getStateEvents('m.space.child') || [])
    .some(event => event.getStateKey?.() === roomId && (event.getContent?.().via || []).length));
}

/** The room the Chat panel has open, or null. */
function openRoom() {
  const view = currentView();
  return view.type === 'room' ? getRooms().find(room => room.roomId === view.roomId) || null : null;
}

/** The room a row named (the one open when it was listed), if you're still in it; else the one open now. */
function roomFor(value) {
  if (!value) return openRoom();
  return joinedRooms().find(room => room.roomId === value) || null;
}

/** Wait (a few seconds at most: Atmos gives a command 15) for sync to bring a room you're in. */
async function joined(roomId, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!getRooms().some(room => room.roomId === roomId && room.getMyMembership?.() === 'join')) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return true;
}

/** Show a room in the Chat panel. */
async function show(roomId) {
  if (!roomId) return;
  showRoom(roomId);
  await atmos.panel.show().catch(() => {});
}

const signedOut = () => [{ note: 'Sign in to Matrix Chat first.' }];
const requireSession = () => { if (!hasSession()) throw new Error('Sign in to Matrix Chat first.'); };

// Rooms in your spaces you haven't joined, from the space hierarchy API,
// fetched when rev/join is typed and kept a minute; the bar asks again once
// they're in (atmos.commands.refresh()).
const SPACE_CHILDREN_TTL = 60_000;
const spaceChildren = new Map(); // spaceId -> { rooms, at, loading, spaceName }

function loadSpaceChildren() {
  for (const space of joinedSpaces()) {
    const cached = spaceChildren.get(space.roomId);
    if (cached?.loading || (cached && Date.now() - cached.at < SPACE_CHILDREN_TTL)) continue;
    const state = { rooms: cached?.rooms || [], at: Date.now(), loading: true, spaceName: space.name || space.roomId };
    spaceChildren.set(space.roomId, state);
    getSpaceChildren(space.roomId).then(page => { state.rooms = page.rooms; })
      .catch(() => {})
      .finally(() => {
        state.loading = false;
        state.at = Date.now();
        atmos.commands.refresh();
      });
  }
}

// Public rooms for what's typed, one search at a time, a moment after typing stops.
let publicQuery = '';
let publicRooms = [];
let publicLoading = false;
let publicTimer = null;

function searchPublicRooms(query, text) {
  if (publicQuery === query) return;
  publicQuery = query;
  publicRooms = [];
  publicLoading = true;
  clearTimeout(publicTimer);
  publicTimer = setTimeout(() => {
    browsePublicRooms({ search: text, limit: 8 }).then(result => { if (publicQuery === query) publicRooms = result; })
      .catch(() => { if (publicQuery === query) publicRooms = []; })
      .finally(() => {
        if (publicQuery !== query) return;
        publicLoading = false;
        atmos.commands.refresh();
      });
  }, 300);
}

// ── go ──
function goRows(args) {
  if (!hasSession()) return signedOut();
  const directIds = getDirectRoomIds();
  const query = lower(args);
  const matches = joinedRooms()
    .filter(room => !room.isSpaceRoom?.())
    .filter(room => !query || lower(roomLabel(room, directIds)).includes(query))
    .slice(0, 8);
  if (!matches.length) return [{ note: query ? 'None of your rooms or chats match.' : 'You’re not in any rooms yet.' }];
  return matches.map(room => ({
    title: roomLabel(room, directIds),
    sub: directIds.has(room.roomId) ? 'Direct message' : (parentSpacesOf(room.roomId)[0]?.name || 'Room'),
    action: 'Open',
    value: room.roomId,
    complete: roomLabel(room, directIds),
  }));
}

async function go({ args, value }) {
  requireSession();
  // Enter before the list caught up: the first room that matches.
  const roomId = value || goRows(args).find(row => row.value)?.value;
  if (!roomId) throw new Error('None of your rooms or chats match.');
  await show(roomId);
  return undefined;
}

// ── join ──
function joinRows(args) {
  if (!hasSession()) return signedOut();
  if (isRoomAddress(args)) return [{ title: `Join ${args}`, action: 'Join', value: 'address' }];
  loadSpaceChildren();
  const query = lower(args);
  const joinedIds = new Set(joinedRooms().map(room => room.roomId));
  const out = [];
  const fromSpaces = [];
  for (const [, state] of spaceChildren) {
    for (const child of state.rooms) {
      if (joinedIds.has(child.roomId) || child.joinRule === 'invite') continue;
      if (query && !lower(child.name).includes(query) && !lower(child.topic).includes(query)) continue;
      fromSpaces.push({
        title: child.name,
        sub: [`in ${state.spaceName}`, child.isSpace ? 'space' : null, plural(child.members, 'member')].filter(Boolean).join(' · '),
        action: 'Join',
        value: `child:${child.roomId}`,
        complete: child.name,
      });
    }
  }
  if (fromSpaces.length) out.push({ heading: 'In your spaces' }, ...fromSpaces.slice(0, 8));
  else if ([...spaceChildren.values()].some(state => state.loading)) out.push({ note: 'Looking in your spaces…' });
  if (query.length >= 3) {
    searchPublicRooms(query, args);
    const rooms = publicRooms.filter(room => !joinedIds.has(room.room_id));
    if (rooms.length) {
      out.push({ heading: 'Public rooms' }, ...rooms.map(room => ({
        title: room.name || room.canonical_alias || room.room_id,
        sub: [plural(Number(room.num_joined_members || 0), 'member'), room.canonical_alias, room.topic].filter(Boolean).join(' · '),
        action: 'Join',
        value: `public:${room.room_id}`,
        complete: room.canonical_alias || room.name || '',
      })));
    } else if (publicLoading) out.push({ note: 'Searching public rooms…' });
  }
  if (!out.length) {
    out.push({ note: query ? 'Nothing matches. Paste a #room:server address or a matrix.to link to join it directly.'
      : 'Type to search your spaces and public rooms, or paste a #room:server address.' });
  }
  return out;
}

async function join({ args, value }) {
  requireSession();
  if (value === 'address' || (!value && isRoomAddress(args))) { await show((await joinByAddress(args))?.roomId); return undefined; }
  if (String(value).startsWith('child:')) {
    const roomId = String(value).slice('child:'.length);
    const child = [...spaceChildren.values()].flatMap(state => state.rooms).find(item => item.roomId === roomId);
    if (!child) throw new Error('That room isn’t in your spaces any more.');
    await joinSpaceRoom(child.roomId, child.via);
    if (child.isSpace) return { done: `Joined ${child.name}.` };
    await show(child.roomId);
    return undefined;
  }
  if (String(value).startsWith('public:')) {
    const roomId = String(value).slice('public:'.length);
    const room = publicRooms.find(item => item.room_id === roomId);
    await show((await joinPublicRoom(room?.canonical_alias || roomId))?.roomId);
    return undefined;
  }
  throw new Error('Choose a room to join, or paste its address.');
}

// ── dm ──
function dmRows(args) {
  if (!hasSession()) return signedOut();
  const directIds = getDirectRoomIds();
  const out = [];
  if (isMatrixId(args)) {
    out.push({ title: `Message ${args.trim()}`, sub: 'Starts a private, encrypted chat, or opens the one you have', action: 'Message', value: 'new' });
  }
  const query = lower(args.replace(/^@/, '').split(':')[0]);
  const chats = joinedRooms().filter(room => directIds.has(room.roomId))
    .filter(room => !query || lower(roomLabel(room, directIds)).includes(query))
    .slice(0, 6);
  if (chats.length) {
    out.push({ heading: 'Your chats' }, ...chats.map(room => ({
      title: roomLabel(room, directIds), sub: 'Direct message', action: 'Open', value: room.roomId, complete: roomLabel(room, directIds),
    })));
  }
  if (!out.length) out.push({ note: 'Type their full Matrix ID, such as @name:matrix.org.' });
  return out;
}

async function dm({ args, value }) {
  requireSession();
  if (value === 'new' || (!value && isMatrixId(args))) { await show((await addFriend(args.trim())).roomId); return undefined; }
  const roomId = value || dmRows(args).find(row => row.value && row.value !== 'new')?.value;
  if (!roomId) throw new Error('Type their full Matrix ID, such as @name:matrix.org.');
  await show(roomId);
  return undefined;
}

// ── create-room, create-space ──
const ACCESS_LABELS = { private: 'invite only', space: 'anyone in the space', public: 'public' };

/** The options as they stand: what the user chose (Atmos sends only those), the rest as they'd be. */
function createOptions(kind, args, chosen = {}) {
  const room = openRoom();
  const defaultParent = room ? parentSpacesOf(room.roomId).find(space => canAddToSpace(space.roomId))?.roomId || '' : '';
  const parent = chosen.parent !== undefined ? String(chosen.parent) : defaultParent; // '' is no space
  let access = ['private', 'space', 'public'].includes(chosen.access) ? chosen.access : (kind === 'room' && parent ? 'space' : 'private');
  if (access === 'space' && (kind === 'space' || !parent)) access = 'private';
  const encrypted = typeof chosen.encrypted === 'boolean' ? chosen.encrypted : access !== 'public';
  const alias = chosen.alias !== undefined ? String(chosen.alias).replace(/^#/, '').replace(/:.*$/, '') : slugOf(args);
  return { parent, access, encrypted, alias, listed: chosen.listed === true };
}

function createSuggestions(kind, { args, options = {} }) {
  if (!hasSession()) return signedOut();
  if (!args) return [{ note: `Type a name for the new ${kind}.` }];
  const chosen = createOptions(kind, args, options);
  const spaces = joinedSpaces().filter(space => canAddToSpace(space.roomId));
  const parentName = spaces.find(space => space.roomId === chosen.parent)?.name;
  return {
    rows: [{
      title: `Create ${kind} “${args}”`,
      sub: [parentName ? `in ${parentName}` : null, ACCESS_LABELS[chosen.access], kind === 'room' && chosen.encrypted ? 'encrypted' : null].filter(Boolean).join(' · '),
      action: 'Create',
    }],
    options: [
      ...(spaces.length ? [{
        id: 'parent', type: 'select', label: 'in', value: chosen.parent,
        options: [{ value: '', label: 'no space' }, ...spaces.map(space => ({ value: space.roomId, label: space.name || space.roomId }))],
      }] : []),
      {
        id: 'access', type: 'select', style: 'chips', label: 'Who can join', value: chosen.access,
        options: [
          { value: 'private', label: ACCESS_LABELS.private },
          ...(kind === 'room' && chosen.parent ? [{ value: 'space', label: ACCESS_LABELS.space }] : []),
          { value: 'public', label: ACCESS_LABELS.public },
        ],
      },
      ...(kind === 'room' ? [{ id: 'encrypted', type: 'toggle', label: 'encrypted', value: chosen.encrypted }] : []),
      ...(chosen.access === 'public' ? [
        { id: 'alias', type: 'text', label: 'Address', prefix: '#', suffix: `:${serverName()}`, value: chosen.alias },
        { id: 'listed', type: 'toggle', label: 'list in directory', value: chosen.listed },
      ] : []),
    ],
  };
}

async function create(kind, { args, options = {} }) {
  requireSession();
  if (!args) throw new Error(`Type a name for the new ${kind}.`);
  const chosen = createOptions(kind, args, options);
  const request = { name: args, access: chosen.access, alias: chosen.alias, listed: chosen.listed, parentSpaceId: chosen.parent || null };
  if (kind === 'space') {
    const { roomId } = await createSpace(request);
    // Its first room next, in it, once sync has brought the space (rooms can only be added to one you're in).
    await joined(roomId);
    return { fill: 'rev/create-room ', options: { parent: roomId }, done: `Created ${args}. Name its first room, or press Esc.` };
  }
  await show((await createRoom({ ...request, encrypted: chosen.encrypted })).roomId);
  return undefined;
}

// ── invite, leave ──
function inviteRows(args) {
  if (!hasSession()) return signedOut();
  const room = openRoom();
  if (!room) return [{ note: 'Open a room to invite someone to it.' }];
  if (!isMatrixId(args)) return [{ note: 'Type their full Matrix ID, such as @name:matrix.org.' }];
  return [{ title: `Invite ${args.trim()}`, sub: `to ${room.name || room.roomId}`, action: 'Invite', value: room.roomId }];
}

async function invite({ args, value }) {
  requireSession();
  const room = roomFor(value);
  if (!room) throw new Error(value ? 'You\u2019re not in that room any more.' : 'Open a room to invite someone to it.');
  if (!isMatrixId(args)) throw new Error('Type their full Matrix ID, such as @name:matrix.org.');
  await inviteToRoom(room.roomId, args.trim());
  return { done: `Invited ${args.trim()}.` };
}

function leaveRows() {
  if (!hasSession()) return signedOut();
  const room = openRoom();
  if (!room) return [{ note: 'Open a room to leave it.' }];
  return [{ title: `Leave ${room.name || room.roomId}`, sub: 'You can rejoin later if the room lets you', action: 'Leave', value: room.roomId, danger: true }];
}

async function leave({ value }) {
  requireSession();
  // The room the row said, even if another opened since it was listed.
  const room = roomFor(value);
  if (!room) throw new Error(value ? 'You\u2019re not in that room any more.' : 'Open a room to leave it.');
  await leaveRoom(room.roomId);
  return { done: `Left ${room.name || 'the room'}.` };
}

// ── notifications ──
// The ping that plays for messages Matrix's push rules say notify you.
// "rev/notifications" offers the other state; "on"/"off" pick one.
const wantedSound = args => (/^(on|off)$/i.test(args) ? args.toLowerCase() === 'on' : !getNotificationSound());

function notificationRows(args) {
  const on = getNotificationSound();
  const wanted = wantedSound(args);
  return [{
    title: `Ping sound ${wanted ? 'on' : 'off'}`,
    sub: wanted === on ? `It’s already ${on ? 'on' : 'off'}` : (wanted ? 'Play a sound for messages that notify you' : 'Stay quiet when messages arrive'),
    action: wanted ? 'Turn on' : 'Turn off',
  }];
}

function notifications({ args }) {
  const wanted = wantedSound(args);
  setNotificationSound(wanted);
  return { done: `Ping sound ${wanted ? 'on' : 'off'}.` };
}

/** Handle every command Matrix Chat declares. Call once, in the background frame. */
export function handleCommands() {
  atmos.commands.handle('go', go, { suggest: ({ args }) => goRows(args) });
  atmos.commands.handle('join', join, { suggest: ({ args }) => joinRows(args) });
  atmos.commands.handle('dm', dm, { suggest: ({ args }) => dmRows(args) });
  atmos.commands.handle('create-room', input => create('room', input), { suggest: input => createSuggestions('room', input) });
  atmos.commands.handle('create-space', input => create('space', input), { suggest: input => createSuggestions('space', input) });
  atmos.commands.handle('notifications', notifications, { suggest: ({ args }) => notificationRows(args) });
  atmos.commands.handle('invite', invite, { suggest: ({ args }) => inviteRows(args) });
  atmos.commands.handle('leave', leave, { suggest: () => leaveRows() });
  // Another account has other spaces.
  onAccountChange(() => { spaceChildren.clear(); publicQuery = ''; publicRooms = []; });
}

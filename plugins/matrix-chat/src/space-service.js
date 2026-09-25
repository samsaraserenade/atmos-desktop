/**
 * Spaces and rooms: what a space contains (joined or not), creating spaces
 * and rooms, joining by address, and invites to rooms and spaces. Direct
 * message requests stay in room-service.js.
 */

const ENCRYPTION = { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } };
const ALIAS_PART = /^[a-z0-9._=\-/]+$/i;

/** The server part of a Matrix ID (@user:server, !room:server, #alias:server). */
export function serverOf(id) {
  const index = String(id || '').indexOf(':');
  return index === -1 ? '' : String(id).slice(index + 1);
}

/**
 * Turn what someone pasted into something to join: #alias:server,
 * !roomid:server, or a matrix.to link to either (with its via= servers).
 */
export function parseRoomAddress(value) {
  let text = String(value || '').trim();
  let via = [];
  const link = text.match(/^https?:\/\/matrix\.to\/#\/([^?]+)(?:\?(.*))?$/i);
  if (link) {
    text = decodeURIComponent(link[1]).split('/')[0];
    via = new URLSearchParams(link[2] || '').getAll('via').filter(Boolean);
  }
  if (!/^[#!][^\s:]+:[^\s]+$/.test(text)) {
    throw new Error('Enter a room address such as #room:matrix.org, or a matrix.to link.');
  }
  return { target: text, via };
}

/** Normalise one room from the space hierarchy API for the views. */
function hierarchyRoom(room, { client, via }) {
  const joined = client.getRoom(room.room_id)?.getMyMembership?.() === 'join';
  return {
    roomId: room.room_id,
    name: room.name || room.canonical_alias || room.room_id,
    topic: room.topic || '',
    alias: room.canonical_alias || '',
    avatarUrl: room.avatar_url || '',
    members: Number(room.num_joined_members) || 0,
    isSpace: room.room_type === 'm.space',
    joinRule: room.join_rule || 'invite',
    joined,
    via: via.get(room.room_id) || [],
  };
}

export function createSpaceService(runtime) {
  const client = runtime.client;

  function requireClient() {
    runtime.assertCurrent();
    if (!client) throw new Error('Sign in first.');
    return client;
  }

  /**
   * One page of a space's direct children, joined or not. `rooms` excludes
   * the space itself; pass `nextBatch` back as `from` for the next page.
   */
  async function getSpaceChildren(spaceId, { from } = {}) {
    const requestClient = requireClient();
    const response = await requestClient.getRoomHierarchy(spaceId, 50, 1, false, from);
    runtime.assertCurrent();
    const rooms = Array.isArray(response?.rooms) ? response.rooms : [];
    const via = new Map();
    for (const room of rooms) {
      for (const child of room.children_state || []) {
        const servers = Array.isArray(child?.content?.via) ? child.content.via : [];
        if (child.state_key && servers.length) via.set(child.state_key, servers);
      }
    }
    return {
      rooms: rooms.filter(room => room.room_id !== spaceId).map(room => hierarchyRoom(room, { client: requestClient, via })),
      nextBatch: response?.next_batch || null,
    };
  }

  /** Join a room found in a space (or anywhere), trying the given servers. */
  async function joinRoom(roomIdOrAlias, via = []) {
    const requestClient = requireClient();
    const servers = [...new Set((Array.isArray(via) ? via : []).filter(Boolean))];
    if (!servers.length && roomIdOrAlias.startsWith('!')) servers.push(serverOf(roomIdOrAlias));
    const room = await requestClient.joinRoom(roomIdOrAlias, servers.length ? { viaServers: servers } : {});
    runtime.assertCurrent();
    return room;
  }

  /** Join by a pasted address or matrix.to link. */
  function joinByAddress(value) {
    const { target, via } = parseRoomAddress(value);
    return joinRoom(target, via);
  }

  /** Whether the signed-in user may add rooms to this space. */
  function canAddToSpace(spaceId) {
    const requestClient = client;
    const space = requestClient?.getRoom(spaceId);
    if (!space || space.getMyMembership?.() !== 'join') return false;
    return space.currentState?.maySendStateEvent?.('m.space.child', requestClient.getUserId()) ?? false;
  }

  function cleanName(value, what) {
    const name = String(value || '').trim();
    if (!name) throw new Error(`Give the ${what} a name.`);
    if (name.length > 255) throw new Error(`The ${what}'s name is too long.`);
    return name;
  }

  function cleanAlias(value) {
    const alias = String(value || '').trim().replace(/^#/, '').replace(/:.*$/, '');
    if (!alias) return '';
    if (!ALIAS_PART.test(alias)) throw new Error('Addresses can use letters, numbers, dots, dashes and underscores.');
    return alias;
  }

  /**
   * Create a room. access: 'private' (invite only), 'space' (anyone in the
   * parent space can join) or 'public' (anyone can join). A room with a
   * parent space is added to it.
   */
  async function createRoom({ name, topic = '', access = 'private', encrypted, alias = '', listed = false, parentSpaceId = null } = {}) {
    const requestClient = requireClient();
    const roomName = cleanName(name, 'room');
    const roomAlias = cleanAlias(alias);
    if (access === 'space' && !parentSpaceId) access = 'private';
    if (!['private', 'space', 'public'].includes(access)) throw new Error('Choose who can join the room.');
    if (access === 'public' && !roomAlias) throw new Error('Public rooms need an address, so people can find them.');
    if (parentSpaceId && !canAddToSpace(parentSpaceId)) throw new Error('You can\'t add rooms to that space.');
    const encrypt = encrypted ?? access !== 'public';
    const server = serverOf(requestClient.getUserId());
    const initialState = [];
    if (encrypt) initialState.push(ENCRYPTION);
    if (parentSpaceId) {
      initialState.push({ type: 'm.space.parent', state_key: parentSpaceId, content: { via: [server], canonical: true } });
    }
    if (access === 'space') {
      initialState.push({
        type: 'm.room.join_rules', state_key: '',
        content: { join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: parentSpaceId }] },
      });
    }
    const result = await requestClient.createRoom({
      name: roomName,
      ...(String(topic).trim() ? { topic: String(topic).trim() } : {}),
      preset: access === 'public' ? 'public_chat' : 'private_chat',
      visibility: access === 'public' && listed ? 'public' : 'private',
      ...(roomAlias && access === 'public' ? { room_alias_name: roomAlias } : {}),
      initial_state: initialState,
    });
    runtime.assertCurrent();
    if (parentSpaceId) await linkToSpace(parentSpaceId, result.room_id, server);
    return { roomId: result.room_id };
  }

  /** Create a space. access: 'private' (invite only) or 'public'. */
  async function createSpace({ name, topic = '', access = 'private', alias = '', listed = false, parentSpaceId = null } = {}) {
    const requestClient = requireClient();
    const spaceName = cleanName(name, 'space');
    const spaceAlias = cleanAlias(alias);
    if (!['private', 'public'].includes(access)) throw new Error('Choose who can join the space.');
    if (access === 'public' && !spaceAlias) throw new Error('Public spaces need an address, so people can find them.');
    if (parentSpaceId && !canAddToSpace(parentSpaceId)) throw new Error('You can\'t add to that space.');
    const server = serverOf(requestClient.getUserId());
    const result = await requestClient.createRoom({
      name: spaceName,
      ...(String(topic).trim() ? { topic: String(topic).trim() } : {}),
      preset: access === 'public' ? 'public_chat' : 'private_chat',
      visibility: access === 'public' && listed ? 'public' : 'private',
      ...(spaceAlias && access === 'public' ? { room_alias_name: spaceAlias } : {}),
      creation_content: { type: 'm.space' },
      // Only moderators post in a space itself; it holds rooms, not chat.
      power_level_content_override: { events_default: 100, invite: access === 'public' ? 0 : 50 },
      initial_state: parentSpaceId
        ? [{ type: 'm.space.parent', state_key: parentSpaceId, content: { via: [server], canonical: true } }]
        : [],
    });
    runtime.assertCurrent();
    if (parentSpaceId) await linkToSpace(parentSpaceId, result.room_id, server);
    return { roomId: result.room_id };
  }

  async function linkToSpace(spaceId, childId, server) {
    await client.sendStateEvent(spaceId, 'm.space.child', { via: [server || serverOf(childId)] }, childId);
    runtime.assertCurrent();
  }

  /** Add an existing room to a space. */
  async function addToSpace(spaceId, roomId) {
    requireClient();
    if (!canAddToSpace(spaceId)) throw new Error('You can\'t add rooms to that space.');
    await linkToSpace(spaceId, roomId, serverOf(client.getUserId()));
  }

  /** Take a room out of a space (the space's link, and the room's link back if you may). */
  async function removeFromSpace(spaceId, roomId) {
    const requestClient = requireClient();
    if (!canAddToSpace(spaceId)) throw new Error('You can\'t change that space\'s rooms.');
    await requestClient.sendStateEvent(spaceId, 'm.space.child', {}, roomId);
    runtime.assertCurrent();
    const room = requestClient.getRoom(roomId);
    const parent = room?.currentState?.getStateEvents?.('m.space.parent', spaceId);
    const linked = parent && Object.keys(parent.getContent?.() || {}).length > 0;
    if (linked && room.currentState.maySendStateEvent?.('m.space.parent', requestClient.getUserId())) {
      // Best effort: the space no longer lists it either way.
      await requestClient.sendStateEvent(roomId, 'm.space.parent', {}, spaceId).catch(() => {});
      runtime.assertCurrent();
    }
  }

  /** Invite someone to a room or space you're in. */
  async function inviteToRoom(roomId, userId) {
    const requestClient = requireClient();
    const target = String(userId || '').trim();
    if (!/^@[^\s:]+:[^\s]+$/.test(target)) throw new Error('Enter their full Matrix ID, such as @name:matrix.org.');
    if (target === requestClient.getUserId()) throw new Error('You\'re already here.');
    await requestClient.invite(roomId, target);
    runtime.assertCurrent();
  }

  /** What you may change in a room or space: its name and its icon. */
  function roomPermissions(roomId) {
    const room = client?.getRoom(roomId);
    const userId = client?.getUserId();
    const may = type => room?.getMyMembership?.() === 'join'
      && (room.currentState?.maySendStateEvent?.(type, userId) ?? false);
    return { name: may('m.room.name'), avatar: may('m.room.avatar') };
  }

  async function setRoomName(roomId, name) {
    const requestClient = requireClient();
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Give it a name.');
    if (clean.length > 255) throw new Error('That name is too long.');
    await requestClient.setRoomName(roomId, clean);
    runtime.assertCurrent();
  }

  /** Upload an image ({ bytes, type, name }) and make it the room's icon. */
  async function setRoomAvatar(roomId, image) {
    const requestClient = requireClient();
    const bytes = image?.bytes;
    const type = String(image?.type || '');
    if (!bytes?.length) throw new Error('That image is empty.');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Choose an image of 10 MB or less.');
    const uploaded = await requestClient.uploadContent(new Blob([bytes], { type }), {
      name: String(image?.name || 'icon'), type, abortController: runtime.controller,
    });
    runtime.assertCurrent();
    const url = typeof uploaded === 'string' ? uploaded : uploaded?.content_uri;
    if (!url) throw new Error('The upload didn\'t return an address.');
    await requestClient.sendStateEvent(roomId, 'm.room.avatar', { url }, '');
    runtime.assertCurrent();
  }

  async function removeRoomAvatar(roomId) {
    const requestClient = requireClient();
    await requestClient.sendStateEvent(roomId, 'm.room.avatar', {}, '');
    runtime.assertCurrent();
  }

  /** Invites to rooms and spaces (not direct message requests). */
  function getInvites(directRoomIds = new Set()) {
    if (!client || runtime.signal?.aborted) return [];
    return client.getRooms()
      .filter(room => room.getMyMembership?.() === 'invite' && !directRoomIds.has(room.roomId))
      .map(room => {
        const member = room.currentState?.getStateEvents?.('m.room.member', client.getUserId());
        const inviter = member?.getSender?.() || '';
        return {
          roomId: room.roomId,
          name: room.name || room.roomId,
          isSpace: room.isSpaceRoom?.() === true,
          inviter,
          inviterName: room.getMember?.(inviter)?.name || inviter,
        };
      });
  }

  async function acceptInvite(roomId) {
    const requestClient = requireClient();
    const room = await requestClient.joinRoom(roomId);
    runtime.assertCurrent();
    return room;
  }

  async function declineInvite(roomId) {
    const requestClient = requireClient();
    await requestClient.leave(roomId);
    runtime.assertCurrent();
  }

  return {
    getSpaceChildren, joinRoom, joinByAddress, canAddToSpace, createRoom, createSpace,
    addToSpace, removeFromSpace, inviteToRoom, roomPermissions, setRoomName, setRoomAvatar, removeRoomAvatar,
    getInvites, acceptInvite, declineInvite,
  };
}

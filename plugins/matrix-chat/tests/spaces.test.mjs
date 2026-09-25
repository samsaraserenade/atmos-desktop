import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceService, parseRoomAddress, serverOf } from '../src/space-service.js';

function setup({ canAdd = true } = {}) {
  const created = [];
  const stateEvents = [];
  const joins = [];
  const rooms = new Map();
  let retired = false;
  const space = {
    roomId: '!space:example.org',
    getMyMembership: () => 'join',
    currentState: { maySendStateEvent: () => canAdd },
  };
  rooms.set(space.roomId, space);
  const client = {
    getUserId: () => '@me:example.org',
    getRoom: id => rooms.get(id),
    getRooms: () => [...rooms.values()],
    createRoom: async options => { created.push(options); return { room_id: `!new${created.length}:example.org` }; },
    sendStateEvent: async (...args) => { stateEvents.push(args); },
    joinRoom: async (id, opts) => { joins.push([id, opts]); return { roomId: id }; },
    leave: async () => {},
    invite: async (...args) => { stateEvents.push(['invite', ...args]); },
    setRoomName: async (...args) => { stateEvents.push(['name', ...args]); },
    uploadContent: async (blob, opts) => { stateEvents.push(['upload', blob.type, opts.name]); return { content_uri: 'mxc://example.org/icon' }; },
    getRoomHierarchy: async () => ({
      rooms: [
        { room_id: space.roomId, name: 'Space', room_type: 'm.space', children_state: [
          { state_key: '!a:example.org', content: { via: ['example.org'] } },
          { state_key: '!b:other.org', content: { via: ['other.org', 'example.org'] } },
        ] },
        { room_id: '!a:example.org', name: 'General', num_joined_members: 12, join_rule: 'restricted' },
        { room_id: '!b:other.org', canonical_alias: '#sub:other.org', room_type: 'm.space' },
      ],
      next_batch: 'next',
    }),
  };
  rooms.set('!a:example.org', { roomId: '!a:example.org', getMyMembership: () => 'join' });
  const runtime = { client, signal: { aborted: false }, assertCurrent() { if (retired) throw new Error('Session changed'); } };
  const service = createSpaceService(runtime);
  return { service, created, stateEvents, joins, rooms, space, retire: () => { retired = true; } };
}

test('lists a space\'s children, joined or not, with the servers to join through', async () => {
  const s = setup();
  const { rooms, nextBatch } = await s.service.getSpaceChildren(s.space.roomId);
  assert.equal(nextBatch, 'next');
  assert.deepEqual(rooms.map(room => [room.roomId, room.name, room.joined, room.isSpace]), [
    ['!a:example.org', 'General', true, false],
    ['!b:other.org', '#sub:other.org', false, true],
  ]);
  assert.deepEqual(rooms[1].via, ['other.org', 'example.org']);
  assert.equal(rooms[0].members, 12);
});

test('creates an encrypted room that space members can join, and links it to the space', async () => {
  const s = setup();
  const { roomId } = await s.service.createRoom({ name: ' Plans ', access: 'space', parentSpaceId: s.space.roomId });
  const options = s.created[0];
  assert.equal(options.name, 'Plans');
  assert.equal(options.preset, 'private_chat');
  const types = options.initial_state.map(event => event.type);
  assert.deepEqual(types, ['m.room.encryption', 'm.space.parent', 'm.room.join_rules']);
  assert.equal(options.initial_state[2].content.join_rule, 'restricted');
  assert.deepEqual(s.stateEvents[0], [s.space.roomId, 'm.space.child', { via: ['example.org'] }, roomId]);
});

test('public rooms need an address, are unencrypted, and are listed only when asked', async () => {
  const s = setup();
  await assert.rejects(s.service.createRoom({ name: 'Open', access: 'public' }), /address/);
  await s.service.createRoom({ name: 'Open', access: 'public', alias: '#open-chat:example.org', listed: true });
  const options = s.created[0];
  assert.equal(options.room_alias_name, 'open-chat');
  assert.equal(options.visibility, 'public');
  assert.equal(options.initial_state.length, 0);
});

test('creates a space whose own timeline only moderators post in', async () => {
  const s = setup();
  await s.service.createSpace({ name: 'Friends' });
  assert.deepEqual(s.created[0].creation_content, { type: 'm.space' });
  assert.equal(s.created[0].power_level_content_override.events_default, 100);
  await assert.rejects(s.service.createSpace({ name: '' }), /name/);
});

test('refuses to add to a space without permission, before creating anything', async () => {
  const s = setup({ canAdd: false });
  await assert.rejects(s.service.createRoom({ name: 'X', parentSpaceId: s.space.roomId }), /can't add/);
  assert.equal(s.created.length, 0);
});

test('joins by alias, room ID or matrix.to link', async () => {
  assert.deepEqual(parseRoomAddress(' #room:matrix.org '), { target: '#room:matrix.org', via: [] });
  assert.deepEqual(parseRoomAddress('https://matrix.to/#/!abc:x.org?via=x.org&via=y.org'), { target: '!abc:x.org', via: ['x.org', 'y.org'] });
  assert.throws(() => parseRoomAddress('room'), /room address/);
  assert.equal(serverOf('@me:example.org:8448'), 'example.org:8448');
  const s = setup();
  await s.service.joinByAddress('!abc:x.org');
  assert.deepEqual(s.joins[0], ['!abc:x.org', { viaServers: ['x.org'] }]);
});

test('lists room and space invites but not direct message requests', () => {
  const s = setup();
  const invite = (roomId, isSpace) => ({
    roomId, name: roomId, getMyMembership: () => 'invite', isSpaceRoom: () => isSpace,
    currentState: { getStateEvents: () => ({ getSender: () => '@friend:example.org' }) },
    getMember: () => ({ name: 'Friend' }),
  });
  s.rooms.set('!dm', invite('!dm', false));
  s.rooms.set('!group', invite('!group', false));
  s.rooms.set('!team', invite('!team', true));
  const invites = s.service.getInvites(new Set(['!dm']));
  assert.deepEqual(invites.map(item => [item.roomId, item.isSpace, item.inviterName]), [['!group', false, 'Friend'], ['!team', true, 'Friend']]);
});

test('retired sessions reject new work', async () => {
  const s = setup();
  s.retire();
  await assert.rejects(s.service.createSpace({ name: 'Late' }), /Session changed/);
  assert.equal(s.created.length, 0);
});

test('invites by full Matrix ID only', async () => {
  const s = setup();
  await assert.rejects(s.service.inviteToRoom('!a:example.org', 'rin'), /full Matrix ID/);
  await assert.rejects(s.service.inviteToRoom('!a:example.org', '@me:example.org'), /already here/);
  await s.service.inviteToRoom('!a:example.org', ' @rin:matrix.org ');
  assert.deepEqual(s.stateEvents.at(-1), ['invite', '!a:example.org', '@rin:matrix.org']);
});

test('renames and changes icons only with a name and a supported image', async () => {
  const s = setup();
  assert.deepEqual(s.service.roomPermissions(s.space.roomId), { name: true, avatar: true });
  assert.deepEqual(s.service.roomPermissions('!unknown'), { name: false, avatar: false });
  await assert.rejects(s.service.setRoomName(s.space.roomId, '   '), /name/);
  await s.service.setRoomName(s.space.roomId, ' Atmos ');
  assert.deepEqual(s.stateEvents.at(-1), ['name', s.space.roomId, 'Atmos']);
  await assert.rejects(s.service.setRoomAvatar(s.space.roomId, { bytes: new Uint8Array([1]), type: 'text/plain' }), /PNG/);
  await assert.rejects(s.service.setRoomAvatar(s.space.roomId, { bytes: new Uint8Array(), type: 'image/png' }), /empty/);
  await s.service.setRoomAvatar(s.space.roomId, { bytes: new Uint8Array([1, 2]), type: 'image/png', name: 'icon.png' });
  assert.deepEqual(s.stateEvents.slice(-2), [
    ['upload', 'image/png', 'icon.png'],
    [s.space.roomId, 'm.room.avatar', { url: 'mxc://example.org/icon' }, ''],
  ]);
  await s.service.removeRoomAvatar(s.space.roomId);
  assert.deepEqual(s.stateEvents.at(-1), [s.space.roomId, 'm.room.avatar', {}, '']);
});

test('removes a room from a space, and the room\'s link back when it can', async () => {
  const s = setup();
  const parent = { getContent: () => ({ via: ['example.org'] }) };
  s.rooms.set('!a:example.org', {
    roomId: '!a:example.org', getMyMembership: () => 'join',
    currentState: { getStateEvents: () => parent, maySendStateEvent: () => true },
  });
  await s.service.removeFromSpace(s.space.roomId, '!a:example.org');
  assert.deepEqual(s.stateEvents.slice(-2), [
    [s.space.roomId, 'm.space.child', {}, '!a:example.org'],
    ['!a:example.org', 'm.space.parent', {}, s.space.roomId],
  ]);
  const locked = setup({ canAdd: false });
  await assert.rejects(locked.service.removeFromSpace(locked.space.roomId, '!a:example.org'), /can't change/);
});

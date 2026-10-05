// Stand-in for src/ui/engine.js in tests/command-handlers.test.mjs: a
// signed-in account with a space, rooms and a chat, and what was asked of it.
export const world = {};
const call = (name, ...args) => world.calls.push([name, ...args]);
const accountListeners = new Set();

/** A room as matrix-js-sdk gives it, as far as the handlers look. */
export function room(roomId, name, { space = false, membership = 'join', members = [], children = [] } = {}) {
  return {
    roomId,
    name,
    getMyMembership: () => membership,
    isSpaceRoom: () => space,
    getJoinedMembers: () => members.map(([userId, memberName]) => ({ userId, name: memberName })),
    currentState: {
      getStateEvents: type => (type === 'm.space.child'
        ? children.map(id => ({ getStateKey: () => id, getContent: () => ({ via: ['example.org'] }) }))
        : []),
    },
  };
}

/** The account as each test starts: Atmos (a space) with General in it, Random, and a chat with Rin. */
export function reset() {
  Object.assign(world, {
    session: true,
    userId: '@me:example.org',
    rooms: [
      room('!space:example.org', 'Atmos', { space: true, children: ['!general:example.org', '!lobby:example.org'] }),
      room('!general:example.org', 'General'),
      room('!random:example.org', 'Random'),
      room('!dm-rin:example.org', 'Rin and me', { members: [['@me:example.org', 'Me'], ['@rin:example.org', 'Rin']] }),
      room('!old:example.org', 'Left long ago', { membership: 'leave' }),
    ],
    direct: new Set(['!dm-rin:example.org']),
    addable: new Set(['!space:example.org']),
    view: { type: 'none' },
    sound: true,
    children: {
      '!space:example.org': [
        { roomId: '!general:example.org', name: 'General', topic: '', members: 5, via: ['example.org'], joinRule: 'restricted', isSpace: false },
        { roomId: '!lobby:example.org', name: 'Lobby', topic: 'Say hi', members: 3, via: ['example.org'], joinRule: 'restricted', isSpace: false },
        { roomId: '!secret:example.org', name: 'Secret', topic: '', members: 2, via: ['example.org'], joinRule: 'invite', isSpace: false },
      ],
    },
    publicRooms: [{ room_id: '!hq:matrix.org', name: 'Matrix HQ', canonical_alias: '#matrix:matrix.org', num_joined_members: 42, topic: 'The Matrix' }],
    calls: [],
  });
  // Another account: the handlers forget what they fetched for this one.
  for (const fn of [...accountListeners]) fn({ userId: world.userId });
}
reset();

export const hasSession = () => world.session;
export const getUserId = () => (world.session ? world.userId : null);
export const getRooms = () => world.rooms;
export const getDirectRoomIds = () => world.direct;
export const canAddToSpace = spaceId => world.addable.has(spaceId);
export const currentView = () => world.view;
export const showRoom = roomId => { call('showRoom', roomId); world.view = { type: 'room', roomId }; };
export const getNotificationSound = () => world.sound;
export const setNotificationSound = on => { call('setNotificationSound', on); world.sound = on; };
export const getSpaceChildren = async spaceId => { call('getSpaceChildren', spaceId); return { rooms: world.children[spaceId] || [], nextBatch: null }; };
export const browsePublicRooms = async options => { call('browsePublicRooms', options); return world.publicRooms; };
export const joinSpaceRoom = async (roomId, via) => { call('joinSpaceRoom', roomId, via); return { roomId }; };
export const joinByAddress = async address => { call('joinByAddress', address); return { roomId: '!joined:example.org' }; };
export const joinPublicRoom = async target => { call('joinPublicRoom', target); return { roomId: '!hq:matrix.org' }; };
export const addFriend = async userId => { call('addFriend', userId); return { roomId: '!dm-new:example.org' }; };
export const createRoom = async request => { call('createRoom', request); return { roomId: '!new-room:example.org' }; };
export const createSpace = async request => {
  call('createSpace', request);
  // Sync brings the new space a moment later.
  setTimeout(() => {
    world.rooms.push(room('!new-space:example.org', request.name, { space: true }));
    world.addable.add('!new-space:example.org');
  }, 200);
  return { roomId: '!new-space:example.org' };
};
export const inviteToRoom = async (roomId, userId) => { call('inviteToRoom', roomId, userId); };
export const leaveRoom = async roomId => { call('leaveRoom', roomId); };
export const onAccountChange = fn => { accountListeners.add(fn); return () => accountListeners.delete(fn); };

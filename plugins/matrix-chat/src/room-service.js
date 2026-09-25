export function createRoomService(runtime, emit) {
  const client = runtime.client;
  const friendRooms = new Map();
  let friendQueue = Promise.resolve();

  function addFriend(value) {
    const operation = friendQueue.then(async () => {
      runtime.assertCurrent();
      if (!client) throw new Error('Sign in before adding a friend.');
      const userId = String(value || '').trim();
      if (!/^@[^\s:]+:[^\s]+$/.test(userId)) throw new Error('Enter a full Matrix ID, such as @name:matrix.org.');
      if (userId === client.getUserId()) throw new Error('Enter your friend’s Matrix ID, rather than your own.');
      const direct = client.getAccountData('m.direct')?.getContent() || {};
      const existing = (Array.isArray(direct[userId]) ? direct[userId] : [])
        .map(id => client.getRoom(id)).find(room => room?.getMyMembership() === 'join');
      const cachedId = friendRooms.get(userId);
      const cachedRoom = cachedId && client.getRoom(cachedId);
      if (cachedRoom && cachedRoom.getMyMembership() !== 'join') friendRooms.delete(userId);
      let roomId = existing?.roomId || friendRooms.get(userId);
      if (!roomId) {
        const result = await client.createRoom({
          invite: [userId], is_direct: true, preset: 'trusted_private_chat',
          initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
        });
        runtime.assertCurrent();
        roomId = result.room_id;
        friendRooms.set(userId, roomId);
      }
      const latest = { ...(client.getAccountData('m.direct')?.getContent() || {}) };
      latest[userId] = [...new Set([...(Array.isArray(latest[userId]) ? latest[userId] : []), roomId])];
      await client.setAccountData('m.direct', latest);
      runtime.assertCurrent();
      return { roomId, existing: Boolean(existing) };
    });
    friendQueue = operation.catch(() => {});
    return operation;
  }
  function getDirectRoomIds() {
    if (!client) return new Set();
    const content = client.getAccountData('m.direct')?.getContent() || {};
    const ids = new Set();
    for (const roomIds of Object.values(content)) {
      if (!Array.isArray(roomIds)) continue;
      for (const id of roomIds) ids.add(id);
    }
    for (const room of client.getRooms()) {
      if (room.getDMInviter?.()) ids.add(room.roomId);
    }
    return ids;
  }

  /** Save the incoming DM classification before joining, while invite state exists. */
  async function acceptDirectRequest(roomId) {
    const requestClient = client;
    if (!requestClient) throw new Error('No active account');
    const room = requestClient.getRoom(roomId);
    if (room?.getMyMembership() !== 'invite') throw new Error('This request is no longer pending');
    const inviter = room.getDMInviter?.()
      || room.currentState.getStateEvents('m.room.member', requestClient.getUserId())?.getSender();
    if (!inviter) throw new Error('Unable to identify the sender');
    const direct = { ...(requestClient.getAccountData('m.direct')?.getContent() || {}) };
    direct[inviter] = [...new Set([...(Array.isArray(direct[inviter]) ? direct[inviter] : []), roomId])];
    await requestClient.setAccountData('m.direct', direct);
    runtime.assertCurrent();
    return requestClient.joinRoom(roomId);
  }

  const readMarkerStates = new WeakMap();

  /** Mark every currently loaded event in `room` as read, both locally and on
   *  the homeserver. Local notification counters are cleared immediately so the
   *  sidebar responds without waiting for the next sync/receipt round trip. */
  function markRoomRead(room) {
    if (!client || !room || client.getRoom(room.roomId) !== room) return Promise.resolve();
    const requestClient = client;

    const events = room.getLiveTimeline()?.getEvents() || [];
    let latest = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const candidate = events[i];
      const eventId = candidate?.getId?.();
      if (!eventId || room.hasPendingEvent?.(eventId)) continue;
      latest = candidate;
      break;
    }

    room.setUnreadNotificationCount?.('total', 0);
    room.setUnreadNotificationCount?.('highlight', 0);
    emit('unread', room);
    if (!latest) return Promise.resolve();

    let stateForRoom = readMarkerStates.get(room);
    if (!stateForRoom) {
      stateForRoom = { wanted: null, sentId: null, running: null };
      readMarkerStates.set(room, stateForRoom);
    }
    stateForRoom.wanted = latest;
    if (stateForRoom.running) return stateForRoom.running;

    stateForRoom.running = (async () => {
      try {
        while (stateForRoom.wanted?.getId?.() !== stateForRoom.sentId) {
          runtime.assertCurrent();
          const target = stateForRoom.wanted;
          await requestClient.setRoomReadMarkers(room.roomId, target.getId(), target);
          stateForRoom.sentId = target.getId();
        }
      } finally {
        stateForRoom.running = null;
      }
    })();
    return stateForRoom.running;
  }


  return { getDirectRoomIds, acceptDirectRequest, markRoomRead, addFriend };
}

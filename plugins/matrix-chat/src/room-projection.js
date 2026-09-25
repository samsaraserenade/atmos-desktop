export const DIRECT_ENTRY_ID = '__direct__';

export function buildRoomEntries(rooms, directRoomIds) {
  const requests = rooms.filter(r => r.getMyMembership?.() === 'invite' && directRoomIds.has(r.roomId));
  rooms = rooms.filter(r => r.getMyMembership?.() === 'join');
  const spaces = rooms.filter((r) => typeof r.isSpaceRoom === 'function' && r.isSpaceRoom());
  const spaceIds = new Set(spaces.map((s) => s.roomId));
  const roomsById = new Map(rooms.map((r) => [r.roomId, r]));

  // Rooms claimed by at least one space, so the orphan pass below can
  // skip them. A room can legitimately appear under more than one
  // space (Matrix doesn't require space membership to be exclusive), so
  // this only tracks "claimed at all", not by which one.
  const claimedRoomIds = new Set();

  const spaceEntries = spaces.map((space) => {
    // m.space.child is the real link, one state event per child room
    // id; an empty `via` means the link was removed (a tombstoned
    // state event, not an actual child — same pattern the SDK uses
    // elsewhere for "this state event exists but no longer applies").
    const childEvents = space.currentState?.getStateEvents('m.space.child') || [];
    const channels = [];
    for (const ev of childEvents) {
      const content = typeof ev.getContent === 'function' ? ev.getContent() : {};
      if (!content.via || content.via.length === 0) continue;
      const childId = typeof ev.getStateKey === 'function' ? ev.getStateKey() : ev.state_key;
      const child = roomsById.get(childId);
      // Unknown room (not joined / not yet synced) or a subspace
      // (shown as its own rail entry instead, per the phase-1 note
      // above) — either way, not a channel row here.
      if (!child || spaceIds.has(childId)) continue;
      channels.push(child);
      claimedRoomIds.add(childId);
    }
    return {
      id: space.roomId,
      name: space.name || space.roomId,
      iconRoom: space,
      channels,
    };
  });

  // Every room nothing above claimed splits into DMs (collapsed into
  // one shared synthetic entry — see this file's header comment) and
  // everything else (each gets its own pseudo-space rail icon, same as
  // a real space). directEntry's iconRoom is deliberately null: there's
  // no single room it represents, so railItemHtml/hydrateAvatars render
  // a fixed generic glyph instead of a per-room hue swatch for it.
  // Omitted entirely (not rendered as an empty pane) when there are no
  // DMs at all, same "don't show a slot with nothing behind it"
  // reasoning as the rest of the rail.
  const orphanRooms = rooms.filter((r) => !spaceIds.has(r.roomId) && !claimedRoomIds.has(r.roomId));
  const dmRooms = orphanRooms.filter((r) => directRoomIds.has(r.roomId));
  const soloRooms = orphanRooms.filter((r) => !directRoomIds.has(r.roomId));

  const directEntry = dmRooms.length === 0 && requests.length === 0 ? [] : [{
    id: DIRECT_ENTRY_ID,
    name: 'Direct Messages',
    iconRoom: null,
    channels: dmRooms,
    requests,
  }];

  // Non-DM orphans (a group room joined outside any space) each get
  // their own single-channel pseudo-space entry — same shape as
  // spaceEntries above, just with a single-room channel list — so they
  // show up in the rail like any other server rather than disappearing
  // into Direct Messages, which is for actual DMs only.
  const soloRoomEntries = soloRooms.map((room) => ({
    id: room.roomId,
    name: room.name || room.roomId,
    iconRoom: room,
    channels: [room],
  }));

  // Direct Messages pinned first, ahead of every real space — same rail
  // position as Discord's own Home/DM button. Solo pseudo-space rooms
  // trail after the real spaces; there's no Home-button-style reason
  // for them to jump the queue.
  return [...directEntry, ...spaceEntries, ...soloRoomEntries];
}


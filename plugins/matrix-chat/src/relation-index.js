// Weak room keys and shared MatrixEvent references avoid copying timeline data.
// A mutation invalidates one index; the next lookup rebuilds it once for all rows.
let indexes = new WeakMap();
export function clearRelationIndexes() { indexes = new WeakMap(); }
export function invalidateRoomRelations(room) { if (room) indexes.delete(room); }

export function relationsForEvent(room, eventId, relationType) {
  const timeline = room.getLiveTimeline();
  const events = timeline?.getEvents() || [];
  let index = indexes.get(room);
  if (!index || index.timeline !== timeline || index.length !== events.length
      || index.first !== events[0] || index.last !== events.at(-1)) {
    index = { timeline, length: events.length, first: events[0], last: events.at(-1), targets: new Map() };
    for (const event of events) {
      const type = event.getType();
      if (type !== 'm.reaction' && type !== 'm.room.message') continue;
      if (event.isRedacted?.()) continue;
      const relation = event.getContent()?.['m.relates_to'];
      if (!relation?.event_id) continue;
      const kind = type === 'm.reaction' && relation.rel_type === 'm.annotation' ? 'm.annotation'
        : type === 'm.room.message' && relation.rel_type === 'm.replace' ? 'm.replace' : null;
      if (!kind) continue;
      let target = index.targets.get(relation.event_id);
      if (!target) { target = new Map(); index.targets.set(relation.event_id, target); }
      let bucket = target.get(kind);
      if (!bucket) { bucket = []; target.set(kind, bucket); }
      bucket.push(event);
    }
    indexes.set(room, index);
  }
  return index.targets.get(eventId)?.get(relationType) || [];
}

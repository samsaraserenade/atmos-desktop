import assert from 'node:assert/strict';
import { createRoomService } from '../src/room-service.js';
import { buildRoomEntries } from '../src/room-projection.js';

let membership = 'invite';
let saved = { '@existing:server': ['!existing'] };
const calls = [];
const request = { roomId: '!request', name: 'Alice', getMyMembership: () => membership, getDMInviter: () => '@alice:server' };
const sdk = {
  getRooms: () => [request], getRoom: () => request,
  getAccountData: () => ({ getContent: () => saved }),
  setAccountData: async (type, content) => { calls.push(type); saved = content; },
  joinRoom: async () => { calls.push('join'); membership = 'join'; return request; },
};
const runtime = { client: sdk, assertCurrent() {} };
const service = createRoomService(runtime, () => {});
const entriesForRequest = () => buildRoomEntries([request], service.getDirectRoomIds());
let entries = entriesForRequest();
assert.equal(entries[0].id, '__direct__');
assert.equal(entries[0].requests.length, 1);
assert.equal(entries[0].channels.length, 0);
await service.acceptDirectRequest("!request");
assert.deepEqual(calls, ['m.direct', 'join']);
assert.equal(saved['@existing:server'][0], '!existing');
assert.equal(saved['@alice:server'][0], '!request');
entries = entriesForRequest();
assert.equal(entries[0].requests.length, 0);
assert.equal(entries[0].channels.length, 1);
membership = 'leave';
assert.equal(entriesForRequest().length, 0);
membership = 'invite';
sdk.setAccountData = async () => { throw new Error('offline'); };
await assert.rejects(service.acceptDirectRequest("!request"), /offline/);
assert.equal(membership, 'invite');
assert.equal(calls.filter(call => call === 'join').length, 1);

const readMarkerCalls = [];
const unreadChanges = [];
const messageEvent = { getId: () => '$latest' };
const readRoom = {
  roomId: '!read',
  getLiveTimeline: () => ({ getEvents: () => [messageEvent] }),
  hasPendingEvent: () => false,
  setUnreadNotificationCount: (type, count) => unreadChanges.push([type, count]),
};
const readClient = {
  getRoom: roomId => roomId === readRoom.roomId ? readRoom : null,
  setRoomReadMarkers: async (...args) => { readMarkerCalls.push(args); },
};
const readService = createRoomService({ client: readClient, assertCurrent() {} }, (...args) => unreadChanges.push(args));
await readService.markRoomRead(readRoom);
assert.deepEqual(unreadChanges.slice(0, 2), [['total', 0], ['highlight', 0]]);
assert.equal(readMarkerCalls.length, 1);
assert.equal(readMarkerCalls[0][0], '!read');
assert.equal(readMarkerCalls[0][1], '$latest');
await readService.markRoomRead(readRoom);
assert.equal(readMarkerCalls.length, 1, 'unchanged latest event does not resend its read marker');

console.log('DM request/read-marker checks passed');

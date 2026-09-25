import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomService } from '../src/room-service.js';

function setup() {
  let direct = { '@other:example.org': ['!other'] };
  const calls = [];
  const rooms = new Map();
  let retired = false;
  const client = {
    getUserId: () => '@me:example.org',
    getAccountData: () => ({ getContent: () => direct }),
    getRoom: id => rooms.get(id),
    createRoom: async options => { calls.push(options); return { room_id: '!new' }; },
    setAccountData: async (type, content) => { direct = content; },
  };
  const service = createRoomService({ client, assertCurrent() { if (retired) throw new Error('Session changed'); } }, () => {});
  return { service, client, calls, rooms, direct: () => direct, retire: () => { retired = true; } };
}

test('invites a friend to an encrypted DM and preserves other direct rooms', async () => {
  const s = setup();
  await s.service.addFriend(' @friend:example.org ');
  assert.deepEqual(s.calls[0].invite, ['@friend:example.org']);
  assert.equal(s.calls[0].is_direct, true);
  assert.equal(s.calls[0].initial_state[0].content.algorithm, 'm.megolm.v1.aes-sha2');
  assert.deepEqual(s.direct(), { '@other:example.org': ['!other'], '@friend:example.org': ['!new'] });
});

test('reuses joined conversations and avoids duplicate invites before sync', async () => {
  const s = setup();
  s.rooms.set('!other', { roomId: '!other', getMyMembership: () => 'join' });
  assert.equal((await s.service.addFriend('@other:example.org')).existing, true);
  await Promise.all([s.service.addFriend('@friend:example.org'), s.service.addFriend('@friend:example.org')]);
  assert.equal(s.calls.length, 1);
});

test('rejects invalid IDs, self invites, and retired sessions', async () => {
  const s = setup();
  await assert.rejects(s.service.addFriend('friend'), /full Matrix ID/);
  await assert.rejects(s.service.addFriend('@me:example.org'), /own/);
  s.retire();
  await assert.rejects(s.service.addFriend('@friend:example.org'), /Session changed/);
  assert.equal(s.calls.length, 0);
});

test('retrying an account-data failure does not send another invitation', async () => {
  const s = setup();
  const save = s.client.setAccountData;
  s.client.setAccountData = async () => { throw new Error('Offline'); };
  await assert.rejects(s.service.addFriend('@friend:example.org'), /Offline/);
  s.client.setAccountData = save;
  await s.service.addFriend('@friend:example.org');
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.direct()['@friend:example.org'], ['!new']);
});

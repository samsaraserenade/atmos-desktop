import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createTrustService, describeShield, SHIELD_COLOUR, SHIELD_REASON_TEXT } from '../src/trust-service.js';

const sdkSource = fs.readFileSync(new URL('../node_modules/matrix-js-sdk/src/crypto-api/index.ts', import.meta.url), 'utf8');
const enumMembers = name => {
  const body = new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(sdkSource)[1];
  return body.split('\n').map(line => line.trim()).filter(line => /^[A-Z_]+,?$/.test(line)).map(line => line.replace(',', ''));
};

test('shield enums match the SDK we ship', () => {
  assert.deepEqual(enumMembers('EventShieldColour'), Object.keys(SHIELD_COLOUR));
  assert.deepEqual(enumMembers('EventShieldReason'), ['UNKNOWN', 'UNVERIFIED_IDENTITY', 'UNSIGNED_DEVICE', 'UNKNOWN_DEVICE', 'AUTHENTICITY_NOT_GUARANTEED', 'MISMATCHED_SENDER_KEY', 'SENT_IN_CLEAR', 'VERIFICATION_VIOLATION', 'MISMATCHED_SENDER']);
  assert.equal(SHIELD_REASON_TEXT.length, 9);
});

test('shields become warnings; none stays silent', () => {
  assert.equal(describeShield(null), null);
  assert.equal(describeShield({ shieldColour: 0, shieldReason: null }), null);
  assert.deepEqual(describeShield({ shieldColour: 2, shieldReason: 3 }), { level: 'danger', text: 'Sent from an unknown or deleted device.' });
  assert.equal(describeShield({ shieldColour: 1, shieldReason: 4 }).level, 'warning');
});

function service({ encrypted = true, roomEncrypted = true, info = null, statuses = {} } = {}) {
  const calls = [];
  const crypto = {
    isEncryptionEnabledInRoom: async () => roomEncrypted,
    getEncryptionInfoForEvent: async () => info,
    getUserVerificationStatus: async userId => statuses[userId] || { needsUserApproval: false },
    pinCurrentUserIdentity: async userId => calls.push(['pin', userId]),
    withdrawVerificationRequirement: async userId => calls.push(['withdraw', userId]),
  };
  const client = { getCrypto: () => crypto, getUserId: () => '@me:x' };
  const event = (extra = {}) => ({
    status: null, getType: () => 'm.room.message', getRoomId: () => '!r:x', isEncrypted: () => encrypted,
    isDecryptionFailure: () => false, isRedacted: () => false, isState: () => false, ...extra,
  });
  return { trust: createTrustService({ client, assertCurrent() {} }), event, calls };
}

test('an unencrypted message in an encrypted room is flagged; elsewhere it is not', async () => {
  const flagged = service({ encrypted: false, roomEncrypted: true });
  assert.equal((await flagged.trust.eventTrust(flagged.event())).level, 'danger');
  const plain = service({ encrypted: false, roomEncrypted: false });
  assert.equal(await plain.trust.eventTrust(plain.event()), null);
});

test('encrypted messages use the SDK verdict; pending, state and failed ones are skipped', async () => {
  const { trust, event } = service({ info: { shieldColour: 2, shieldReason: 2 } });
  assert.match((await trust.eventTrust(event())).text, /hasn't verified/);
  assert.equal(await trust.eventTrust(event({ status: 'sending' })), null);
  assert.equal(await trust.eventTrust(event({ isState: () => true })), null);
  assert.equal(await trust.eventTrust(event({ isDecryptionFailure: () => true })), null);
  assert.equal(await trust.eventTrust(event({ getType: () => 'm.reaction' })), null);
});

test('identity changes: listed, and accepting pins or withdraws as appropriate', async () => {
  const statuses = {
    '@changed:x': { needsUserApproval: true, wasCrossSigningVerified: () => false, isCrossSigningVerified: () => false },
    '@was-verified:x': { needsUserApproval: true, wasCrossSigningVerified: () => true, isCrossSigningVerified: () => false },
  };
  const { trust, calls } = service({ statuses });
  const room = { getJoinedMembers: () => [{ userId: '@me:x' }, { userId: '@fine:x', name: 'Fine' }, { userId: '@changed:x', name: 'Changed' }, { userId: '@was-verified:x', name: 'Was' }] };
  assert.deepEqual(await trust.identityChanges(room), [
    { userId: '@changed:x', name: 'Changed', wasVerified: false },
    { userId: '@was-verified:x', name: 'Was', wasVerified: true },
  ]);
  await trust.acceptIdentityChange('@changed:x');
  await trust.acceptIdentityChange('@was-verified:x');
  assert.deepEqual(calls, [['pin', '@changed:x'], ['withdraw', '@was-verified:x']]);
});

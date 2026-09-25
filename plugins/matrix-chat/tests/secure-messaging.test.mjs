import assert from 'node:assert/strict';
import test from 'node:test';
import { createCryptoService } from '../src/crypto-service.js';

function setup({ hasServerKeys = false, cached = {}, secretStorageReady = false, backup = null, uploadError = null } = {}) {
  const holder = { key: null };
  const calls = [];
  const crypto = {
    userHasCrossSigningKeys: async (userId, download) => { calls.push(['hasKeys', userId, download]); return hasServerKeys; },
    getCrossSigningStatus: async () => ({ privateKeysCachedLocally: cached }),
    isSecretStorageReady: async () => secretStorageReady,
    createRecoveryKeyFromPassphrase: async () => ({ privateKey: new Uint8Array([1, 2, 3]), encodedPrivateKey: 'EsTa bcDe' }),
    bootstrapCrossSigning: async ({ authUploadDeviceSigningKeys }) => {
      calls.push(['crossSigning', holder.key !== null]);
      await authUploadDeviceSigningKeys(async auth => {
        calls.push(['upload', auth]);
        if (uploadError) throw uploadError;
      });
    },
    getKeyBackupInfo: async () => backup,
    bootstrapSecretStorage: async opts => {
      const key = await opts.createSecretStorageKey();
      calls.push(['secretStorage', { setupNewSecretStorage: opts.setupNewSecretStorage, setupNewKeyBackup: opts.setupNewKeyBackup, keyHeld: holder.key === key.privateKey }]);
    },
  };
  const client = { getCrypto: () => crypto, getUserId: () => '@new:matrix.org' };
  const runtime = { client, assertCurrent() {} };
  return { service: createCryptoService(runtime, { sdk: {}, holder }), holder, calls };
}

test('a new account is offered set-up; one with keys elsewhere is not', async () => {
  assert.equal((await setup().service.getSecureMessagingStatus()).needsSetup, true);
  assert.equal((await setup({ hasServerKeys: true }).service.getSecureMessagingStatus()).needsSetup, false);
  // Interrupted set-up: keys uploaded from here but secret storage unfinished.
  const all = { masterKey: true, selfSigningKey: true, userSigningKey: true };
  assert.equal((await setup({ hasServerKeys: true, cached: all }).service.getSecureMessagingStatus()).needsSetup, true);
  assert.equal((await setup({ hasServerKeys: true, cached: all, secretStorageReady: true }).service.getSecureMessagingStatus()).needsSetup, false);
});

test('set-up creates keys, secret storage and a backup, and returns the recovery key', async () => {
  const { service, holder, calls } = setup();
  const result = await service.setUpSecureMessaging();
  assert.deepEqual(result, { recoveryKey: 'EsTa bcDe' });
  assert.deepEqual(calls.map(call => call[0]), ['hasKeys', 'crossSigning', 'upload', 'secretStorage']);
  assert.deepEqual(calls.find(call => call[0] === 'upload')[1], null); // first upload without re-authenticating
  assert.deepEqual(calls.find(call => call[0] === 'secretStorage')[1], { setupNewSecretStorage: true, setupNewKeyBackup: true, keyHeld: true });
  assert.equal(holder.key, null); // not kept after set-up
});

test('set-up keeps an existing key backup and refuses to replace an identity', async () => {
  const kept = setup({ backup: { version: '1' } });
  await kept.service.setUpSecureMessaging();
  assert.equal(kept.calls.find(call => call[0] === 'secretStorage')[1].setupNewKeyBackup, false);
  await assert.rejects(setup({ hasServerKeys: true }).service.setUpSecureMessaging(), /already has secure messaging/);
});

test('a server that demands re-authentication gets an explanation and nothing is left held', async () => {
  const uploadError = Object.assign(new Error('Unauthorized'), { httpStatus: 401, data: { flows: [{ stages: ['m.login.password'] }] } });
  const { service, holder } = setup({ uploadError });
  await assert.rejects(service.setUpSecureMessaging(), /extra confirmation/);
  assert.equal(holder.key, null);
});

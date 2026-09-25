import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';

const fakeAtmos = new URL('./fake-oauth-atmos.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: fakeAtmos, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const vault = await import('../src/vault.js');
const state = await import('../src/state.js');
const { deleteCryptoStore, storePrefixFor, initCryptoForSession } = await import('../src/crypto-service.js');
const { handlers } = await import('./fake-oauth-atmos.mjs');
const { createVault } = createRequire(import.meta.url)('../vault.cjs');

// A stand-in for Electron's safeStorage: reversible, but recognisably "sealed".
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(`SEALED:${text}`),
  decryptString: buffer => {
    const text = buffer.toString();
    if (!text.startsWith('SEALED:')) throw new Error('not ours');
    return text.slice(7);
  },
});
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-vault-')), 'matrix-chat', 'vault-key.bin');

test('vault key: created once, protected by secure storage, the same on every read', async () => {
  const file = tempFile();
  const first = await createVault({ safeStorage: fakeSafeStorage(), fs, path, crypto, file }).get();
  assert.equal(first.key.length, 32);
  assert.equal(first.protected, true);
  assert.equal(first.created, true);
  const onDisk = fs.readFileSync(file);
  assert.equal(onDisk[0], 1);
  assert.equal(onDisk.includes(Buffer.from(first.key)), false); // never the raw key
  const again = await createVault({ safeStorage: fakeSafeStorage(), fs, path, crypto, file }).get();
  assert.deepEqual(again.key, first.key);
  assert.equal(again.created, false);
});

test('vault key: a plainly stored key is protected once secure storage exists; an unreadable one is replaced', async () => {
  const file = tempFile();
  const plain = await createVault({ safeStorage: fakeSafeStorage(false), fs, path, crypto, file }).get();
  assert.equal(plain.protected, false);
  const upgraded = await createVault({ safeStorage: fakeSafeStorage(true), fs, path, crypto, file }).get();
  assert.deepEqual(upgraded.key, plain.key);
  assert.equal(upgraded.protected, true);
  assert.equal(fs.readFileSync(file)[0], 1);

  fs.writeFileSync(file, Buffer.concat([Buffer.from([1]), Buffer.from('someone else')]));
  const replaced = await createVault({ safeStorage: fakeSafeStorage(), fs, path, crypto, file }).get();
  assert.equal(replaced.replaced, true);
  assert.notDeepEqual(replaced.key, plain.key);
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('vault-key.bin.unreadable-')));
});

test('sealing: round-trips, and refuses altered data, another purpose or another key', async () => {
  const key = crypto.randomBytes(32);
  vault.useVaultKeys(await vault.deriveKeys(new Uint8Array(key)));
  const sealed = await vault.seal({ token: 'secret-token' }, 'sessions');
  assert.match(sealed, /^v1\./);
  assert.equal(sealed.includes('secret-token'), false);
  assert.deepEqual(await vault.unseal(sealed, 'sessions'), { token: 'secret-token' });
  await assert.rejects(vault.unseal(sealed, 'other-purpose'));
  const bytes = Buffer.from(sealed.slice(3), 'base64');
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(vault.unseal(`v1.${bytes.toString('base64')}`, 'sessions'));
  vault.useVaultKeys(await vault.deriveKeys(new Uint8Array(crypto.randomBytes(32))));
  await assert.rejects(vault.unseal(sealed, 'sessions'));
});

test('derived keys: the store key is fixed per vault key and differs from it', async () => {
  const key = new Uint8Array(crypto.randomBytes(32));
  const a = await vault.deriveKeys(key);
  const b = await vault.deriveKeys(key);
  assert.deepEqual(a.storeKey, b.storeKey);
  assert.notDeepEqual(a.storeKey, key);
  await assert.rejects(vault.deriveKeys(new Uint8Array(16)));
});

test('saved state: tokens only ever leave sealed; old plain-text sessions are set aside, not used', async () => {
  vault.useVaultKeys(await vault.deriveKeys(new Uint8Array(crypto.randomBytes(32))));
  let saved = null;
  handlers['state.set'] = value => { saved = value; };
  const session = { homeserver: 'https://matrix.org', userId: '@a:matrix.org', accessToken: 'secret-at', refreshToken: 'secret-rt', deviceId: 'DEV' };
  state.matrixState.matrixSessions = [session];
  state.matrixState.matrixSession = session;
  // state.js saves through atmos.state.set; route it to the fake.
  const atmos = (await import('./fake-oauth-atmos.mjs')).default;
  atmos.state.set = async value => { saved = value; };
  atmos.state.get = async () => saved;
  await state.flush();
  const text = JSON.stringify(saved);
  assert.equal(text.includes('secret-at') || text.includes('secret-rt'), false);
  assert.ok(saved.sealedSessions);

  state.matrixState.matrixSession = null;
  state.matrixState.matrixSessions = [];
  await state.loadState();
  assert.equal(state.matrixState.matrixSession.accessToken, 'secret-at');
  assert.equal(state.matrixState.matrixSession, state.matrixState.matrixSessions[0]);

  // A save from before sealing: its sessions become legacySessions only.
  saved = { matrixSession: session, matrixSessions: [session], storageVersion: 0 };
  await state.loadState();
  assert.equal(state.matrixState.matrixSession, null);
  assert.equal(state.matrixState.legacySessions.length, 1);

  // Sealed with a key this computer no longer has.
  saved = { sealedSessions: await vault.seal({ active: null, sessions: [] }, 'matrix-chat/sessions') };
  vault.useVaultKeys(await vault.deriveKeys(new Uint8Array(crypto.randomBytes(32))));
  await state.loadState();
  assert.equal(state.matrixState.sessionsUnreadable, true);
  assert.deepEqual(state.matrixState.matrixSessions, []);
});

test('encryption databases: one per account and device, encrypted, deletable', async () => {
  assert.equal(storePrefixFor('@a:x', 'DEV'), 'atmos-matrix::@a:x::DEV');
  assert.throws(() => storePrefixFor('@a:x'), /device/);
  let opened;
  await initCryptoForSession({ initRustCrypto: async args => { opened = args; } }, { userId: '@a:x', deviceId: 'DEV' }, new Uint8Array(32));
  assert.equal(opened.cryptoDatabasePrefix, 'atmos-matrix::@a:x::DEV');
  assert.equal(opened.storageKey.length, 32);
  await assert.rejects(initCryptoForSession({ initRustCrypto: async () => {} }, { userId: '@a:x', deviceId: 'DEV' }, undefined), /vault key/);

  const deleted = [];
  const idb = { deleteDatabase(name) { deleted.push(name); const request = {}; setImmediate(() => request.onsuccess()); return request; } };
  assert.equal(await deleteCryptoStore('@a:x', 'DEV', idb), true);
  assert.deepEqual(deleted, ['atmos-matrix::@a:x::DEV::matrix-sdk-crypto', 'atmos-matrix::@a:x::DEV::matrix-sdk-crypto-meta']);
});

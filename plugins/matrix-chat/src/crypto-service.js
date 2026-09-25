/**
 * Encryption databases. Each signed-in account-and-device gets its own
 * IndexedDB database (Rust crypto's store: the device's identity keys, room
 * keys, cached cross-signing keys), encrypted with the vault's store key
 * (src/vault.js), so what's on disk is unreadable without this user's OS
 * secure storage. Frames of Matrix Chat run in an origin of their own
 * (extension.json "isolation"), so no other extension can open it either.
 *
 * One database per device, not per account: signing in again makes a new
 * device (new identity keys), and an old device's store must never be
 * reopened for it. A signed-out device's database is deleted (client.js).
 */
export function storePrefixFor(userId, deviceId) {
  if (!userId || !deviceId) throw new Error('matrix-chat: an encryption database needs an account and a device');
  return `atmos-matrix::${userId}::${deviceId}`;
}

// initRustCrypto() names its two databases <prefix>::matrix-sdk-crypto and
// <prefix>::matrix-sdk-crypto-meta.
const STORE_SUFFIXES = ['::matrix-sdk-crypto', '::matrix-sdk-crypto-meta'];

/** Start encryption for `client` (constructed for `session`, not yet started). */
export async function initCryptoForSession(client, session, storageKey) {
  if (!(storageKey instanceof Uint8Array) || storageKey.length !== 32) {
    throw new Error('matrix-chat: encryption needs the vault key');
  }
  await client.initRustCrypto({ cryptoDatabasePrefix: storePrefixFor(session.userId, session.deviceId), storageKey });
}

/**
 * Delete a device's encryption database. Resolves true once both parts are
 * gone. While the database is still open (a client shutting down), deleting
 * waits for it to close; client.js keeps a note so a deletion cut short by
 * quitting is finished on the next launch.
 */
export function deleteCryptoStore(userId, deviceId, idb = globalThis.indexedDB) {
  if (!idb) return Promise.resolve(false);
  const prefix = storePrefixFor(userId, deviceId);
  return Promise.all(STORE_SUFFIXES.map(suffix => new Promise(resolve => {
    const request = idb.deleteDatabase(prefix + suffix);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  }))).then(results => results.every(Boolean));
}


// ─── Recovery key decoding (base58, Matrix spec format) ────────────────────
// A recovery key as displayed by Element etc (e.g. "EsTx A4Wd 2M...") is a
// fixed byte layout — 2-byte prefix (0x8B, 0x01), the 32-byte private key,
// then a 1-byte parity check (XOR of every preceding byte) — base58-encoded
// (Bitcoin alphabet) with spaces purely cosmetic in the display form. This
// bundle doesn't export matrix-js-sdk's own decodeRecoveryKey (esbuild only
// bundles what's actually reachable from this plugin's existing imports,
// and nothing here touched recovery keys before now — checked via the
// bundle's own namespace in devtools, it isn't in there), so it's
// hand-rolled here instead of pulling in a new dependency for one small,
// spec-fixed algorithm.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RECOVERY_KEY_PREFIX = [0x8b, 0x01];

function base58Decode(str) {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`matrix-chat: recovery key contains an invalid character: "${char}"`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading '1' characters encode leading zero bytes in base58 — the
  // big-integer conversion above drops them, so restore them by count.
  for (const char of str) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/**
 * Decodes a recovery key as displayed by Element etc into its raw 32-byte
 * private key. Throws (with a specific, user-facing reason) on any local
 * format problem — wrong length, bad prefix, failed checksum — so a
 * mistyped key is caught immediately rather than surfacing later as an
 * opaque SDK error several layers down.
 */
function decodeRecoveryKeyValue(displayKey) {
  const stripped = (displayKey || '').replace(/\s+/g, '');
  if (!stripped) throw new Error('matrix-chat: recovery key is empty');

  const bytes = base58Decode(stripped);

  if (bytes.length !== RECOVERY_KEY_PREFIX.length + 32 + 1) {
    throw new Error('matrix-chat: recovery key is the wrong length — check for a typo or a missing/extra character');
  }
  if (bytes[0] !== RECOVERY_KEY_PREFIX[0] || bytes[1] !== RECOVERY_KEY_PREFIX[1]) {
    throw new Error('matrix-chat: this doesn\'t look like a valid recovery key (unrecognized prefix)');
  }

  let parity = 0;
  for (let i = 0; i < bytes.length - 1; i++) parity ^= bytes[i];
  if (parity !== bytes[bytes.length - 1]) {
    throw new Error('matrix-chat: recovery key checksum failed — check for a typo');
  }

  return bytes.slice(RECOVERY_KEY_PREFIX.length, RECOVERY_KEY_PREFIX.length + 32);
}

/** Accept either a pasted recovery key or the contents of Element's
 * downloaded recovery-key text file. File exports may include explanatory
 * text around the key, so try complete lines after trying the input as-is. */
function decodeRecoveryKey(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').trim();
  if (!text) return decodeRecoveryKeyValue(text);

  try {
    return decodeRecoveryKeyValue(text);
  } catch (originalError) {
    const candidates = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && /^[1-9A-HJ-NP-Za-km-z\s]+$/.test(line));
    for (const candidate of candidates) {
      try { return decodeRecoveryKeyValue(candidate); } catch { /* try the next line */ }
    }
    throw originalError;
  }
}

// ─── Recovery-key entry (server-side key backup, via secret storage) ───────
// What Element calls the "recovery key" is not the key backup's own
// private key — it's the *secret storage* (4S) key, which wraps/encrypts
// the real backup decryption key (stored server-side as the
// m.megolm_backup.v1 secret) along with other secrets like the
// cross-signing keys. See CryptoCallbacks' own docs: "this is the
// 'default secret storage key' and may be known as the 'recovery key'".
// The two are only the *same* 32 bytes on an account that has never
// rotated one without the other — which is common right after initial
// setup, but not guaranteed, and (confirmed here) "Change recovery key"
// in Element specifically does NOT guarantee it: that flow can rotate
// the secret-storage wrapper while leaving the backup's own key pair
// untouched underneath, so treating the pasted key as the backup key
// directly (this file's first two attempts) fails even for a
// genuinely-correct, freshly-copied key.
//
// The actually-correct, documented flow: stage the decoded key for the
// originating client's cryptoCallbacks.getSecretStorageKey (registered at client-creation
// time — see login()/restoreSession()) to hand back, then call
// crypto.loadSessionBackupPrivateKeyFromSecretStorage() — which pulls
// the *real* backup key out of secret storage using that callback,
// checks it against the live backup, and caches it via
// storeSessionBackupPrivateKey itself. Only then is restoreKeyBackup()
// guaranteed to find a key that's actually consistent with the current
// backup, regardless of whether the two keys happen to coincide.


export function createSecretStorageCallbacks() {
  const holder = { key: null };
  return {
    holder,
    callbacks: {
      getSecretStorageKey: async ({ keys }) => {
        const keyId = Object.keys(keys)[0];
        if (!keyId || !holder.key) return null;
        return [keyId, holder.key];
      },
    },
  };
}

/**
 * Restores old room keys from the account's existing server-side key
 * backup, using a recovery key the user pasted in (e.g. copied out of
 * Element's Security settings). Decodes+validates the key's format
 * locally first (cheap, no network calls — catches a typo immediately),
 * stages it for getSecretStorageKey() above, then lets
 * loadSessionBackupPrivateKeyFromSecretStorage() be the judge of
 * whether it's actually the right key — see this section's header
 * comment for why that's the correct check rather than comparing the
 * pasted key against the backup directly. Resolves once every
 * backed-up room key has been imported; throws with a specific reason
 * on failure (bad format, wrong key, no backup on this account, or the
 * restore itself failing for some other reason) so settings-menu.js
 * can show the user something actionable. Large accounts can mean this
 * takes a while — see restoreKeyBackup's own docs on that — callers
 * wanting progress feedback can pass a progressCallback through opts
 * in a later revision of this function; not needed for a first pass.
 */

export function createCryptoService(runtime, { sdk, holder }) {
  const client = runtime.client;
  async function restoreFromRecoveryKey(recoveryKeyString) {
    const recoveryClient = client;
    if (!recoveryClient) throw new Error('matrix-chat: no active client');
    const crypto = recoveryClient.getCrypto();
    if (!crypto) throw new Error('matrix-chat: encryption is not initialized on this client');
    if (!holder) throw new Error('matrix-chat: recovery is unavailable for this client');

    holder.key = decodeRecoveryKey(recoveryKeyString); // throws locally on bad format/checksum

    try {
      runtime.assertCurrent();
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    } catch (err) {
      // Per this method's own docs, it throws when the key can't be
      // fetched from secret storage at all (wrong key — getSecretStorageKey
      // effectively returned nothing usable), when there's no backup on
      // the server, or when what it did fetch doesn't match the live
      // backup. Wording varies, so match loosely and give the actionable
      // version; anything that doesn't match is a different failure
      // (network, server error, etc) and is surfaced as-is.
      if (/\b(secret.?storage|mac|signature|decrypt|match)\b/i.test(err?.message || '')) {
        throw new Error('matrix-chat: that recovery key doesn\'t match this account\'s secret storage — double-check it against Element\'s Security settings');
      }
      throw err;
    } finally {
      holder.key = null;
    }

    runtime.assertCurrent();

    return crypto.restoreKeyBackup();
  }

  /** Import a Matrix/Schildi encrypted room-key export. This is a different
   * format from a recovery key: it contains Megolm sessions and is protected
   * by the export password chosen when the file was created. */
  async function importRoomKeyFile(fileContents, passphrase = '') {
    const importClient = client;
    if (!importClient) throw new Error('matrix-chat: no active client');
    const crypto = importClient.getCrypto();
    if (!crypto) throw new Error('matrix-chat: encryption is not initialized on this client');

    const text = String(fileContents || '').replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('matrix-chat: the key file is empty');

    let json = text;
    if (/-----BEGIN MEGOLM SESSION DATA-----/.test(text)) {
      if (!passphrase) throw new Error('matrix-chat: enter the password used when this key file was exported');
      try {
        json = sdk.OlmMachine.decryptExportedRoomKeys(text, passphrase);
      } catch {
        throw new Error('matrix-chat: could not decrypt that key file — check its export password');
      }
    }

    try {
      JSON.parse(json);
    } catch {
      throw new Error('matrix-chat: this is not a supported Matrix room-key export');
    }
    runtime.assertCurrent();
    await crypto.importRoomKeysAsJson(json);
  }

  // ─── Cross-signing (device verification, via secret storage) ───────────────
  // Separate axis from key backup above — restoring the backup lets this
  // device decrypt past messages; it says nothing about whether other
  // devices/users trust *this* device. That trust is cross-signing, and a
  // brand-new device (this one, freshly logged in) starts out unverified —
  // hence "encrypted by a device not verified by its owner" even once
  // decryption itself is working fine.
  //
  // The cross-signing private keys (master/self-signing/user-signing) live
  // in secret storage exactly like the backup key does, under their own
  // secrets (m.cross_signing.master etc, not m.megolm_backup.v1) — so this
  // reuses the same per-client key holder and getSecretStorageKey callback
  // as restoreFromRecoveryKey above. Keeping that holder tied to the client
  // matters when another saved account is activated during a slow restore:
  // the key must never become visible to the newly-active account.
  //
  // Two calls, not one:
  //   1. crypto.bootstrapCrossSigning() — fetches+caches the *existing*
  //      cross-signing keys via getSecretStorageKey. Per its own docs, this
  //      is idempotent and safe to call unconditionally when the keys
  //      already exist (which they will here — Element set them up).
  //   2. crypto.crossSignDevice(deviceId) — bootstrapping alone only caches
  //      the keys; it does NOT itself sign anything. This second, separate
  //      call is what actually signs *this* device with the self-signing
  //      key and publishes that signature, which is what clears the
  //      "not verified by its owner" state.
  //
  // authUploadDeviceSigningKeys is only invoked if bootstrapCrossSigning
  // couldn't find/match existing keys via the recovery key and is about to
  // CREATE NEW ones instead — that would replace this account's real
  // cross-signing identity and invalidate trust with every other device and
  // every user who verified it, which is never the intent of a recovery-key
  // flow. Refuse outright rather than let that happen silently.
  async function crossSignThisDevice(recoveryKeyString) {
    const recoveryClient = client;
    if (!recoveryClient) throw new Error('matrix-chat: no active client');
    const crypto = recoveryClient.getCrypto();
    if (!crypto) throw new Error('matrix-chat: encryption is not initialized on this client');
    if (!holder) throw new Error('matrix-chat: recovery is unavailable for this client');

    holder.key = decodeRecoveryKey(recoveryKeyString); // throws locally on bad format/checksum

    try {
      runtime.assertCurrent();
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async () => {
          throw new Error('matrix-chat: could not find this account\'s existing cross-signing keys via that recovery key — refusing to create new ones, which would invalidate trust with your other devices');
        },
      });

      runtime.assertCurrent();

      await crypto.crossSignDevice(recoveryClient.getDeviceId());
    } catch (err) {
      if (/\b(secret.?storage|mac|signature|decrypt|match)\b/i.test(err?.message || '')) {
        throw new Error('matrix-chat: that recovery key doesn\'t match this account\'s secret storage — double-check it against Element\'s Security settings');
      }
      throw err;
    } finally {
      holder.key = null;
    }
  }


  // ─── First-time set-up (new accounts) ─────────────────────────────────
  //
  // A brand-new account has no cross-signing identity, no secret storage
  // and no key backup: nothing lets another device trust this one or read
  // its message history later. Setting up creates all three and hands back
  // a recovery key, the one thing the person must keep.
  //
  // Only offered when the account has no cross-signing keys on the server,
  // or when this device holds the private keys but secret storage was never
  // finished (a set-up interrupted part-way). An account that already has
  // an identity elsewhere goes through verification or its recovery key
  // instead: creating new keys would cut off every device and person that
  // trusted the old ones.

  function requireCrypto() {
    const crypto = client?.getCrypto();
    if (!crypto) throw new Error('matrix-chat: encryption is not initialized on this client');
    return crypto;
  }

  async function getSecureMessagingStatus() {
    const crypto = requireCrypto();
    const [hasServerKeys, crossSigning, secretStorageReady] = await Promise.all([
      crypto.userHasCrossSigningKeys(client.getUserId(), true),
      crypto.getCrossSigningStatus(),
      crypto.isSecretStorageReady(),
    ]);
    runtime.assertCurrent();
    const cached = crossSigning?.privateKeysCachedLocally || {};
    const privateKeysHere = Boolean(cached.masterKey && cached.selfSigningKey && cached.userSigningKey);
    return {
      needsSetup: !hasServerKeys || (privateKeysHere && !secretStorageReady),
      hasServerKeys,
      secretStorageReady,
    };
  }

  function explainUploadFailure(err) {
    const flows = err?.data?.flows;
    if (err?.httpStatus === 401 && Array.isArray(flows)) {
      return new Error('matrix-chat: your homeserver needs extra confirmation before creating encryption keys, which Atmos can\'t do yet. Set up secure messaging once in Element, then use its recovery key here.');
    }
    return err;
  }

  async function setUpSecureMessaging() {
    const crypto = requireCrypto();
    if (!holder) throw new Error('matrix-chat: secure messaging set-up is unavailable for this client');
    const status = await getSecureMessagingStatus();
    if (!status.needsSetup) {
      throw new Error('matrix-chat: this account already has secure messaging set up. Verify with another device or use your recovery key instead.');
    }

    const recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
    // Secret storage reads this key back (getSecretStorageKey) while it
    // stores the cross-signing and backup keys under it.
    holder.key = recoveryKey.privateKey;
    try {
      runtime.assertCurrent();
      await crypto.bootstrapCrossSigning({
        // New accounts may upload their first keys without re-authenticating
        // (MSC3967); a server that still asks gets an explanation instead.
        authUploadDeviceSigningKeys: async makeRequest => {
          try {
            return await makeRequest(null);
          } catch (err) {
            throw explainUploadFailure(err);
          }
        },
      });
      runtime.assertCurrent();
      // A backup the account already has (from an older client) is kept
      // rather than replaced; only a missing one is created.
      const existingBackup = await crypto.getKeyBackupInfo();
      runtime.assertCurrent();
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => recoveryKey,
        setupNewSecretStorage: true,
        setupNewKeyBackup: !existingBackup,
      });
      runtime.assertCurrent();
    } finally {
      holder.key = null;
    }
    return { recoveryKey: recoveryKey.encodedPrivateKey };
  }

  return { restoreFromRecoveryKey, importRoomKeyFile, crossSignThisDevice, getSecureMessagingStatus, setUpSecureMessaging };
}

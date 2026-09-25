'use strict';
/**
 * Matrix Chat's vault key (main process): one random 256-bit key that
 * encrypts everything secret the plugin keeps on disk — saved sessions
 * (access and refresh tokens) and each account's encryption database (its
 * identity keys, room keys and cross-signing keys).
 *
 * The key file is itself encrypted with the operating system's secure
 * storage (Electron safeStorage: DPAPI on Windows, Keychain on macOS, the
 * secret service on Linux), so it can only be read by this user on this
 * computer. Copying the profile folder, or reading it as another user or
 * from a backup, yields nothing usable.
 *
 * Format: one byte (1 = protected by safeStorage, 0 = stored plainly because
 * secure storage isn't available on this system), then the payload.
 */

const PROTECTED = 1;
const PLAIN = 0;

function createVault({ safeStorage, fs, path, crypto, file }) {
  let pending = null;

  async function write(key) {
    const canProtect = safeStorage.isEncryptionAvailable();
    const body = canProtect
      ? Buffer.concat([Buffer.from([PROTECTED]), safeStorage.encryptString(key.toString('base64'))])
      : Buffer.concat([Buffer.from([PLAIN]), key]);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.promises.writeFile(temporary, body, { mode: 0o600 });
    await fs.promises.rename(temporary, file);
    return canProtect;
  }

  async function read() {
    let stored;
    try {
      stored = await fs.promises.readFile(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const key = crypto.randomBytes(32);
      return { key, protected: await write(key), created: true };
    }
    try {
      if (stored[0] === PROTECTED) {
        const key = Buffer.from(safeStorage.decryptString(stored.subarray(1)), 'base64');
        if (key.length !== 32) throw new Error('vault key has the wrong length');
        return { key, protected: true, created: false };
      }
      if (stored[0] === PLAIN && stored.length === 33) {
        const key = Buffer.from(stored.subarray(1));
        // Secure storage became available since: protect the key now.
        const nowProtected = safeStorage.isEncryptionAvailable() ? await write(key) : false;
        return { key, protected: nowProtected, created: false };
      }
      throw new Error('vault key file is not recognised');
    } catch (error) {
      // Unreadable (another user's or computer's secure storage, or damaged).
      // Keep the old file for inspection and start a new key: saved sessions
      // can't be opened any more, so Matrix Chat asks to sign in again.
      console.error('[matrix-chat] vault key unreadable; starting a new one:', error.message);
      await fs.promises.rename(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
      const key = crypto.randomBytes(32);
      return { key, protected: await write(key), created: true, replaced: true };
    }
  }

  /** { key: Uint8Array(32), protected, created, replaced? } — read once per run. */
  function get() {
    pending ||= read().catch(error => { pending = null; throw error; });
    return pending.then(result => ({ ...result, key: new Uint8Array(result.key) }));
  }

  return { get };
}

module.exports = { createVault };

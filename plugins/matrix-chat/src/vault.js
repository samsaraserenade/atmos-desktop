/**
 * The frame side of Matrix Chat's vault (main process: vault.cjs).
 *
 * main.cjs hands over one random 256-bit key, protected on disk by the
 * operating system's secure storage. Two independent keys are derived from
 * it (HKDF-SHA-256), so neither use can weaken the other:
 *
 *   - the sessions key (AES-256-GCM) seals saved sessions — access tokens,
 *     refresh tokens, sign-in server details — before they're handed to
 *     Atmos's saved state, which is otherwise plain text on disk;
 *   - the store key encrypts each account's encryption database
 *     (initRustCrypto's storageKey): identity keys, room keys, cross-signing
 *     keys.
 */
import atmos from 'atmos-sdk';

const SEAL_VERSION = 1;
const encoder = new TextEncoder();
let opened = null;

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive the two working keys from the 32-byte vault key. Exported for tests. */
export async function deriveKeys(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) throw new Error('matrix-chat: the vault key is invalid');
  const base = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(info) });
  const sessionsKey = await crypto.subtle.deriveKey(hkdf('atmos/matrix-chat/sessions/v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const storeKey = new Uint8Array(await crypto.subtle.deriveBits(hkdf('atmos/matrix-chat/crypto-store/v1'), base, 256));
  return { sessionsKey, storeKey };
}

/** Fetch and derive the keys. Called once by boot.js before loading state. */
export async function openVault() {
  const result = await atmos.invoke('plugin:matrix-chat', 'vault-key');
  opened = { ...(await deriveKeys(new Uint8Array(result.key))), protected: result.protected === true, replaced: result.replaced === true };
  return { protected: opened.protected, replaced: opened.replaced };
}

/** Use already-derived keys (tests). */
export function useVaultKeys(keys) {
  opened = { protected: true, replaced: false, ...keys };
}

function requireVault() {
  if (!opened) throw new Error('matrix-chat: the vault is not open');
  return opened;
}

/** Whether the key is protected by the OS's secure storage (false only where none exists). */
export function isVaultProtected() {
  return requireVault().protected;
}

/** The 32-byte key for this plugin's encryption databases. */
export function cryptoStoreKey() {
  return requireVault().storeKey;
}

/** Encrypt a JSON-able value: "v1.<base64 iv|ciphertext>". */
export async function seal(value, purpose) {
  const { sessionsKey } = requireVault();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, sessionsKey, plaintext));
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv);
  out.set(ciphertext, iv.length);
  return `v${SEAL_VERSION}.${toBase64(out)}`;
}

/** Decrypt what seal() produced for the same purpose. Throws if it was altered or sealed with another key. */
export async function unseal(sealed, purpose) {
  const { sessionsKey } = requireVault();
  const match = /^v(\d+)\.([A-Za-z0-9+/=]+)$/.exec(String(sealed || ''));
  if (!match || Number(match[1]) !== SEAL_VERSION) throw new Error('matrix-chat: saved data is in an unknown format');
  const bytes = fromBase64(match[2]);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(purpose) }, sessionsKey, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

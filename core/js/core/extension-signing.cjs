'use strict';
/**
 * Signed extensions.
 *
 * An official extension carries signature.json beside its files:
 *
 *   {
 *     "format": 1,
 *     "algorithm": "ed25519",
 *     "keyId": "3f2a…",                     first 16 hex digits of sha256(public key)
 *     "payload": {
 *       "format": 1, "kind": "plugin", "id": "notes",
 *       "version": "0.9.0", "publisher": "atmos",
 *       "files": { "boot.js": "<sha256>", … }   every file except signature.json
 *     },
 *     "signature": "<base64>"               Ed25519 over the canonical JSON of payload
 *   }
 *
 * Atmos trusts the public keys in core/trusted-keys.json. A package signed
 * with an official key there is official wherever it is installed; see
 * extension-catalog.cjs and extension-trust.cjs. The private key never
 * goes near the repo (scripts/extension-keys.cjs keeps it in an encrypted
 * file elsewhere).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { compareFiles } = require('./extension-integrity.cjs');

const SIGNATURE_FILE = 'signature.json';
const TRUSTED_KEYS_FORMAT = 1;

/** JSON with object keys sorted at every level, so the signed bytes are stable. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicKeyDer(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' });
}

function keyIdFor(publicKey) {
  return crypto.createHash('sha256').update(publicKeyDer(publicKey)).digest('hex').slice(0, 16);
}

/** A trusted-keys.json entry for a public key. */
function trustedKeyEntry(publicKey, { publisher = 'atmos', official = true, note } = {}) {
  const entry = {
    id: keyIdFor(publicKey),
    publisher,
    official,
    algorithm: 'ed25519',
    publicKey: publicKeyDer(publicKey).toString('base64'),
    addedAt: new Date().toISOString().slice(0, 10),
  };
  if (note) entry.note = note;
  return entry;
}

/**
 * Read trusted-keys.json files into a Map of key id → { key, publisher,
 * official, revoked }. Entries that don't parse, or whose id doesn't match
 * their key, are skipped with a warning.
 */
function loadTrustedKeys(files, warn = message => console.warn(message)) {
  const keys = new Map();
  for (const file of files.filter(Boolean)) {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`[extensions] could not read trusted keys ${file}: ${error.message}`);
      continue;
    }
    if (list?.format !== TRUSTED_KEYS_FORMAT || !Array.isArray(list.keys)) {
      warn(`[extensions] ${file} is not a trusted keys list (format ${TRUSTED_KEYS_FORMAT})`);
      continue;
    }
    for (const entry of list.keys) {
      try {
        if (entry.algorithm !== 'ed25519') throw new Error(`unsupported algorithm ${entry.algorithm}`);
        const key = crypto.createPublicKey({ key: Buffer.from(entry.publicKey, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
        if (keyIdFor(key) !== entry.id) throw new Error('id does not match the key');
        if (typeof entry.publisher !== 'string' || !entry.publisher) throw new Error('no publisher');
        keys.set(entry.id, { id: entry.id, key, publisher: entry.publisher, official: entry.official === true, revoked: entry.revoked === true });
      } catch (error) {
        warn(`[extensions] skipping trusted key ${entry?.id || '?'} in ${file}: ${error.message}`);
      }
    }
  }
  return keys;
}

/** Hashes of every file an extension's signature covers (all but signature.json). */
function signedFiles(dir, hasher) {
  const { files } = hasher.hashTree(dir);
  delete files[SIGNATURE_FILE];
  return files;
}

/**
 * Sign the extension folder `dir` and write its signature.json.
 * `privateKey` is a crypto KeyObject (Ed25519).
 */
function signExtension(dir, { kind, id, privateKey, hasher }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  const publicKey = crypto.createPublicKey(privateKey);
  const payload = {
    format: 1,
    kind,
    id,
    version: manifest.version,
    publisher: manifest.publisher,
    files: signedFiles(dir, hasher),
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
  const document = { format: 1, algorithm: 'ed25519', keyId: keyIdFor(publicKey), payload, signature };
  fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(document, null, 1)}\n`);
  return document;
}

function readSignature(dir) {
  const file = path.join(dir, SIGNATURE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (document?.format !== 1 || document.algorithm !== 'ed25519' || typeof document.signature !== 'string'
      || typeof document.keyId !== 'string' || !document.payload || typeof document.payload !== 'object') {
      return { invalid: 'signature.json has an unsupported format' };
    }
    return document;
  } catch (error) {
    return { invalid: `signature.json is unreadable: ${error.message}` };
  }
}

/**
 * Check the signature itself, not the files: who signed it, for which
 * extension and version. Cheap, so the catalog can use it to classify
 * extensions before the files are hashed.
 *
 * Returns { signed: false } when there is no signature.json, otherwise
 * { signed: true, status, reason, keyId, publisher, official, version }
 * where status is 'valid', 'untrusted' (unknown or revoked key) or
 * 'invalid' (unreadable, bad signature, or signed for another extension).
 */
function checkSignature(dir, { kind, id, manifest, trustedKeys }) {
  const document = readSignature(dir);
  if (!document) return { signed: false };
  const base = { signed: true, keyId: document.keyId || null, official: false };
  if (document.invalid) return { ...base, status: 'invalid', reason: document.invalid };
  const trusted = trustedKeys.get(document.keyId);
  if (!trusted) return { ...base, status: 'untrusted', reason: 'Signed with a key this copy of Atmos does not know' };
  if (trusted.revoked) return { ...base, status: 'untrusted', reason: 'Signed with a key that has been revoked' };
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonicalJson(document.payload)), trusted.key, Buffer.from(document.signature, 'base64'));
  } catch { ok = false; }
  if (!ok) return { ...base, status: 'invalid', reason: 'Its signature does not match' };
  const { payload } = document;
  if (payload.kind !== kind || payload.id !== id) {
    return { ...base, status: 'invalid', reason: `It is signed as ${payload.kind} '${payload.id}', not ${kind} '${id}'` };
  }
  if (payload.publisher !== trusted.publisher) {
    return { ...base, status: 'untrusted', reason: `The key belongs to '${trusted.publisher}', not '${payload.publisher}'` };
  }
  if (manifest && (manifest.version !== payload.version || manifest.publisher !== payload.publisher)) {
    return { ...base, status: 'invalid', reason: 'Its extension.json does not match what was signed' };
  }
  if (!payload.files || typeof payload.files !== 'object') return { ...base, status: 'invalid', reason: 'signature.json lists no files' };
  return { ...base, status: 'valid', reason: null, publisher: payload.publisher, official: trusted.official, version: payload.version, files: payload.files };
}

/**
 * Full check: the signature, then every file against it.
 * status: 'unsigned' | 'untrusted' | 'tampered' | 'verified'.
 */
function verifyExtension(dir, { kind, id, manifest, trustedKeys, hasher }) {
  const check = checkSignature(dir, { kind, id, manifest, trustedKeys });
  if (!check.signed) return { status: 'unsigned', reason: 'Not signed' };
  if (check.status === 'untrusted') return { ...check, status: 'untrusted' };
  if (check.status === 'invalid') return { ...check, status: 'tampered' };
  const mismatch = compareFiles(signedFiles(dir, hasher), check.files);
  const { files, ...rest } = check;
  return mismatch
    ? { ...rest, status: 'tampered', reason: `Files differ from the signed package (${mismatch.replace('not listed in integrity.json', 'nothing listed')})` }
    : { ...rest, status: 'verified', reason: null };
}

// ── Package indexes (sources) ────────────────────────────────────────────

/**
 * Sign a source's index.json: `index` without its signature fields. The
 * signature covers everything else, so a source's host can't change which
 * packages or versions it lists, or their hashes.
 */
function signIndex(index, privateKey) {
  const { keyId: _k, signature: _s, ...body } = index;
  const signature = crypto.sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64');
  return { ...body, keyId: keyIdFor(crypto.createPublicKey(privateKey)), signature };
}

/** { ok, reason, keyId, publisher } for an index. Only official keys can sign one. */
function checkIndexSignature(index, trustedKeys) {
  if (!index || typeof index !== 'object' || typeof index.signature !== 'string' || typeof index.keyId !== 'string') {
    return { ok: false, reason: 'The source\'s index is not signed' };
  }
  const trusted = trustedKeys.get(index.keyId);
  if (!trusted || trusted.revoked || !trusted.official) return { ok: false, reason: 'The source\'s index is not signed with an official key' };
  const { keyId, signature, ...body } = index;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonicalJson(body)), trusted.key, Buffer.from(signature, 'base64')); } catch { ok = false; }
  return ok ? { ok: true, reason: null, keyId, publisher: trusted.publisher } : { ok: false, reason: 'The source\'s index signature does not match' };
}

module.exports = {
  signIndex,
  checkIndexSignature,
  SIGNATURE_FILE,
  canonicalJson,
  keyIdFor,
  trustedKeyEntry,
  loadTrustedKeys,
  signExtension,
  checkSignature,
  verifyExtension,
};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHasher, listFiles } = require('./extension-integrity.cjs');
const {
  trustedKeyEntry, loadTrustedKeys, signExtension, checkSignature, verifyExtension, canonicalJson, SIGNATURE_FILE,
} = require('./extension-signing.cjs');
const { writePackage, readPackage, packFolder, unpackTo, isSafeName } = require('./extension-package.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-signing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
}

function keys(dir, entries) {
  const file = path.join(dir, 'trusted-keys.json');
  fs.writeFileSync(file, JSON.stringify({ format: 1, keys: entries }));
  return loadTrustedKeys([file], () => {});
}

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
});

test('a signed extension verifies, and any change to its files or signature is caught', t => {
  const dir = tempDir(t);
  const ext = path.join(dir, 'ambient');
  writeTree(ext, {
    'extension.json': { version: '0.9.0', publisher: 'atmos', permissions: {} },
    'boot.js': 'export default 1;',
    'assets/rain.ogg': 'ogg',
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustedKeys = keys(dir, [trustedKeyEntry(publicKey)]);
  const hasher = createHasher(null);
  const opts = { kind: 'plugin', id: 'ambient', trustedKeys, hasher };

  const document = signExtension(ext, { kind: 'plugin', id: 'ambient', privateKey, hasher });
  assert.deepEqual(Object.keys(document.payload.files).sort(), ['assets/rain.ogg', 'boot.js', 'extension.json']);
  const manifest = () => JSON.parse(fs.readFileSync(path.join(ext, 'extension.json'), 'utf8'));
  let result = verifyExtension(ext, { ...opts, manifest: manifest() });
  assert.equal(result.status, 'verified');
  assert.equal(result.official, true);
  assert.equal(result.publisher, 'atmos');

  fs.writeFileSync(path.join(ext, 'boot.js'), 'export default 2;');
  result = verifyExtension(ext, { ...opts, manifest: manifest() });
  assert.equal(result.status, 'tampered');
  assert.match(result.reason, /changed boot\.js/);
  fs.writeFileSync(path.join(ext, 'boot.js'), 'export default 1;');
  fs.writeFileSync(path.join(ext, 'extra.js'), 'steal()');
  assert.match(verifyExtension(ext, { ...opts, manifest: manifest() }).reason, /added extra\.js/);
  fs.unlinkSync(path.join(ext, 'extra.js'));

  // Editing the payload (say, to list a new file) breaks the signature.
  const signed = JSON.parse(fs.readFileSync(path.join(ext, SIGNATURE_FILE), 'utf8'));
  signed.payload.files['extra.js'] = 'x';
  fs.writeFileSync(path.join(ext, SIGNATURE_FILE), JSON.stringify(signed));
  result = checkSignature(ext, { ...opts, manifest: manifest() });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason, /does not match/);

  // Signed for another extension: not valid here.
  signExtension(ext, { kind: 'plugin', id: 'ambient', privateKey, hasher });
  assert.match(checkSignature(ext, { ...opts, id: 'finance', manifest: manifest() }).reason, /signed as plugin 'ambient'/);
  assert.equal(checkSignature(ext, { ...opts, kind: 'service', manifest: manifest() }).status, 'invalid');
});

test('unknown, revoked, non-official and wrong-publisher keys are not trusted', t => {
  const dir = tempDir(t);
  const ext = path.join(dir, 'clock');
  writeTree(ext, { 'extension.json': { version: '1.0.0', publisher: 'atmos' }, 'boot.js': '' });
  const hasher = createHasher(null);
  const official = crypto.generateKeyPairSync('ed25519');
  const stranger = crypto.generateKeyPairSync('ed25519');
  const opts = { kind: 'plugin', id: 'clock', manifest: { version: '1.0.0', publisher: 'atmos' }, hasher };

  assert.equal(verifyExtension(ext, { ...opts, trustedKeys: new Map() }).status, 'unsigned');

  signExtension(ext, { kind: 'plugin', id: 'clock', privateKey: stranger.privateKey, hasher });
  const trusted = keys(dir, [trustedKeyEntry(official.publicKey)]);
  let result = verifyExtension(ext, { ...opts, trustedKeys: trusted });
  assert.equal(result.status, 'untrusted');
  assert.match(result.reason, /does not know/);

  const revoked = { ...trustedKeyEntry(stranger.publicKey), revoked: true };
  assert.match(verifyExtension(ext, { ...opts, trustedKeys: keys(dir, [revoked]) }).reason, /revoked/);

  const community = trustedKeyEntry(stranger.publicKey, { official: false });
  result = verifyExtension(ext, { ...opts, trustedKeys: keys(dir, [community]) });
  assert.equal(result.status, 'verified');
  assert.equal(result.official, false);

  const otherPublisher = trustedKeyEntry(stranger.publicKey, { publisher: 'someone' });
  assert.match(verifyExtension(ext, { ...opts, trustedKeys: keys(dir, [otherPublisher]) }).reason, /belongs to 'someone'/);

  // A manifest that no longer says what was signed.
  assert.match(checkSignature(ext, { ...opts, manifest: { version: '2.0.0', publisher: 'atmos' }, trustedKeys: keys(dir, [community]) }).reason,
    /does not match what was signed/);
});

test('trusted keys whose id does not match their key are skipped', t => {
  const dir = tempDir(t);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const warnings = [];
  const file = path.join(dir, 'k.json');
  fs.writeFileSync(file, JSON.stringify({ format: 1, keys: [{ ...trustedKeyEntry(publicKey), id: '0000000000000000' }, trustedKeyEntry(publicKey)] }));
  const loaded = loadTrustedKeys([file, path.join(dir, 'missing.json')], message => warnings.push(message));
  assert.equal(loaded.size, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /id does not match/);
});

test('packages round-trip, are reproducible, and refuse unsafe paths', t => {
  const dir = tempDir(t);
  const src = path.join(dir, 'src');
  writeTree(src, { 'extension.json': '{}', 'a/b.js': 'x'.repeat(5000), 'empty.txt': '', 'ünï.txt': 'u' });
  const first = packFolder(src, listFiles);
  const second = packFolder(src, listFiles);
  assert.ok(first.equals(second), 'same files give the same bytes');
  const out = path.join(dir, 'out');
  const names = unpackTo(first, out);
  assert.deepEqual(names.sort(), ['a/b.js', 'empty.txt', 'extension.json', 'ünï.txt']);
  assert.equal(fs.readFileSync(path.join(out, 'a', 'b.js'), 'utf8'), 'x'.repeat(5000));
  assert.throws(() => unpackTo(first, out), /already exists/);

  for (const bad of ['../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a/../b']) assert.equal(isSafeName(bad), false, bad);
  assert.throws(() => writePackage([{ name: '../evil', data: Buffer.from('') }]), /Unsafe/);

  // Hand-craft an entry named ../evil and check reading refuses it.
  const evil = writePackage([{ name: 'xxxxxxx', data: Buffer.from('boom') }]);
  const patched = Buffer.from(evil.toString('latin1').split('xxxxxxx').join('../evil'), 'latin1');
  assert.throws(() => readPackage(patched), /unsafe path/);

  const corrupt = Buffer.from(first);
  corrupt[40] ^= 0xff;
  assert.throws(() => readPackage(corrupt));
  assert.throws(() => readPackage(Buffer.from('not a zip')), /Not a package/);
});

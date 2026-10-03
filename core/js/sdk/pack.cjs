#!/usr/bin/env node
'use strict';
/**
 * Package a community extension for a GitHub release (Atmos SDK).
 *
 *   node .atmos-sdk/pack.cjs                    unsigned
 *   node .atmos-sdk/pack.cjs --key <file>       signed with your key
 *   node .atmos-sdk/pack.cjs --new-key <file>   make a key (once), then sign with it
 *
 * Run it in the extension's folder (npm run pack does). It writes, in
 * dist/ (--out to change):
 *
 *   <id>-<version>.atmos   the extension: a zip of its files, and
 *                          signature.json when signed
 *   index.json             what Atmos reads first: the package's id,
 *                          version, size and SHA-256
 *
 * Attach both to a GitHub release (the latest release is the one Atmos
 * reads). People add your repository in Settings → Extensions → sources
 * (github.com/you/repo), install it, and approve what it asks for; every
 * new version asks them again.
 *
 * Signing is optional. A signed extension shows as "Signed" with your key's
 * id, and Atmos points it out if a later version is signed with another key
 * (or none), so people can tell an update still comes from you. Keep the key
 * file out of the repository, and keep a copy: a new key looks like someone
 * else. It's an Ed25519 key in PEM; set ATMOS_SIGNING_PASSPHRASE to encrypt a
 * new key or read an encrypted one.
 *
 * Options: --id <id> (default: package.json's "name", else the folder's),
 * --kind plugin|service (default: plugin), --out <folder> (default: dist).
 * Left out of the package: anything whose name starts with a dot,
 * node_modules, tests, the output folder, package.json, package-lock.json
 * and jsconfig.json.
 *
 * MIT licence, like the rest of the SDK. Atmos checks what this writes with
 * its own code; a test in Atmos packs, installs and verifies with this file.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const LEFT_OUT = new Set(['node_modules', 'tests', 'package.json', 'package-lock.json', 'jsconfig.json']);

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { key: null, newKey: null, id: null, kind: 'plugin', out: 'dist', dir: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { if (!argv[i + 1]) fail(`${arg} needs a value`); return argv[i += 1]; };
    if (arg === '--key') args.key = value();
    else if (arg === '--new-key') args.newKey = value();
    else if (arg === '--id') args.id = value();
    else if (arg === '--kind') args.kind = value();
    else if (arg === '--out') args.out = value();
    else if (arg === '--dir') args.dir = value();
    else fail(`unknown option ${arg}`);
  }
  if (!['plugin', 'service'].includes(args.kind)) fail('--kind is plugin or service');
  return args;
}

/** JSON with keys sorted at every level: the bytes Atmos checks a signature over. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const keyIdFor = publicKey => sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);

/** The extension's files: [relative path with forward slashes], sorted. */
function packageFiles(root, outDir) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.') || path.resolve(full) === path.resolve(outDir)) continue;
      if (dir === root && LEFT_OUT.has(entry.name)) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

// ── The zip (what Atmos's extension-package.cjs reads) ───────────────────

const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // fixed: the same files give the same bytes
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const deflate = deflated.length < data.length;
    const body = deflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) fail('the package is over 4 GB');
  }
  const size = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ── Keys ─────────────────────────────────────────────────────────────────

function newKey(file, root) {
  const target = path.resolve(file);
  if (!path.relative(path.resolve(root), target).startsWith('..')) fail('keep the key outside the extension\'s folder (it must never be committed or packaged)');
  if (fs.existsSync(target)) fail(`${target} already exists; not overwriting a key`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const passphrase = process.env.ATMOS_SIGNING_PASSPHRASE;
  const pem = privateKey.export(passphrase ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase } : { type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pem, { mode: 0o600, flag: 'wx' });
  console.log(`pack: made ${target} (key ${keyIdFor(crypto.createPublicKey(privateKey))}${passphrase ? ', encrypted' : ''}). Keep a copy somewhere safe.`);
  return target;
}

function readKey(file) {
  let key;
  try {
    key = crypto.createPrivateKey({ key: fs.readFileSync(file), passphrase: process.env.ATMOS_SIGNING_PASSPHRASE });
  } catch (error) {
    fail(`couldn't read the key in ${file} (${error.message}); an encrypted key needs ATMOS_SIGNING_PASSPHRASE`);
  }
  if (key.asymmetricKeyType !== 'ed25519') fail(`${file} isn't an Ed25519 key`);
  return key;
}

// ── Pack ─────────────────────────────────────────────────────────────────

function pack(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = path.resolve(args.dir);
  const outDir = path.resolve(root, args.out);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8')); } catch (error) {
    fail(`no readable extension.json in ${root} (${error.message})`);
  }
  let id = args.id;
  if (!id) {
    try { id = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name; } catch { id = null; }
    id ||= path.basename(root);
  }
  if (!VALID_ID.test(id)) fail(`'${id}' isn't a valid id (lowercase letters, numbers and hyphens); pass --id`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) fail('extension.json needs a "version" like 1.0.0');
  if (typeof manifest.publisher !== 'string' || !manifest.publisher) fail('extension.json needs a "publisher" (your name or handle)');
  if (manifest.publisher === 'atmos') fail('"publisher": "atmos" is for official extensions; use your own name');
  if (fs.existsSync(path.join(root, 'main.cjs'))) fail('community extensions can\'t have a main.cjs (main-process code is for official extensions)');

  const names = packageFiles(root, outDir).filter(name => name !== 'signature.json');
  if (!names.includes('extension.json')) fail('extension.json would be left out');
  const files = names.map(name => ({ name, data: fs.readFileSync(path.join(root, ...name.split('/'))) }));
  const keyFile = args.newKey ? newKey(args.newKey, root) : args.key;
  let keyId = null;
  if (keyFile) {
    const privateKey = readKey(keyFile);
    const publicKey = crypto.createPublicKey(privateKey);
    keyId = keyIdFor(publicKey);
    const payload = {
      format: 1, kind: args.kind, id, version: manifest.version, publisher: manifest.publisher,
      files: Object.fromEntries(files.map(file => [file.name, sha256(file.data)])),
    };
    const signature = {
      format: 1, algorithm: 'ed25519', keyId, payload,
      signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    files.push({ name: 'signature.json', data: Buffer.from(`${JSON.stringify(signature, null, 1)}\n`) });
  }

  const buffer = writeZip(files);
  const file = `${id}-${manifest.version}.atmos`;
  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir).filter(name => name.endsWith('.atmos') || name === 'index.json')) fs.rmSync(path.join(outDir, old));
  fs.writeFileSync(path.join(outDir, file), buffer);
  const item = {
    kind: args.kind, id, version: manifest.version, publisher: manifest.publisher,
    displayName: manifest.displayName || null, description: manifest.description || null,
    apiVersion: manifest.apiVersion, requires: manifest.requires || {}, engines: manifest.engines || null,
    dependencies: manifest.dependencies || {}, file, size: buffer.length, sha256: sha256(buffer),
  };
  for (const key of Object.keys(item)) if (item[key] === null || item[key] === undefined) delete item[key];
  const index = { format: 1, name: manifest.displayName || id, generated: new Date().toISOString(), packages: [item] };
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  const where = path.relative(process.cwd(), outDir) || '.';
  console.log(`pack: ${path.join(where, file)}  ${files.length} files, ${(buffer.length / 1024).toFixed(0)} KB, ${keyId ? `signed (key ${keyId})` : 'unsigned'}`);
  console.log(`pack: ${path.join(where, 'index.json')}`);
  console.log('pack: attach both to a GitHub release; people add github.com/<you>/<repo> as a source in Atmos.');
  return { file: path.join(outDir, file), index: path.join(outDir, 'index.json'), keyId };
}

if (require.main === module) pack();
module.exports = { pack, canonicalJson, packageFiles };

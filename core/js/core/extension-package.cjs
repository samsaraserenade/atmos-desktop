'use strict';
/**
 * .atmos packages: an extension folder (with its signature.json) as a zip.
 *
 * Only what Atmos needs of the zip format: stored or deflated entries, no
 * zip64, no encryption. Reading checks every name (no absolute paths, no
 * "..", no backslashes) and size before anything is written, so a package
 * can't reach outside the folder it is unpacked into.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PACKAGE_EXTENSION = '.atmos';
const LIMITS = Object.freeze({ entries: 20000, entryBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 });

let crcTable = null;
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Whether a zip entry name is a safe relative file path. */
function isSafeName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Fixed timestamp (1 January 2000): packages of the same files are byte-identical.
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

/** Build a zip from [{ name, data }]. Names use forward slashes. */
function writePackage(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!isSafeName(name)) throw new Error(`Unsafe file name in package: ${name}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new Error('Package too large (zip64 is not supported)');
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Read a zip into [{ name, data }], checking names, sizes and checksums. */
function readPackage(buffer, limits = LIMITS) {
  let endAt = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { endAt = i; break; }
  }
  if (endAt < 0) throw new Error('Not a package (no zip directory)');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  if (count > limits.entries) throw new Error(`Package has too many files (${count})`);
  const out = [];
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Package directory is damaged');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // directory entry
    if (!isSafeName(name)) throw new Error(`Package contains an unsafe path: ${name}`);
    if (seen.has(name.toLowerCase())) throw new Error(`Package lists ${name} twice`);
    seen.add(name.toLowerCase());
    if (flags & 0x1) throw new Error('Encrypted packages are not supported');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name}`);
    if (size > limits.entryBytes) throw new Error(`${name} is too large`);
    total += size;
    if (total > limits.totalBytes) throw new Error('Package is too large');
    if (localAt + 30 > buffer.length || buffer.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`Package entry ${name} is damaged`);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const body = buffer.subarray(dataAt, dataAt + compressedSize);
    if (body.length !== compressedSize) throw new Error(`Package entry ${name} is truncated`);
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Package entry ${name} is corrupt`);
    out.push({ name, data });
  }
  return out;
}

/** Zip every file under `dir` (as listed by `listFiles`) into a package. */
function packFolder(dir, listFiles) {
  return writePackage(listFiles(dir).map(name => ({ name, data: fs.readFileSync(path.join(dir, ...name.split('/'))) })));
}

/** Unpack a package into `dir`, which must not exist yet. */
function unpackTo(buffer, dir) {
  const entries = readPackage(buffer);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  for (const { name, data } of entries) {
    const target = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return entries.map(entry => entry.name);
}

module.exports = { PACKAGE_EXTENSION, writePackage, readPackage, packFolder, unpackTo, isSafeName };

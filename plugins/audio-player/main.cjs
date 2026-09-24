'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { serveMedia } = require('./src/media-resource.cjs');

const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'opus', 'wma']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const MAX_TAG_FALLBACK_BYTES = 512 * 1024 * 1024;

async function checkedDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('A valid absolute folder path is required.');
  const resolved = path.resolve(value);
  if (!(await fs.promises.stat(resolved)).isDirectory()) throw new Error('Folder does not exist.');
  return resolved;
}

function checkedExtensions(values) {
  const requested = Array.isArray(values) ? values : [];
  return new Set(requested.map(String).map(v => v.toLowerCase().replace(/^\./, '')).filter(v => AUDIO_EXTENSIONS.has(v)));
}

function directoryExists(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  try { return fs.statSync(path.resolve(value)).isDirectory(); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function matchingFile(filePath, extensions) {
  return extensions.has(path.extname(filePath).slice(1).toLowerCase());
}

async function listFiles(root, extensions) {
  return (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.join(root, entry.name))
    .filter(filePath => matchingFile(filePath, extensions));
}

async function listDirTree(root, extensions) {
  const result = [];
  const visit = async directory => {
    let hasMatchingFiles = false;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && matchingFile(fullPath, extensions)) hasMatchingFiles = true;
    }
    result.push({
      path: directory,
      relativePath: path.relative(root, directory).replace(/\\/g, '/'),
      hasMatchingFiles,
    });
  };
  await visit(root);
  return result;
}

function contentType(filePath) {
  return ({ mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', wma: 'audio/x-ms-wma' })[path.extname(filePath).slice(1).toLowerCase()] || 'application/octet-stream';
}

function imageContentType(filePath) {
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function readCoverSidecar(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A valid absolute media path is required.');
  const resolved = path.resolve(filePath);
  if (!AUDIO_EXTENSIONS.has(path.extname(resolved).slice(1).toLowerCase())) throw new Error('A supported media file is required.');
  const directory = path.dirname(resolved);
  const candidates = [
    'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
    'folder.jpg', 'folder.jpeg', 'folder.png', 'folder.webp',
  ];
  for (const name of candidates) {
    const candidate = path.join(directory, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) continue;
      return {
        data: fs.readFileSync(candidate),
        format: imageContentType(candidate),
      };
    } catch (_e) { /* try the next conventional filename */ }
  }
  return null;
}

function synchsafeSize(bytes) {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function parseVorbisComments(buffer, offset) {
  if (offset + 8 > buffer.length) return {};
  const vendorLength = buffer.readUInt32LE(offset); offset += 4 + vendorLength;
  if (offset + 4 > buffer.length) return {};
  const count = Math.min(buffer.readUInt32LE(offset), 10000); offset += 4;
  const values = {};
  for (let i = 0; i < count && offset + 4 <= buffer.length; i++) {
    const length = buffer.readUInt32LE(offset); offset += 4;
    if (length < 0 || offset + length > buffer.length) break;
    const item = buffer.toString('utf8', offset, offset + length); offset += length;
    const equals = item.indexOf('=');
    if (equals > 0) values[item.slice(0, equals).toUpperCase()] = item.slice(equals + 1);
  }
  return {
    title: values.TITLE,
    artist: values.ARTIST,
    album: values.ALBUM,
    albumArtist: values.ALBUMARTIST || values.ALBUM_ARTIST,
    track: values.TRACKNUMBER,
    disc: values.DISCNUMBER,
    date: values.DATE,
    compilation: values.COMPILATION,
  };
}

function readOggTags(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const data = Buffer.alloc(size);
    fs.readSync(descriptor, data, 0, size, 0);
    const packets = [];
    let packetParts = [], pos = 0;
    while (pos + 27 <= data.length && packets.length < 8) {
      if (data.toString('ascii', pos, pos + 4) !== 'OggS') break;
      const segmentCount = data[pos + 26];
      if (pos + 27 + segmentCount > data.length) break;
      const bodyStart = pos + 27 + segmentCount;
      let bodyOffset = bodyStart;
      for (let i = 0; i < segmentCount; i++) {
        const length = data[pos + 27 + i];
        if (bodyOffset + length > data.length) return {};
        packetParts.push(data.slice(bodyOffset, bodyOffset + length));
        bodyOffset += length;
        if (length < 255) {
          packets.push(Buffer.concat(packetParts));
          packetParts = [];
        }
      }
      pos = bodyOffset;
    }
    for (const packet of packets) {
      if (packet.slice(0, 8).toString('ascii') === 'OpusTags') return parseVorbisComments(packet, 8);
      if (packet[0] === 3 && packet.slice(1, 7).toString('ascii') === 'vorbis') return parseVorbisComments(packet, 7);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {};
}

function readFlacTags(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    const signature = Buffer.alloc(4);
    if (fs.readSync(descriptor, signature, 0, 4, 0) !== 4 || signature.toString('ascii') !== 'fLaC') return {};
    let pos = 4, isLast = false;
    while (!isLast && pos + 4 <= stat.size && pos < 32 * 1024 * 1024) {
      const header = Buffer.alloc(4);
      if (fs.readSync(descriptor, header, 0, 4, pos) !== 4) break;
      isLast = Boolean(header[0] & 0x80);
      const type = header[0] & 0x7f;
      const length = (header[1] << 16) | (header[2] << 8) | header[3];
      if (pos + 4 + length > stat.size) break;
      if (type === 4 && length <= 16 * 1024 * 1024) {
        const comments = Buffer.alloc(length);
        fs.readSync(descriptor, comments, 0, length, pos + 4);
        return parseVorbisComments(comments, 0);
      }
      pos += 4 + length;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {};
}

function readWavTags(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    const header = Buffer.alloc(12);
    if (fs.readSync(descriptor, header, 0, 12, 0) !== 12 || header.toString('ascii', 0, 4) !== 'RIFF') return {};
    let pos = 12;
    while (pos + 8 <= stat.size) {
      const chunkHeader = Buffer.alloc(8);
      if (fs.readSync(descriptor, chunkHeader, 0, 8, pos) !== 8) break;
      const id = chunkHeader.toString('ascii', 0, 4);
      const length = chunkHeader.readUInt32LE(4);
      if (length > MAX_TAG_FALLBACK_BYTES || pos + 8 + length > stat.size) break;
      if (id === 'LIST' && length >= 4 && length <= 16 * 1024 * 1024) {
        const list = Buffer.alloc(length);
        fs.readSync(descriptor, list, 0, length, pos + 8);
        if (list.toString('ascii', 0, 4) === 'INFO') {
          const info = {};
          let itemPos = 4;
          while (itemPos + 8 <= list.length) {
            const itemId = list.toString('ascii', itemPos, itemPos + 4);
            const itemLength = list.readUInt32LE(itemPos + 4);
            if (itemPos + 8 + itemLength > list.length) break;
            info[itemId] = list.toString('utf8', itemPos + 8, itemPos + 8 + itemLength).replace(/\0+$/, '');
            itemPos += 8 + itemLength + (itemLength % 2);
          }
          return { title: info.INAM, artist: info.IART, album: info.IPRD, track: info.ITRK, date: info.ICRD };
        }
      }
      pos += 8 + length + (length % 2);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {};
}

function readTagFallback(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A valid absolute media path is required.');
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) throw new Error('A supported media file is required.');
  if (ext === 'ogg' || ext === 'opus') return { tags: readOggTags(resolved) };
  if (ext === 'flac') return { tags: readFlacTags(resolved) };
  if (ext === 'wav') return { tags: readWavTags(resolved) };
  if (!['mp3', 'aac', 'm4a'].includes(ext)) return null;

  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_TAG_FALLBACK_BYTES) return null;
  if (ext === 'm4a') return { bytes: fs.readFileSync(resolved) };

  const descriptor = fs.openSync(resolved, 'r');
  try {
    const header = Buffer.alloc(Math.min(10, stat.size));
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.length === 10 && header.toString('ascii', 0, 3) === 'ID3') {
      const tagLength = Math.min(stat.size, 10 + synchsafeSize(header.slice(6, 10)));
      const bytes = Buffer.alloc(tagLength);
      fs.readSync(descriptor, bytes, 0, tagLength, 0);
      return { bytes };
    }
    if (stat.size >= 128) {
      const bytes = Buffer.alloc(128);
      fs.readSync(descriptor, bytes, 0, 128, stat.size - 128);
      return { bytes };
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return null;
}

module.exports = context => {
  context.handle('choose-folder', async event => {
    const owner = context.BrowserWindow.fromWebContents(event.sender);
    const result = await context.dialog.showOpenDialog(owner || undefined, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  context.handle('choose-cover', async (event, mediaPath) => {
    const owner = context.BrowserWindow.fromWebContents(event.sender);
    const defaultPath = typeof mediaPath === 'string' && path.isAbsolute(mediaPath)
      ? path.dirname(path.resolve(mediaPath))
      : undefined;
    const result = await context.dialog.showOpenDialog(owner || undefined, {
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const selected = path.resolve(result.filePaths[0]);
    const extension = path.extname(selected).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('A supported image file is required.');
    const stat = fs.statSync(selected);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Cover image must be smaller than 25 MB.');
    return {
      name: path.basename(selected),
      type: imageContentType(selected),
      data: fs.readFileSync(selected),
    };
  });

  context.handle('list-files', async (_event, folderPath, extensions) =>
    listFiles(await checkedDirectory(folderPath), checkedExtensions(extensions)));

  context.handle('list-dir-tree', async (_event, folderPath, extensions) =>
    listDirTree(await checkedDirectory(folderPath), checkedExtensions(extensions)));

  context.handle('directory-exists', (_event, folderPath) => directoryExists(folderPath));

  context.handle('show-item', (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A valid absolute file path is required.');
    context.shell.showItemInFolder(path.resolve(filePath));
    return true;
  });

  context.handle('read-cover-sidecar', (_event, filePath) => readCoverSidecar(filePath));
  context.handle('read-tag-fallback', (_event, filePath) => readTagFallback(filePath));

  context.registerResourceProvider('audio-player-media', ({ request, pathname }) =>
    serveMedia(request, pathname, AUDIO_EXTENSIONS, contentType));
};

// Pure helpers exposed for regression tests; Atmos still consumes the function above.
module.exports._test = { directoryExists, imageContentType, parseVorbisComments, synchsafeSize };

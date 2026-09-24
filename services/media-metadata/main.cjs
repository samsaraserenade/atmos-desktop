'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeCoverArt } = require('./cover-art.cjs');

const TAG_READ_LIMIT = 262144;

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('A valid absolute media path is required.');
  }
  return filePath;
}

function createCapability() {
  return {
    readFileBytes(filePath, maxBytes = TAG_READ_LIMIT) {
      const target = assertFilePath(filePath);
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new TypeError('The media path must identify a file.');
      const requested = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : TAG_READ_LIMIT;
      const size = Math.min(stat.size, requested, TAG_READ_LIMIT);
      const buffer = Buffer.alloc(size);
      const descriptor = fs.openSync(target, 'r');
      try {
        fs.readSync(descriptor, buffer, 0, size, 0);
      } finally {
        fs.closeSync(descriptor);
      }
      return buffer;
    },

    writeCoverArt(filePath, imageBase64, mimeType) {
      const target = assertFilePath(filePath);
      if (typeof imageBase64 !== 'string' || !imageBase64) {
        throw new TypeError('Cover art must be a non-empty base64 string.');
      }
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
        throw new TypeError('Cover art must be JPEG or PNG.');
      }
      return writeCoverArt(target, Buffer.from(imageBase64, 'base64'), mimeType);
    },
  };
}

async function activate(context) {
  const capability = createCapability();
  context.handle('read-file-bytes', (_event, filePath, maxBytes) =>
    capability.readFileBytes(filePath, maxBytes));
  context.handle('write-cover-art', (_event, filePath, imageBase64, mimeType) =>
    capability.writeCoverArt(filePath, imageBase64, mimeType));
  context.provide('media-metadata', capability);
  return capability;
}

module.exports = activate;
module.exports.activate = activate;
module.exports.createCapability = createCapability;
module.exports.assertFilePath = assertFilePath;

'use strict';
/**
 * What Atmos's own protocols (atmos-app://, atmos-ext://) serve from disk:
 * a file's type, and its bytes only when it really is a file inside the
 * folder it's served from. Moved out of main.js so it can be unit-tested
 * (protocol-files.test.cjs).
 */
const fs = require('fs');
const path = require('path');

// Extension → MIME lookup shared by every atmos-* protocol (the app shell,
// plugins, and services). Chromium silently refuses some assets served as
// application/octet-stream — notably stylesheets injected with
// `new URL('./x.css', import.meta.url)` — so every served type belongs here.
// Text types carry an explicit charset because the protocol handlers return
// raw bytes with no other encoding hint.
const MIME_BY_EXT = Object.freeze({
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.cjs':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.avif':  'image/avif',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.mp3':   'audio/mpeg',
  '.wav':   'audio/wav',
  '.ogg':   'audio/ogg',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.wasm':  'application/wasm',
});

function mimeFor(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/**
 * A file's bytes, or null when it's missing or not a file. With `root`,
 * only a file that really is inside it: a symbolic link (or junction)
 * pointing out of an extension's folder would otherwise serve whatever it
 * points at, and links aren't part of the fingerprint a community
 * extension is approved on.
 */
async function readServableFile(filePath, root = null) {
  try {
    if (root) {
      const [real, realRoot] = await Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(root)]);
      const inside = path.relative(realRoot, real);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
    }
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? await fs.promises.readFile(filePath) : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

module.exports = { MIME_BY_EXT, mimeFor, readServableFile };

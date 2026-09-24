'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

async function serveMedia(request, pathname, extensions, contentType) {
  if (!path.isAbsolute(pathname) || !extensions.has(path.extname(pathname).slice(1).toLowerCase())) {
    return new Response('Invalid media path', { status: 400 });
  }
  let handle;
  try {
    handle = await fs.promises.open(pathname, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return new Response('Not found', { status: 404 });
    let start = 0;
    let end = stat.size - 1;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const invalid = () => new Response(null, {
        status: 416, headers: { 'Content-Range': `bytes */${stat.size}` },
      });
      if (!match || (!match[1] && !match[2])) return invalid();
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
        start = Math.max(0, stat.size - suffix);
      } else {
        start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : end;
        if (!Number.isSafeInteger(requestedEnd)) return invalid();
        end = Math.min(requestedEnd, end);
      }
      if (!Number.isSafeInteger(start) || start > end || start >= stat.size) return invalid();
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(Math.max(0, end - start + 1)),
      'Content-Type': contentType(pathname),
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    const options = { status: range ? 206 : 200, headers };
    if (!stat.size || request.method === 'HEAD') return new Response(null, options);
    // Ownership transfers to the stream; cancellation closes its file handle.
    const stream = handle.createReadStream({ start, end, autoClose: true, signal: request.signal });
    handle = null;
    return new Response(Readable.toWeb(stream), options);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new Response('Not found', { status: 404 });
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = { serveMedia };

/**
 * electron/services/media-metadata/formats/flac.js
 * ─────────────────────────────────────────────────────────────────────────────
 * FLAC format logic — parsing existing metadata blocks and rebuilding the
 * file with a fresh METADATA_BLOCK_PICTURE (type 6, "Cover front").
 * https://xiph.org/flac/format.html#metadata_block_picture
 *
 * Pure buffer-in/buffer-out — no filesystem access. cover-art.js owns
 * reading the file and writing the result back.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Given the raw bytes of a FLAC file and a cover image, return a new Buffer
 * for the whole file with all existing PICTURE blocks removed and a fresh
 * one inserted. All other metadata blocks are preserved verbatim; audio
 * frames are left completely untouched. Throws if `data` isn't a valid
 * FLAC file.
 */
function buildFlacWithCover(data, imgBuffer, mimeType) {
  if (data.slice(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('Not a valid FLAC file');
  }

  // ── Collect existing metadata blocks (skip all PICTURE blocks) ──────────────
  const blocks = [];
  let pos      = 4;
  let isLast   = false;

  while (!isLast && pos + 4 <= data.length) {
    const headerByte = data[pos];
    isLast    = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7F;
    const blockLen  = (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3];

    if (pos + 4 + blockLen > data.length) break;
    const blockData = data.slice(pos + 4, pos + 4 + blockLen);

    // type 6 = PICTURE — drop all of them; we'll add our own
    if (blockType !== 6) blocks.push({ type: blockType, data: blockData });

    pos += 4 + blockLen;
  }

  // Remaining bytes are audio frames
  const audioData = data.slice(pos);

  // ── Build METADATA_BLOCK_PICTURE ────────────────────────────────────────────
  const mime      = mimeType || 'image/jpeg';
  const mimeBytes = Buffer.from(mime, 'ascii');
  const descBytes = Buffer.alloc(0); // empty description

  const picTypeB  = Buffer.allocUnsafe(4); picTypeB.writeUInt32BE(3, 0);  // Cover (front)
  const mimeLenB  = Buffer.allocUnsafe(4); mimeLenB.writeUInt32BE(mimeBytes.length, 0);
  const descLenB  = Buffer.allocUnsafe(4); descLenB.writeUInt32BE(0, 0);
  const zeros4    = Buffer.alloc(4, 0);    // width / height / bpp / colours — unknown
  const imgLenB   = Buffer.allocUnsafe(4); imgLenB.writeUInt32BE(imgBuffer.length, 0);

  const picData = Buffer.concat([
    picTypeB,  mimeLenB,  mimeBytes,
    descLenB,  descBytes,
    zeros4,    zeros4,    zeros4,    zeros4,   // w, h, bpp, colours
    imgLenB,   imgBuffer,
  ]);

  blocks.push({ type: 6, data: picData });

  // ── Reassemble file ─────────────────────────────────────────────────────────
  const parts = [Buffer.from('fLaC')];

  for (let i = 0; i < blocks.length; i++) {
    const isLastBlock = i === blocks.length - 1;
    const hdr = Buffer.allocUnsafe(4);
    hdr[0] = (isLastBlock ? 0x80 : 0x00) | (blocks[i].type & 0x7F);
    // 24-bit big-endian block length
    hdr[1] = (blocks[i].data.length >> 16) & 0xFF;
    hdr[2] = (blocks[i].data.length >>  8) & 0xFF;
    hdr[3] =  blocks[i].data.length        & 0xFF;
    parts.push(hdr, blocks[i].data);
  }

  parts.push(audioData);
  return Buffer.concat(parts);
}

module.exports = {
  buildFlacWithCover,
};

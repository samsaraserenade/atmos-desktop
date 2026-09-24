/**
 * electron/services/media-metadata/formats/id3.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ID3v2 format logic — parsing an existing tag and rebuilding one with a
 * fresh APIC (cover art) frame. Supports both ID3v2.3 (regular 32-bit frame
 * sizes) and ID3v2.4 (synchsafe 32-bit frame sizes). If the file has no
 * ID3v2 header, a fresh ID3v2.3 tag is prepended.
 *
 * Pure buffer-in/buffer-out — no filesystem access. cover-art.js owns
 * reading the file and writing the result back.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Decode a 4-byte synchsafe integer (ID3v2 standard). */
function decodeSynchsafe(b0, b1, b2, b3) {
  return ((b0 & 0x7F) << 21) | ((b1 & 0x7F) << 14) | ((b2 & 0x7F) << 7) | (b3 & 0x7F);
}

/** Encode an integer as a 4-byte synchsafe integer. */
function encodeSynchsafe(n) {
  return [
    (n >> 21) & 0x7F,
    (n >> 14) & 0x7F,
    (n >> 7)  & 0x7F,
     n        & 0x7F,
  ];
}

/**
 * Given the raw bytes of an audio file and a cover image, return a new
 * Buffer for the whole file with the APIC frame replaced (or added).
 * Any existing ID3v2 tag's non-APIC frames are preserved verbatim; audio
 * data is left completely untouched.
 */
function buildId3WithCover(data, imgBuffer, mimeType) {
  let id3End     = 0;    // byte offset where existing ID3 tag ends (0 = no tag)
  let id3Version = 3;    // ID3v2 major version to preserve/use
  let id3Flags   = 0;    // original tag flags (used only to detect extended header)
  const frames   = [];   // collected frame buffers (APIC excluded)

  // ── Parse existing ID3v2 tag ────────────────────────────────────────────────
  if (data.length >= 10 &&
      data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {

    id3Version = data[3];
    id3Flags   = data[5];
    const tagSize = decodeSynchsafe(data[6], data[7], data[8], data[9]);
    id3End = 10 + tagSize;

    let pos = 10;

    // Skip extended header if the flag is set
    if (id3Flags & 0x40) {
      const extSize = id3Version === 4
        ? decodeSynchsafe(data[pos], data[pos+1], data[pos+2], data[pos+3])
        : data.readUInt32BE(pos);
      pos += extSize;
    }

    // Walk frames, collecting everything except APIC
    while (pos + 10 <= id3End) {
      const fid = data.slice(pos, pos + 4).toString('ascii');
      // Padding or garbage — stop
      if (!/^[A-Z0-9]{4}$/.test(fid)) break;

      let fsize;
      if (id3Version === 4) {
        fsize = decodeSynchsafe(data[pos+4], data[pos+5], data[pos+6], data[pos+7]);
      } else {
        fsize = data.readUInt32BE(pos + 4);
      }
      if (fsize < 0 || pos + 10 + fsize > id3End) break;

      if (fid !== 'APIC') {
        frames.push(data.slice(pos, pos + 10 + fsize));
      }
      pos += 10 + fsize;
    }
  }

  // ── Build new APIC frame ────────────────────────────────────────────────────
  const mime = mimeType || 'image/jpeg';

  // Frame content: encoding(1) + MIME+NUL + picType(1) + desc+NUL + imageData
  const apicContent = Buffer.concat([
    Buffer.from([0x00]),                     // text encoding: ISO-8859-1
    Buffer.from(mime + '\x00', 'latin1'),    // MIME type, null-terminated
    Buffer.from([0x03]),                     // picture type: 3 = Cover (front)
    Buffer.from([0x00]),                     // description: empty string + NUL
    imgBuffer,
  ]);

  // Frame size field — encoding depends on ID3 version
  const apicSizeBuf = Buffer.allocUnsafe(4);
  if (id3Version === 4) {
    Buffer.from(encodeSynchsafe(apicContent.length)).copy(apicSizeBuf);
  } else {
    apicSizeBuf.writeUInt32BE(apicContent.length, 0);
  }

  frames.push(Buffer.concat([
    Buffer.from('APIC'),
    apicSizeBuf,
    Buffer.from([0x00, 0x00]),  // frame flags
    apicContent,
  ]));

  // ── Rebuild tag ──────────────────────────────────────────────────────────────
  const framesData = Buffer.concat(frames);
  const tagSizeSS  = Buffer.from(encodeSynchsafe(framesData.length));

  // New 10-byte ID3v2 header (flags = 0: no unsync, no extended header)
  const newHeader = Buffer.from([
    0x49, 0x44, 0x33,  // "ID3"
    id3Version,         // major version (preserve original: 3 or 4)
    0x00,               // revision
    0x00,               // flags (clear — we're not writing an extended header)
    tagSizeSS[0], tagSizeSS[1], tagSizeSS[2], tagSizeSS[3],
  ]);

  // Audio data begins immediately after the original ID3 tag (or from byte 0)
  const audioData = data.slice(id3End);
  return Buffer.concat([newHeader, framesData, audioData]);
}

module.exports = {
  decodeSynchsafe,
  encodeSynchsafe,
  buildId3WithCover,
};

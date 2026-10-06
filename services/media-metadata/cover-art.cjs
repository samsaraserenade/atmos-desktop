/**
 * electron/services/media-metadata/cover-art.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cover Art Writer — the capability, not the IPC plumbing (see index.js for
 * that). Supports writing embedded cover art to:
 *
 *   • MP3 / MP2 / MP1 — ID3v2 APIC frame (v2.3, v2.4; PIC in v2.2) [formats/id3.js]
 *   • FLAC            — METADATA_BLOCK_PICTURE             [formats/flac.js]
 *   • Everything else — sidecar cover.jpg / cover.png alongside the audio file
 *
 * All three paths leave the audio data itself completely untouched. This
 * module is filesystem-facing (it replaces the audio file whole, through a
 * temporary copy, so a crash can't leave it half written) but otherwise
 * knows nothing about panels, plugins, or the renderer — any plugin that
 * needs to write cover art calls this indirectly, via the IPC handler this
 * service registers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const { buildId3WithCover }  = require('./formats/id3.cjs');
const { buildFlacWithCover } = require('./formats/flac.cjs');

// On Windows a file can't be replaced while something holds it open: a
// virus scanner or the indexer for a moment (the new temporary file too),
// a player for longer. Try again for about two seconds.
const REPLACE_RETRY_MS = [50, 100, 200, 400, 600, 800];
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Replace `filePath`'s contents with `data` without ever leaving it half
 * written: the new bytes go to a temporary file beside it, which then
 * replaces the original in one step. If the file still can't be replaced
 * after a few tries (on Windows, another program has it open), the original
 * is left as it was and that's reported: writing over it in place could
 * stop part-way and leave neither copy whole.
 */
async function replaceFile(filePath, data) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.atmos-${process.pid}-${Date.now()}.tmp`);
  const { mode } = fs.statSync(filePath);
  const handle = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
  } catch (error) {
    fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(handle);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, filePath);
      return;
    } catch (error) {
      if (LOCKED.has(error.code) && attempt < REPLACE_RETRY_MS.length) {
        await wait(REPLACE_RETRY_MS[attempt]);
        continue;
      }
      fs.rmSync(temporary, { force: true });
      if (LOCKED.has(error.code)) {
        throw new Error(`${path.basename(filePath)} couldn't be replaced: it may be open in another program (or playing), or read-only. Try again once it's free`);
      }
      throw error;
    }
  }
}

/**
 * Write cover art into the given audio file.
 *
 * @param {string} filePath   - Absolute OS path to the audio file.
 * @param {Buffer} imgBuffer  - Raw image bytes.
 * @param {string} mimeType   - MIME type of the image ('image/jpeg' | 'image/png' | …)
 * @returns {Promise<{ ok: boolean, sidecar?: boolean, ext?: string, error?: string }>}
 *   sidecar = true means the image was saved as cover.jpg/png next to the
 *   file instead of being embedded (unsupported format).
 */
async function writeCoverArt(filePath, imgBuffer, mimeType) {
  try {
    const ext = path.extname(filePath).toLowerCase().slice(1);

    if (['mp3', 'mp2', 'mp1'].includes(ext)) {
      const data    = fs.readFileSync(filePath);
      const rebuilt = buildId3WithCover(data, imgBuffer, mimeType);
      await replaceFile(filePath, rebuilt);
      return { ok: true };
    }

    if (ext === 'flac') {
      const data    = fs.readFileSync(filePath);
      const rebuilt = buildFlacWithCover(data, imgBuffer, mimeType);
      await replaceFile(filePath, rebuilt);
      return { ok: true };
    }

    // Unsupported embedded format — write sidecar file instead
    const dir         = path.dirname(filePath);
    const sidecarExt  = mimeType === 'image/png' ? 'png' : 'jpg';
    const sidecarPath = path.join(dir, `cover.${sidecarExt}`);
    // Never written through: a cover.jpg that is a link could lead
    // anywhere (outside the library). One that's a file is replaced whole;
    // a link is removed and a file made in its place.
    let existing = null;
    try { existing = fs.lstatSync(sidecarPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing?.isFile()) await replaceFile(sidecarPath, imgBuffer);
    else {
      if (existing) fs.unlinkSync(sidecarPath);
      fs.writeFileSync(sidecarPath, imgBuffer, { flag: 'wx' });
    }
    return { ok: true, sidecar: true, ext };

  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  writeCoverArt,
  replaceFile,
};

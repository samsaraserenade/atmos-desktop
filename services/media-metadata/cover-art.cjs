/**
 * electron/services/media-metadata/cover-art.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cover Art Writer — the capability, not the IPC plumbing (see index.js for
 * that). Supports writing embedded cover art to:
 *
 *   • MP3 / MP2 / MP1 — ID3v2 APIC frame (v2.3 and v2.4)   [formats/id3.js]
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

/**
 * Replace `filePath`'s contents with `data` without ever leaving it half
 * written: the new bytes go to a temporary file beside it, which then
 * replaces the original in one step. If the file is open elsewhere (Windows
 * refuses to replace it then), the complete temporary copy is copied over
 * it instead.
 */
function replaceFile(filePath, data) {
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
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      fs.copyFileSync(temporary, filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * Write cover art into the given audio file.
 *
 * @param {string} filePath   - Absolute OS path to the audio file.
 * @param {Buffer} imgBuffer  - Raw image bytes.
 * @param {string} mimeType   - MIME type of the image ('image/jpeg' | 'image/png' | …)
 * @returns {{ ok: boolean, sidecar?: boolean, ext?: string, error?: string }}
 *   sidecar = true means the image was saved as cover.jpg/png next to the
 *   file instead of being embedded (unsupported format).
 */
function writeCoverArt(filePath, imgBuffer, mimeType) {
  try {
    const ext = path.extname(filePath).toLowerCase().slice(1);

    if (['mp3', 'mp2', 'mp1'].includes(ext)) {
      const data    = fs.readFileSync(filePath);
      const rebuilt = buildId3WithCover(data, imgBuffer, mimeType);
      replaceFile(filePath, rebuilt);
      return { ok: true };
    }

    if (ext === 'flac') {
      const data    = fs.readFileSync(filePath);
      const rebuilt = buildFlacWithCover(data, imgBuffer, mimeType);
      replaceFile(filePath, rebuilt);
      return { ok: true };
    }

    // Unsupported embedded format — write sidecar file instead
    const dir         = path.dirname(filePath);
    const sidecarExt  = mimeType === 'image/png' ? 'png' : 'jpg';
    const sidecarPath = path.join(dir, `cover.${sidecarExt}`);
    fs.writeFileSync(sidecarPath, imgBuffer);
    return { ok: true, sidecar: true, ext };

  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  writeCoverArt,
  replaceFile,
};

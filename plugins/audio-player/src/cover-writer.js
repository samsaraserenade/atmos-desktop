// Writing a new cover into an album's files (engine side; the cover editor
// in the panel prepares the image). Media Metadata embeds it where the
// format allows and falls back to a cover.jpg beside the files.
import { writeCoverArt } from './media-metadata.js';

export async function persistCover(filePaths, embedBase64, mimeType) {
  let sidecarUsed = false;
  let sidecarExt = null;
  let anyWriteErr = false;
  const seen = new Set();
  for (const filePath of filePaths) {
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const result = await writeCoverArt(filePath, embedBase64, mimeType);
    if (!result?.ok) {
      console.warn('[audio-player] writeCoverArt failed for', filePath, result?.error);
      anyWriteErr = true;
    } else if (result.sidecar) {
      sidecarUsed = true;
      sidecarExt = result.ext || '?';
    }
  }
  return { anyWriteErr, sidecarUsed, sidecarExt };
}

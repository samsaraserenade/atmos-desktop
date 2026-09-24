/**
 * services/media-metadata/renderer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Media metadata service — reading/writing tags and cover art on audio
 * files. Privileged operations go to this service's main.cjs through the
 * route the consumer passes to setInvoke(), while tag parsing stays here, same role as js/services/location.js:
 * DOM-free, feature-agnostic, callable by any plugin that needs this
 * capability — not owned by, or aware of, audio-player specifically.
 *
 * readTags() (and its jsmediatags loader) moved here from
 * js/plugins/audio-player/library.js — reading raw ID3/tag data off a file
 * has no audio-player-specific decisions in it, unlike library.js's own
 * picToDataUrl(), which crops embedded cover art to a 400x400 square
 * specifically for the album grid and stays a library.js concern.
 *
 * audio-player's library scanner (js/plugins/audio-player/library.js) is
 * the first consumer, but nothing here knows a library scanner exists.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Reaching the main process ────────────────────────────────────────────────
// This module is a library: it runs in whichever document imports it and
// reaches the service's IPC handlers only through the route its consumer
// passes in. From a frame (declare "invokes": ["service:media-metadata"]):
//
//   import atmos from 'atmos-sdk';
//   const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
//   metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));
//
// From the Atmos page, pass Core's bridge the same way (see Audio Player's
// src/media-metadata.js).
let _invoke = null;

/** Route this module's main-process calls through `fn(channel, ...args)`. */
export function setInvoke(fn) {
  if (typeof fn !== 'function') throw new TypeError('media-metadata: setInvoke needs a function');
  _invoke = fn;
}

/**
 * Write cover art into an audio file's metadata (embedded APIC/PICTURE
 * frame where supported, sidecar cover.jpg/png otherwise).
 *
 * @param {string} filePath    - Absolute OS path to the audio file.
 * @param {string} imageBase64 - Base64-encoded image bytes.
 * @param {string} mimeType    - e.g. 'image/jpeg' or 'image/png'.
 * @returns {Promise<{ok:boolean, sidecar?:boolean, ext?:string, error?:string}>}
 */
export function writeCoverArt(filePath, imageBase64, mimeType) {
  if (!_invoke) {
    return Promise.resolve({ ok: false, error: 'writeCoverArt not available (no route to the main process; call setInvoke())' });
  }
  return _invoke('write-cover-art', filePath, imageBase64, mimeType);
}

// ── jsmediatags loader ───────────────────────────────────────────────────────
// jsmediatags.min.js is a legacy UMD-style bundle that only ever exposes a
// plain `window.jsmediatags` global — it has no ES export to import. Loaded
// here (as a classic script, still a plain global) so any consumer of
// readTags() gets it lazily on first use, without needing to know it exists.
// Idempotent and safe to call from multiple entry points.
let _jsmediatagsPromise = null;
function _ensureJsMediaTags() {
  if (window.jsmediatags) return Promise.resolve();
  if (_jsmediatagsPromise) return _jsmediatagsPromise;
  _jsmediatagsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./jsmediatags.min.js', import.meta.url).href;
    script.onload  = () => resolve();
    script.onerror = () => reject(new Error('failed to load jsmediatags.min.js'));
    document.head.appendChild(script);
  });
  return _jsmediatagsPromise;
}

/**
 * Normalise the raw jsmediatags output into a flat object we can rely on.
 * jsmediatags exposes its shorthand keys (title, artist, album…) plus the raw
 * ID3 frames by their 4-char frame ID.  TPE2 (Album Artist) is only available
 * via the raw frame ID — it has no shorthand alias.
 */
function _normaliseTags(raw) {
  // TPE2 frame value may be a plain string or an object with a .data property
  const tpe2 = raw.TPE2;
  const albumArtist = typeof tpe2 === 'string'
    ? tpe2
    : (tpe2?.data ?? tpe2?.v ?? raw.band ?? raw.album_artist ?? '');

  return { ...raw, albumArtist };
}

/**
 * Read ID3/tag data off an audio file — title, artist, album, albumArtist,
 * track number, embedded picture (raw jsmediatags picture object, not yet
 * converted to a displayable image), etc. Returns {} on any failure so
 * callers can always fall back to filename-derived metadata.
 *
 * @param {string} filePath - Absolute OS path to the audio file.
 * @returns {Promise<object>} flat, normalised tag object (possibly empty)
 */
export async function readTags(filePath) {
  try {
    await _ensureJsMediaTags();
  } catch (err) {
    console.error('[media-metadata]', err.message);
    return {};
  }

  // Preferred path: ask the main process to read the raw bytes via IPC, then
  // feed jsmediatags a Blob. This sidesteps Chromium's file:// XHR restrictions
  // entirely and works reliably regardless of Electron security settings.
  if (_invoke) {
    try {
      const bytes = await _invoke('read-file-bytes', filePath);
      if (bytes && bytes.byteLength > 0) {
        return await new Promise(resolve => {
          window.jsmediatags.read(new Blob([bytes]), {
            onSuccess: tag => resolve(_normaliseTags(tag.tags || {})),
            onError:   ()  => resolve({}),
          });
        });
      }
    } catch (_e) { /* return the normal empty metadata fallback below */ }
  }

  return {};
}

// Future: export function readCoverArt(filePath) { ... }
// (raw embedded picture → data URL, no cropping/resizing — for consumers
// that want the original image rather than library.js's grid-shaped thumbnail)

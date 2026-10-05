/**
 * What a Now Playing session may hold (atmos.nowPlaying, SDK 1.4), checked
 * as Atmos checks it: Core's hub (core/js/core/now-playing.js) and the fake
 * Atmos extensions test against (testing/fake-atmos.mjs) both use this, so
 * a test passes only with what Atmos takes.
 *
 * Text is plain and bounded. Artwork is read byte by byte: a PNG, JPEG,
 * WebP or GIF by its first bytes, whatever type it claims, 1 MB and 4096
 * pixels a side at most, and passed on as a Blob made here.
 */

export const ACTIONS = Object.freeze(['toggle', 'next', 'previous', 'seek', 'volume']);
const MAX_TEXT = 200;
const MAX_FROM = 80;
export const MAX_ARTWORK_BYTES = 1024 * 1024;  // one image
const MAX_ARTWORK_SIDE = 4096;                 // pixels
const MAX_DATA_URL = 40 + Math.ceil(MAX_ARTWORK_BYTES / 3) * 4;
const DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

// Characters that don't show or that reorder text: control and format
// characters (bidi overrides among them) but the joiners emoji need, line
// and paragraph separators, unpaired surrogates and Hangul fillers.
const HIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\u115F\u1160\u3164\uFFA0]|(?![\u200C\u200D])\p{Cf}/gu;

/** Plain text, one line, at most `max` characters (whole ones). */
export function text(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('Now Playing text must be a string');
  const clean = value.slice(0, max * 4).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return (chars.length > max ? chars.slice(0, max).join('').trim() : clean) || null;
}

function seconds(value, what) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`Now Playing ${what} is a number of seconds, 0 or more`);
  return value;
}

/** A session key: 1–64 letters, digits, - _ . : */
export function sessionKey(value = 'main') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
    throw new TypeError('a Now Playing key is 1–64 letters, digits, - _ . or :');
  }
  return value;
}

/**
 * What an extension may say it plays, checked, all but its artwork (which
 * readArtwork reads). Throws a TypeError naming the field.
 */
export function normalizeSession(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('atmos.nowPlaying.set(session): session is an object');
  const title = text(input.title, MAX_TEXT);
  if (!title) throw new TypeError('a Now Playing session has a title');
  const actions = input.actions == null ? [] : input.actions;
  if (!Array.isArray(actions) || actions.length > 20) throw new TypeError(`Now Playing actions are a list of: ${ACTIONS.join(', ')}`);
  for (const action of actions) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Now Playing actions are ${ACTIONS.join(', ')}; “${String(action).slice(0, 20)}” isn’t one`);
  }
  let volume = null;
  if (input.volume != null) {
    if (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 100) throw new TypeError('Now Playing volume is 0–100');
    volume = input.volume;
  }
  // false: this start wasn't the user's doing (a page that began playing
  // by itself): it shows only when nothing else plays.
  if (input.startedByUser != null && typeof input.startedByUser !== 'boolean') throw new TypeError('Now Playing startedByUser is true or false');
  const duration = seconds(input.duration, 'duration');
  const position = seconds(input.position, 'position');
  return {
    title,
    artist: text(input.artist, MAX_TEXT),
    album: text(input.album, MAX_TEXT),
    from: text(input.from, MAX_FROM),
    duration,
    position: position == null ? null : (duration == null ? position : Math.min(position, duration)),
    playing: input.playing === true,
    actions: [...new Set(actions)],
    volume,
  };
}

// ── Artwork ─────────────────────────────────────────────────────────────────

const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const be32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * A GIF's size: its screen, or more where a frame reaches past it (a
 * decoder makes room for it), every frame walked. null if it's cut short.
 */
function gifSize(b) {
  let width = le16(b, 6);
  let height = le16(b, 8);
  let i = 13;
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7));
  const skipBlocks = at => { while (at < b.length && b[at] !== 0) at += b[at] + 1; return at + 1; };
  while (i < b.length) {
    const block = b[i];
    if (block === 0x3b) break; // the end
    if (block === 0x21) { i = skipBlocks(i + 2); continue; } // an extension
    if (block !== 0x2c || i + 10 > b.length) return null;
    width = Math.max(width, le16(b, i + 1) + le16(b, i + 5));
    height = Math.max(height, le16(b, i + 3) + le16(b, i + 7));
    const flags = b[i + 9];
    i += 10;
    if (flags & 0x80) i += 3 * (2 << (flags & 7));
    i = skipBlocks(i + 1); // past the LZW code size and the image data
  }
  return { type: 'image/gif', width, height };
}

/** { type, width, height } from an image's own bytes, or null: PNG, JPEG, WebP or GIF only. */
export function sniffImage(b) {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return { type: 'image/png', width: be32(b, 16), height: be32(b, 20) };
  }
  if (b.length >= 13 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return gifSize(b);
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: 'image/webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      return { type: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The frame header (SOFn) gives the size; markers before it are skipped.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', width: be16(b, i + 7), height: be16(b, i + 5) };
      }
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  return null;
}

/** FNV-1a over the bytes, with their length: the same image, the same key. */
function artworkKey(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return `${bytes.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Artwork: an image Blob or a data: URL of one, 1 MB at most, read here.
 * Resolves { blob, key, bytes } (a Blob Core made, typed by what the bytes
 * are) or null. No SVG (it can carry script), no address Atmos would fetch,
 * nothing that decodes into more than 4096 pixels a side.
 */
export async function readArtwork(value) {
  if (value == null) return null;
  let bytes;
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (value.size > MAX_ARTWORK_BYTES) throw new TypeError('Now Playing artwork is 1 MB at most');
    bytes = new Uint8Array(await value.arrayBuffer());
  } else if (typeof value === 'string') {
    if (value.length > MAX_DATA_URL) throw new TypeError('Now Playing artwork is 1 MB at most');
    const match = DATA_URL.exec(value);
    if (!match) throw new TypeError('Now Playing artwork is an image Blob or a data: URL of a PNG, JPEG, WebP or GIF');
    const binary = atob(match[1]);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length > MAX_ARTWORK_BYTES) throw new TypeError('Now Playing artwork is 1 MB at most');
  } else {
    throw new TypeError('Now Playing artwork is an image Blob or a data: URL');
  }
  const image = sniffImage(bytes);
  if (!image) throw new TypeError('Now Playing artwork is a PNG, JPEG, WebP or GIF image');
  if (!(image.width > 0 && image.height > 0 && image.width <= MAX_ARTWORK_SIDE && image.height <= MAX_ARTWORK_SIDE)) {
    throw new TypeError(`Now Playing artwork is at most ${MAX_ARTWORK_SIDE} pixels a side`);
  }
  return { blob: new Blob([bytes], { type: image.type }), key: artworkKey(bytes), bytes: bytes.length };
}

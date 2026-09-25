/**
 * js/plugins/matrix-chat/src/ui/blurhash.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Blurhash decoding (MSC2448: xyz.amorgan.blurhash). Paints the placeholder
 * shown before hydrateMedia has resolved real bytes for an image/video.
 * Pure math over a tiny grid, no DOM/Matrix dependency beyond canvas — split
 * out of room-view.js as its own self-contained module.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BLURHASH_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str) {
  let value = 0;
  for (const c of str) value = value * 83 + BLURHASH_DIGITS.indexOf(c);
  return value;
}

function decodeSrgb(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function encodeSrgb(v) {
  const c = Math.max(0, Math.min(1, v));
  return c <= 0.0031308
    ? Math.round(c * 12.92 * 255 + 0.5)
    : Math.round((1.055 * c ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(val, exp) {
  return Math.sign(val) * Math.abs(val) ** exp;
}

function decodeBlurhashPixels(hash, width, height) {
  const sizeFlag = decode83(hash[0]);
  const componentsX = (sizeFlag % 9) + 1;
  const componentsY = Math.floor(sizeFlag / 9) + 1;
  const quantisedMax = decode83(hash[1]);
  const maximumValue = (quantisedMax + 1) / 166;

  const colors = [];
  for (let i = 0; i < componentsX * componentsY; i++) {
    if (i === 0) {
      const value = decode83(hash.substring(2, 6));
      colors.push([decodeSrgb(value >> 16), decodeSrgb((value >> 8) & 255), decodeSrgb(value & 255)]);
    } else {
      const value = decode83(hash.substring(4 + i * 2, 6 + i * 2));
      colors.push([
        signPow((Math.floor(value / 361) - 9) / 9, 2) * maximumValue,
        signPow((Math.floor(value / 19) % 19 - 9) / 9, 2) * maximumValue,
        signPow((value % 19 - 9) / 9, 2) * maximumValue,
      ]);
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < componentsY; j++) {
        for (let i = 0; i < componentsX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const [cr, cg, cb] = colors[i + j * componentsX];
          r += cr * basis;
          g += cg * basis;
          b += cb * basis;
        }
      }
      const idx = (y * width + x) * 4;
      pixels[idx] = encodeSrgb(r);
      pixels[idx + 1] = encodeSrgb(g);
      pixels[idx + 2] = encodeSrgb(b);
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

// Small enough to be instant even when many placeholders render at once
// (a room's initial timeline paint), large enough not to look obviously
// blocky as a blurred backdrop behind a still-loading image/video.
const BLURHASH_DECODE_DIM = 32;

// hash -> data: URL. renderTimeline() fully rebuilds up to `windowSize`
// messages' HTML on every scroll-triggered pagination and window-growth
// call (see renderTimeline's own comment on why it works that way), which
// means the same event's blurhash gets handed to renderEventBody again on
// every one of those re-renders — without this cache, decodeBlurhashToDataUrl's
// trig-heavy decode loop plus a canvas putImageData+toDataURL (PNG encode)
// would re-run from scratch for every image/video in the window, every
// time, which is exactly the kind of synchronous main-thread work that
// shows up as scroll stutter. The decode is a pure function of the hash
// string, so caching it here is always correct — never invalidated,
// never revisited with different output for the same key.
const blurhashPlaceholderCache = new Map();

// Returns a data: URL of the decoded placeholder, or null if the hash is
// malformed (a differently-shaped or corrupt hash from some other
// client) — callers just skip the backdrop in that case rather than
// showing a broken image.
export function decodeBlurhashToDataUrl(hash) {
  const cached = blurhashPlaceholderCache.get(hash);
  if (cached !== undefined) return cached;

  let result;
  try {
    const pixels = decodeBlurhashPixels(hash, BLURHASH_DECODE_DIM, BLURHASH_DECODE_DIM);
    const canvas = document.createElement('canvas');
    canvas.width = BLURHASH_DECODE_DIM;
    canvas.height = BLURHASH_DECODE_DIM;
    canvas.getContext('2d').putImageData(new ImageData(pixels, BLURHASH_DECODE_DIM, BLURHASH_DECODE_DIM), 0, 0);
    result = canvas.toDataURL('image/png');
  } catch {
    result = null;
  }
  blurhashPlaceholderCache.set(hash, result);
  return result;
}

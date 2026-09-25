export function createMediaService(runtime, { encryptAttachment, probe, buildPreview } = {}) {
  const client = runtime.client;
  function msgtypeFor(mimetype) {
    if (mimetype.startsWith('image/')) return 'm.image';
    if (mimetype.startsWith('video/')) return 'm.video';
    if (mimetype.startsWith('audio/')) return 'm.audio';
    return 'm.file';
  }

  // ─── Blurhash encoding (MSC2448: xyz.amorgan.blurhash) ────────────────────
  // A blurhash is a short base83 string that compresses an image's dominant
  // colors/gradient into ~20-30 characters — cheap enough to ride along in
  // content.info and decode client-side (room-view.js's job) into a blurred
  // placeholder that paints instantly, well before either the real
  // thumbnail or the full file has been fetched/decrypted. Only the encoder
  // lives here; nothing on the sending side ever needs to decode one.
  const BLURHASH_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

  function encode83(value, length) {
    let result = '';
    for (let i = 1; i <= length; i++) {
      const digit = Math.floor(value / 83 ** (length - i)) % 83;
      result += BLURHASH_DIGITS[digit];
    }
    return result;
  }

  function srgbToLinear(v) {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function linearToSrgb(v) {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.0031308
      ? Math.round(c * 12.92 * 255 + 0.5)
      : Math.round((1.055 * c ** (1 / 2.4) - 0.055) * 255 + 0.5);
  }

  function signPow(val, exp) {
    return Math.sign(val) * Math.abs(val) ** exp;
  }

  // DC/AC basis coefficient for component (i,j) over the whole sampled
  // image — O(width*height) per component, which is why callers always run
  // this over a downscaled BLURHASH_SAMPLE_DIM frame rather than a
  // full-resolution one.
  function basisCoefficient(pixels, width, height, i, j) {
    let r = 0, g = 0, b = 0;
    const normalisation = (i === 0 && j === 0) ? 1 : 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const basis = normalisation * Math.cos((Math.PI * i * x) / width) * Math.cos((Math.PI * j * y) / height);
        const idx = (y * width + x) * 4;
        r += basis * srgbToLinear(pixels[idx]);
        g += basis * srgbToLinear(pixels[idx + 1]);
        b += basis * srgbToLinear(pixels[idx + 2]);
      }
    }
    const scale = 1 / (width * height);
    return [r * scale, g * scale, b * scale];
  }

  // Encodes raw RGBA pixel data (as returned by canvas getImageData) into a
  // blurhash string. 4x3 components matches the reference implementation
  // (and most other Matrix clients' default) — more components capture
  // more detail but produce a longer string for basically no visual gain
  // at placeholder scale.
  function encodeBlurhash(pixels, width, height, componentsX = 4, componentsY = 3) {
    const factors = [];
    for (let j = 0; j < componentsY; j++) {
      for (let i = 0; i < componentsX; i++) {
        factors.push(basisCoefficient(pixels, width, height, i, j));
      }
    }
    const [dc, ...ac] = factors;

    let hash = encode83((componentsX - 1) + (componentsY - 1) * 9, 1);

    let maximumValue;
    if (ac.length > 0) {
      const actualMax = Math.max(...ac.flat().map(Math.abs));
      const quantisedMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
      maximumValue = (quantisedMax + 1) / 166;
      hash += encode83(quantisedMax, 1);
    } else {
      maximumValue = 1;
      hash += encode83(0, 1);
    }

    const [dcR, dcG, dcB] = dc;
    hash += encode83((linearToSrgb(dcR) << 16) + (linearToSrgb(dcG) << 8) + linearToSrgb(dcB), 4);

    for (const [r, g, b] of ac) {
      const q = (v) => Math.max(0, Math.min(18, Math.floor(signPow(v / maximumValue, 0.5) * 9 + 9.5)));
      hash += encode83(q(r) * 361 + q(g) * 19 + q(b), 2);
    }

    return hash;
  }

  // ─── Thumbnail + blurhash generation (client-side, before upload) ─────────
  // Real preview thumbnail dimensions are capped to the same ceiling as
  // Synapse's largest default thumbnail preset (see THUMBNAIL_PRESETS
  // above) — no point uploading a "preview" bigger than what the receiving
  // side would ever request back.
  const THUMBNAIL_MAX_W = 800;
  const THUMBNAIL_MAX_H = 600;

  // Blurhash is sampled from a tiny frame — the DCT sum in
  // basisCoefficient() is O(width*height*components), and nothing about
  // placeholder quality benefits from feeding it more than a handful of
  // pixels per axis.
  const BLURHASH_SAMPLE_DIM = 32;

  function scaleToFit(width, height, maxW, maxH) {
    const ratio = Math.min(maxW / width, maxH / height, 1);
    return { w: Math.max(1, Math.round(width * ratio)), h: Math.max(1, Math.round(height * ratio)) };
  }

  // Draws `source` (an ImageBitmap or HTMLVideoElement — anything valid as
  // a CanvasImageSource) onto a fresh canvas at w×h. Shared by both the
  // real-thumbnail and blurhash-sampling paths below so a video frame only
  // has to be captured once.
  function drawToCanvas(source, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    return canvas;
  }

  function canvasToBlurhash(canvas) {
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return encodeBlurhash(data, canvas.width, canvas.height);
  }

  function canvasToJpegBlob(canvas, quality = 0.7) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))), 'image/jpeg', quality);
    });
  }

  /**
   * Generates a real preview thumbnail (small JPEG, destined for
   * content.info.thumbnail_url/thumbnail_file) and a blurhash (destined for
   * content.info["xyz.amorgan.blurhash"], the near-instant placeholder
   * room-view.js paints before either the thumbnail or the full file has
   * arrived) from an image or video File. Returns null for any other file
   * type, or on failure (corrupt file, unsupported codec, browser can't
   * decode it) — same best-effort/non-fatal contract as probeMediaInfo:
   * neither a thumbnail nor a blurhash is ever required for a valid upload.
   */
  async function generateThumbnailAndBlurhash(file) {
    let source, sourceW, sourceH;
    let cleanup = () => {};

    try {
      if (file.type.startsWith('image/')) {
        const bitmap = await createImageBitmap(file);
        source = bitmap;
        sourceW = bitmap.width;
        sourceH = bitmap.height;
        cleanup = () => bitmap.close?.();
      } else if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        const objectUrl = URL.createObjectURL(file);
        cleanup = () => URL.revokeObjectURL(objectUrl);
        await new Promise((resolve, reject) => {
          video.preload = 'auto';
          video.muted = true;
          video.onloadeddata = resolve;
          video.onerror = () => reject(new Error('video load failed'));
          video.src = objectUrl;
        });
        // A frame partway in tends to be more representative than frame
        // zero (often a black/blank leader frame) — mirrors what most
        // video thumbnailers, including Synapse's own, do by default.
        if (Number.isFinite(video.duration) && video.duration > 0) {
          await new Promise((resolve) => {
            video.onseeked = resolve;
            video.currentTime = Math.min(1, video.duration / 2);
          });
        }
        source = video;
        sourceW = video.videoWidth;
        sourceH = video.videoHeight;
      } else {
        return null;
      }

      if (!sourceW || !sourceH) return null;

      const { w: thumbW, h: thumbH } = scaleToFit(sourceW, sourceH, THUMBNAIL_MAX_W, THUMBNAIL_MAX_H);
      const thumbBlob = await canvasToJpegBlob(drawToCanvas(source, thumbW, thumbH));

      const { w: hashW, h: hashH } = scaleToFit(sourceW, sourceH, BLURHASH_SAMPLE_DIM, BLURHASH_SAMPLE_DIM);
      const blurhash = canvasToBlurhash(drawToCanvas(source, hashW, hashH));

      return {
        blurhash,
        thumbnail: {
          blob: thumbBlob,
          info: { w: thumbW, h: thumbH, mimetype: 'image/jpeg', size: thumbBlob.size },
        },
      };
    } catch (err) {
      console.error('[matrix-chat] thumbnail/blurhash generation failed', err);
      return null;
    } finally {
      cleanup();
    }
  }

  // Best-effort width/height (images, video) or duration (video, audio) —
  // these are optional layout/UI hints per the spec, never required for a
  // valid message, so any failure here (corrupt file, unsupported codec,
  // browser can't decode it) just means the info block ends up sparser,
  // not a failed upload.
  async function probeMediaInfo(file) {
    const info = {};
    if (file.type.startsWith('image/')) {
      try {
        const bitmap = await createImageBitmap(file);
        info.w = bitmap.width;
        info.h = bitmap.height;
        bitmap.close?.();
      } catch { /* leave w/h unset */ }
      return info;
    }

    if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
      const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
      const objectUrl = URL.createObjectURL(file);
      try {
        await new Promise((resolve, reject) => {
          el.preload = 'metadata';
          el.onloadedmetadata = resolve;
          el.onerror = () => reject(new Error('metadata load failed'));
          el.src = objectUrl;
        });
        if (Number.isFinite(el.duration)) info.duration = Math.round(el.duration * 1000);
        if (el.videoWidth) info.w = el.videoWidth;
        if (el.videoHeight) info.h = el.videoHeight;
      } catch { /* leave info sparse */ } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
    return info;
  }

  /**
   * Upload a file and send it as a message — msgtype and extra info
   * (dimensions/duration) are derived from the file's own mimetype, same
   * as Element: images, video, and audio each get their own msgtype and
   * relevant info fields; anything else falls back to a plain m.file.
   * caption, if given, becomes the message's body (with the original
   * filename preserved separately in content.filename) rather than the
   * filename itself — mirrors how Element handles a captioned upload.
   *
   * Mirrors the receiving side's split (client.js's decryptAttachmentFile /
   * room-view's hydrateMedia) in reverse: encrypted rooms need the bytes
   * encrypted client-side *before* upload (content.file, not content.url —
   * same shape decryptAttachmentFile already expects when reading messages
   * back), plain rooms just upload as-is.
   */
  async function sendFileMessage(roomId, file, { caption } = {}) {
    if (!client) throw new Error('matrix-chat: no active client');
    runtime.assertCurrent();
    const isEncrypted = !!client.isRoomEncrypted?.(roomId);

    const mimetype = file.type || 'application/octet-stream';
    const msgtype = msgtypeFor(mimetype);
    const extraInfo = await (probe || probeMediaInfo)(file);
    const body = caption?.trim() || file.name;

    // Thumbnail + blurhash only make sense for the two msgtypes that get
    // rendered as visual media in the timeline — an m.audio/m.file
    // attachment has no frame to preview or blur.
    const preview = (msgtype === 'm.image' || msgtype === 'm.video')
      ? await (buildPreview || generateThumbnailAndBlurhash)(file)
      : null;

    runtime.assertCurrent();
    let content;

    if (isEncrypted) {
      const buffer = await file.arrayBuffer();
      runtime.assertCurrent();
      const encrypted = await encryptAttachment(buffer);
      // Encrypted attachments upload as opaque bytes (application/octet-
      // stream) rather than the real mimetype, so the homeserver — or
      // anyone snooping the upload request — can't learn what the file is
      // just from its content-type. The real mimetype still travels inside
      // info.mimetype, which is itself inside the e2ee-encrypted event.
      runtime.assertCurrent();
      const { content_uri } = await client.uploadContent(encrypted.data, {
        abortController: runtime.controller,
        type: 'application/octet-stream',
      });
      const info = { mimetype, size: file.size, ...extraInfo };

      if (preview) {
        // The thumbnail is exactly as sensitive as the main attachment (it's
        // a real, if small, rendering of the same content) so in an
        // encrypted room it gets the same treatment: encrypt client-side,
        // upload opaque bytes, reference it as thumbnail_file rather than
        // thumbnail_url. Blurhash is a ~28-character lossy hint, not
        // reconstructable into anything resembling the original — sent in
        // the clear inside info like every other Matrix client does.
        const encryptedThumb = await encryptAttachment(await preview.thumbnail.blob.arrayBuffer());
        runtime.assertCurrent();
        const { content_uri: thumbUri } = await client.uploadContent(encryptedThumb.data, {
          abortController: runtime.controller,
          type: 'application/octet-stream',
        });
        info.thumbnail_file = { ...encryptedThumb.info, url: thumbUri };
        info.thumbnail_info = preview.thumbnail.info;
        info['xyz.amorgan.blurhash'] = preview.blurhash;
      }

      content = {
        msgtype,
        body,
        filename: file.name,
        info,
        file: { ...encrypted.info, url: content_uri },
      };
    } else {
      runtime.assertCurrent();
      const { content_uri } = await client.uploadContent(file, { type: mimetype, abortController: runtime.controller });
      const info = { mimetype, size: file.size, ...extraInfo };

      if (preview) {
        runtime.assertCurrent();
        const { content_uri: thumbUri } = await client.uploadContent(preview.thumbnail.blob, {
          abortController: runtime.controller,
          type: 'image/jpeg',
        });
        info.thumbnail_url = thumbUri;
        info.thumbnail_info = preview.thumbnail.info;
        info['xyz.amorgan.blurhash'] = preview.blurhash;
      }

      content = {
        msgtype,
        body,
        filename: file.name,
        info,
        url: content_uri,
      };
    }

    runtime.assertCurrent();

    return client.sendEvent(roomId, 'm.room.message', content);
  }


  return { sendFileMessage };
}

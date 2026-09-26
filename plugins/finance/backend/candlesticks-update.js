const BUCKET_STEPS_MS = [
  15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000,
];

function metadataOf(point) {
  const { t, time, timestamp, v, value, price, close, c, start, end, t0, t1, open, o, high, h, low, l, ...metadata } = point || {};
  return metadata;
}

// Preserve the same metadata and OHLC rules as a full bucket rebuild.
export function appendCandleSample(candle, point, bucketMs) {
  const value = Number(point.v ?? point.value ?? point.close);
  return { ...metadataOf(candle), ...metadataOf(point), t0: candle.t0,
    t1: candle.t0 + bucketMs, o: candle.o,
    h: Math.max(candle.h, value), l: Math.min(candle.l, value), c: value };
}

export function pickBucketMs(points, targetCandles = 60) {
  if (points.length < 2) return BUCKET_STEPS_MS[0];
  const span = points[points.length - 1].t - points[0].t;
  if (span <= 0) return BUCKET_STEPS_MS[0];
  return BUCKET_STEPS_MS.find(step => span / step <= targetCandles) || BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

export function bucketHistory(points, bucketMs) {
  if (!Array.isArray(points) || !points.length) return [];
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) throw new TypeError('bucketMs must be positive');
  const buckets = new Map();
  for (const point of points) {
    const t = Number(point.t ?? point.time ?? point.timestamp);
    const v = Number(point.v ?? point.value ?? point.close);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const t0 = Math.floor(t / bucketMs) * bucketMs;
    let candle = buckets.get(t0);
    if (!candle) {
      // Keep consumer metadata on derived candles. Canonical chart fields win,
      // while later observations refresh metadata on the forming candle.
      candle = { ...metadataOf(point), t0, t1: t0 + bucketMs, o: v, h: v, l: v, c: v };
      buckets.set(t0, candle);
    } else {
      const open = candle.o;
      const high = candle.h;
      const low = candle.l;
      Object.assign(candle, metadataOf(point));
      candle.t0 = t0;
      candle.t1 = t0 + bucketMs;
      candle.o = open;
      candle.h = Math.max(high, v);
      candle.l = Math.min(low, v);
      candle.c = v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t0 - b.t0);
}

/**
 * Convert regular OHLC candles into Heiken Ashi candles.
 */
export function heikenAshiStep(previous, raw) {
  const { t0, t1, o, h, l, c } = raw;
  const close = (o + h + l + c) / 4;
  const open = previous ? (previous.o + previous.c) / 2 : (o + c) / 2;
  return { ...raw, t0, t1, o: open, h: Math.max(h, open, close), l: Math.min(l, open, close), c: close };
}

export function heikenAshi(candles) {
  const output = [];
  let previous = null;
  for (const candle of candles || []) {
    previous = heikenAshiStep(previous, candle);
    output.push(previous);
  }
  return output;
}

export function computeCandleScale(candles, innerHeight, padTop, padPercent = 0.08) {
  if (!candles.length) return { minP: 0, rngP: 1, yOf: () => padTop + innerHeight / 2 };
  const minimum = Math.min(...candles.map(candle => candle.l));
  const maximum = Math.max(...candles.map(candle => candle.h));
  const range = maximum - minimum || Math.abs(minimum) * 0.002 || 1;
  const minP = minimum - range * padPercent;
  const rngP = range * (1 + padPercent * 2);
  return { minP, rngP, yOf: value => padTop + innerHeight - ((value - minP) / rngP) * innerHeight };
}

export function renderCandlesSVG({
  candles, W, H, padLeft, padRight, padTop, padBottom,
  colorUp, colorDown, opacity = 1, xOf = null, bodyWidth = null,
  colorOf = null, yOf: suppliedYOf = null, bridgeFromPreviousClose = false,
}) {
  if (!candles.length) return '';
  const innerWidth = W - padLeft - padRight;
  const innerHeight = H - padTop - padBottom;
  const yOf = suppliedYOf || computeCandleScale(candles, innerHeight, padTop).yOf;
  const slotWidth = innerWidth / candles.length;
  const width = Math.max(1, bodyWidth ?? slotWidth * 0.6);
  let markup = '';
  candles.forEach((candle, index) => {
    const defaultColor = candle.c >= candle.o ? colorUp : colorDown;
    const color = colorOf ? colorOf(candle, index, defaultColor) : defaultColor;
    const x = xOf ? xOf(candle, index) : padLeft + slotWidth * (index + 0.5);
    if (bridgeFromPreviousClose && index > 0 && candles[index - 1].c !== candle.o) {
      const prior = candles[index - 1].c;
      const top = yOf(Math.max(prior, candle.o));
      const bottom = yOf(Math.min(prior, candle.o));
      const bridgeColor = color;
      markup += `<rect class="tc-candle-bridge" x="${(x - width / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" height="${Math.max(1, bottom - top).toFixed(1)}" fill="${bridgeColor}" opacity="${opacity}"/>`;
    }
    const wickTop = yOf(candle.h);
    const wickBottom = yOf(candle.l);
    const bodyTop = yOf(Math.max(candle.o, candle.c));
    const bodyBottom = yOf(Math.min(candle.o, candle.c));
    markup += `<line x1="${x.toFixed(1)}" y1="${wickTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${wickBottom.toFixed(1)}" stroke="${color}" stroke-width="1" opacity="${opacity}"/>`;
    markup += `<rect x="${(x - width / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${width.toFixed(1)}" height="${Math.max(1, bodyBottom - bodyTop).toFixed(1)}" fill="${color}" opacity="${opacity}"/>`;
  });
  return markup;
}

/**
 * Same candle geometry/coloring as renderCandlesSVG, drawn straight onto a
 * 2D canvas context instead of built as an SVG markup string. Used by
 * chart-next.js's candle layer: at high candle counts, painting a few
 * thousand fillRect/stroke calls onto one raster surface is cheap, while
 * creating/diffing that many live SVG <line>/<rect> DOM nodes on every
 * redraw is the expensive part -- this is the same reason the crosshair/
 * axis/toolbar chrome stays SVG (low element count, benefits from real DOM)
 * while the candle body layer moves here (high element count, benefits from
 * having no DOM at all). The caller is expected to have already sized and
 * scaled the canvas (devicePixelRatio) and to clearRect the *previous*
 * frame's drawing itself only when needed -- this function always starts by
 * clearing its own (W, H) region, since a partial/incremental candle redraw
 * isn't meaningfully cheaper than a full one once you're already in canvas
 * land (unlike the SVG string-diff this replaces, there's no "did anything
 * change" shortcut available before painting -- the caller does that check
 * up front instead, by only calling this when the draw key actually changed).
 */
export function renderCandlesCanvas(ctx, {
  candles, W, H, padLeft, padRight, padTop, padBottom,
  colorUp, colorDown, opacity = 1, xOf = null, bodyWidth = null,
  colorOf = null, yOf: suppliedYOf = null, bridgeFromPreviousClose = false,
}) {
  ctx.clearRect(0, 0, W, H);
  if (!candles.length) return;
  const innerWidth = W - padLeft - padRight;
  const innerHeight = H - padTop - padBottom;
  const yOf = suppliedYOf || computeCandleScale(candles, innerHeight, padTop).yOf;
  const slotWidth = innerWidth / candles.length;
  const width = Math.max(1, bodyWidth ?? slotWidth * 0.6);
  ctx.save();
  ctx.globalAlpha = opacity;
  candles.forEach((candle, index) => {
    const defaultColor = candle.c >= candle.o ? colorUp : colorDown;
    const color = colorOf ? colorOf(candle, index, defaultColor) : defaultColor;
    const x = xOf ? xOf(candle, index) : padLeft + slotWidth * (index + 0.5);
    if (bridgeFromPreviousClose && index > 0 && candles[index - 1].c !== candle.o) {
      const prior = candles[index - 1].c;
      const top = yOf(Math.max(prior, candle.o));
      const bottom = yOf(Math.min(prior, candle.o));
      const bridgeColor = color;
      ctx.fillStyle = bridgeColor;
      ctx.fillRect(x - width / 2, top, width, Math.max(1, bottom - top));
    }
    const wickTop = yOf(candle.h);
    const wickBottom = yOf(candle.l);
    const bodyTop = yOf(Math.max(candle.o, candle.c));
    const bodyBottom = yOf(Math.min(candle.o, candle.c));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, wickTop);
    ctx.lineTo(x, wickBottom);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, bodyTop, width, Math.max(1, bodyBottom - bodyTop));
  });
  ctx.restore();
}

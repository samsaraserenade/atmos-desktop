export const SAMSARA_DEFAULTS = Object.freeze({
  movingAverages: Object.freeze([
    Object.freeze({ type: 'EMA', length: 50 }),
    Object.freeze({ type: 'EMA', length: 100 }),
    Object.freeze({ type: 'EMA', length: 150 }),
    Object.freeze({ type: 'EMA', length: 200 }),
    Object.freeze({ type: 'HMA', length: 100 }),
  ]),
  rsiLength: 14,
  rsiUpper: 80,
  rsiLower: 20,
  showMovingAverages: true,
  movingAverageOpacity: 0.58,
  showRsi: true,
  showSessions: true,
  colorCandles: true,
});

function cleanLength(length) {
  return Math.max(1, Math.floor(Number(length) || 1));
}

export function sma(values, length) {
  const n = cleanLength(length);
  const output = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    sum += values[index];
    if (index >= n) sum -= values[index - n];
    if (index >= n - 1) output[index] = sum / n;
  }
  return output;
}

export function ema(values, length) {
  const n = cleanLength(length);
  const output = Array(values.length).fill(null);
  if (!values.length) return output;
  if (n === 1) return values.slice();
  const multiplier = 2 / (n + 1);
  let seed = 0;
  for (let index = 0; index < values.length; index++) {
    if (index < n) seed += values[index];
    if (index === n - 1) output[index] = seed / n;
    else if (index >= n) output[index] = values[index] * multiplier + output[index - 1] * (1 - multiplier);
  }
  return output;
}

function weightedMovingAverage(values, length) {
  const n = cleanLength(length);
  const output = Array(values.length).fill(null);
  const denominator = n * (n + 1) / 2;
  const window = new Array(n);
  let count = 0;
  let cursor = 0;
  let sum = 0;
  let weighted = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      count = cursor = 0;
      sum = weighted = 0;
      continue;
    }
    if (count === n) {
      const oldSum = sum;
      sum -= window[cursor];
      weighted -= oldSum;
      window[cursor] = value;
      cursor = (cursor + 1) % n;
      weighted += value * n;
      sum += value;
    } else {
      window[count] = value;
      count++;
      sum += value;
      weighted += value * count;
    }
    if (count === n) output[index] = weighted / denominator;
  }
  return output;
}

export function wma(values, length) {
  return weightedMovingAverage(values, length);
}

export function hma(values, length) {
  const n = cleanLength(length);
  const half = wma(values, Math.max(1, Math.round(n / 2)));
  const full = wma(values, n);
  const difference = values.map((_, index) => Number.isFinite(half[index]) && Number.isFinite(full[index])
    ? 2 * half[index] - full[index]
    : null);
  return weightedMovingAverage(difference, Math.max(1, Math.round(Math.sqrt(n))));
}

export function dema(values, length) {
  const first = ema(values, length);
  const firstValid = first.findIndex(Number.isFinite);
  if (firstValid < 0) return first;
  const secondTail = ema(first.slice(firstValid), length);
  const output = Array(values.length).fill(null);
  for (let index = firstValid; index < values.length; index++) {
    const second = secondTail[index - firstValid];
    if (Number.isFinite(second)) output[index] = 2 * first[index] - second;
  }
  return output;
}

export function movingAverage(values, type, length) {
  switch (String(type || 'EMA').toUpperCase()) {
    case 'SMA': return sma(values, length);
    case 'WMA': return wma(values, length);
    case 'HMA': return hma(values, length);
    case 'DEMA': return dema(values, length);
    default: return ema(values, length);
  }
}

export function rsi(values, length = 14) {
  const n = cleanLength(length);
  const output = Array(values.length).fill(null);
  if (values.length <= n) return output;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= n; index++) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= n;
  averageLoss /= n;
  const current = () => averageLoss === 0 ? 100 : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss);
  output[n] = current();
  for (let index = n + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (n - 1) + Math.max(change, 0)) / n;
    averageLoss = (averageLoss * (n - 1) + Math.max(-change, 0)) / n;
    output[index] = current();
  }
  return output;
}

export function mergedUtcSession(timestamp) {
  const hour = ((Math.floor(timestamp / 3_600_000) % 24) + 24) % 24;
  if (hour < 7) return { key: 'tokyo', color: '#ff9900' };
  if (hour < 13) return { key: 'london', color: '#4caf4f' };
  if (hour < 21) return { key: 'new-york', color: '#2195f3' };
  return { key: 'sydney', color: '#a461bb' };
}

export function buildSamsaraStudy(values, config = SAMSARA_DEFAULTS) {
  const movingAverages = config.showMovingAverages === false ? []
    : (config.movingAverages || SAMSARA_DEFAULTS.movingAverages)
      .filter(setting => setting.enabled !== false)
      .map(setting => ({ ...setting, values: movingAverage(values, setting.type, setting.length) }));
  const rsiValues = config.showRsi === false ? null : rsi(values, config.rsiLength ?? SAMSARA_DEFAULTS.rsiLength);
  return { movingAverages, rsi: rsiValues };
}

function contiguousSegments(values, average, xs, renderFrom) {
  const segments = [];
  let current = null;
  for (let index = renderFrom; index < values.length; index++) {
    if (!Number.isFinite(average[index]) || !Number.isFinite(xs[index])) continue;
    const bullish = values[index] >= average[index];
    const point = { x: xs[index], price: values[index], average: average[index] };
    if (!current || current.bullish !== bullish) {
      const prior = current?.points[current.points.length - 1];
      if (current) segments.push(current);
      current = { bullish, points: prior ? [prior, point] : [point] };
    } else current.points.push(point);
  }
  if (current) segments.push(current);
  return segments;
}

export function renderSamsaraOverlaySVG({
  values, times, xs, renderFrom = 0, yOf, plotTop, plotHeight,
  bullishColor, bearishColor, config = SAMSARA_DEFAULTS, clipId = 'atmos-chart-indicator-clip',
  // Callers that re-render the same candle window on every pointer move
  // (panning, hovering) can precompute this once with buildSamsaraStudy()
  // and keep passing it back in here — the MA/RSI crunching only depends
  // on `values`+`config`, never on the per-frame pixel `xs`, so recomputing
  // it every frame is pure waste. Omit it and this still works exactly as
  // before, just recomputing fresh each call.
  study: precomputedStudy,
  // Milliseconds per candle/point at the chart's current timeframe. Session
  // ticks stop being a meaningful signal once a single bar spans more than
  // an hour — a 4H or 1D candle already crosses several sessions on its
  // own, so the strip would just be noise. Defaults to 0 (i.e. "not known
  // to be coarser than 1h") so callers that don't pass it — direct tests,
  // mainly — keep rendering sessions exactly as before.
  intervalMs = 0,
}) {
  if (values.length < 2) return '';
  const study = precomputedStudy || buildSamsaraStudy(values, config);
  let fills = '';
  let lines = '';
  let states = '';
  let signals = '';
  let sessions = '';

  if (config.showMovingAverages !== false) {
    const opacity = Math.max(0, Math.min(1, Number(config.movingAverageOpacity ?? SAMSARA_DEFAULTS.movingAverageOpacity)));
    for (const average of study.movingAverages) {
      for (const segment of contiguousSegments(values, average.values, xs, renderFrom)) {
        if (segment.points.length < 2) continue;
        const color = segment.bullish ? bullishColor : bearishColor;
        const maPoints = segment.points.map(point => `${point.x.toFixed(1)},${yOf(point.average).toFixed(1)}`);
        const pricePoints = segment.points.map(point => `${point.x.toFixed(1)},${yOf(point.price).toFixed(1)}`);
        fills += `<polygon points="${pricePoints.concat(maPoints.slice().reverse()).join(' ')}" fill="${color}" opacity="${(opacity * 0.1).toFixed(3)}"/>`;
        lines += `<path d="M ${maPoints.join(' L ')}" fill="none" stroke="${color}" stroke-width="0.85" opacity="${opacity.toFixed(3)}"/>`;
      }
    }
  }

  let stateStart = null;
  let stateKind = 0;
  const flushState = end => {
    if (stateStart == null || !stateKind) return;
    const x0 = xs[stateStart];
    const x1 = xs[end];
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) return;
    const color = stateKind > 0 ? bullishColor : bearishColor;
    states += `<rect x="${Math.min(x0, x1).toFixed(1)}" y="${plotTop}" width="${Math.max(1, Math.abs(x1 - x0)).toFixed(1)}" height="${plotHeight}" fill="${color}" opacity="0.045"/>`;
  };
  if (config.showRsi !== false) {
    const lower = config.rsiLower ?? 20;
    const upper = config.rsiUpper ?? 80;
    for (let index = renderFrom; index < values.length; index++) {
      const rsiValue = study.rsi[index];
      const kind = !Number.isFinite(rsiValue) ? 0 : rsiValue < lower ? 1 : rsiValue > upper ? -1 : 0;
      if (kind !== stateKind) {
        flushState(index - 1);
        stateStart = kind ? index : null;
        stateKind = kind;
      }
    }
    flushState(values.length - 1);
    for (let index = Math.max(renderFrom, 1); index < values.length; index++) {
      const previous = study.rsi[index - 1];
      const current = study.rsi[index];
      if (!Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(xs[index])) continue;
      const bullishSignal = previous <= lower && current > lower;
      const bearishSignal = previous >= upper && current < upper;
      if (!bullishSignal && !bearishSignal) continue;
      const priorX = Number.isFinite(xs[index - 1]) ? xs[index - 1] : xs[index];
      const width = Math.max(2, Math.abs(xs[index] - priorX));
      const color = bullishSignal ? bullishColor : bearishColor;
      signals += `<rect x="${(xs[index] - width / 2).toFixed(1)}" y="${plotTop}" width="${width.toFixed(1)}" height="${plotHeight}" fill="${color}" opacity="0.13"/>`;
    }
  }

  if (config.showSessions !== false && intervalMs <= 3_600_000) {
    // Same monochrome treatment as the sidebar allocation donut: every
    // session tick is white, and *brightness* ranks them by typical trading
    // activity instead of hue — America is the busiest overlap session,
    // then London, then Asian hours, then the quiet Sydney-only stretch.
    // (mergedUtcSession's own .color is left alone — the separate "color
    // candles by session" feature below still uses it as a real hue.)
    const SESSION_BRIGHTNESS = { 'new-york': 0.85, london: 0.62, tokyo: 0.42, sydney: 0.24 };
    let start = renderFrom;
    while (start < times.length) {
      const session = mergedUtcSession(times[start]);
      let end = start;
      while (end + 1 < times.length && mergedUtcSession(times[end + 1]).key === session.key) end++;
      const x0 = xs[start];
      const x1 = xs[end];
      if (Number.isFinite(x0) && Number.isFinite(x1)) {
        const opacity = SESSION_BRIGHTNESS[session.key] ?? 0.46;
        sessions += `<rect x="${Math.min(x0, x1).toFixed(1)}" y="${(plotTop + plotHeight - 3).toFixed(1)}" width="${Math.max(1, Math.abs(x1 - x0)).toFixed(1)}" height="3" rx="1" fill="rgb(var(--ink-rgb))" opacity="${opacity.toFixed(2)}"/>`;
      }
      start = end + 1;
    }
  }

  return `<defs><clipPath id="${clipId}"><rect x="-100000" y="${plotTop}" width="200000" height="${plotHeight}"/></clipPath></defs><g class="atmos-chart-indicator-overlay tc-samsara-overlay" clip-path="url(#${clipId})">${states}${signals}${fills}${lines}${sessions}</g>`;
}

/** Raster equivalent of the SVG overlay. The caller owns bitmap sizing/clearing. */
export function renderSamsaraOverlayCanvas(ctx, {
  values, times, xs, renderFrom = 0, yOf, plotTop, plotHeight,
  bullishColor, bearishColor, config = SAMSARA_DEFAULTS,
  study: precomputedStudy, intervalMs = 0, inkColor = '#ffffff',
}) {
  if (values.length < 2) return;
  const study = precomputedStudy || buildSamsaraStudy(values, config);
  const round = value => Number(value.toFixed(1));
  const rect = (x, width, color, opacity) => {
    ctx.fillStyle = color; ctx.globalAlpha = opacity;
    ctx.fillRect(round(x), plotTop, round(width), plotHeight);
  };
  ctx.save();
  ctx.beginPath(); ctx.rect(-100000, plotTop, 200000, plotHeight); ctx.clip();
  if (config.showRsi !== false) {
    const lower = config.rsiLower ?? 20, upper = config.rsiUpper ?? 80;
    let start = null, kind = 0;
    const flush = end => {
      if (start == null || !kind || !Number.isFinite(xs[start]) || !Number.isFinite(xs[end])) return;
      rect(Math.min(xs[start], xs[end]), Math.max(1, Math.abs(xs[end] - xs[start])), kind > 0 ? bullishColor : bearishColor, .045);
    };
    for (let i = renderFrom; i < values.length; i++) {
      const rsi = study.rsi[i], next = !Number.isFinite(rsi) ? 0 : rsi < lower ? 1 : rsi > upper ? -1 : 0;
      if (next !== kind) { flush(i - 1); start = next ? i : null; kind = next; }
    }
    flush(values.length - 1);
    for (let i = Math.max(renderFrom, 1); i < values.length; i++) {
      const previous = study.rsi[i - 1], current = study.rsi[i];
      if (!Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(xs[i])) continue;
      const up = previous <= lower && current > lower, down = previous >= upper && current < upper;
      if (!up && !down) continue;
      const prior = Number.isFinite(xs[i - 1]) ? xs[i - 1] : xs[i];
      const width = Math.max(2, Math.abs(xs[i] - prior));
      rect(xs[i] - width / 2, width, up ? bullishColor : bearishColor, .13);
    }
  }
  if (config.showMovingAverages !== false) {
    const opacity = Math.max(0, Math.min(1, Number(config.movingAverageOpacity ?? SAMSARA_DEFAULTS.movingAverageOpacity)));
    const segments = study.movingAverages.flatMap(average => contiguousSegments(values, average.values, xs, renderFrom)).filter(segment => segment.points.length >= 2);
    // All fills precede all strokes, matching the SVG compositing order.
    for (const segment of segments) {
      ctx.fillStyle = segment.bullish ? bullishColor : bearishColor;
      ctx.globalAlpha = Number((opacity * .1).toFixed(3)); ctx.beginPath();
      segment.points.forEach((point, i) => ctx[i ? 'lineTo' : 'moveTo'](round(point.x), round(yOf(point.price))));
      for (let i = segment.points.length - 1; i >= 0; i--) { const point = segment.points[i]; ctx.lineTo(round(point.x), round(yOf(point.average))); }
      ctx.closePath(); ctx.fill();
    }
    ctx.lineWidth = .85; ctx.globalAlpha = Number(opacity.toFixed(3));
    for (const segment of segments) {
      ctx.strokeStyle = segment.bullish ? bullishColor : bearishColor; ctx.beginPath();
      segment.points.forEach((point, i) => ctx[i ? 'lineTo' : 'moveTo'](round(point.x), round(yOf(point.average))));
      ctx.stroke();
    }
  }
  if (config.showSessions !== false && intervalMs <= 3600000) {
    const brightness = { 'new-york': .85, london: .62, tokyo: .42, sydney: .24 };
    for (let start = renderFrom; start < times.length;) {
      const session = mergedUtcSession(times[start]); let end = start;
      while (end + 1 < times.length && mergedUtcSession(times[end + 1]).key === session.key) end++;
      if (Number.isFinite(xs[start]) && Number.isFinite(xs[end])) {
        ctx.fillStyle = inkColor; ctx.globalAlpha = brightness[session.key] ?? .46;
        ctx.beginPath(); ctx.roundRect(round(Math.min(xs[start], xs[end])), round(plotTop + plotHeight - 3), round(Math.max(1, Math.abs(xs[end] - xs[start]))), 3, 1); ctx.fill();
      }
      start = end + 1;
    }
  }
  ctx.restore();
}

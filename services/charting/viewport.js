const DEFAULTS = Object.freeze({
  mode: 'line', timelineMode: 'gapless', bucketMs: 60_000,
  width: 520, height: 110,
  padding: Object.freeze({ top: 8, right: 0, bottom: 24, left: 0 }),
  lineWindow: 300, lineWindowMin: 20, lineWindowMax: 5_000,
  candleMinCount: 5, candleDefaultCount: 60,
  axisLabelSpacingPx: 34, axisMinTicks: 3, axisMaxTicks: 8,
  priceScale: 'linear',
});

const finite = value => Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// Returns the index into `items` whose xOf(items[index]) is closest to
// `x`, assuming xOf is monotonically non-decreasing over `items` (true for
// every visible[] here -- see call sites). O(log n) instead of the O(n)
// linear scan this replaces, which matters because nearestTimeAtPixel runs
// on every mousemove pixel.
function nearestIndexByX(items, xOf, x) {
  if (!items.length) return -1;
  let lo = 0, hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xOf(items[mid]) < x) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(xOf(items[lo - 1]) - x) <= Math.abs(xOf(items[lo]) - x)) return lo - 1;
  return lo;
}

export function niceNumber(range, round = true) {
  if (!(range > 0)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

export function computeAxisTicks(minimum, range, plotHeight, options = {}) {
  if (!(range > 0) || !(plotHeight > 0)) return [];
  const spacing = options.axisLabelSpacingPx ?? DEFAULTS.axisLabelSpacingPx;
  const minTicks = options.axisMinTicks ?? DEFAULTS.axisMinTicks;
  const maxTicks = options.axisMaxTicks ?? DEFAULTS.axisMaxTicks;
  const targetCount = clamp(Math.round(plotHeight / spacing) + 1, minTicks, maxTicks);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true);
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const maximum = minimum + range;
  const first = Math.ceil(minimum / step) * step;
  const ticks = [];
  for (let value = first, index = 0; value <= maximum + step * 1e-6 && index < maxTicks + 4; value += step, index++) {
    ticks.push(Object.freeze({ value, step }));
  }
  return ticks;
}

function computeLinearPriceScale(clean, plotHeight, padTop) {
  const minimum = clean.length ? Math.min(...clean) : 0;
  const maximum = clean.length ? Math.max(...clean) : 0;
  const rawRange = maximum - minimum || Math.abs(minimum) * 0.002 || 1;
  const minP = minimum - rawRange * 0.08;
  const rngP = rawRange * 1.16;
  const yOfPrice = value => padTop + plotHeight - ((value - minP) / rngP) * plotHeight;
  const priceAtPixel = y => minP + (1 - (clamp(y, padTop, padTop + plotHeight) - padTop) / plotHeight) * rngP;
  return Object.freeze({ minimum: minP, maximum: minP + rngP, range: rngP, yOfPrice, priceAtPixel, mode: 'linear' });
}

// Same shape/contract as the linear scale above (minimum/maximum/range are
// still real price units, not log units -- so anything reading
// priceDomain elsewhere doesn't need to know which mode produced it) but
// the interpolation between padTop/plotHeight and price happens in
// log10-space instead. Falls back to the linear scale for a series with
// no positive values, since log(0) and log(negative) are undefined and a
// price axis can't represent them either way.
function computeLogPriceScale(clean, plotHeight, padTop) {
  const positive = clean.filter(value => value > 0);
  if (!positive.length) return computeLinearPriceScale(clean, plotHeight, padTop);
  const logMinimum = Math.log10(Math.min(...positive));
  const logMaximum = Math.log10(Math.max(...positive));
  const rawLogRange = (logMaximum - logMinimum) || Math.abs(logMinimum) * 0.02 || 0.05;
  const logMinP = logMinimum - rawLogRange * 0.08;
  const logRngP = rawLogRange * 1.16;
  const yOfPrice = value => {
    const logValue = Math.log10(Math.max(value, 1e-12));
    return padTop + plotHeight - ((logValue - logMinP) / logRngP) * plotHeight;
  };
  const priceAtPixel = y => {
    const t = 1 - (clamp(y, padTop, padTop + plotHeight) - padTop) / plotHeight;
    return Math.pow(10, logMinP + t * logRngP);
  };
  const minimum = Math.pow(10, logMinP);
  const maximum = Math.pow(10, logMinP + logRngP);
  return Object.freeze({ minimum, maximum, range: maximum - minimum, yOfPrice, priceAtPixel, mode: 'log' });
}

export function computePriceScale(values, plotHeight, padTop = 8, mode = 'linear') {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  return mode === 'log' ? computeLogPriceScale(clean, plotHeight, padTop) : computeLinearPriceScale(clean, plotHeight, padTop);
}

// "Nice" tick values for a log-scale axis are conventionally 1/2/5 (or a
// denser 1/2/3/5/7, or plain whole decades) times a power of ten, rather
// than evenly-spaced round numbers the way niceNumber()/computeAxisTicks
// above work -- evenly-spaced-in-price ticks would bunch together
// nonsensically once the axis itself is log-spaced. This picks the
// sparsest of a few standard mantissa sets that still clears the target
// tick count for the available plotHeight (mirroring computeAxisTicks'
// own density target), so a wide multi-decade range gets whole decades
// and a narrow one gets finer 1/2/5 (or denser still) subdivisions.
const LOG_MANTISSA_SETS = [[1], [1, 5], [1, 2, 5], [1, 2, 3, 5, 7], [1, 2, 3, 4, 5, 6, 7, 8, 9]];
export function computeLogAxisTicks(minimum, maximum, plotHeight, options = {}) {
  if (!(minimum > 0) || !(maximum > minimum) || !(plotHeight > 0)) return [];
  const spacing = options.axisLabelSpacingPx ?? DEFAULTS.axisLabelSpacingPx;
  const minTicks = options.axisMinTicks ?? DEFAULTS.axisMinTicks;
  const maxTicks = options.axisMaxTicks ?? DEFAULTS.axisMaxTicks;
  const targetCount = clamp(Math.round(plotHeight / spacing) + 1, minTicks, maxTicks);
  const firstDecade = Math.floor(Math.log10(minimum));
  const lastDecade = Math.ceil(Math.log10(maximum));
  const candidatesFor = mantissas => {
    const values = [];
    for (let decade = firstDecade; decade <= lastDecade; decade++) {
      for (const mantissa of mantissas) {
        const value = mantissa * Math.pow(10, decade);
        if (value >= minimum * (1 - 1e-9) && value <= maximum * (1 + 1e-9)) values.push(value);
      }
    }
    return [...new Set(values)].sort((a, b) => a - b);
  };
  let chosen = candidatesFor(LOG_MANTISSA_SETS[0]);
  for (const mantissas of LOG_MANTISSA_SETS) {
    const candidates = candidatesFor(mantissas);
    if (candidates.length >= targetCount || mantissas === LOG_MANTISSA_SETS.at(-1)) { chosen = candidates; break; }
    chosen = candidates;
  }
  // Still denser than the row has room for (a wide mantissa set inside a
  // narrow decade span) -- thin to an even index stride rather than
  // switching mantissa sets again, same fallback computeAxisTicks would
  // reach for if niceNumber() alone ever produced too many.
  if (chosen.length > maxTicks) {
    const stride = Math.ceil(chosen.length / maxTicks);
    chosen = chosen.filter((_value, index) => index % stride === 0);
  }
  // A range zoomed in tighter than a single decade (a small-cap token
  // sitting at, say, $0.0012-$0.0021) can have too few single-digit
  // mantissa candidates to reach even minTicks -- there just aren't that
  // many "nice" 1/2/5-style values in that narrow a span. Falling back to
  // computeAxisTicks' plain evenly-spaced nice numbers still produces
  // meaningful tick *values*; they land at their correct (non-evenly-
  // spaced) pixel position same as any other tick since yOfPrice does the
  // actual log placement -- only perfectly even on-screen spacing is lost,
  // which is an acceptable trade next to having almost no ticks at all.
  if (chosen.length < minTicks) return computeAxisTicks(minimum, maximum - minimum, plotHeight, options);
  return chosen.map(value => Object.freeze({ value, step: null }));
}

function normalizePoint(point, index) {
  const time = Number(point?.time ?? point?.t ?? point?.timestamp);
  const value = Number(point?.value ?? point?.v ?? point?.price ?? point?.close);
  return finite(time) && finite(value) ? Object.freeze({ source: point, index, time, value }) : null;
}

function normalizeCandle(candle, index) {
  const t0 = Number(candle?.t0 ?? candle?.start ?? candle?.time ?? candle?.timestamp);
  const t1 = Number(candle?.t1 ?? candle?.end ?? t0);
  const o = Number(candle?.o ?? candle?.open);
  const h = Number(candle?.h ?? candle?.high);
  const l = Number(candle?.l ?? candle?.low);
  const c = Number(candle?.c ?? candle?.close);
  return [t0, t1, o, h, l, c].every(finite) ? Object.freeze({ source: candle, index, t0, t1, o, h, l, c }) : null;
}

function rangeStartTime(key, firstTime, lastTime) {
  if (!key || key === 'all') return firstTime;
  if (key === '1d') return lastTime - 24 * 60 * 60_000;
  if (key === '1w') return lastTime - 7 * 24 * 60 * 60_000;
  if (key === '1m') return lastTime - 30 * 24 * 60 * 60_000;
  if (key === 'ytd') {
    const date = new Date(lastTime);
    return new Date(date.getFullYear(), 0, 1).getTime();
  }
  return firstTime;
}

function downsample(items, limit) {
  if (items.length <= limit) return items;
  const sampled = [];
  const step = (items.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index++) sampled.push(items[Math.round(index * step)]);
  return sampled;
}

export function createChartViewport(options = {}) {
  let settings = { ...DEFAULTS, ...options, padding: { ...DEFAULTS.padding, ...(options.padding || {}) } };
  let lineWindow = clamp(Math.round(settings.lineWindow), settings.lineWindowMin, settings.lineWindowMax);
  let lineOffset = options.lineOffset ?? null;
  let candleSpanMs = options.candleSpanMs ?? null;
  let candleOffsetMs = options.candleOffsetMs ?? null;
  let activeRangeKey = options.activeRangeKey ?? null;
  let lastInnerWidth = null;
  let layout = emptyLayout();
  let normalizedCache = { data: null, revision: null, mode: null, all: null };
  // calculate() used to rebuild the full layout (visible-window slice,
  // xByTime map, price-scale min/max scan, axis ticks) on every call, even
  // though a caller like the chart's pointermove handler calls it 2-3x per
  // mouse pixel of movement with nothing but the cursor position having
  // changed. Layout is a pure function of (data, revision) plus this
  // module's own mutable view state, so a call with all of those unchanged
  // from last time is guaranteed to produce an identical result -- safe to
  // just hand back the same frozen object instead of redoing the work.
  // width/height are checked separately from `settings` itself because
  // resize() mutates them on the existing settings object in place rather
  // than replacing it.
  let lastLayoutCache = null;

  function emptyLayout() {
    return Object.freeze({
      mode: settings?.mode || 'line', visible: Object.freeze([]), count: 0,
      width: settings?.width || 0, height: settings?.height || 0,
      plotWidth: 0, plotHeight: 0, domain: null, priceDomain: null,
      ticks: Object.freeze([]), pan: null, bodyWidth: 0,
      xOfTime: () => 0, yOfPrice: () => 0, timeAtPixel: () => null, nearestTimeAtPixel: () => null, priceAtPixel: () => null,
    });
  }

  function dimensions() {
    const { padding } = settings;
    return {
      plotWidth: Math.max(1, settings.width - padding.left - padding.right),
      plotHeight: Math.max(1, settings.height - padding.top - padding.bottom),
    };
  }

  // Named distinctly from the settings.priceScale *option* (the
  // 'linear' | 'log' mode string) it reads, to keep the two from being
  // confused at call sites below.
  function scaleFor(values, plotHeight) {
    const scale = computePriceScale(values, plotHeight, settings.padding.top, settings.priceScale);
    return { minP: scale.minimum, rngP: scale.range, maxP: scale.maximum, yOfPrice: scale.yOfPrice, priceAtPixel: scale.priceAtPixel };
  }

  // computeAxisTicks()'s evenly-spaced "nice round number" ticks only
  // make sense against a linear axis; a log axis needs the 1/2/5-per-
  // decade ticks computeLogAxisTicks() produces instead (see its own
  // comment) or they'd bunch together nonsensically near the top of each
  // decade once yOfPrice itself is log-spaced.
  function ticksFor(minimum, range, plotHeight) {
    return settings.priceScale === 'log'
      ? computeLogAxisTicks(minimum, minimum + range, plotHeight, settings)
      : computeAxisTicks(minimum, range, plotHeight, settings);
  }

  function lineLayout(all) {
    const { plotWidth, plotHeight } = dimensions();
    if (!all.length) return emptyLayout();
    let visible;
    let pan;
    if (activeRangeKey) {
      const startTime = rangeStartTime(activeRangeKey, all[0].time, all.at(-1).time);
      let lo = 0, hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (all[mid].time < startTime) lo = mid + 1; else hi = mid;
      }
      visible = downsample(all.slice(lo), settings.lineWindowMax);
      pan = { start: 0, win: visible.length, maxOffset: 0, total: visible.length, live: true, unit: 'index', mode: 'line' };
    } else {
      const win = Math.min(lineWindow, all.length);
      const maxOffset = Math.max(0, all.length - win);
      const start = lineOffset == null ? maxOffset : clamp(lineOffset, 0, maxOffset);
      visible = all.slice(start, start + win);
      pan = { start, win, maxOffset, total: all.length, live: lineOffset == null, unit: 'index', mode: 'line' };
    }
    const firstTime = visible[0].time;
    const lastTime = visible.at(-1).time;
    const timeSpan = Math.max(1, lastTime - firstTime);
    const slot = visible.length > 1 ? plotWidth / (visible.length - 1) : 0;
    const xByTime = new Map(visible.map((point, index) => [point.time, settings.padding.left + (settings.timelineMode === 'gaps' ? ((point.time - firstTime) / timeSpan) * plotWidth : (visible.length > 1 ? index * slot : plotWidth * 0.5))]));
    const xOfTime = time => {
      if (settings.timelineMode === 'gaps') return settings.padding.left + ((time - firstTime) / timeSpan) * plotWidth;
      if (xByTime.has(time)) return xByTime.get(time);
      const nearest = visible.reduce((best, point) => Math.abs(point.time - time) < Math.abs((best?.time ?? Infinity) - time) ? point : best, null);
      return nearest ? xByTime.get(nearest.time) : settings.padding.left;
    };
    const timeAtPixel = x => {
      const chartX = clamp(x, settings.padding.left, settings.padding.left + plotWidth);
      if (settings.timelineMode === 'gaps') return firstTime + ((chartX - settings.padding.left) / plotWidth) * timeSpan;
      const index = Math.round(((chartX - settings.padding.left) / plotWidth) * Math.max(0, visible.length - 1));
      return visible[clamp(index, 0, visible.length - 1)]?.time ?? null;
    };
    const nearestTimeAtPixel = x => {
      const index = nearestIndexByX(visible, point => xOfTime(point.time), x);
      return index >= 0 ? visible[index].time : null;
    };
    const scale = scaleFor(visible.map(point => point.value), plotHeight);
    const ticks = ticksFor(scale.minP, scale.rngP, plotHeight);
    return Object.freeze({ mode: 'line', visible: Object.freeze(visible), count: visible.length, width: settings.width, height: settings.height, plotWidth, plotHeight, domain: Object.freeze({ from: firstTime, to: lastTime }), priceDomain: Object.freeze({ minimum: scale.minP, maximum: scale.maxP, range: scale.rngP }), ticks: Object.freeze(ticks), pan: Object.freeze(pan), bodyWidth: 0, xOfTime, yOfPrice: scale.yOfPrice, timeAtPixel, nearestTimeAtPixel, priceAtPixel: scale.priceAtPixel });
  }

  function candleLayout(all) {
    const { plotWidth, plotHeight } = dimensions();
    if (!all.length) return emptyLayout();
    const bucketMs = Math.max(1, Number(settings.bucketMs) || (all[0].t1 - all[0].t0) || 1);
    const dataStart = all[0].t0;
    const dataEnd = all.at(-1).t1;
    const totalSpan = Math.max(1, dataEnd - dataStart);
    const minimumSpan = bucketMs * settings.candleMinCount;
    const maximumSpan = Math.max(minimumSpan, totalSpan);
    if (activeRangeKey) {
      const start = Math.max(dataStart, rangeStartTime(activeRangeKey, dataStart, dataEnd));
      candleSpanMs = Math.max(minimumSpan, dataEnd - start);
      candleOffsetMs = null;
    }
    if (candleSpanMs == null) candleSpanMs = Math.min(totalSpan, bucketMs * settings.candleDefaultCount);
    candleSpanMs = clamp(candleSpanMs, minimumSpan, maximumSpan);
    const maxOffset = Math.max(0, totalSpan - candleSpanMs);
    const offset = candleOffsetMs == null ? maxOffset : clamp(candleOffsetMs, 0, maxOffset);
    const startTime = candleOffsetMs == null ? dataEnd - candleSpanMs : dataStart + offset;
    const endTime = startTime + candleSpanMs;
    const visible = all.filter(candle => candle.t1 > startTime && candle.t0 < endTime);
    const gapless = settings.timelineMode === 'gapless';
    const slotWidth = gapless ? plotWidth / Math.max(1, visible.length) : Math.max(1, (bucketMs / candleSpanMs) * plotWidth);
    const xByTime = new Map();
    visible.forEach((candle, index) => {
      const elapsedX = settings.padding.left + ((((candle.t0 + candle.t1) / 2) - startTime) / candleSpanMs) * plotWidth;
      xByTime.set(candle.t0, gapless ? settings.padding.left + slotWidth * (index + 0.5) : clamp(elapsedX, settings.padding.left, settings.width - settings.padding.right));
    });
    const xOfTime = time => {
      if (xByTime.has(time)) return xByTime.get(time);
      return settings.padding.left + ((time - startTime) / candleSpanMs) * plotWidth;
    };
    const timeAtPixel = x => {
      const chartX = clamp(x, settings.padding.left, settings.padding.left + plotWidth);
      if (!gapless) return startTime + ((chartX - settings.padding.left) / plotWidth) * candleSpanMs;
      const index = Math.floor((chartX - settings.padding.left) / Math.max(1, slotWidth));
      return visible[clamp(index, 0, visible.length - 1)]?.t0 ?? null;
    };
    const nearestTimeAtPixel = x => {
      const index = nearestIndexByX(visible, candle => xOfTime(candle.t0), x);
      return index >= 0 ? visible[index].t0 : null;
    };
    const scale = scaleFor(visible.flatMap(candle => [candle.l, candle.h]), plotHeight);
    const ticks = ticksFor(scale.minP, scale.rngP, plotHeight);
    const pan = { start: offset, win: candleSpanMs, maxOffset, total: totalSpan, live: candleOffsetMs == null, unit: 'time', mode: settings.mode };
    return Object.freeze({ mode: settings.mode, visible: Object.freeze(visible), count: visible.length, width: settings.width, height: settings.height, plotWidth, plotHeight, domain: Object.freeze({ from: startTime, to: endTime }), priceDomain: Object.freeze({ minimum: scale.minP, maximum: scale.maxP, range: scale.rngP }), ticks: Object.freeze(ticks), pan: Object.freeze(pan), bodyWidth: slotWidth * 0.6, slotWidth, xOfTime, yOfPrice: scale.yOfPrice, timeAtPixel, nearestTimeAtPixel, priceAtPixel: scale.priceAtPixel });
  }

  function setOptions(patch = {}) {
    settings = { ...settings, ...patch, padding: { ...settings.padding, ...(patch.padding || {}) } };
    if (patch.lineWindow != null) lineWindow = clamp(Math.round(patch.lineWindow), settings.lineWindowMin, settings.lineWindowMax);
    if ('lineOffset' in patch) lineOffset = patch.lineOffset;
    if ('candleSpanMs' in patch) candleSpanMs = patch.candleSpanMs;
    if ('candleOffsetMs' in patch) candleOffsetMs = patch.candleOffsetMs;
    if ('activeRangeKey' in patch) activeRangeKey = patch.activeRangeKey;
    return api;
  }

  function resize(width, height) {
    const oldInnerWidth = lastInnerWidth;
    settings.width = Math.max(1, Number(width) || 1);
    settings.height = Math.max(1, Number(height) || 1);
    const newInnerWidth = dimensions().plotWidth;
    if (candleSpanMs != null && oldInnerWidth != null && oldInnerWidth > 0 && newInnerWidth !== oldInnerWidth) {
      const ratio = newInnerWidth / oldInnerWidth;
      candleSpanMs = Math.round(candleSpanMs * ratio);
      if (candleOffsetMs != null) candleOffsetMs = Math.round(candleOffsetMs * ratio);
    }
    lastInnerWidth = newInnerWidth;
    return api;
  }

  function calculate(data = [], revision = null, appendOnly = false) {
    if (lastInnerWidth == null) lastInnerWidth = dimensions().plotWidth;
    const cached = lastLayoutCache;
    if (cached && cached.data === data && cached.revision === revision && cached.settings === settings
      && cached.width === settings.width && cached.height === settings.height
      && cached.lineWindow === lineWindow && cached.lineOffset === lineOffset
      && cached.candleSpanMs === candleSpanMs && cached.candleOffsetMs === candleOffsetMs
      && cached.activeRangeKey === activeRangeKey) {
      return layout;
    }
    // The chart engine guarantees unchanged prefix points for ordered appends.
    // General viewport callers retain the full normalization fallback.
    if (appendOnly && normalizedCache.data === data && normalizedCache.mode === settings.mode
      && normalizedCache.revision !== revision && normalizedCache.all?.length > 0
      && normalizedCache.all.length < data.length) {
      const previous = normalizedCache.all;
      // A batch can replace the previous last point before appending.
      const updatedLast = (settings.mode === 'line' ? normalizePoint : normalizeCandle)(data[previous.length - 1], previous.length - 1);
      const tail = data.slice(previous.length).map((point, offset) =>
        (settings.mode === 'line' ? normalizePoint : normalizeCandle)(point, previous.length + offset));
      let lastTime = updatedLast?.time ?? updatedLast?.t0;
      const ordered = updatedLast && previous[0].source === data[0]
        && (previous.length < 2 || lastTime >= (previous.at(-2).time ?? previous.at(-2).t0)) && tail.every(point => {
        if (!point) return false;
        const time = point.time ?? point.t0;
        if (time < lastTime) return false;
        lastTime = time;
        return true;
      });
      if (ordered) { previous[previous.length - 1] = updatedLast; for (const point of tail) previous.push(point); normalizedCache.revision = revision; }
    }
    if (normalizedCache.data === data && normalizedCache.mode === settings.mode && normalizedCache.revision !== revision
      && normalizedCache.all?.length === data.length && data.length) {
      normalizedCache.all[normalizedCache.all.length - 1] = (settings.mode === 'line' ? normalizePoint : normalizeCandle)(data[data.length - 1], data.length - 1);
      normalizedCache.revision = revision;
    } else if (normalizedCache.data !== data || normalizedCache.revision !== revision || normalizedCache.mode !== settings.mode) {
      normalizedCache = {
        data, revision, mode: settings.mode,
        all: data.map(settings.mode === 'line' ? normalizePoint : normalizeCandle).filter(Boolean)
          .sort((a, b) => (a.time ?? a.t0) - (b.time ?? b.t0)),
      };
    }
    layout = settings.mode === 'line' ? lineLayout(normalizedCache.all) : candleLayout(normalizedCache.all);
    lastLayoutCache = {
      data, revision, settings, width: settings.width, height: settings.height,
      lineWindow, lineOffset, candleSpanMs, candleOffsetMs, activeRangeKey,
    };
    return layout;
  }

  function zoom(deltaY) {
    if (!layout.pan || deltaY === 0) return api;
    activeRangeKey = null;
    const factor = deltaY > 0 ? 1.15 : 1 / 1.15;
    if (layout.pan.unit === 'time') {
      candleSpanMs = Math.max(1_000, Math.round((candleSpanMs ?? layout.pan.win) * factor));
      if (candleOffsetMs != null) {
        const center = layout.pan.start + layout.pan.win / 2;
        const nextWindow = Math.min(candleSpanMs, layout.pan.total);
        const nextMaximum = Math.max(0, layout.pan.total - nextWindow);
        candleOffsetMs = clamp(Math.round(center - nextWindow / 2), 0, nextMaximum);
      }
    } else {
      lineWindow = clamp(Math.round(lineWindow * factor), settings.lineWindowMin, settings.lineWindowMax);
      if (lineOffset != null) {
        const center = layout.pan.start + layout.pan.win / 2;
        const nextWindow = Math.min(lineWindow, layout.pan.total);
        lineOffset = clamp(Math.round(center - nextWindow / 2), 0, Math.max(0, layout.pan.total - nextWindow));
      }
    }
    return api;
  }

  function panPixels(deltaX) {
    if (!layout.pan || layout.pan.maxOffset <= 0 || layout.plotWidth <= 0) return api;
    const delta = Math.round((-deltaX / layout.plotWidth) * layout.pan.win);
    const next = clamp(layout.pan.start + delta, 0, layout.pan.maxOffset);
    const atLiveEdge = next >= layout.pan.maxOffset;
    if (layout.pan.unit === 'time') candleOffsetMs = atLiveEdge ? null : next;
    else lineOffset = atLiveEdge ? null : next;
    return api;
  }

  function reset() {
    activeRangeKey = null;
    lineOffset = null;
    candleOffsetMs = null;
    candleSpanMs = null;
    return api;
  }

  function resetResizeBaseline() {
    lastInnerWidth = null;
    return api;
  }

  function getState() {
    return Object.freeze({
      mode: settings.mode, timelineMode: settings.timelineMode,
      lineWindow, lineOffset, candleSpanMs, candleOffsetMs, activeRangeKey,
      width: settings.width, height: settings.height,
      pan: layout.pan, domain: layout.domain, priceDomain: layout.priceDomain,
    });
  }

  const api = Object.freeze({ setOptions, resize, calculate, zoom, panPixels, reset, resetResizeBaseline, getState, getLayout: () => layout });
  return api;
}

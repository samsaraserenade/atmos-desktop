import { onChartStorageChange, readStored, writeStored } from './storage.js';

// Stored through the consumer's storage (storage.js).
const STORAGE_KEY = 'charting-settings:v1';

const DEFAULTS = Object.freeze({
  smoothing: 0,
  lineOpacity: 0.85,
  backgroundOpacity: 1,
  showCurrentPriceLine: false,
  candleAnimation: true,
  samsara: Object.freeze({
    overlayEnabled: true,
    movingAveragesEnabled: true,
    movingAverageEnabled: Object.freeze([true, true, true, true, true]),
    movingAverageOpacity: 0.58,
    rsiEnabled: true,
    sessionsEnabled: true,
    candleColoringEnabled: true,
    candleColorBasis: 'session',
  }),
});

const listeners = new Set();

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalize(input = {}, current = DEFAULTS) {
  const samsaraInput = input.samsara || {};
  const samsaraCurrent = current.samsara || DEFAULTS.samsara;
  const enabled = Array.isArray(samsaraInput.movingAverageEnabled)
    ? Array.from({ length: 5 }, (_, index) => samsaraInput.movingAverageEnabled[index] !== false)
    : [...samsaraCurrent.movingAverageEnabled];
  const basis = /^(session|consensus|ma[1-5])$/.test(String(samsaraInput.candleColorBasis || ''))
    ? String(samsaraInput.candleColorBasis)
    : samsaraCurrent.candleColorBasis;
  return Object.freeze({
    smoothing: clamp(input.smoothing, 0, 100, current.smoothing),
    lineOpacity: clamp(input.lineOpacity, 0, 1, current.lineOpacity),
    backgroundOpacity: clamp(input.backgroundOpacity, 0, 1, current.backgroundOpacity),
    showCurrentPriceLine: input.showCurrentPriceLine == null ? current.showCurrentPriceLine : !!input.showCurrentPriceLine,
    candleAnimation: input.candleAnimation == null ? current.candleAnimation : !!input.candleAnimation,
    samsara: Object.freeze({
      overlayEnabled: samsaraInput.overlayEnabled == null ? samsaraCurrent.overlayEnabled : !!samsaraInput.overlayEnabled,
      movingAveragesEnabled: samsaraInput.movingAveragesEnabled == null ? samsaraCurrent.movingAveragesEnabled : !!samsaraInput.movingAveragesEnabled,
      movingAverageEnabled: Object.freeze(enabled),
      movingAverageOpacity: clamp(samsaraInput.movingAverageOpacity, 0, 1, samsaraCurrent.movingAverageOpacity),
      rsiEnabled: samsaraInput.rsiEnabled == null ? samsaraCurrent.rsiEnabled : !!samsaraInput.rsiEnabled,
      sessionsEnabled: samsaraInput.sessionsEnabled == null ? samsaraCurrent.sessionsEnabled : !!samsaraInput.sessionsEnabled,
      candleColoringEnabled: samsaraInput.candleColoringEnabled == null ? samsaraCurrent.candleColoringEnabled : !!samsaraInput.candleColoringEnabled,
      candleColorBasis: basis,
    }),
  });
}

function load() {
  const saved = readStored(STORAGE_KEY);
  return saved && typeof saved === 'object' ? normalize(saved) : normalize();
}

let settings = load();

// A consumer configured its storage: pick up what it had saved.
onChartStorageChange(() => {
  const next = load();
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  settings = next;
  applyCssVariables();
  for (const listener of listeners) listener(settings);
});

function applyCssVariables() {
  document.documentElement?.style?.setProperty('--atmos-chart-background-opacity', String(settings.backgroundOpacity));
  document.documentElement?.style?.setProperty('--atmos-chart-line-opacity', String(settings.lineOpacity));
  document.documentElement?.style?.setProperty('--atmos-chart-candle-motion', settings.candleAnimation ? '160ms' : '0ms');
}

export function getChartSettings() {
  return settings;
}

export function setChartSettings(patch = {}) {
  const next = normalize(patch, settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return settings;
  settings = next;
  writeStored(STORAGE_KEY, settings);
  applyCssVariables();
  for (const listener of listeners) listener(settings);
  return settings;
}

export function onChartSettingsChange(listener, { signal } = {}) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  listeners.add(listener);
  const unsubscribe = () => {
    listeners.delete(listener);
    signal?.removeEventListener?.('abort', unsubscribe);
  };
  if (signal?.aborted) unsubscribe();
  else signal?.addEventListener?.('abort', unsubscribe, { once: true });
  return unsubscribe;
}

applyCssVariables();

export const CHART_SETTINGS_DEFAULTS = DEFAULTS;

const INTERVAL_UNITS_MS = Object.freeze({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });
const MIN_CUSTOM_INTERVAL_MS = 1_000;
const MAX_CUSTOM_INTERVAL_MS = 30 * 86_400_000;

export function parseIntervalMs(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return null;
  const milliseconds = Math.round(Number(match[1]) * INTERVAL_UNITS_MS[match[2] || 's']);
  return Number.isFinite(milliseconds) && milliseconds >= MIN_CUSTOM_INTERVAL_MS && milliseconds <= MAX_CUSTOM_INTERVAL_MS
    ? milliseconds
    : null;
}

export function formatIntervalMs(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 1) return '';
  for (const [unit, unitMs] of [['d', INTERVAL_UNITS_MS.d], ['h', INTERVAL_UNITS_MS.h], ['m', INTERVAL_UNITS_MS.m], ['s', INTERVAL_UNITS_MS.s]]) {
    if (value >= unitMs && value % unitMs === 0) return `${value / unitMs}${unit}`;
  }
  return `${Math.round(value)}ms`;
}

export function bindIntervalInput(input, form, onChange) {
  const submit = event => {
    event.preventDefault();
    const milliseconds = parseIntervalMs(input.value);
    input.classList.toggle('is-invalid', milliseconds == null);
    if (milliseconds == null) {
      input.title = 'Use 1s–30d, for example 1s, 30s, 2m, or 3h.';
      return;
    }
    input.value = formatIntervalMs(milliseconds);
    input.title = `Custom candle timeframe: ${input.value}`;
    onChange(milliseconds);
  };
  const edit = () => input.classList.remove('is-invalid');
  const keydown = event => { event.stopPropagation(); if (event.key === 'Escape') input.blur(); };
  form.addEventListener('submit', submit);
  input.addEventListener('input', edit);
  input.addEventListener('keydown', keydown);
  return () => {
    form.removeEventListener('submit', submit);
    input.removeEventListener('input', edit);
    input.removeEventListener('keydown', keydown);
  };
}

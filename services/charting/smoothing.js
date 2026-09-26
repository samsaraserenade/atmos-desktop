const MIN_ALPHA = 0.03;

export function smoothingAlpha(level) {
  return Math.pow(MIN_ALPHA, Math.max(0, Math.min(100, Number(level) || 0)) / 100);
}

export function smoothValues(values, level = 0) {
  if (!values.length || level <= 0) return values.slice();
  const alpha = smoothingAlpha(level);
  const output = values.slice();
  let average = Number(values[0]);
  output[0] = average;
  for (let index = 1; index < values.length; index++) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    average = alpha * value + (1 - alpha) * average;
    output[index] = average;
  }
  return output;
}

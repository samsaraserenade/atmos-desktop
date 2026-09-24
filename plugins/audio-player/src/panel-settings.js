// Cover appearance in the album browser (album menu → Cover Appearance).
import { audioState } from './state.js';

export function applyCoverSize(px) {
  document.documentElement.style.setProperty('--alb-cover-size', `${px}px`);
}

export function applyCoverSaturation(pct) {
  document.documentElement.style.setProperty('--alb-cover-sat', `${pct}%`);
  document.body.classList.toggle('albums-custom-saturation', pct !== 100);
}

export function applyDimAmount(value) {
  document.documentElement.style.setProperty('--alb-dim-opacity', (1 - 0.70 * value / 100).toFixed(3));
  document.body.classList.toggle('albums-no-hover', value === 0);
}

export function applyDisplayPreferences() {
  applyCoverSize(audioState.albumCoverSize ?? 160);
  applyCoverSaturation(audioState.albumCoverSaturation ?? 100);
  applyDimAmount(audioState.albumDim ?? 50);
  document.body.classList.toggle('album-labels-hidden', !!audioState.albumLabelsHidden);
  document.body.classList.toggle('albums-always-dimmed', (audioState.albumDimMode || 'always') === 'always');
}

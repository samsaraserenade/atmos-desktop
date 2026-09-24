import { wallpaperState } from './persist.js';

let active = false;
let ignoringMouse = false;
let lastPointer = null;
let previousRootBackground = '';
let previousBodyBackground = '';
let transparentWindowActive = false;

function isInteractivePoint(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element || element === document.documentElement || element === document.body) return false;
  if (element.closest('[data-atmos-surface-layer="workspace-background"]')) return false;
  if (element.matches([
    '#media-fullscreen', '#panel-primary', '#panel-content',
    '.panel-section', '.panel-section-content', '.panel-plugin-viewport',
  ].join(','))) return false;
  return true;
}

function setClickThrough(enabled) {
  if (ignoringMouse === enabled) return;
  ignoringMouse = enabled;
  window.atmosCore?.setWindowClickThrough?.(enabled);
}

function refreshHitTesting() {
  if (!active || !transparentWindowActive || wallpaperState.mode !== 'transparent') {
    setClickThrough(false);
    return;
  }
  if (document.querySelector('#settings-menu.open')) {
    setClickThrough(false);
    return;
  }
  setClickThrough(lastPointer ? !isInteractivePoint(lastPointer.x, lastPointer.y) : true);
}

export function applyWallpaperPresentation(state = wallpaperState) {
  if (!active) return;
  const background = transparentWindowActive && state.mode === 'transparent' ? 'transparent' : '#050505';
  document.documentElement.style.background = 'transparent';
  document.body.style.background = background;
  refreshHitTesting();
}

export function isTransparentWindowActive() {
  return transparentWindowActive;
}

export async function mountWallpaperInteraction(context) {
  if (active) return;
  const effects = window.atmosCore?.getWindowEffects
    ? await window.atmosCore.getWindowEffects()
    : { active: true, configured: true };
  transparentWindowActive = effects.active === true;
  active = true;
  previousRootBackground = document.documentElement.style.background;
  previousBodyBackground = document.body.style.background;

  let hitTestFrame = null;
  const trackPointer = event => {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (hitTestFrame !== null) return;
    hitTestFrame = context.requestAnimationFrame(() => {
      hitTestFrame = null;
      refreshHitTesting();
    });
  };
  context.listen(document, 'mousemove', trackPointer, true);
  context.listen(document, 'dragover', trackPointer, true);
  context.listen(window, 'atmos:interactive-ui-changed', refreshHitTesting);
  context.onCleanup(() => {
    active = false;
    hitTestFrame = null;
    transparentWindowActive = false;
    lastPointer = null;
    document.documentElement.style.background = previousRootBackground;
    document.body.style.background = previousBodyBackground;
    setClickThrough(false);
  });
  applyWallpaperPresentation();
}

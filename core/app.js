/** Core renderer entry point. Extension contributions are discovered at runtime. */

import { load }                           from './js/persist.js';
import './js/core/context-menu.js';
import './js/core/sidebar-shell.js';
import './js/core/appearance.js';
import { loadServiceSidebars,
         loadServiceSettings,
         loadServicePersist,
         loadServiceBoot,
         listInstalledServices }           from './js/core/service-loader.js';
import { ensureDefaultPanelPlugin,
         activatePanelPlugin,
         getPersistedPanelPluginId,
         isPanelPluginRegistered,
         listPanelPlugins,
         restorePanelWorkspace }            from './js/core/panel-registry.js';
import { openOnboardingSettings }           from './js/core/settings-menu.js';
import { initTaskView }                     from './js/core/task-view.js';
import { runBootHooks }                    from './js/core/boot-registry.js';
import { loadPluginPanelsAndBoot,
         loadPluginPersist,
         loadPluginSidebars,
         loadPluginSettings,
         listInstalledPlugins }             from './js/core/plugin-loader.js';
import { loadFramedExtensions }           from './js/core/extension-frame-host.js';

// ── Title bar controls ────────────────────────────────────────────────────────
document.getElementById('win-min')  ?.addEventListener('click', () => window.atmosCore?.minimize());
document.getElementById('win-max')  ?.addEventListener('click', () => window.atmosCore?.maximize());
document.getElementById('win-close')?.addEventListener('click', () => window.atmosCore?.close());

const _fullscreenButton = document.getElementById('win-fullscreen');
function _syncFullscreenButton(fullscreen) {
  if (!_fullscreenButton) return;
  _fullscreenButton.classList.toggle('active', !!fullscreen);
  _fullscreenButton.setAttribute('aria-pressed', String(!!fullscreen));
  const label = fullscreen ? 'Exit borderless fullscreen' : 'Enter borderless fullscreen';
  _fullscreenButton.title = label;
  _fullscreenButton.setAttribute('aria-label', label);
  document.documentElement.classList.toggle('window-fullscreen', !!fullscreen);
}
_fullscreenButton?.addEventListener('click', async () => {
  _syncFullscreenButton(await window.atmosCore?.toggleFullscreen?.());
});
window.atmosCore?.onFullscreenChange?.(_syncFullscreenButton);
window.atmosCore?.isFullscreen?.()?.then(_syncFullscreenButton);

function _syncMaximizedState(maximized) {
  document.documentElement.classList.toggle('window-maximized', !!maximized);
}
window.atmosCore?.onMaximizedChange?.(_syncMaximizedState);
window.atmosCore?.isMaximized?.()?.then(_syncMaximizedState);

const _windowEffects = await (window.atmosCore?.getWindowEffects?.() ?? Promise.resolve({ active: false }));
document.documentElement.classList.toggle('custom-window-effects', _windowEffects.active === true);

// Transparent frameless windows lose reliable native edge resizing on
// Windows. Install custom handles only for that optional launch mode; the
// default opaque window keeps Electron's cheaper native resize path.
for (const direction of _windowEffects.active ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] : []) {
  const handle = document.createElement('div');
  handle.className = `window-resize-handle window-resize-${direction}`;
  handle.dataset.direction = direction;
  document.body.appendChild(handle);

  let pointerId = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    window.atmosCore?.beginWindowResize?.(direction, event.screenX, event.screenY);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return;
    window.atmosCore?.updateWindowResize?.(event.screenX, event.screenY);
  });
  const finishResize = event => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    window.atmosCore?.endWindowResize?.();
  };
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
}

// ── Double-click title bar → toggle fullscreen ────────────────────────────────
document.getElementById('titlebar')?.addEventListener('dblclick', event => {
  if (event.target.closest('.win-controls')) return;
  window.atmosCore?.toggleFullscreen();
});

// Register extension persistence before loading the shared state blob.
await loadServicePersist();
await loadPluginPersist();
load();

// UI contributions load only after every extension has installed its state
// defaults and persistence handlers.
await Promise.all([
  loadServiceSidebars(),
  loadServiceSettings(),
  loadPluginSidebars(),
  loadPluginSettings(),
]);

// Discover panel and boot entry points by convention. Services' boot hooks
// (the background layer: Wallpaper and Audio) register first.
await loadServiceBoot();
await loadPluginPanelsAndBoot();

// Framed extensions (third-party, and first-party opted into frames) run in
// sandboxed iframes; register their surfaces with the same registries.
loadFramedExtensions({ plugins: await listInstalledPlugins(), services: await listInstalledServices() });

// Preserve the restored selection before mounting the registry default.
const _savedPanelId = getPersistedPanelPluginId();

if (listPanelPlugins().length > 0) {
  document.getElementById('media-fullscreen')?.classList.remove('panel-host-empty');
  ensureDefaultPanelPlugin();
  if (_savedPanelId && isPanelPluginRegistered(_savedPanelId)) {
    activatePanelPlugin(_savedPanelId);
  }
  restorePanelWorkspace();
  initTaskView();
}

// Reuse the loaders' session cache rather than re-walking both extension
// roots in the main process.
const [_installedPlugins, _installedServices] = await Promise.all([
  listInstalledPlugins(),
  listInstalledServices(),
]);
if (_installedPlugins.length === 0 && _installedServices.length === 0) {
  openOnboardingSettings();
}

// Run extension startup hooks in deterministic order.
await runBootHooks();

// Startup finished: lets the boot splash in index.html fade out.
window.__atmosBootComplete = true;
window.dispatchEvent(new Event('atmos:boot-complete'));

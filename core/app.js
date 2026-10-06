/** Core renderer entry point. Extension contributions are discovered at runtime. */

import { load, forgetStateNamespaces }    from './js/persist.js';
import './js/core/context-menu.js';
import './js/core/sidebar-shell.js';
import './js/core/command-bar.js';
import './js/core/appearance.js';
import { loadSystemState,
         loadSystemSettings,
         loadSystemBoot }                  from './js/core/system-services.js';
import { listInstalledPlugins,
         listInstalledServices }           from './js/core/extension-list.js';
import { ensureDefaultPanelPlugin,
         activatePanelPlugin,
         getPersistedPanelPluginId,
         isPanelPluginRegistered,
         listPanelPlugins,
         restorePanelWorkspace }            from './js/core/panel-registry.js';
import { openOnboardingSettings }           from './js/core/settings-menu.js';
import { initTaskView }                     from './js/core/task-view.js';
import { runBootHooks }                    from './js/core/boot-registry.js';
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

// ── Double-click title bar → toggle fullscreen ────────────────────────────────
document.getElementById('titlebar')?.addEventListener('dblclick', event => {
  if (event.target.closest('.win-controls')) return;
  window.atmosCore?.toggleFullscreen();
});

// Register the system services' state before loading the shared state blob.
await loadSystemState();
load();
// Extensions removed with their data at this start (extension-manager.cjs):
// forget their state namespaces (a plugin and a service may use kind-id).
try {
  const removed = await window.atmosCore?.extensionManager?.takeDataCleanup?.() || [];
  if (removed.length) forgetStateNamespaces(removed.flatMap(({ kind, id }) => [id, `${kind}-${id}`]));
} catch (error) {
  console.warn('[app] could not clear removed extensions\' data:', error.message);
}

// The system services' Appearance settings, once state is loaded, then their
// boot hooks (the background layer: Audio and Wallpaper).
await loadSystemSettings();
await loadSystemBoot();

// Every extension runs in sandboxed frames; register their surfaces with
// Core's registries.
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
// First start of an installed Atmos: choose from the extensions that come
// with it (Settings, first run). Without any, the same page explains how to add them.
const _setup = await window.atmosCore?.extensionManager?.setup?.().catch(() => null);
// After an upgrade, extensions are downloaded in the background; once they
// are, Settings → Extensions shows them waiting for a restart.
const _showDownloaded = () => import('./js/core/settings-menu.js').then(module => module.openExtensionManager()).catch(() => {});
window.atmosCore?.extensionManager?.onUpgradeDownloaded?.(_showDownloaded);
// A reminder that an Atmos update is waiting, clicked: Settings → Atmos.
window.atmosCore?.extensionManager?.onShowManager?.(() => import('./js/core/settings-menu.js').then(module => module.openAtmosSettings()).catch(() => {}));
if (_setup?.upgradeDownloaded) _showDownloaded();
if (_setup?.needed || (_installedPlugins.length === 0 && _installedServices.length === 0)) {
  openOnboardingSettings();
}

// Run extension startup hooks in deterministic order.
await runBootHooks();

// Startup finished: lets the boot splash in index.html fade out.
window.__atmosBootComplete = true;
window.dispatchEvent(new Event('atmos:boot-complete'));

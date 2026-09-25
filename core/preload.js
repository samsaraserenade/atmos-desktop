/**
 * preload.js
 * Runs in the renderer process with Node.js access.
 * Exposes the narrow Core and extension bridges via contextBridge.
 */
console.log('[preload] loading...');
const { contextBridge, ipcRenderer } = require('electron');
const { webUtils } = require('electron');

// ── Context bridge ────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('atmosCore', {
  isElectron:       true,
  getAppVersion:    ()                   => ipcRenderer.invoke('app:version'),
  listPlugins:      ()                   => ipcRenderer.invoke('plugins:list'),
  listServices:     ()                   => ipcRenderer.invoke('services:list'),
  setExtensionEnabled: (kind, id, enabled) => ipcRenderer.invoke('extensions:set-enabled', kind, id, enabled),
  restartAtmos:     ()                   => ipcRenderer.invoke('extensions:restart'),
  approveExtension: (kind, id, fingerprint) => ipcRenderer.invoke('extensions:approve', kind, id, fingerprint),
  revokeExtensionApproval: (kind, id)     => ipcRenderer.invoke('extensions:revoke', kind, id),
  toggleFullscreen: ()                   => ipcRenderer.invoke('toggle-fullscreen'),
  // Location is off until the person presses Detect (location-gate.cjs).
  allowLocationDetect: ()                => ipcRenderer.invoke('location:allow-detect'),
  isFullscreen:     ()                   => ipcRenderer.invoke('is-fullscreen'),
  onFullscreenChange: callback => {
    const listener = (_event, fullscreen) => callback(fullscreen);
    ipcRenderer.on('fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('fullscreen-changed', listener);
  },
  isMaximized:      ()                   => ipcRenderer.invoke('is-maximized'),
  onMaximizedChange: callback => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('maximized-changed', listener);
    return () => ipcRenderer.removeListener('maximized-changed', listener);
  },
  getWindowEffects: ()                    => ipcRenderer.invoke('window-effects:get'),
  capturePanelPreview: rect               => ipcRenderer.invoke('task-view:capture-preview', rect),
  setTransparentWindow: enabled           => ipcRenderer.invoke('window-effects:set-transparent', enabled === true),
  minimize:         ()                   => ipcRenderer.send('win-minimize'),
  maximize:         ()                   => ipcRenderer.send('win-maximize'),
  close:            ()                   => ipcRenderer.send('win-close'),
  setWindowClickThrough: enabled         => ipcRenderer.send('set-window-click-through', enabled === true),
  beginWindowResize: (direction, x, y)   => ipcRenderer.send('window-resize:start', direction, x, y),
  updateWindowResize: (x, y)             => ipcRenderer.send('window-resize:update', x, y),
  endWindowResize: ()                    => ipcRenderer.send('window-resize:end'),
  openExtensionRoot: kind                => ipcRenderer.invoke('extensions:open-root', kind),
  showExtensionNotification: (kind, id, options) => ipcRenderer.invoke('extensions:notify', kind, id, options),
  onExtensionNotificationClick: callback => {
    const listener = (_event, kind, id, tag) => callback(kind, id, tag);
    ipcRenderer.on('extensions:notification-click', listener);
    return () => ipcRenderer.removeListener('extensions:notification-click', listener);
  },
});

contextBridge.exposeInMainWorld('atmos', {
  extensionInvoke: (kind, id, name, ...args) => ipcRenderer.invoke(`atmos-extension:${kind}:${id}:${name}`, ...args),
  extensionOn: (kind, id, name, callback) => {
    const channel = `atmos-extension:${kind}:${id}:${name}`;
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  resourceUrl: (provider, resourcePath = '') => 'atmos-resource://' + encodeURIComponent(provider) + '/' + resourcePath.split('/').map(encodeURIComponent).join('/'),
  getPathForFile: webUtils ? file => webUtils.getPathForFile(file) : undefined,
});

console.log('[preload] Atmos bridges exposed successfully');

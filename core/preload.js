/**
 * preload.js
 * Runs in the renderer process with Node.js access.
 * Exposes the narrow Core and extension bridges via contextBridge.
 */
console.log('[preload] loading...');
const { contextBridge, ipcRenderer } = require('electron');

// ── Context bridge ────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('atmosCore', {
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
  reloadAtmos:         ()                 => ipcRenderer.send('atmos:reload'),
  setColorScheme:      scheme             => ipcRenderer.send('appearance:color-scheme', scheme === 'light' ? 'light' : 'dark'),
  setTransparentWindow: enabled           => ipcRenderer.invoke('window-effects:set-transparent', enabled === true),
  minimize:         ()                   => ipcRenderer.send('win-minimize'),
  maximize:         ()                   => ipcRenderer.send('win-maximize'),
  close:            ()                   => ipcRenderer.send('win-close'),
  setWindowClickThrough: enabled         => ipcRenderer.send('set-window-click-through', enabled === true),
  beginWindowResize: (direction, x, y)   => ipcRenderer.send('window-resize:start', direction, x, y),
  updateWindowResize: (x, y)             => ipcRenderer.send('window-resize:update', x, y),
  endWindowResize: ()                    => ipcRenderer.send('window-resize:end'),
  openExtensionRoot: kind                => ipcRenderer.invoke('extensions:open-root', kind),
  // A framed extension's invoke(), made by Core's bridge on its behalf:
  // `stamp.caller` ("plugin:<id>") is who asked, which the main process
  // checks against what the target shares ("exports.ipc"); `stamp.frame`
  // the frame, which frameClosed() says went (a handler's
  // event.callerFrame). The page's own code never invokes a main.cjs handler.
  invokeExtensionAs: (stamp, kind, id, name, ...args) => ipcRenderer.invoke(`atmos-extension:${kind}:${id}:${name}`,
    stamp && typeof stamp === 'object' ? { caller: String(stamp.caller), frame: String(stamp.frame) } : String(stamp), ...args),
  frameClosed: frame => ipcRenderer.send('extensions:frame-closed', String(frame)),
  showExtensionNotification: (kind, id, options) => ipcRenderer.invoke('extensions:notify', kind, id, options),
  openExtensionLink: (kind, id, url, info) => ipcRenderer.invoke('extensions:open-link', kind, id, url, info),
  // { x, y, ago }: the Atmos window's last mouse-button press (Now Playing).
  lastClick: () => ipcRenderer.invoke('atmos:last-click'),
  // A framed extension's atmos.fetch(), made by the main process on its
  // behalf (stamped with `caller`, like invokeExtensionAs).
  extensionFetch: (caller, requestId, request) => ipcRenderer.invoke('extensions:fetch', String(caller), String(requestId), request),
  abortExtensionFetch: (caller, requestId) => ipcRenderer.send('extensions:fetch-abort', String(caller), String(requestId)),
  // A developer folder changed (--dev-extension): { kind, id, restart, extension }.
  onDeveloperChange: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('extensions:developer-changed', listener);
    return () => ipcRenderer.removeListener('extensions:developer-changed', listener);
  },
  // Community extensions approved while Atmos runs, loading now: [description].
  onExtensionsLoaded: callback => {
    const listener = (_event, list) => callback(list);
    ipcRenderer.on('extensions:loaded', listener);
    return () => ipcRenderer.removeListener('extensions:loaded', listener);
  },
  // Community extensions whose approval was just removed, stopping now: ["kind:id"].
  onExtensionsStopped: callback => {
    const listener = (_event, refs) => callback(refs);
    ipcRenderer.on('extensions:stopped', listener);
    return () => ipcRenderer.removeListener('extensions:stopped', listener);
  },
  onExtensionNotificationClick: callback => {
    const listener = (_event, kind, id, tag) => callback(kind, id, tag);
    ipcRenderer.on('extensions:notification-click', listener);
    return () => ipcRenderer.removeListener('extensions:notification-click', listener);
  },
  // Atmos Browser: Core's web layer in this page and the main process
  // (web-layer.js, web-host.cjs). Pages are addressed by their contents' id.
  web: {
    command:           (id, name, ...args) => ipcRenderer.invoke('web:do', id, name, ...args),
    downloads:         ()                  => ipcRenderer.invoke('web:downloads'),
    download:          (id, action)        => ipcRenderer.invoke('web:download-do', id, action),
    respondPermission: (id, answer)        => ipcRenderer.invoke('web:permission-respond', id, answer),
    respondExternal:   (id, allow)         => ipcRenderer.invoke('web:external-respond', id, allow),
    siteSettings:      ()                  => ipcRenderer.invoke('web:site-settings'),
    setSiteSetting:    (origin, name, value) => ipcRenderer.invoke('web:site-setting', origin, name, value),
    options:           ()                  => ipcRenderer.invoke('web:options'),
    setOptions:        patch               => ipcRenderer.invoke('web:set-options', patch),
    clearData:         what                => ipcRenderer.invoke('web:clear-data', what),
    adblock:           ()                  => ipcRenderer.invoke('web:adblock'),
    adblockUpdate:     ()                  => ipcRenderer.invoke('web:adblock-update'),
    listenForLinks:    ref                 => ipcRenderer.invoke('web:link-listener', ref),
    openExternal:      url                 => ipcRenderer.invoke('web:open-external', url),
    onEvent: callback => {
      const listener = (_event, id, type, payload) => callback(id, type, payload);
      ipcRenderer.on('web:event', listener);
      return () => ipcRenderer.removeListener('web:event', listener);
    },
  },
  // Each extension's atmos.state, one file each (extension-state.cjs).
  extensionState: {
    loadAll:  ()               => ipcRenderer.invoke('extension-state:load-all'),
    save:     (kind, id, data) => ipcRenderer.invoke('extension-state:save', kind, id, data),
    saveSync: (kind, id, data) => ipcRenderer.sendSync('extension-state:save-sync', kind, id, data),
  },
  // The extension manager (Settings → Extensions).
  extensionManager: {
    status:        ()                      => ipcRenderer.invoke('extensions:manager-status'),
    checkForUpdates: ()                    => ipcRenderer.invoke('extensions:check-updates'),
    install:       (kind, id)              => ipcRenderer.invoke('extensions:install', kind, id),
    remove:        (kind, id, options)     => ipcRenderer.invoke('extensions:remove', kind, id, options),
    cancel:        (kind, id)              => ipcRenderer.invoke('extensions:cancel', kind, id),
    addSource:     location                => ipcRenderer.invoke('extensions:add-source', location),
    removeSource:  location                => ipcRenderer.invoke('extensions:remove-source', location),
    takeDataCleanup: ()                    => ipcRenderer.invoke('extensions:take-data-cleanup'),
    frameFailed:   (kind, id, reason)      => ipcRenderer.invoke('extensions:frame-failed', kind, id, reason),
    setup:         ()                      => ipcRenderer.invoke('extensions:setup'),
    finishSetup:   chosen                  => ipcRenderer.invoke('extensions:finish-setup', chosen),
    openAtmosDownload: ()                  => ipcRenderer.invoke('extensions:open-atmos-download'),
    // Atmos updating itself: download (automatic updates off), install now
    // (Atmos quits and starts again), and the setting.
    downloadAtmosUpdate: ()                => ipcRenderer.invoke('extensions:atmos-update-download'),
    installAtmosUpdate: ()                 => ipcRenderer.invoke('extensions:atmos-update-install'),
    setAtmosAutoUpdate: on                 => ipcRenderer.invoke('extensions:atmos-update-auto', on === true),
    // Atmos asks for Settings → Extensions (a reminder about an update was clicked).
    onShowManager: callback => {
      const listener = () => callback();
      ipcRenderer.on('extensions:show-manager', listener);
      return () => ipcRenderer.removeListener('extensions:show-manager', listener);
    },
    onUpgradeDownloaded: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('extensions:upgrade-downloaded', listener);
      return () => ipcRenderer.removeListener('extensions:upgrade-downloaded', listener);
    },
    onChange: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('extensions:manager-changed', listener);
      return () => ipcRenderer.removeListener('extensions:manager-changed', listener);
    },
  },
});

contextBridge.exposeInMainWorld('atmos', {
  extensionOn: (kind, id, name, callback) => {
    const channel = `atmos-extension:${kind}:${id}:${name}`;
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

console.log('[preload] Atmos bridges exposed successfully');

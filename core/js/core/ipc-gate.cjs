'use strict';
/**
 * Who may call the main process. Every channel main.js registers answers
 * the Atmos page itself (atmos-app://local/, the window's own page) and
 * nothing else: not extensions' frames, which reach the main process only
 * through the page's bridge, and not web pages.
 *
 * Electron takes IPC from any renderer in the window, and a renderer
 * exploit needs no preload to send it. Since Atmos Browser those renderers
 * hold the open web too: each tab is a <webview> guest of the Atmos window
 * (BrowserWindow.fromWebContents of a tab is that window), and its pop-ups
 * are windows of their own. A handler that acts on "the sender's window"
 * without asking who the sender is would screenshot or drive Atmos for any
 * page whose renderer was taken over. A page's own scripts can't send IPC
 * at all; this is for the renderer that has been.
 *
 * ipc-gate.test.cjs checks that main.js registers nothing except through
 * here. Core's web host has its own gate for its channels (web-host.cjs:
 * `handle` for the Atmos page's, `pageFrom` for a page's own channel).
 */
const APP_PREFIX = 'atmos-app://local/';

/**
 * Whether an IPC message comes from the Atmos page: a sender outside the
 * browser's sessions (`isWebSession`) whose frame is at atmos-app://local/.
 * When the frame is already gone (a page's last messages as it unloads),
 * its contents' address answers instead.
 */
function fromAtmosPage(event, { isWebSession = () => false } = {}) {
  const sender = event?.sender;
  if (!sender || typeof sender.getURL !== 'function') return false;
  try {
    if (isWebSession(sender.session)) return false;
    return String(event.senderFrame?.url || sender.getURL()).startsWith(APP_PREFIX);
  } catch {
    return false;
  }
}

/**
 * ipcMain's handle() and on(), answering only senders `isAllowed` accepts.
 * Refused, an invoke rejects with "Not allowed" and a message is dropped;
 * a synchronous one gets `refused` back when the channel gives one (an
 * unanswered sendSync would hold its renderer).
 */
function pageOnly(ipcMain, isAllowed) {
  return {
    handle(channel, fn) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isAllowed(event)) throw new Error('Not allowed');
        return fn(event, ...args);
      });
    },
    on(channel, fn, options = {}) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isAllowed(event)) {
          if ('refused' in options) event.returnValue = options.refused;
          return;
        }
        fn(event, ...args);
      });
    },
  };
}

module.exports = { APP_PREFIX, fromAtmosPage, pageOnly };

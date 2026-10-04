'use strict';
/**
 * Where Atmos's own windows and frames may go (Atmos Browser's pages have
 * their own policy: web-policy.cjs). Moved out of main.js so it can be
 * unit-tested (app-navigation.test.cjs).
 *
 * The Atmos window's page is always atmos-app://local/: it never navigates
 * away. Links and window.open() to the web from it and from extension
 * frames open in the user's browser (or in Atmos Browser, when the user
 * turned that on: main.js's openExternally); everything else is refused.
 * Frames only ever show extension documents. Core creates them; an
 * extension frame may reload or move within its own origin, never to the
 * web, to another extension's origin, or to Atmos itself.
 */

const APP_ORIGIN = 'atmos-app://local';
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isAppUrl(url) {
  return typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Whether a link may leave Atmos for another program (the browser, mail). */
function mayOpenExternally(url) {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Whether a frame (not the main frame) of `contents` may go to `url`.
 * `initiator` is the frame that started the navigation (Electron's
 * details.initiator): none, or the page's main frame, is Core itself.
 */
function frameNavigationAllowed(url, initiator, mainFrame) {
  const fromCore = !initiator || initiator === mainFrame;
  return typeof url === 'string' && url.startsWith('atmos-ext://')
    && (fromCore || (!!initiator.origin && initiator.origin === originOf(url)));
}

/**
 * The guard for one webContents of Atmos's own (not a browser page):
 * window.open, navigations of the page and of its frames. `openExternally`
 * hands a link to another program; `attachWebview` decides <webview>s
 * (web-host.cjs); `warn` logs.
 */
function guardContents(contents, { openExternally, attachWebview, warn = console.warn }) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  // Refused everywhere except the Atmos page's own web layer, and there
  // only in the browser's sessions, starting blank, with fixed preferences.
  contents.on('will-attach-webview', (event, webPreferences, params) => attachWebview(contents, event, webPreferences, params));
  contents.on('will-frame-navigate', details => {
    if (details.isMainFrame) return;
    if (!frameNavigationAllowed(details.url, details.initiator, contents.mainFrame)) {
      details.preventDefault();
      warn('[main] blocked frame navigation to', details.url);
    }
  });
}

module.exports = { APP_ORIGIN, EXTERNAL_PROTOCOLS, isAppUrl, originOf, mayOpenExternally, frameNavigationAllowed, guardContents };

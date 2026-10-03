'use strict';
/**
 * A window on screen the moment Atmos starts (the Fable review's D1).
 *
 * Atmos checks every extension's files, starts official main.cjs and moves
 * storage before its window exists (that order matters: protocols, origins
 * and browser permissions come first). That can take seconds, and on a
 * first start after an update longer. Rather than reorder it, a plain
 * window opens first, where the Atmos window will be, showing what the
 * page's own boot splash shows (Rev on the theme's surface, core/index.html
 * #boot-splash). It stays above the Atmos window until that window has
 * painted, so the page's splash takes over without a flash, and goes.
 *
 * It runs no script (javascript: false), has no preload, and shows one
 * image, inlined.
 */

const fs = require('fs');

const SURFACE = '#161618'; // rgb(22, 22, 24): the default theme's --surface-rgb
const SAFETY_MS = 20000;   // gone by then whatever happens

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The splash page: the boot splash's layout and sizes, with its line (one
 * of the boot splash's own, boot-messages.cjs; the page goes on with it).
 */
function splashHtml(imageDataUrl, line = 'Starting Atmos…') {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
html, body { margin: 0; height: 100%; background: ${SURFACE}; overflow: hidden; }
#s { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
  font-family: 'Segoe UI', Roboto, Helvetica, sans-serif; }
img { width: min(180%, 660px); height: min(180%, 660px); object-fit: contain; opacity: .92; user-select: none; -webkit-user-drag: none; }
p { margin: 0; min-height: 1.2em; max-width: 480px; padding: 0 24px; font-size: .78rem; letter-spacing: .01em; text-align: center; color: rgba(255,255,255,.48); }
i { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.08); }
</style></head><body><div id="s"><img alt="" src="${imageDataUrl}"><p>${escapeHtml(line)}</p><i></i></div></body></html>`;
}

/**
 * Where the Atmos window will be: its saved bounds, the display's work area
 * when it was maximized, the whole display when it was fullscreen.
 */
function splashBounds(state, { defaults, screen }) {
  const bounds = { ...defaults, ...(state?.bounds || {}) };
  if (!state?.isMaximized && !state?.isFullScreen) return bounds;
  const display = Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    ? screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    : screen.getPrimaryDisplay();
  return { ...(state.isFullScreen ? display.bounds : display.workArea) };
}

/**
 * Open the splash. Returns { window, close() }, or null if it couldn't be
 * made (Atmos starts as before).
 */
function openStartupSplash({ BrowserWindow, screen, state, defaults, imagePath, icon, line, warn = message => console.warn(message) }) {
  let win;
  try {
    const image = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
    win = new BrowserWindow({
      ...splashBounds(state, { defaults, screen }),
      frame: false, resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, hasShadow: false, roundedCorners: true, show: false,
      backgroundColor: SURFACE, icon, title: 'Atmos',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
    });
    win.__atmosStartupSplash = true;
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(image, line))}`).catch(() => {});
  } catch (error) {
    warn(`[main] startup splash: ${error.message}`);
    return null;
  }
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
  };
  timer = setTimeout(close, SAFETY_MS);
  timer.unref?.();
  return { window: win, close };
}

module.exports = { openStartupSplash, splashHtml, splashBounds, SURFACE };

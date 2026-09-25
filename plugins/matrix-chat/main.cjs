const { net, dialog, app, BrowserWindow, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createOAuthCallbacks } = require('./oauth-callback.cjs');
const { createVault } = require('./vault.cjs');

function requestKey(event, requestId) {
  return `${event.sender.id}:${requestId}`;
}

// Headers a frame may not set on a relayed request: ones that would let it
// pose as another site or page (Cookie, Origin, Referer, Host), hijack the
// connection (proxy/transfer framing), or claim browser-only facts (Sec-*).
// Matrix requests need none of them.
const BLOCKED_HEADER = /^(cookie2?|host|origin|referer|connection|keep-alive|transfer-encoding|te|trailer|upgrade|content-length|expect|via|forwarded|x-forwarded-.*|proxy-.*|sec-.*)$/i;

function relayHeaders(headers) {
  return (Array.isArray(headers) ? headers : [])
    .filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && !BLOCKED_HEADER.test(pair[0].trim()));
}

function assertRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Matrix requests must use an HTTP(S) homeserver URL.');
  }
  return url.href;
}

/**
 * Matrix homeservers are web APIs, but Atmos's renderer has a custom origin
 * (atmos-app://local). Homeservers that omit CORS headers therefore cannot be
 * reached with renderer fetch(), even though they are otherwise valid Matrix
 * servers. Run those requests through Electron's main-process network stack,
 * where browser CORS does not apply, and return a fetch-shaped payload.
 */
exports.activate = function activate(context) {
  const controllers = new Map();

  // Frames can't start downloads: "Download" in a message's menu sends the
  // bytes here, and this asks where to save them.
  context.handle('save-file', async (event, payload) => {
    const bytes = payload?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length > 2 * 1024 * 1024 * 1024) throw new TypeError('save-file needs the file bytes.');
    const name = path.basename(String(payload?.name || 'download')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'download';
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner || undefined, { defaultPath: path.join(app.getPath('downloads'), name) });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, bytes);
    return result.filePath;
  });

  // A room or space icon: the frame can't open a file picker from an Atmos
  // menu, so this does, and returns the image's bytes.
  context.handle('pick-image', async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner || undefined, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    const file = result.canceled ? null : result.filePaths?.[0];
    if (!file) return null;
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
    if (!type) throw new TypeError('Choose a PNG, JPEG, GIF or WebP image.');
    const { size } = await fs.promises.stat(file);
    if (size > 10 * 1024 * 1024) throw new RangeError('Choose an image of 10 MB or less.');
    return { name: path.basename(file), type, bytes: new Uint8Array(await fs.promises.readFile(file)) };
  });

  // The key that encrypts saved sessions and encryption databases, kept
  // under the OS's secure storage. See vault.cjs.
  const vault = createVault({ safeStorage, fs, path, crypto, file: path.join(app.getPath('userData'), 'matrix-chat', 'vault-key.bin') });
  context.handle('vault-key', () => vault.get());

  // Matrix OAuth sign-in / sign-up: the homeserver's page opens in the
  // system browser and redirects back to a one-time 127.0.0.1 listener.
  // See oauth-callback.cjs.
  const oauth = createOAuthCallbacks({
    http,
    shell,
    windowFor: sender => BrowserWindow.fromWebContents(sender),
  });
  app.on('before-quit', () => oauth.cancelAll());
  context.handle('oauth-listen', (event, payload) => oauth.listen(event.sender, payload));
  context.handle('oauth-open', (event, payload) => oauth.open(String(payload?.flowId || ''), payload?.url));
  context.handle('oauth-wait', (event, flowId) => oauth.wait(String(flowId || '')));
  context.handle('oauth-cancel', (event, flowId) => oauth.cancel(String(flowId || '')));
  // "Manage account" and the sign-up help links: https pages, always in
  // the system browser.
  context.handle('open-link', async (event, value) => {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') throw new TypeError('Only https links can be opened.');
    await shell.openExternal(url.href);
  });

  context.handle('fetch-abort', (event, requestId) => {
    controllers.get(requestKey(event, requestId))?.abort();
  });

  context.handle('fetch', async (event, payload) => {
    const requestId = String(payload?.requestId || '');
    if (!/^[a-z0-9-]{1,80}$/i.test(requestId)) throw new TypeError('Invalid Matrix request id.');
    const key = requestKey(event, requestId);
    const controller = new AbortController();
    controllers.set(key, controller);

    try {
      const url = assertRemoteUrl(payload?.url);
      const method = String(payload?.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        throw new TypeError('Unsupported Matrix request method.');
      }
      const options = {
        method,
        headers: relayHeaders(payload?.headers),
        // Never Atmos's own cookies or HTTP auth: Matrix authenticates with
        // its own bearer token header.
        credentials: 'omit',
        signal: controller.signal,
      };

      if (method !== 'GET' && method !== 'HEAD' && payload?.body != null) {
        options.body = new Uint8Array(payload.body);
      }

      const response = await net.fetch(url, options);
      return {
        ok: true,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (error) {
      return {
        ok: false,
        name: error?.name || 'TypeError',
        message: error?.message || 'Matrix network request failed.',
      };
    } finally {
      controllers.delete(key);
    }
  });
};

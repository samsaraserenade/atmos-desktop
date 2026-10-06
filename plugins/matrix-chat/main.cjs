const { net, dialog, app, BrowserWindow, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createOAuthCallbacks } = require('./oauth-callback.cjs');
const { createVault } = require('./vault.cjs');

// A frame's own: every frame's call comes through the Atmos page (event.sender),
// and Core names the frame (event.callerFrame; an older Atmos names none).
function requestKey(event, requestId) {
  return `${event.sender.id}:${event.callerFrame?.id ?? ''}:${requestId}`;
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

// A relayed answer is held whole in the main process, which runs all of
// Atmos, before it goes to the frame: bound what one may hold (larger than a
// homeserver's usual upload limit), what all of them being read at once may,
// how many run at once (the rest wait their turn), and how long one may go
// without a byte (well past /sync's 30 s long poll), plus, before the answer,
// the time an upload takes on a slow uplink.
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_READING_BYTES = 256 * 1024 * 1024;
const MAX_RUNNING = 16;
const STALL_MS = 5 * 60 * 1000;
const SLOW_UPLOAD_BYTES_PER_MS = 64 * 1024 / 1000;

function tooLarge(message) {
  const error = new RangeError(`${message}: too large to relay.`);
  error.name = 'TypeError';
  return error;
}
const MB = bytes => `${bytes / 1024 / 1024} MB`;

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
  let running = 0;
  const waiting = [];
  let reading = 0;

  /** A turn to run, in order; rejects if the request is aborted while it waits. */
  function takeTurn(signal) {
    if (running < MAX_RUNNING) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const turn = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      };
      waiting.push(turn);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  function endTurn() {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  }

  /**
   * The answer's bytes, refused past the limits; `alive` is called on each
   * chunk. Aborted, the read stops (whatever the stream does with the
   * signal) and nothing cut short passes for the whole answer.
   */
  async function readBody(response, alive, signal) {
    if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
      response.body?.cancel().catch(() => {});
      throw tooLarge(`The homeserver's answer is over ${MB(MAX_BODY_BYTES)}`);
    }
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const stop = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        if (done) break;
        alive();
        size += value.byteLength;
        reading += value.byteLength;
        chunks.push(value);
        if (size > MAX_BODY_BYTES) throw tooLarge(`The homeserver's answer is over ${MB(MAX_BODY_BYTES)}`);
        if (reading > MAX_READING_BYTES) throw tooLarge(`The answers being read come to over ${MB(MAX_READING_BYTES)}`);
      }
    } catch (error) {
      stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', stop);
      reading -= size;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  }

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
    // A frame that goes takes its requests with it (a /sync, an upload).
    const frameGone = () => controller.abort();
    event.callerFrame?.once('destroyed', frameGone);
    let turn = false;
    let stalled = false;
    let timer = null;
    const alive = (extraMs = 0) => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; controller.abort(); }, STALL_MS + extraMs);
    };

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
        if (options.body.byteLength > MAX_BODY_BYTES) throw tooLarge(`The upload is over ${MB(MAX_BODY_BYTES)}`);
      }

      await takeTurn(controller.signal);
      turn = true;
      // Nothing comes back while an upload is still being sent.
      alive(options.body ? options.body.byteLength / SLOW_UPLOAD_BYTES_PER_MS : 0);
      const response = await net.fetch(url, options);
      alive();
      const body = await readBody(response, alive, controller.signal);
      return {
        ok: true,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body,
      };
    } catch (error) {
      if (stalled) return { ok: false, name: 'TypeError', message: 'The homeserver stopped answering.' };
      return {
        ok: false,
        name: error?.name || 'TypeError',
        message: error?.message || 'Matrix network request failed.',
      };
    } finally {
      clearTimeout(timer);
      event.callerFrame?.removeListener('destroyed', frameGone);
      controllers.delete(key);
      if (turn) endTurn();
    }
  });
};

'use strict';
/**
 * The browser half of Matrix's OAuth sign-in (matrix.org and other
 * homeservers running the Matrix Authentication Service).
 *
 * Sign-in and account creation happen on the homeserver's own web page, in
 * the system browser (shell.openExternal, never an Atmos window). When the
 * person finishes, that page redirects to http://127.0.0.1:<port>/callback,
 * a one-time listener opened here for that sign-in only (RFC 8252's loopback
 * redirect for native apps). The listener answers one matching callback,
 * shows a "return to Atmos" page, brings Atmos to the front, and closes.
 *
 * The frame side (src/oauth.js) holds the PKCE verifier and does the token
 * exchange; nothing secret passes through here except the one-time code.
 */

const CALLBACK_PATH = '/callback';
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function resultPage(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Atmos</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/**
 * @param {object} deps
 * @param {typeof import('http')} deps.http
 * @param {{ openExternal(url: string): Promise<void> }} deps.shell
 * @param {(webContents: any) => any} [deps.windowFor] - the BrowserWindow to bring forward
 */
function createOAuthCallbacks({ http, shell, windowFor = () => null, timeoutMs = FLOW_TIMEOUT_MS }) {
  const flows = new Map();
  // A flow's outcome is kept briefly after it ends, so a browser that comes
  // back before the frame starts waiting (a remembered consent can redirect
  // instantly) isn't lost.
  const finished = new Map();
  let nextFlow = 0;

  function finish(flowId, result) {
    const flow = flows.get(flowId);
    if (!flow) return;
    flows.delete(flowId);
    clearTimeout(flow.timer);
    flow.server.close();
    // Keep-alive sockets from the browser would otherwise hold the port.
    flow.server.closeAllConnections?.();
    finished.set(flowId, result);
    setTimeout(() => finished.delete(flowId), 60 * 1000).unref?.();
    flow.resolve(result);
  }

  /** Open a listener for one sign-in. `state` is the value the browser must send back. */
  async function listen(sender, { state } = {}) {
    if (!STATE_PATTERN.test(String(state || ''))) throw new TypeError('OAuth sign-in needs a random state value.');
    // One sign-in at a time: starting again cancels the one left waiting.
    for (const flowId of [...flows.keys()]) finish(flowId, { error: 'cancelled' });

    const flowId = `f${Date.now().toString(36)}${(++nextFlow).toString(36)}`;
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const server = http.createServer((request, response) => {
      let url;
      try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch { url = null; }
      const send = (status, title, message) => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        response.end(resultPage(title, message));
      };
      if (request.method !== 'GET' || !url || url.pathname !== CALLBACK_PATH) {
        send(404, 'Not found', 'This address is only used to finish signing in to Atmos.');
        return;
      }
      // Anything without this sign-in's state (a stray or forged request)
      // is turned away and the listener keeps waiting for the real one.
      if (url.searchParams.get('state') !== state) {
        send(400, 'Sign-in link expired', 'Start signing in again from Atmos.');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const cancelled = error === 'access_denied';
        send(200, cancelled ? 'Sign-in cancelled' : 'Sign-in failed',
          cancelled ? 'You can close this tab and return to Atmos.' : (url.searchParams.get('error_description') || 'Return to Atmos and try again.'));
        finish(flowId, { error, errorDescription: url.searchParams.get('error_description') || '' });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        send(400, 'Sign-in failed', 'The homeserver did not send a sign-in code. Return to Atmos and try again.');
        finish(flowId, { error: 'invalid_response' });
        return;
      }
      send(200, 'You\'re signed in', 'You can close this tab and return to Atmos.');
      const win = flows.get(flowId)?.window;
      if (win && !win.isDestroyed?.()) {
        if (win.isMinimized?.()) win.restore();
        win.show?.();
        win.focus?.();
      }
      finish(flowId, { code, state: url.searchParams.get('state') });
    });

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
    });
    const timer = setTimeout(() => finish(flowId, { error: 'timeout' }), timeoutMs);
    timer.unref?.();
    flows.set(flowId, { server, done, resolve, timer, window: windowFor(sender) });
    return { flowId, port: server.address().port, path: CALLBACK_PATH };
  }

  /** Open the homeserver's sign-in page in the system browser. */
  async function open(flowId, url) {
    if (!flows.has(flowId)) throw new Error('That sign-in has already finished.');
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new TypeError('Sign-in pages must use https.');
    await shell.openExternal(parsed.href);
  }

  /** Resolves with { code, state } or { error } once the browser comes back. */
  function wait(flowId) {
    const flow = flows.get(flowId);
    if (!flow) return Promise.resolve(finished.get(flowId) || { error: 'cancelled' });
    return flow.done;
  }

  function cancel(flowId) {
    finish(flowId, { error: 'cancelled' });
  }

  function cancelAll() {
    for (const flowId of [...flows.keys()]) finish(flowId, { error: 'cancelled' });
  }

  return { listen, open, wait, cancel, cancelAll };
}

module.exports = { createOAuthCallbacks, CALLBACK_PATH };

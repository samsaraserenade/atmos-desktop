import atmos from 'atmos-sdk';

let nextRequestId = 0;

const invoke = (name, ...args) => atmos.invoke('plugin:matrix-chat', name, ...args);

function makeRemoteError(name, message) {
  if (name === 'AbortError') return new DOMException(message, 'AbortError');
  const error = new TypeError(message);
  error.name = name || 'TypeError';
  return error;
}

/**
 * A fetch-compatible adapter for Matrix traffic. The plugin's main-process
 * entry performs the actual HTTP request so valid homeservers do not need to
 * allow Atmos's origin via CORS.
 */
export async function matrixFetch(resource, init) {
  const request = new Request(resource, init);
  if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

  const requestId = `${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`;
  const abort = () => { void invoke('fetch-abort', requestId).catch(() => {}); };
  request.signal.addEventListener('abort', abort, { once: true });

  try {
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD'
      ? null
      : await request.arrayBuffer();
    if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    const result = await invoke('fetch', {
      requestId,
      url: request.url,
      method,
      headers: [...request.headers.entries()],
      body,
    });

    if (!result?.ok) {
      throw makeRemoteError(result?.name, result?.message || 'Matrix network request failed.');
    }

    const responseBody = [204, 205, 304].includes(result.status) ? null : result.body;
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

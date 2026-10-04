'use strict';
/**
 * atmos-ext://: what extension frames load. Each extension's files from its
 * own origin (frames.frameHost), Core's SDK files to origins that have an
 * extension, a frame's document with that extension's Content-Security-
 * Policy, a library service's modules to the frames that declared it, and
 * Core's storage pages only to the move or removal running now. Moved out
 * of main.js so it can be unit-tested (atmos-ext-protocol.test.cjs); main.js
 * registers `handle` with protocol.handle and gives it what it reads:
 *
 *   framedEntries()                   active extensions that run in frames
 *   trustOf(entry)                    its trust record ({ permissions }), or null
 *   libraryService, libraryOriginsFor, resourceProvidersFor,
 *   originMayUseLibrary               from createFrameAccess (below)
 *   moveInProgress()                  { host, removeHost } of the storage move running now, or null
 *   sdkDir, originMoveScript          where Core's SDK files and the move page's script are
 */
const fs = require('fs');
const path = require('path');
const frames = require('./extension-frames.cjs');
const { resolveContainedPath } = require('./path-security.cjs');
const { MIME_BY_EXT, mimeFor, readServableFile } = require('./protocol-files.cjs');

// ui.css: Atmos's Settings rows and controls, for frames that opt in (SDK 1.1).
const SDK_FILES = Object.freeze({ '/__atmos/sdk.js': 'atmos-sdk.js', '/__atmos/frame.js': 'frame.js', '/__atmos/frame.css': 'frame.css', '/__atmos/ui.css': 'ui.css' });

/**
 * Which frame origins may use what of other extensions: a library service's
 * modules (imported cross-origin) and atmos-resource:// providers.
 *
 *   framedEntries()     active extensions that run in frames
 *   trustOf(entry)      its trust record ({ permissions }), or null
 *   findService(id)     the catalog's service of that id, or null
 *   isActive(entry)     whether it loads this session
 */
function createFrameAccess({ framedEntries, trustOf, findService, isActive }) {
  const invokes = entry => trustOf(entry)?.permissions.invokes || [];

  /** An active service whose files other extensions' frames may import, or null. */
  function libraryService(id) {
    const entry = findService(id);
    return entry && isActive(entry) && entry.manifest?.library === true ? entry : null;
  }

  /** Origins of the libraries a framed extension declared (invokes service:<id>), its own left out. */
  function libraryOriginsFor(entry) {
    const origins = new Set();
    for (const target of invokes(entry)) {
      const [kind, id] = target.split(':');
      const library = kind === 'service' ? libraryService(id) : null;
      if (library) origins.add(frames.frameOrigin(library));
    }
    origins.delete(frames.frameOrigin(entry));
    return [...origins];
  }

  /**
   * atmos-resource:// providers a framed extension may load: those it
   * registers itself ("resources"). Another extension's are never shared
   * (that went with SDK 1.0).
   */
  function resourceProvidersFor(entry) {
    return [...new Set(trustOf(entry)?.permissions.resources || [])];
  }

  /** Whether a frame origin may fetch() a resource provider's responses. */
  function originMayUseResource(origin, provider) {
    return framedEntries().some(entry => frames.frameOrigin(entry) === origin && resourceProvidersFor(entry).includes(provider));
  }

  /** Whether a frame origin belongs to an extension that declared this library. */
  function originMayUseLibrary(origin, library) {
    return framedEntries().some(entry => frames.frameOrigin(entry) === origin && invokes(entry).includes(`service:${library.id}`));
  }

  return { libraryService, libraryOriginsFor, resourceProvidersFor, originMayUseResource, originMayUseLibrary };
}

function createAtmosExtHandler({
  framedEntries, trustOf, libraryService, libraryOriginsFor, resourceProvidersFor, originMayUseLibrary,
  moveInProgress = () => null, sdkDir, originMoveScript, error = console.error,
}) {
  const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  async function serve(request) {
    const url = new URL(request.url);
    const host = url.hostname;
    const owners = framedEntries().filter(entry => frames.frameHost(entry) === host);
    const rel = decodeURIComponent(url.pathname);

    if (rel === '/__atmos/frame.html') {
      const [kind, id] = (url.searchParams.get('ext') || '').split(':');
      const entry = owners.find(candidate => candidate.kind === kind && candidate.id === id);
      if (!entry) return new Response('Forbidden', { status: 403 });
      const csp = frames.frameCsp({
        permissions: trustOf(entry)?.permissions,
        inlineScriptHashes: [frames.IMPORT_MAP_HASH],
        libraryOrigins: libraryOriginsFor(entry),
        resourceProviders: resourceProvidersFor(entry),
      });
      return new Response(frames.frameDocument(), {
        headers: { ...noStore, 'Content-Type': MIME_BY_EXT['.html'], 'Content-Security-Policy': csp },
      });
    }
    // Core's pages that copy an extension's storage into its own origin, or
    // delete it, served only to the move or removal running now (main.js:
    // _moveToOwnOrigins, _clearRemovedStorage).
    const move = moveInProgress();
    if (move && (rel === '/__atmos/move.html' || rel === '/__atmos/move.js')) {
      // export: the shared origin, or the origin whose storage is being deleted (it reads and deletes).
      const role = host === frames.FIRST_PARTY_HOST || (move.removeHost && host === move.removeHost) ? 'export'
        : move.host && host === move.host ? 'import' : null;
      if (role && rel === '/__atmos/move.html') {
        return new Response(frames.moveDocument(role), {
          headers: { ...noStore, 'Content-Type': MIME_BY_EXT['.html'], 'Content-Security-Policy': frames.moveCsp(role) },
        });
      }
      if (role) {
        return new Response(await fs.promises.readFile(originMoveScript), {
          headers: { ...noStore, 'Content-Type': MIME_BY_EXT['.js'] },
        });
      }
    }
    // An empty document in the shared first-party origin, for Core's own
    // one-time storage cleanup (main.js: _cleanUpSharedOriginStorage).
    if (rel === '/__atmos/blank.html' && host === frames.FIRST_PARTY_HOST) {
      return new Response('<!doctype html><title></title>', {
        headers: { ...noStore, 'Content-Type': MIME_BY_EXT['.html'], 'Content-Security-Policy': "default-src 'none'" },
      });
    }
    if (SDK_FILES[rel]) {
      if (!owners.length) return new Response('Not found', { status: 404 });
      const filePath = path.join(sdkDir, SDK_FILES[rel]);
      return new Response(await fs.promises.readFile(filePath), {
        headers: { ...noStore, 'Content-Type': mimeFor(filePath) },
      });
    }

    const match = rel.match(/^\/(plugins|services)\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
    const file = match ? frames.safeRelative(match[3]) : null;
    if (!file) return new Response('Not found', { status: 404 });
    const kind = match[1] === 'plugins' ? 'plugin' : 'service';
    let entry = owners.find(candidate => candidate.kind === kind && candidate.id === match[2]);
    const headers = { 'X-Content-Type-Options': 'nosniff' };
    if (!entry && kind === 'service') {
      // Another extension's frame importing a library service's modules.
      const library = libraryService(match[2]);
      if (library && frames.frameHost(library) === host) {
        entry = library;
        const origin = request.headers.get('origin');
        if (origin && originMayUseLibrary(origin, library)) {
          headers['Access-Control-Allow-Origin'] = origin;
          headers.Vary = 'Origin';
        }
      }
    }
    if (!entry) return new Response('Not found', { status: 404 });
    const filePath = resolveContainedPath(entry.path, file);
    const buf = filePath ? await readServableFile(filePath, entry.path) : null;
    if (!buf) return new Response('Not found', { status: 404 });
    // A developer folder changes under Atmos: never serve a stale copy.
    if (entry.source === 'developer') headers['Cache-Control'] = 'no-store';
    return new Response(buf, { headers: { ...headers, 'Content-Type': mimeFor(filePath) } });
  }

  return {
    async handle(request) {
      try {
        return await serve(request);
      } catch (e) {
        error('[main] atmos-ext protocol error:', e.message);
        return new Response('Error', { status: 500 });
      }
    },
  };
}

module.exports = { SDK_FILES, createFrameAccess, createAtmosExtHandler };

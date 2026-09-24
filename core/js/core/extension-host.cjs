const fs = require('fs');
const { CONTEXT_ELECTRON, normalizePermissions } = require('./extension-permissions.cjs');
const path = require('path');

// Main-process mirror of capabilities.js. Keep these values aligned so a
// manifest receives the same decision before privileged and renderer loading.
const CORE_API_VERSION = 3;
const CORE_CAPABILITIES = new Map(Object.entries({
  'extensions.manifest': 1,
  'events.namespaced': 1,
  'lifecycle.context': 1,
  'renderer.capabilities': 1,
  'surface.workspace': 1,
  'context-menu.contributions': 1,
  'panel.explicit-default': 1,
  'state.namespaced': 1,
  'appearance.semantic-colors': 1,
  'settings.appearance-contributions': 1,
  'sidebar.resizable-sections': 1,
  'extensions.after': 1,
  'extensions.tiers': 1,
  'extensions.permissions': 1,
  'extensions.frames': 3, // 2: listen, legacy localStorage, setWallpaper, fileDrops, shortcut; 3: header menus, legacy state/IndexedDB keys, legacyId, toggling shortcuts, menu ticks and selects, notifications, wallpaper, audio, drawers, menu controls and icons, boot keys
  'panel.surface-presentation': 1,
  'panel.pass-through': 1,
}));

function readCompatibleManifest(extensionRoot) {
  const manifestPath = path.join(extensionRoot, 'extension.json');
  if (!fs.existsSync(manifestPath)) return { compatible: true, manifest: null };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { compatible: false, reason: `invalid extension.json: ${error.message}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { compatible: false, reason: 'extension.json root must be an object' };
  }
  if (manifest.apiVersion !== undefined && !Number.isFinite(manifest.apiVersion)) {
    return { compatible: false, reason: 'apiVersion must be a number' };
  }
  if (Number.isFinite(manifest.apiVersion) && manifest.apiVersion > CORE_API_VERSION) {
    return {
      compatible: false,
      reason: `requires core API ${manifest.apiVersion}, current API is ${CORE_API_VERSION}`,
    };
  }

  const requirements = Array.isArray(manifest.requires)
    ? manifest.requires.map(name => [name, 1])
    : manifest.requires && typeof manifest.requires === 'object'
      ? Object.entries(manifest.requires)
        .filter(([, required]) => required !== false)
        .map(([name, version]) => [name, Number.isFinite(version) ? version : 1])
      : [];
  for (const [name, version] of requirements) {
    if ((CORE_CAPABILITIES.get(name) ?? 0) < version) {
      return { compatible: false, reason: `requires capability '${name}' v${version}` };
    }
  }
  return { compatible: true, manifest };
}

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Orders extensions so each one starts after the ids its manifest lists in
 * `after`. Dependencies that are not present (not installed, disabled or
 * incompatible) are ignored. Ties keep alphabetical order, and a cycle is
 * reported and broken alphabetically rather than blocking startup.
 *
 * @param {{ id: string, manifest?: object | null }[]} entries
 * @param {(message: string) => void} [warn]
 */
function orderExtensions(entries, warn = message => console.warn(message)) {
  const byId = new Map([...entries].sort((a, b) => a.id.localeCompare(b.id)).map(entry => [entry.id, entry]));
  const waitingOn = new Map();
  for (const [id, entry] of byId) {
    const after = Array.isArray(entry.manifest?.after) ? entry.manifest.after : [];
    waitingOn.set(id, new Set(after.filter(dep => typeof dep === 'string' && VALID_ID.test(dep) && dep !== id && byId.has(dep))));
  }
  const ordered = [];
  while (waitingOn.size) {
    let ready = [...waitingOn].find(([, deps]) => deps.size === 0)?.[0];
    if (!ready) {
      const stuck = [...waitingOn.keys()];
      warn(`[extensions] circular "after" ordering between ${stuck.join(', ')}; starting '${stuck[0]}' first`);
      ready = stuck[0];
    }
    ordered.push(byId.get(ready));
    waitingOn.delete(ready);
    for (const deps of waitingOn.values()) deps.delete(ready);
  }
  return ordered;
}

function createExtensionHost(dependencies) {
  const resourceProviders = new Map();
  const capabilities = new Map();
  const ipcChannels = new Set();

  function scopedChannel(kind, id, name) {
    if (!['plugin', 'service'].includes(kind) || !VALID_ID.test(id) || !/^[a-z0-9][a-z0-9:-]*$/.test(name)) {
      throw new Error('Invalid extension IPC channel');
    }
    return `atmos-extension:${kind}:${id}:${name}`;
  }

  /**
   * The context handed to a main.cjs. It only carries what the extension's
   * `permissions` declare: the listed Electron objects (never ipcMain or
   * protocol), IPC when "ipc" is true, and the named capabilities and
   * resource providers. Anything else throws, so undeclared use fails loudly.
   */
  function context(kind, id, root, manifest = null) {
    const permissions = normalizePermissions(manifest?.permissions);
    const label = `${kind} '${id}'`;
    const deny = what => { throw new Error(`[extensions] ${label} is not permitted to ${what}; declare it in extension.json "permissions"`); };
    const granted = Object.fromEntries(CONTEXT_ELECTRON
      .filter(name => permissions.electron.includes(name) && dependencies[name] !== undefined)
      .map(name => [name, dependencies[name]]));
    return {
      ...granted,
      kind,
      id,
      root,
      permissions,
      handle(name, handler) {
        if (!permissions.ipc) deny('register IPC handlers ("ipc": true)');
        if (typeof handler !== 'function') throw new Error('Extension IPC handler must be a function');
        const channel = scopedChannel(kind, id, name);
        if (ipcChannels.has(channel)) throw new Error(`Extension IPC handler already registered: ${name}`);
        dependencies.ipcMain.handle(channel, handler);
        ipcChannels.add(channel);
        return channel;
      },
      send(webContents, name, ...args) {
        if (!permissions.ipc) deny('send IPC events ("ipc": true)');
        if (!webContents || typeof webContents.send !== 'function') throw new Error('Extension IPC target is unavailable');
        webContents.send(scopedChannel(kind, id, name), ...args);
      },
      provide(name, value) {
        if (!permissions.provides.includes(name)) deny(`provide capability '${name}' ("provides")`);
        if (capabilities.has(name)) throw new Error(`Capability already registered: ${name}`);
        capabilities.set(name, value);
      },
      use(name) {
        if (!permissions.uses.includes(name)) deny(`use capability '${name}' ("uses")`);
        return capabilities.get(name);
      },
      registerResourceProvider(name, handler) {
        if (!permissions.resources.includes(name)) deny(`register resource provider '${name}' ("resources")`);
        if (resourceProviders.has(name)) throw new Error(`Resource provider already registered: ${name}`);
        resourceProviders.set(name, handler);
      },
    };
  }

  function _foldersIn(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ id: entry.name, path: path.join(root, entry.name) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Activate every folder in `root` (kept for tests and simple setups). */
  async function activateRoot(kind, root, options = {}) {
    return activateEntries(kind, _foldersIn(root), options);
  }

  /** Activate the main.cjs of each `{ id, path }` entry, in "after" order. */
  async function activateEntries(kind, entries, { exclude = new Set() } = {}) {
    const candidates = [];
    for (const { id, path: extensionRoot } of entries) {
      if (exclude.has(id)) continue;
      const entryPath = path.join(extensionRoot, 'main.cjs');
      if (!fs.existsSync(entryPath)) continue;
      const compatibility = readCompatibleManifest(extensionRoot);
      if (!compatibility.compatible) {
        console.warn(`[extensions] ${kind} '${id}' skipped: ${compatibility.reason}`);
        continue;
      }
      candidates.push({ id, manifest: compatibility.manifest, extensionRoot, entryPath });
    }

    for (const { id, manifest, extensionRoot, entryPath } of orderExtensions(candidates)) {
      try {
        const entry = require(entryPath);
        const activate = typeof entry === 'function' ? entry : entry.activate;
        if (typeof activate !== 'function') {
          console.warn(`[extensions] ${kind} '${id}' has main.cjs without an activate function`);
          continue;
        }
        await activate(context(kind, id, extensionRoot, manifest));
        console.log(`[extensions] activated ${kind} '${id}'`);
      } catch (error) {
        console.error(`[extensions] failed to activate ${kind} '${id}':`, error);
      }
    }
  }

  /** Service ids replaced by plugins; accepts a plugin root or `{ id, path }` entries. */
  function supersededServices(plugins, { exclude = new Set() } = {}) {
    const result = new Set();
    const entries = typeof plugins === 'string' ? _foldersIn(plugins) : plugins;
    for (const { id: pluginId, path: extensionRoot } of entries) {
      if (exclude.has(pluginId)) continue;
      const compatibility = readCompatibleManifest(extensionRoot);
      if (!compatibility.compatible) {
        console.warn(`[extensions] plugin '${pluginId}' cannot supersede services: ${compatibility.reason}`);
        continue;
      }
      for (const id of compatibility.manifest?.supersedesServices || []) {
        if (VALID_ID.test(id)) result.add(id);
      }
    }
    return result;
  }

  // `allowOrigin(origin, provider)` says whether a frame origin may read a
  // provider's responses with fetch(); the frame's CSP already limits which
  // providers it can load at all.
  function registerResourceProtocol(protocol, { allowOrigin = () => false } = {}) {
    protocol.handle('atmos-resource', async request => {
      try {
        const url = new URL(request.url);
        const provider = resourceProviders.get(url.hostname);
        if (!provider) return new Response('Unknown provider', { status: 404 });
        const response = await provider({ request, url, pathname: decodeURIComponent(url.pathname.replace(/^\//, '')) });
        const origin = request.headers.get('origin');
        if (!origin || !response || !allowOrigin(origin, url.hostname)) return response;
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', origin);
        headers.append('Vary', 'Origin');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        console.error('[extensions] resource request failed:', error);
        return new Response('Error', { status: 500 });
      }
    });
  }

  return { activateRoot, activateEntries, registerResourceProtocol, scopedChannel, supersededServices };
}

module.exports = { createExtensionHost, orderExtensions };

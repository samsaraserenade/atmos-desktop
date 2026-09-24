'use strict';
/**
 * Extension permissions: the `permissions` block of extension.json.
 *
 *   "permissions": {
 *     "network":   ["api.example.com", "*.example.org"] | ["*"],
 *     "browser":   ["geolocation", "clipboard-read", "notifications", "media", "display-capture"],
 *     "invokes":   ["service:example-service"],     // other extensions' IPC it calls
 *     "node":      ["fs", "path", "child_process"],  // modules main.cjs requires
 *     "electron":  ["dialog", "shell", "app", "BrowserWindow", "clipboard", "nativeImage", "net"],
 *     "ipc":       true,                              // main.cjs registers IPC handlers
 *     "provides":  ["example-data"],                  // main-process capabilities it offers
 *     "uses":      ["media-library"],                 // main-process capabilities it uses
 *     "resources": ["example-art"]                    // atmos-resource:// providers
 *   }
 *
 * Core enforces what passes through it: the Electron objects, IPC,
 * capabilities and resource providers a main.cjs receives, and the browser
 * permissions the Atmos window may use. Direct Node `require()` calls and
 * renderer network access cannot be enforced in-process; they are declared
 * and checked statically by scripts/extension-permissions.test.cjs.
 */

const KEYS = ['network', 'browser', 'invokes', 'node', 'electron', 'ipc', 'provides', 'uses', 'resources'];
// "wasm" is not a Chromium permission: it lets the extension's frames
// compile WebAssembly (their CSP gets 'wasm-unsafe-eval').
const BROWSER_PERMISSIONS = ['geolocation', 'clipboard-read', 'notifications', 'media', 'display-capture', 'wasm'];
// Electron objects Core can hand to a main.cjs through its context.
const CONTEXT_ELECTRON = ['app', 'BrowserWindow', 'dialog', 'shell'];
// Browser permissions every page may use without declaring them.
const BASELINE_BROWSER = ['clipboard-sanitized-write', 'fullscreen'];

const EMPTY = Object.freeze({
  network: [], browser: [], invokes: [], node: [], electron: [], ipc: false, provides: [], uses: [], resources: [],
});

function list(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) {
    throw new TypeError(`permissions.${key} must be an array of strings`);
  }
  return [...new Set(value.map(item => item.trim()))].sort();
}

/** Validate and normalise a permissions block. Missing means "none". */
function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) return { ...EMPTY };
  if (typeof permissions !== 'object' || Array.isArray(permissions)) throw new TypeError('permissions must be an object');
  const unknown = Object.keys(permissions).filter(key => !KEYS.includes(key));
  if (unknown.length) throw new TypeError(`unknown permission ${unknown.map(key => `"${key}"`).join(', ')}`);
  if (permissions.ipc !== undefined && typeof permissions.ipc !== 'boolean') throw new TypeError('permissions.ipc must be true or false');
  const normalized = {
    network: list(permissions.network, 'network').map(host => host.toLowerCase()),
    browser: list(permissions.browser, 'browser'),
    invokes: list(permissions.invokes, 'invokes'),
    node: list(permissions.node, 'node'),
    electron: list(permissions.electron, 'electron'),
    ipc: permissions.ipc === true,
    provides: list(permissions.provides, 'provides'),
    uses: list(permissions.uses, 'uses'),
    resources: list(permissions.resources, 'resources'),
  };
  const badBrowser = normalized.browser.filter(name => !BROWSER_PERMISSIONS.includes(name));
  if (badBrowser.length) throw new TypeError(`unknown browser permission ${badBrowser.join(', ')}`);
  const badInvoke = normalized.invokes.filter(name => !/^(plugin|service):[a-z0-9][a-z0-9-]*$/.test(name));
  if (badInvoke.length) throw new TypeError(`permissions.invokes entries look like "service:id" (${badInvoke.join(', ')})`);
  return normalized;
}

const RISKY_NODE = {
  child_process: 'Run other programs on your computer',
  fs: 'Read and write files on your computer',
  http: 'Open network connections or run a local server',
  https: 'Open network connections or run a local server',
  net: 'Open network connections or run a local server',
  os: 'Read information about your computer',
};
const ELECTRON_TEXT = {
  app: 'Read Atmos app details and folders',
  BrowserWindow: 'Control Atmos windows',
  dialog: 'Show open and save dialogs',
  shell: 'Open files, folders and links in other apps',
  clipboard: 'Use the clipboard from the main process',
  net: 'Make network requests from the main process',
};
const BROWSER_TEXT = {
  geolocation: 'Use your location',
  'clipboard-read': 'Read the clipboard',
  notifications: 'Show system notifications',
  media: 'Use your camera or microphone',
  'display-capture': 'Capture your screen',
  wasm: 'Run compiled WebAssembly code',
};

/** Plain-language lines for Settings and the approval prompt. */
function describePermissions(permissions, { hasMain = false } = {}) {
  const p = normalizePermissions(permissions);
  const lines = [];
  if (hasMain) lines.push('Runs code in Atmos’s main process, with full access to your computer');
  const node = [...new Set(p.node.map(name => RISKY_NODE[name]).filter(Boolean))];
  lines.push(...node);
  lines.push(...p.electron.map(name => ELECTRON_TEXT[name]).filter(Boolean));
  lines.push(...p.browser.map(name => BROWSER_TEXT[name]));
  if (p.network.includes('*')) lines.push('Connect to any website or server');
  else if (p.network.length) {
    const shown = p.network.slice(0, 4).join(', ');
    lines.push(`Connect to ${shown}${p.network.length > 4 ? ` and ${p.network.length - 4} more` : ''}`);
  }
  if (p.invokes.length) lines.push(`Call ${p.invokes.map(name => name.split(':')[1]).join(', ')}`);
  if (p.provides.length) lines.push(`Share ${p.provides.join(', ')} with other extensions`);
  if (p.uses.length) lines.push(`Use ${p.uses.join(', ')} from other extensions`);
  if (!lines.length) lines.push('No special permissions');
  return [...new Set(lines)];
}

module.exports = {
  BASELINE_BROWSER, BROWSER_PERMISSIONS, CONTEXT_ELECTRON, KEYS,
  normalizePermissions, describePermissions,
};

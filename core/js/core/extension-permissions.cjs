'use strict';
/**
 * Extension permissions: the `permissions` block of extension.json.
 *
 *   "permissions": {
 *     "network":   ["api.example.com", "*.example.org"] | ["*"],
 *     "browser":   ["geolocation", "clipboard-read", "notifications", "media", "display-capture"],
 *     "invokes":   ["service:example-service"],     // other extensions it talks to
 *     "node":      ["fs", "path", "child_process"],  // modules main.cjs requires
 *     "electron":  ["dialog", "shell", "app", "BrowserWindow", "clipboard", "nativeImage", "net"],
 *     "ipc":       true,                              // main.cjs registers IPC handlers
 *     "resources": ["example-art"]                    // atmos-resource:// providers
 *   }
 *
 * Core enforces what passes through it: the Electron objects, IPC and
 * resource providers a main.cjs receives, the hosts a frame and
 * atmos.fetch() reach, and the browser permissions each origin may use.
 * Direct Node `require()` calls cannot be enforced in-process; they are
 * declared and checked statically by scripts/extension-permissions.test.cjs.
 *
 * "provides" (main-process capabilities) is still accepted, so packages
 * made before SDK 1.0 load, but means nothing: nothing could use them.
 */

const KEYS = ['network', 'browser', 'invokes', 'node', 'electron', 'ipc', 'provides', 'resources'];
// "wasm" is not a Chromium permission: it lets the extension's frames
// compile WebAssembly (their CSP gets 'wasm-unsafe-eval').
const BROWSER_PERMISSIONS = ['geolocation', 'clipboard-read', 'notifications', 'media', 'display-capture', 'wasm'];
// Electron objects Core can hand to a main.cjs through its context.
const CONTEXT_ELECTRON = ['app', 'BrowserWindow', 'dialog', 'shell'];
// Browser permissions every page may use without declaring them.
const BASELINE_BROWSER = ['clipboard-sanitized-write', 'fullscreen'];

const EMPTY = Object.freeze({
  network: [], browser: [], invokes: [], node: [], electron: [], ipc: false, provides: [], resources: [],
});

// A network entry is a host name (a label or more, dots between, no
// scheme, port, path or spaces), optionally "*." for its subdomains, or "*"
// for any host. It becomes a CSP source and the atmos.fetch() allow-list,
// so anything else could mean more than the approval prompt says.
const HOST_PATTERN = /^(\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Names that mean this computer or the local network, whatever resolves
// them: "Connect to printer.lan" mustn't read like a website.
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa'];

/**
 * Whether a normalised network entry is a public host name, "*.host" or
 * "*". Not an IP address (the last label of a name always has a letter:
 * "127.0.0.1" and "0x7f.1" are addresses) and not a local-only name.
 */
function isValidHost(entry) {
  if (entry === '*') return true;
  if (!HOST_PATTERN.test(entry)) return false;
  const name = entry.replace(/^\*\./, '');
  if (!/[a-z]/.test(name.slice(name.lastIndexOf('.') + 1))) return false;
  return !LOCAL_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * Whether `host` (a URL's hostname) is covered by `network`: exactly, by a
 * "*.parent" entry (its subdomains, not the parent itself, as in CSP), or
 * by "*".
 */
function hostAllowed(host, network) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!name) return false;
  return (network || []).some(entry => entry === '*'
    || entry === name
    || (entry.startsWith('*.') && name.endsWith(entry.slice(1))));
}

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
    network: [...new Set(list(permissions.network, 'network').map(host => host.toLowerCase()))].sort(),
    browser: list(permissions.browser, 'browser'),
    invokes: list(permissions.invokes, 'invokes'),
    node: list(permissions.node, 'node'),
    electron: list(permissions.electron, 'electron'),
    ipc: permissions.ipc === true,
    provides: list(permissions.provides, 'provides'),
    resources: list(permissions.resources, 'resources'),
  };
  const badHosts = normalized.network.filter(entry => !isValidHost(entry));
  if (badHosts.length) {
    throw new TypeError(`permissions.network entries are public host names like "api.example.com" or "*.example.com", or "*"; not addresses, ports, paths or local names (${badHosts.map(entry => JSON.stringify(entry)).join(', ')})`);
  }
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
  safeStorage: 'Encrypt data with your system\u2019s secure storage',
};
// The system services an extension reaches through the SDK, in plain words.
const SYSTEM_INVOKES = {
  'service:audio': 'Play audio',
  'service:wallpaper': 'See and change your wallpaper',
  'service:location': 'Know your location, as set in Atmos',
};
const BROWSER_TEXT = {
  geolocation: 'Use your location',
  'clipboard-read': 'Read the clipboard',
  notifications: 'Show system notifications',
  media: 'Use your camera or microphone',
  'display-capture': 'Capture your screen',
  wasm: 'Run compiled WebAssembly code',
};

/**
 * Plain-language lines for Settings and the approval prompt. `everyHost`
 * names every host rather than four and "N more" (for anything the user
 * approves, and for what an update adds).
 */
function describePermissions(permissions, { hasMain = false, everyHost = false } = {}) {
  const p = normalizePermissions(permissions);
  const lines = [];
  if (hasMain) lines.push('Runs code in Atmos’s main process, with full access to your computer');
  const node = [...new Set(p.node.map(name => RISKY_NODE[name]).filter(Boolean))];
  lines.push(...node);
  lines.push(...p.electron.map(name => ELECTRON_TEXT[name]).filter(Boolean));
  lines.push(...p.browser.map(name => BROWSER_TEXT[name]));
  if (p.network.includes('*')) lines.push('Connect to any website or server');
  else if (p.network.length) {
    const shown = (everyHost ? p.network : p.network.slice(0, 4)).join(', ');
    lines.push(`Connect to ${shown}${!everyHost && p.network.length > 4 ? ` and ${p.network.length - 4} more` : ''}`);
  }
  lines.push(...p.invokes.filter(name => SYSTEM_INVOKES[name]).map(name => SYSTEM_INVOKES[name]));
  const others = p.invokes.filter(name => !SYSTEM_INVOKES[name]);
  if (others.length) lines.push(`Use what ${others.map(name => name.split(':')[1]).join(', ')} share${others.length === 1 ? 's' : ''} with other extensions`);
  if (!lines.length) lines.push('No special permissions');
  return [...new Set(lines)];
}

/** Whether network entry `entry` is already covered by the entries in `list`. */
function hostCovered(entry, list) {
  if (list.includes('*') || list.includes(entry)) return true;
  if (entry === '*') return false;
  if (!entry.startsWith('*.')) return hostAllowed(entry, list);
  // "*.a.example" is within "*.example"; nothing narrower covers a wildcard.
  const name = entry.slice(2);
  return list.some(other => other.startsWith('*.') && name.endsWith(other.slice(1)));
}

/**
 * What `current` asks for that `approved` didn't, compared as data (not as
 * the English lines): { network, browser, invokes, … } with only the
 * additions, or null when nothing was added. `approved` that can't be read
 * (from an older Atmos) counts as nothing approved.
 */
function permissionsAdded(current, approved) {
  const now = normalizePermissions(current);
  let before;
  try { before = normalizePermissions(approved ?? undefined); } catch { before = normalizePermissions(undefined); }
  const added = {};
  for (const key of ['browser', 'invokes', 'node', 'electron', 'provides', 'resources']) {
    const had = new Set(before[key]);
    const extra = now[key].filter(value => !had.has(value));
    if (extra.length) added[key] = extra;
  }
  const hosts = now.network.filter(entry => !hostCovered(entry, before.network));
  if (hosts.length) added.network = hosts;
  if (now.ipc && !before.ipc) added.ipc = true;
  return Object.keys(added).length ? added : null;
}

// ── What an extension shares with others ("exports") ─────────────────────
//
//   "exports": {
//     "ipc":       { "read-tags": "official" },   // main.cjs handlers (invoke)
//     "events":    { "changed": "all" },          // its events: main.cjs context.send() and atmos.events
//     "methods":   { "greet": "all" }             // methods its boot frame expose()s (call)
//   }
//
// SDK 1.1: a name may instead say what it gives, in plain words, for
// Settings and the approval prompt:
//
//     "methods":   { "palette": { "with": "all", "description": "The sky's colours now, without your location" } }
//
// An extension's atmos-resource:// providers serve its own frames only
// (sharing them, "exports.resources", went with SDK 1.0: nothing used it).
//
// Everything an extension offers is its own until it is listed here. The
// level says who else may use it: "official" (system and official
// extensions) or "all" (community extensions too). Another extension also
// has to declare the target in "permissions.invokes". An extension always
// reaches everything of its own; the Atmos page never invokes handlers itself.
//
// An extension with no "exports" block at all (made before Atmos 0.12)
// shares everything with official extensions, as before, and nothing with
// community ones: an official extension that hasn't been updated yet keeps
// working with the others. Its reach lists are then ["*"].

const EXPORT_KINDS = ['ipc', 'events', 'methods'];
const EXPORT_LEVELS = ['official', 'all'];
const EXPORT_NAME = /^[a-z0-9][a-z0-9:._-]*$/i;

const EXPORT_DESCRIPTION_MAX = 200;

/** One exported name's value: "official" | "all", or { with, description }. */
function exportEntry(kind, name, value) {
  if (typeof value === 'string') {
    if (!EXPORT_LEVELS.includes(value)) throw new TypeError(`exports.${kind}.${name} must be "official" or "all"`);
    return { level: value, description: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`exports.${kind}.${name} must be "official", "all" or { "with": …, "description": … }`);
  }
  const unknown = Object.keys(value).filter(key => key !== 'with' && key !== 'description');
  if (unknown.length) throw new TypeError(`exports.${kind}.${name} has unknown ${unknown.map(key => `"${key}"`).join(', ')} (use "with" and "description")`);
  if (!EXPORT_LEVELS.includes(value.with)) throw new TypeError(`exports.${kind}.${name}.with must be "official" or "all"`);
  let description = null;
  if (value.description !== undefined) {
    description = typeof value.description === 'string' ? value.description.replace(/\s+/g, ' ').trim() : '';
    if (!description || description.length > EXPORT_DESCRIPTION_MAX) {
      throw new TypeError(`exports.${kind}.${name}.description must be text of 1–${EXPORT_DESCRIPTION_MAX} characters`);
    }
  }
  return { level: value.with, description };
}

/**
 * Validate an "exports" block and give each name's level and description:
 * { ipc: { name: { level, description } }, ... }. Missing means nothing shared.
 */
function exportDetails(exportsBlock) {
  const out = Object.fromEntries(EXPORT_KINDS.map(kind => [kind, {}]));
  if (exportsBlock === undefined || exportsBlock === null) return out;
  if (typeof exportsBlock !== 'object' || Array.isArray(exportsBlock)) throw new TypeError('exports must be an object');
  const unknown = Object.keys(exportsBlock).filter(key => !EXPORT_KINDS.includes(key));
  if (unknown.length) throw new TypeError(`unknown exports ${unknown.map(key => `"${key}"`).join(', ')} (use ${EXPORT_KINDS.join(', ')})`);
  for (const kind of EXPORT_KINDS) {
    const block = exportsBlock[kind];
    if (block === undefined) continue;
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new TypeError(`exports.${kind} must be an object of name: "official" | "all"`);
    for (const [name, value] of Object.entries(block)) {
      if (!EXPORT_NAME.test(name)) throw new TypeError(`exports.${kind} has an invalid name "${name}"`);
      out[kind][name] = exportEntry(kind, name, value);
    }
  }
  return out;
}

/** Validate and normalise an "exports" block: { ipc: { name: level }, ... }. Missing means nothing shared. */
function normalizeExports(exportsBlock) {
  const details = exportDetails(exportsBlock);
  return Object.fromEntries(EXPORT_KINDS.map(kind => [kind,
    Object.fromEntries(Object.entries(details[kind]).map(([name, { level }]) => [name, level]))]));
}

const joinWords = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
const exportLabel = (kind, name) => (kind === 'methods' ? `${name}()` : kind === 'events' ? `${name} events` : `its ${name} handler`);

/**
 * Plain-language lines for an extension's own card and approval prompt:
 * what it shares, with whom, and (when it says) what that gives. `null`
 * for no "exports" block (it shares everything with official extensions
 * only); [] when the block shares nothing.
 */
function describeExports(exportsBlock) {
  if (exportsBlock === undefined || exportsBlock === null) return null;
  const details = exportDetails(exportsBlock);
  const lines = [];
  for (const level of ['all', 'official']) {
    for (const kind of ['methods', 'events', 'ipc']) {
      for (const [name, entry] of Object.entries(details[kind]).sort(([a], [b]) => a.localeCompare(b))) {
        if (entry.level !== level) continue;
        const who = level === 'all' ? 'Any extension' : 'Official extensions';
        const what = kind === 'methods' ? `can call ${name}()` : kind === 'events' ? `can hear its ${name} events` : `can use its ${name} handler`;
        lines.push(`${who} ${what}${entry.description ? `: ${entry.description}` : ''}`);
      }
    }
  }
  return lines;
}

// What an extension may hold that it could pass on to others through what
// it shares: the location, the camera, the clipboard, the screen.
const SENSITIVE = {
  invokes: { 'service:location': 'know your location' },
  browser: { geolocation: 'use your location', 'clipboard-read': 'read the clipboard', media: 'use your camera or microphone', 'display-capture': 'capture your screen' },
};

/**
 * A warning for Settings when an extension can reach something sensitive
 * and shares anything with every extension, which could pass it on to
 * extensions that were never allowed it themselves. Null otherwise.
 */
function sharingRisk(permissions, exportsBlock) {
  let p;
  let details;
  try { p = normalizePermissions(permissions); details = exportDetails(exportsBlock); } catch { return null; }
  const holds = [
    ...p.invokes.filter(name => SENSITIVE.invokes[name]).map(name => SENSITIVE.invokes[name]),
    ...p.browser.filter(name => SENSITIVE.browser[name]).map(name => SENSITIVE.browser[name]),
  ];
  const shared = EXPORT_KINDS.flatMap(kind => Object.entries(details[kind])
    .filter(([, entry]) => entry.level === 'all').map(([name]) => exportLabel(kind, name)));
  if (!holds.length || !shared.length) return null;
  return `It can ${joinWords([...new Set(holds)])}, and shares ${joinWords(shared)} with any extension, so what it shares could pass that on.`;
}

/** Whether an extension of `tier` may use something exported at `level`. */
function levelAllows(level, tier) {
  if (level === 'all') return true;
  if (level === 'official') return tier === 'system' || tier === 'first-party';
  return false;
}

/**
 * What `caller` ({ kind, id, tier, invokes }) may use of `target`
 * ({ kind, id, exports }): { ipc, events, methods }, each a list
 * of names, or ["*"] for everything (a target with no "exports" block,
 * to an official caller). Its own extension: `null` (everything). Not
 * declared in "invokes": nothing.
 */

/** Whether a reach list (from reachOf) includes `name`. */
function reaches(list, name) {
  return Array.isArray(list) && (list.includes('*') || list.includes(name));
}
function reachOf(caller, target) {
  if (caller.kind === target.kind && caller.id === target.id) return null;
  const empty = Object.fromEntries(EXPORT_KINDS.map(kind => [kind, []]));
  if (!(caller.invokes || []).includes(`${target.kind}:${target.id}`)) return empty;
  if (target.exports === undefined || target.exports === null) {
    return levelAllows('official', caller.tier) ? Object.fromEntries(EXPORT_KINDS.map(kind => [kind, ['*']])) : empty;
  }
  let shared;
  try { shared = normalizeExports(target.exports); } catch { return empty; }
  return Object.fromEntries(EXPORT_KINDS.map(kind => [kind,
    Object.entries(shared[kind]).filter(([, level]) => levelAllows(level, caller.tier)).map(([name]) => name).sort()]));
}

module.exports = {
  BASELINE_BROWSER, CONTEXT_ELECTRON, normalizePermissions, describePermissions, normalizeExports, exportDetails, describeExports, sharingRisk, levelAllows, reachOf, reaches,
  isValidHost, hostAllowed, hostCovered, permissionsAdded,
};

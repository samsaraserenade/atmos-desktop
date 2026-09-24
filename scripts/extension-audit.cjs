'use strict';
/**
 * Static permission audit for extensions.
 *
 * scanExtension(dir) reads an extension's source and reports what it
 * actually uses: Node modules and Electron APIs in main-process code, IPC,
 * shared capabilities and resource providers, browser permissions, the
 * network hosts it names, and other extensions' IPC it calls.
 * auditExtension(dir) compares that with the `permissions` declared in
 * extension.json and returns the problems. The test in
 * scripts/extension-permissions.test.cjs runs it over every bundled
 * extension, whatever its tier.
 *
 * This is a static check: it catches regressions and undeclared use in
 * first-party code, it is not a sandbox.
 */

const fs = require('fs');
const path = require('path');
const { normalizePermissions } = require('../core/js/core/extension-permissions.cjs');

// Folders Atmos never executes (dev tooling, companion apps, fixtures).
const NOT_EXECUTED = new Set([
  'node_modules', 'tests', 'tools', 'backend', 'mobile-android', 'android-client',
  'browser-extension', 'benchmarks', 'build', 'docs', 'data', 'backups', '_to_delete',
]);
// Hosts that appear in code without being contacted (XML namespaces, placeholders).
const IGNORED_HOSTS = [/^www\.w3\.org$/, /\.invalid$/, /^localhost$/, /^127\.0\.0\.1$/, /^example\.(com|org)$/];
const ELECTRON_APIS = ['app', 'BrowserWindow', 'dialog', 'shell', 'clipboard', 'nativeImage', 'net', 'session', 'safeStorage', 'Notification', 'powerMonitor', 'screen', 'webContents'];

function walk(root, exclude, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (NOT_EXECUTED.has(entry.name) || exclude.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      walk(root, exclude, full, out);
    } else if (/\.(c?js|mjs)$/.test(entry.name) && !/\.test\.|\.min\.js$/.test(entry.name)) {
      out.push({ rel, full });
    }
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function scanExtension(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  const id = path.basename(dir);
  const exclude = Array.isArray(manifest.auditExclude) ? manifest.auditExclude : [];
  const used = {
    node: new Set(), electron: new Set(), ipc: false,
    provides: new Set(), uses: new Set(), resources: new Set(),
    browser: new Set(), network: new Set(), invokes: new Set(),
  };
  const where = {};
  const note = (key, value, file) => { (where[`${key}:${value}`] ||= []).push(file); };

  for (const { rel, full } of walk(dir, exclude)) {
    const raw = fs.readFileSync(full, 'utf8');
    const source = stripComments(raw);
    const vendor = rel.startsWith('vendor/');
    const main = rel.endsWith('.cjs');

    if (main) {
      for (const [, name] of source.matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)) {
        const module = name.replace(/^node:/, '').replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, '$1');
        used.node.add(module); note('node', module, rel);
      }
      for (const [, api] of source.matchAll(/\bcontext\.(app|BrowserWindow|dialog|shell|ipcMain|protocol)\b/g)) {
        used.electron.add(api); note('electron', api, rel);
      }
      for (const [, names] of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:context|require\(\s*['"]electron['"]\s*\))/g)) {
        for (const name of names.split(',').map(part => part.trim().split(/\s*:\s*/)[0])) {
          if (ELECTRON_APIS.includes(name)) { used.electron.add(name); note('electron', name, rel); }
        }
      }
      for (const [, api] of source.matchAll(/require\(\s*['"]electron['"]\s*\)\.(\w+)/g)) {
        if (ELECTRON_APIS.includes(api)) { used.electron.add(api); note('electron', api, rel); }
      }
      if (/\bcontext\.(handle|send)\(/.test(source)) { used.ipc = true; note('ipc', 'true', rel); }
      // Names may be string literals or constants defined in the same file.
      const constant = identifier => source.match(new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*['"]([\\w.-]+)['"]`))?.[1];
      const names = pattern => [...source.matchAll(pattern)].map(([, literal, identifier]) => literal || constant(identifier) || `<${identifier}>`);
      const ARG = String.raw`\(\s*(?:['"]([\w.-]+)['"]|([A-Za-z_$][\w$]*))`;
      for (const name of names(new RegExp(String.raw`\bcontext\.provide\??\.?` + ARG, 'g'))) { used.provides.add(name); note('provides', name, rel); }
      for (const name of names(new RegExp(String.raw`\bcontext\.use\??\.?` + ARG, 'g'))) { used.uses.add(name); note('uses', name, rel); }
      for (const name of names(new RegExp(String.raw`\bregisterResourceProvider` + ARG, 'g'))) { used.resources.add(name); note('resources', name, rel); }
    } else if (!vendor) {
      // Vendored libraries are skipped: their unused code paths (e.g. a chat
      // SDK's call support) would otherwise demand permissions nobody uses.
      const browser = [
        [/navigator\.geolocation/, 'geolocation'],
        [/navigator\.clipboard\.read(Text)?\(/, 'clipboard-read'],
        [/\bnew Notification\(|Notification\.requestPermission|\bnotifications\.show\(/, 'notifications'],
        [/getUserMedia\(/, 'media'],
        [/getDisplayMedia\(/, 'display-capture'],
      ];
      for (const [pattern, permission] of browser) {
        if (pattern.test(source)) { used.browser.add(permission); note('browser', permission, rel); }
      }
      for (const [, kind, target] of source.matchAll(/extensionInvoke\(\s*['"](plugin|service)['"]\s*,\s*['"]([a-z0-9-]+)['"]/g)) {
        if (target !== id) { used.invokes.add(`${kind}:${target}`); note('invokes', `${kind}:${target}`, rel); }
      }
    }
    // Compiling WebAssembly (often inside a vendored library) needs "wasm".
    if (!main && /\bWebAssembly\.(?:instantiate|compile)|\.wasm['"`]/.test(source)) { used.browser.add('wasm'); note('browser', 'wasm', rel); }
    if (!vendor) {
      for (const [, host] of source.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
        const lower = host.toLowerCase();
        if (IGNORED_HOSTS.some(pattern => pattern.test(lower))) continue;
        used.network.add(lower); note('network', lower, rel);
      }
    }
  }
  return { id, manifest, used, where };
}

function hostAllowed(host, patterns) {
  return patterns.some(pattern => pattern === '*' || pattern === host
    || (pattern.startsWith('*.') && (host === pattern.slice(2) || host.endsWith(pattern.slice(1)))));
}

/** Differences between what the code uses and what the manifest declares. */
function auditExtension(dir) {
  const { id, manifest, used, where } = scanExtension(dir);
  const problems = [];
  let declared;
  try {
    declared = normalizePermissions(manifest.permissions);
  } catch (error) {
    return [`${id}: ${error.message}`];
  }
  if (!manifest.permissions) problems.push(`${id}: extension.json has no "permissions" block`);
  const missing = (key, values, allowed) => {
    for (const value of values) {
      if (!allowed(value)) problems.push(`${id}: uses ${key} '${value}' without declaring it (${where[`${key}:${value}`]?.slice(0, 3).join(', ')})`);
    }
  };
  missing('node', used.node, value => declared.node.includes(value));
  missing('electron', used.electron, value => declared.electron.includes(value));
  if (used.ipc && !declared.ipc) problems.push(`${id}: registers IPC handlers without "ipc": true (${where['ipc:true'].join(', ')})`);
  missing('provides', used.provides, value => declared.provides.includes(value));
  missing('uses', used.uses, value => declared.uses.includes(value));
  missing('resources', used.resources, value => declared.resources.includes(value));
  missing('browser', used.browser, value => declared.browser.includes(value));
  missing('invokes', used.invokes, value => declared.invokes.includes(value));
  missing('network', used.network, value => hostAllowed(value, declared.network));

  const hasMain = fs.existsSync(path.join(dir, 'main.cjs'));
  if (!hasMain && (declared.node.length || declared.electron.length || declared.ipc)) {
    problems.push(`${id}: declares main-process permissions but has no main.cjs`);
  }
  // Unused declarations are permission creep in reverse: flag them too.
  const unused = (key, values, usedSet) => {
    for (const value of values) if (!usedSet.has(value)) problems.push(`${id}: declares ${key} '${value}' but never uses it`);
  };
  unused('node', declared.node, used.node);
  unused('electron', declared.electron, used.electron);
  unused('provides', declared.provides, used.provides);
  unused('uses', declared.uses, used.uses);
  unused('resources', declared.resources, used.resources);
  unused('browser', declared.browser, used.browser);
  if (declared.ipc && !used.ipc) problems.push(`${id}: declares "ipc": true but registers no IPC handlers`);
  return problems;
}

// ── Library rules ────────────────────────────────────────────────────────────
// A library service ("library": true) is code its consumers import. It runs
// with the consumer's identity, permissions and storage, and owns no
// lifecycle, UI or state (ATMOS_CORE_INTEGRATION.md, "Services and
// libraries"). Core already refuses to run a library's entry points or give
// it frames; this checks the source so the rules are visible in review.
const ENTRY_FILES = ['boot.js', 'panel.js', 'sidebar.js', 'settings.js', 'persist.js'];
const IMPORT_SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g;
const STORAGE = /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/;
const ATMOS_GLOBALS = /\bwindow\.atmos(Core)?\b|\batmosCore\b/;

/**
 * Problems with a library service's code. `allowStorage` lists files (paths
 * relative to the library) allowed to persist on their own for now: known,
 * named exceptions that are due to be fixed, never granted by a manifest.
 * main.cjs and other .cjs files are the service's main-process side, not
 * library code, and are covered by auditExtension().
 */
function auditLibrary(dir, { allowStorage = [] } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  const id = path.basename(dir);
  const problems = [];
  if (manifest.library !== true) return problems;
  if (manifest.contributes !== undefined) problems.push(`${id}: a library contributes no surfaces ("contributes")`);
  if (manifest.runtime !== undefined) problems.push(`${id}: a library has no runtime of its own ("runtime")`);
  for (const file of ENTRY_FILES) {
    if (fs.existsSync(path.join(dir, file))) problems.push(`${id}: ${file} is an entry point; a library has none (rename it if it is an ordinary module)`);
  }
  const exclude = Array.isArray(manifest.auditExclude) ? manifest.auditExclude : [];
  for (const { rel, full } of walk(dir, exclude)) {
    if (rel.endsWith('.cjs')) continue;
    const source = stripComments(fs.readFileSync(full, 'utf8'));
    for (const match of source.matchAll(IMPORT_SPECIFIERS)) {
      const specifier = match[2];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        problems.push(`${id}/${rel}: imports '${specifier}'; a library imports only its own files`);
      } else if (path.relative(dir, path.resolve(path.dirname(full), specifier)).startsWith('..')) {
        problems.push(`${id}/${rel}: imports '${specifier}', outside the library`);
      }
    }
    if (ATMOS_GLOBALS.test(source)) problems.push(`${id}/${rel}: uses Atmos globals; a library reaches Atmos only through what its consumer passes in`);
    if (STORAGE.test(source) && !allowStorage.includes(rel)) problems.push(`${id}/${rel}: persists on its own; a library keeps no state (take it from the consumer)`);
  }
  return problems;
}

module.exports = { scanExtension, auditExtension, auditLibrary, hostAllowed };

if (require.main === module) {
  // `node scripts/extension-audit.cjs <dir>...` prints what each extension uses.
  for (const dir of process.argv.slice(2)) {
    const { id, used } = scanExtension(path.resolve(dir));
    const plain = Object.fromEntries(Object.entries(used).map(([key, value]) => [key, value instanceof Set ? [...value].sort() : value]));
    console.log(id, JSON.stringify(plain));
  }
}

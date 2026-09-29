'use strict';
/**
 * The extension manager: installs, updates and removes official packages
 * from sources, with every change applied on the next start.
 *
 * Sources. A source is a folder or an https:// URL holding index.json and
 * the .atmos packages it lists. The index is signed with an official key
 * (extension-signing.cjs signIndex), so its host needn't be trusted: every
 * package is also checked against the index's size and SHA-256 and then
 * against its own signature before it is staged. Sources come from
 * core/extension-sources.json (built in) and extension-sources.json in
 * user data (added in Settings).
 *
 * Nothing changes while Atmos runs. Install and update download, verify
 * and unpack into user data's extension-staging/, and record the change in
 * extension-pending.json; remove records it too. At the next start,
 * applyPending() (before the catalog looks at anything) moves staged
 * packages into the installed folder and deletes removed ones. The version
 * an update replaced is kept in extension-previous/<kind>/<id>, where the
 * catalog can fall back to it, until the new one has loaded once
 * (confirmApplied()).
 *
 * Checking for updates only reads the indexes; nothing downloads until
 * the user presses Install or Update.
 *
 * An index is never older than one already seen from the same source (its
 * signed "generated" time), so a source can't be rolled back to an old
 * index that hides updates.
 */

const fs = require('fs');
const path = require('path');
const { readPackage, isSafeName, PACKAGE_EXTENSION } = require('./extension-package.cjs');
const { verifyExtension, checkIndexSignature } = require('./extension-signing.cjs');
const { createHasher, sha256 } = require('./extension-integrity.cjs');
const { readJson, writeJson } = require('./json-files.cjs');
const { compareVersions, isValidVersion, satisfies } = require('./extension-version.cjs');
const { normalizeDependencies } = require('./extension-dependencies.cjs');
const { checkCompatibility } = require('./extension-host.cjs');

const KIND_FOLDER = { plugin: 'plugins', service: 'services' };
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

/** Move a folder, copying when a rename can't (another volume). */
function moveFolder(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

const ref = (kind, id) => `${kind}:${id}`;

/** A validated index entry, or null. */
function readIndexEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const { kind, id, version, file, size, sha256: hash } = item;
  if (!KIND_FOLDER[kind] || !VALID_ID.test(id || '') || !isValidVersion(version)) return null;
  if (typeof file !== 'string' || !isSafeName(file) || !file.endsWith(PACKAGE_EXTENSION)) return null;
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES || !/^[0-9a-f]{64}$/.test(hash || '')) return null;
  return {
    kind, id, version, file, size, sha256: hash,
    publisher: typeof item.publisher === 'string' ? item.publisher : null,
    displayName: typeof item.displayName === 'string' ? item.displayName : null,
    description: typeof item.description === 'string' ? item.description : null,
    apiVersion: item.apiVersion,
    requires: item.requires,
    engines: item.engines && typeof item.engines === 'object' && !Array.isArray(item.engines) ? item.engines : undefined,
    dependencies: item.dependencies && typeof item.dependencies === 'object' ? item.dependencies : {},
  };
}

/**
 * @param {object} options
 * @param {string} options.userData            Atmos's user-data folder
 * @param {(kind: 'plugins'|'services') => string} options.installedRoot
 * @param {Map} options.trustedKeys
 * @param {string[]} [options.builtInSourceFiles]  lists of sources shipped with Atmos
 * @param {string[]} [options.extraSources]        sources for this session only (development)
 * @param {{ location: string, name?: string }[]} [options.seedSources]
 *        the packages that come with Atmos (resources/extensions/packages in
 *        a personal build): a built-in source
 * @param {{ location: string, name?: string }[]} [options.setupSources]
 *        where the first-run picker and the upgrade install take packages
 *        from (default: seedSources; a release installer: the official
 *        source on GitHub). None: no first-run setup (running from source).
 * @param {(url: string) => Promise<Buffer>} [options.fetchUrl]  https downloads
 * @param {() => Array} [options.installed]        catalog entries of both kinds, with trust
 * @param {string} [options.appVersion]  this Atmos's version: a signed index's
 *        "core" entry newer than it is offered as "Atmos X is available"
 */
function createExtensionManager({
  userData, installedRoot, trustedKeys, builtInSourceFiles = [], extraSources = [], seedSources = [], setupSources = seedSources,
  fetchUrl = null, installed = () => [], warn = message => console.warn(message), appVersion = null,
}) {
  const files = {
    seen: path.join(userData, 'extension-index-seen.json'),
    sources: path.join(userData, 'extension-sources.json'),
    pending: path.join(userData, 'extension-pending.json'),
    applied: path.join(userData, 'extension-applied.json'),
    cleanup: path.join(userData, 'extension-data-cleanup.json'),
    setup: path.join(userData, 'extension-setup.json'),
  };
  const dirs = {
    staging: path.join(userData, 'extension-staging'),
    previous: path.join(userData, 'extension-previous'),
  };
  let lastCheck = { checkedAt: null, sources: [], packages: [], core: null };

  // ── Sources ────────────────────────────────────────────────────────────

  function userSources() {
    const list = readJson(files.sources, null)?.sources;
    return Array.isArray(list) ? list.filter(item => typeof item?.location === 'string') : [];
  }

  /** Every source: built in, added by the user, and this session's extras. */
  function sources() {
    const out = [];
    const seen = new Set();
    const add = (location, origin, name) => {
      const key = location.trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ location: key, origin, name: name || null });
    };
    for (const seed of seedSources) add(seed.location, 'built-in', seed.name || 'Comes with Atmos');
    for (const file of builtInSourceFiles) {
      for (const item of readJson(file, null)?.sources || []) if (typeof item?.location === 'string') add(item.location, 'built-in', item.name);
    }
    for (const item of userSources()) add(item.location, 'user', item.name);
    for (const location of extraSources) add(location, 'session');
    return out;
  }

  function isUrl(location) {
    return /^https?:\/\//i.test(location);
  }

  function validateLocation(location) {
    if (typeof location !== 'string' || !location.trim()) throw new Error('Enter a folder or an https:// address');
    const value = location.trim();
    if (isUrl(value)) {
      if (!/^https:\/\//i.test(value)) throw new Error('Sources on the web must use https://');
      return value;
    }
    if (!path.isAbsolute(value)) throw new Error('Enter the full path of a folder');
    return path.resolve(value);
  }

  function addSource(location) {
    const value = validateLocation(location);
    const list = userSources();
    if (!list.some(item => item.location === value)) list.push({ location: value, addedAt: new Date().toISOString() });
    writeJson(files.sources, { format: 1, sources: list });
    return sources();
  }

  function removeSource(location) {
    writeJson(files.sources, { format: 1, sources: userSources().filter(item => item.location !== location) });
    return sources();
  }

  async function readFrom(location, file, maxBytes) {
    if (isUrl(location)) {
      if (!fetchUrl) throw new Error('Web sources are not available here');
      const url = new URL(file, location.endsWith('/') ? location : `${location}/`).toString();
      const buffer = await fetchUrl(url, maxBytes);
      if (buffer.length > maxBytes) throw new Error(`${file} is too large`);
      return buffer;
    }
    const full = path.join(location, ...file.split('/'));
    const stat = await fs.promises.stat(full);
    if (stat.size > maxBytes) throw new Error(`${file} is too large`);
    return fs.promises.readFile(full);
  }

  /** Read and check one source's index. */
  async function readSource(source) {
    const index = JSON.parse((await readFrom(source.location, 'index.json', MAX_INDEX_BYTES)).toString('utf8'));
    if (index?.format !== 1 || !Array.isArray(index.packages)) throw new Error('index.json has an unsupported format');
    const signature = checkIndexSignature(index, trustedKeys);
    if (!signature.ok) throw new Error(signature.reason);
    checkFreshness(source.location, index.generated);
    const packages = index.packages.map(readIndexEntry).filter(Boolean)
      .map(item => ({ ...item, source: source.location }));
    // The newest Atmos, as the signed index states it ("core": { "version" }).
    // Only the version is taken from it: where to download Atmos is Core's
    // own setting, never a URL from a source.
    const core = isValidVersion(index.core?.version) ? { version: index.core.version } : null;
    return { name: typeof index.name === 'string' ? index.name : null, packages, core };
  }

  /**
   * Refuse an index older than the newest one already seen from the same
   * source (its signed "generated" time), and remember a newer one. Someone
   * who controls where a source points can then serve an old, genuinely
   * signed index to hide updates only until Atmos has seen a newer one.
   */
  function checkFreshness(location, generated) {
    const time = typeof generated === 'string' ? Date.parse(generated) : NaN;
    if (!Number.isFinite(time)) return;
    const seen = readJson(files.seen, null)?.sources || {};
    const newest = Date.parse(seen[location] || '');
    if (Number.isFinite(newest) && time < newest) {
      throw new Error(`This source's index (${generated}) is older than one Atmos has already seen (${seen[location]}), so it was not used`);
    }
    if (!Number.isFinite(newest) || time > newest) {
      try { writeJson(files.seen, { format: 1, sources: { ...seen, [location]: new Date(time).toISOString() } }); } catch (error) {
        warn(`[extensions] could not record ${location}'s index time: ${error.message}`);
      }
    }
  }

  // ── What is installed, pending and available ──────────────────────────

  function pendingChanges() {
    const list = readJson(files.pending, null)?.changes;
    return Array.isArray(list) ? list : [];
  }

  function writePending(changes) {
    writeJson(files.pending, { format: 1, changes });
  }

  function appliedRecords() {
    const list = readJson(files.applied, null)?.applied;
    return Array.isArray(list) ? list : [];
  }

  /** The best version of each package across sources that this Core can run. */
  function bestPackages(packages) {
    const best = new Map();
    for (const item of packages) {
      const compatibility = checkCompatibility({ apiVersion: item.apiVersion, requires: item.requires, engines: item.engines }, { appVersion });
      if (!compatibility.compatible) continue;
      const key = ref(item.kind, item.id);
      if (!best.has(key) || compareVersions(item.version, best.get(key).version) > 0) best.set(key, item);
    }
    return best;
  }

  /**
   * Check every source for packages and updates. Reads the indexes only.
   * Returns status().
   */
  async function checkForUpdates() {
    const results = [];
    const packages = [];
    let core = null;
    for (const source of sources()) {
      try {
        const read = await readSource(source);
        packages.push(...read.packages);
        if (read.core && (!core || compareVersions(read.core.version, core.version) > 0)) core = read.core;
        results.push({ ...source, ok: true, name: source.name || read.name, packages: read.packages.length, error: null });
      } catch (error) {
        results.push({ ...source, ok: false, packages: 0, error: error.code === 'ENOENT' ? 'Not found' : error.message });
      }
    }
    lastCheck = { checkedAt: new Date().toISOString(), sources: results, packages, core };
    return status();
  }

  function installedByRef() {
    return new Map(installed().map(entry => [ref(entry.kind, entry.id), entry]));
  }

  /**
   * Optional dependencies worth offering: for each package on a source, each
   * change waiting for a restart and each installed extension, the optional
   * dependencies a source has that are neither installed (in range) nor
   * about to be. "plugin:finance" → [{ kind, id, version, displayName, description, size }].
   * Installing one is the user's choice; install() pulls in only those marked
   * "recommended" (and only on install, so one removed later stays offered).
   */
  function optionalOffers(best, present, pending) {
    const coming = new Set(pending.filter(change => change.action === 'install').map(change => ref(change.kind, change.id)));
    const going = new Set(pending.filter(change => change.action === 'remove').map(change => ref(change.kind, change.id)));
    const declared = new Map();
    for (const item of best.values()) declared.set(ref(item.kind, item.id), item.dependencies);
    for (const entry of present.values()) {
      const key = ref(entry.kind, entry.id);
      if (!declared.has(key) && !going.has(key) && entry.tier !== 'third-party') declared.set(key, entry.manifest?.dependencies);
    }
    const offers = {};
    for (const [key, dependencies] of declared) {
      const list = [];
      for (const dep of normalizeDependencies({ dependencies }).list) {
        if (!dep.optional) continue;
        const target = ref(dep.kind, dep.id);
        const have = present.get(target);
        if (coming.has(target) || (have && !going.has(target) && have.tier !== 'third-party' && satisfies(have.version, dep.range))) continue;
        const item = best.get(target);
        if (!item || !satisfies(item.version, dep.range)) continue;
        list.push({ kind: item.kind, id: item.id, version: item.version, displayName: item.displayName, description: item.description, size: item.size });
      }
      if (list.length) offers[key] = list;
    }
    return offers;
  }

  /** A package's dependencies with display names: [{ kind, id, name, optional }]. */
  function namedDependencies(dependencies, best, present) {
    return normalizeDependencies({ dependencies }).list.map(dep => {
      const key = ref(dep.kind, dep.id);
      const known = best.get(key)?.displayName || present.get(key)?.manifest?.displayName;
      const name = known || dep.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      return { kind: dep.kind, id: dep.id, name, optional: dep.optional, system: present.get(key)?.tier === 'system' };
    });
  }

  /** Everything Settings shows: sources, packages with what can be done, pending changes. */
  function status() {
    const present = installedByRef();
    const pending = pendingChanges();
    const pendingBy = new Map(pending.map(change => [ref(change.kind, change.id), change]));
    const best = bestPackages(lastCheck.packages);
    const packages = [...best.values()].map(item => {
      const entry = present.get(ref(item.kind, item.id));
      const change = pendingBy.get(ref(item.kind, item.id)) || null;
      let action = 'install';
      if (entry?.tier === 'system') action = 'none';
      else if (entry && entry.tier !== 'third-party' && entry.version && isValidVersion(entry.version)) {
        action = compareVersions(item.version, entry.version) > 0 ? 'update' : 'none';
      }
      return {
        kind: item.kind, id: item.id, version: item.version, displayName: item.displayName, description: item.description,
        publisher: item.publisher, size: item.size, source: item.source,
        installedVersion: entry?.version || null, installedTier: entry?.tier || null, installedSource: entry?.source || null,
        action, pending: change, dependencies: namedDependencies(item.dependencies, best, present),
      };
    });
    return {
      checkedAt: lastCheck.checkedAt,
      sources: lastCheck.checkedAt ? lastCheck.sources : sources().map(source => ({ ...source, ok: null })),
      packages,
      pending,
      optional: optionalOffers(best, present, pending),
      applied: appliedRecords(),
      updates: packages.filter(item => item.action === 'update' && !item.pending).length,
      // "Atmos X is available": the newest version a source's signed index
      // names, when it is newer than this one.
      core: {
        current: appVersion,
        available: lastCheck.core && isValidVersion(appVersion) && compareVersions(lastCheck.core.version, appVersion) > 0
          ? lastCheck.core.version : null,
      },
    };
  }

  // ── Install and update ─────────────────────────────────────────────────

  /**
   * The packages installing kind:id needs: itself and any required
   * dependency that is missing or too old, from the sources, plus the
   * recommended optional ones a source has.
   */
  function plan(kind, id) {
    const best = bestPackages(lastCheck.packages);
    const present = installedByRef();
    const pending = new Map(pendingChanges().filter(change => change.action === 'install').map(change => [ref(change.kind, change.id), change]));
    const steps = [];
    const visiting = new Set();
    const visit = (targetKind, targetId, range, neededBy, recommended = false) => {
      const key = ref(targetKind, targetId);
      if (visiting.has(key) || steps.some(step => ref(step.kind, step.id) === key)) return;
      const entry = present.get(key);
      const staged = pending.get(key);
      const have = staged?.version || (entry && entry.tier !== 'third-party' ? entry.version : null);
      if (neededBy && have && satisfies(have, range)) return;
      const item = best.get(key);
      if (!item || (range && !satisfies(item.version, range))) {
        throw new Error(neededBy
          ? `${neededBy} needs ${targetId}${range && range !== '*' ? ` ${range}` : ''}, which none of your sources has`
          : `No source has ${targetId}`);
      }
      visiting.add(key);
      for (const dep of normalizeDependencies({ dependencies: item.dependencies }).list) {
        if (!dep.optional) visit(dep.kind, dep.id, dep.range, item.displayName || item.id);
        // A recommended optional dependency comes too on a first install,
        // when a source has it (not on an update: the user may have removed
        // it); without it the extension still installs.
        else if (dep.recommended && !have) {
          const offered = best.get(ref(dep.kind, dep.id));
          if (offered && satisfies(offered.version, dep.range)) visit(dep.kind, dep.id, dep.range, item.displayName || item.id, true);
        }
      }
      visiting.delete(key);
      steps.push({ ...item, reason: neededBy ? (recommended ? 'recommended' : 'dependency') : (have ? 'update' : 'install') });
    };
    visit(kind, id, null, null);
    return steps;
  }

  /** Download, check and unpack one package into staging. */
  async function stage(item) {
    // Never more than the signed index says the package is.
    const buffer = await readFrom(item.source, item.file, item.size);
    if (buffer.length !== item.size || sha256(buffer) !== item.sha256) throw new Error(`${item.file} doesn't match the source's index`);
    const entries = readPackage(buffer);
    const target = path.join(dirs.staging, `${item.kind}-${item.id}-${item.version}`);
    const temp = `${target}.tmp-${process.pid}`;
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });
    try {
      for (const { name, data } of entries) {
        const full = path.join(temp, ...name.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, data);
      }
      const manifest = readJson(path.join(temp, 'extension.json'), null);
      if (!manifest || manifest.version !== item.version) throw new Error(`${item.file} is not version ${item.version} of ${item.id}`);
      const check = verifyExtension(temp, { kind: item.kind, id: item.id, manifest, trustedKeys, hasher: createHasher(null) });
      if (check.status !== 'verified' || !check.official) {
        throw new Error(`${item.file} is not an official package (${check.reason || check.status})`);
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(temp, target);
      return target;
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Install or update kind:id (and what it needs) at the next start.
   * Returns { changes, status }.
   */
  async function install(kind, id) {
    if (!lastCheck.checkedAt) await checkForUpdates();
    const steps = plan(kind, id);
    const staged = [];
    for (const item of steps) staged.push({ item, dir: await stage(item) });
    const changes = pendingChanges().filter(change => !staged.some(({ item }) => change.kind === item.kind && change.id === item.id));
    for (const { item, dir } of staged) {
      changes.push({
        action: 'install', kind: item.kind, id: item.id, version: item.version, reason: item.reason,
        displayName: item.displayName, staged: path.relative(userData, dir), requestedAt: new Date().toISOString(),
      });
    }
    writePending(changes);
    return { changes: staged.map(({ item }) => ({ kind: item.kind, id: item.id, version: item.version, reason: item.reason })), status: status() };
  }

  // ── Remove ────────────────────────────────────────────────────────────

  /**
   * Remove an installed extension at the next start. Only what is in the
   * installed folder can be removed; one bundled with Atmos can be
   * switched off instead. Refused while something installed needs it.
   */
  function remove(kind, id, { deleteData = false } = {}) {
    const present = installedByRef();
    const entry = present.get(ref(kind, id));
    const folder = path.join(installedRoot(KIND_FOLDER[kind] || ''), id);
    if (!KIND_FOLDER[kind] || !VALID_ID.test(id) || !fs.existsSync(folder)) {
      throw new Error(entry?.source === 'bundled' ? 'It comes with Atmos; switch it off instead' : 'It is not installed');
    }
    const removing = new Set(pendingChanges().filter(change => change.action === 'remove').map(change => ref(change.kind, change.id)));
    removing.add(ref(kind, id));
    // Another copy stays (the one bundled with Atmos): nothing loses it.
    const bundledStays = entry && (entry.source === 'bundled' || entry.fallback?.source === 'bundled');
    const needers = bundledStays ? [] : [...present.values()].filter(other => !removing.has(ref(other.kind, other.id))
      && normalizeDependencies(other.manifest).list.some(dep => !dep.optional && dep.kind === kind && dep.id === id));
    if (needers.length) {
      const names = needers.map(other => other.manifest?.displayName || other.id).join(', ');
      throw new Error(`${names} ${needers.length === 1 ? 'needs' : 'need'} it; remove ${needers.length === 1 ? 'that' : 'those'} first`);
    }
    const changes = pendingChanges().filter(change => !(change.kind === kind && change.id === id));
    changes.push({
      action: 'remove', kind, id, version: entry?.version || null, deleteData: deleteData === true,
      displayName: entry?.manifest?.displayName || null, requestedAt: new Date().toISOString(),
    });
    writePending(changes);
    return status();
  }

  /** Undo a change that hasn't been applied yet. */
  function cancel(kind, id) {
    const keep = [];
    for (const change of pendingChanges()) {
      if (change.kind === kind && change.id === id) {
        if (change.staged) fs.rmSync(path.join(userData, change.staged), { recursive: true, force: true });
      } else keep.push(change);
    }
    writePending(keep);
    return status();
  }

  // ── At startup ────────────────────────────────────────────────────────

  function previousFolder(kind, id) {
    return path.join(dirs.previous, KIND_FOLDER[kind], id);
  }

  /**
   * An extension's own data folder in user data (userData/<id>), if one
   * exists with exactly that name. Chromium's and Atmos's own folders have
   * capitals or dots, and are listed here too in case a case-insensitive
   * file system would match anyway.
   */
  const OWN_FILES = new Set(['cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'indexeddb', 'local storage',
    'session storage', 'network', 'blob_storage', 'shared dictionary', 'shared_proto_db', 'crashpad', 'extension-staging', 'extension-previous',
    'sharedstorage', 'webstorage', 'service worker', 'databases', 'backups',
    // On Windows user data is also the install folder (%APPDATA%\atmos).
    'plugins', 'services', 'service', '_archive']);
  function dataFolder(id) {
    if (OWN_FILES.has(id.toLowerCase())) return null;
    let names = [];
    try { names = fs.readdirSync(userData); } catch { return null; }
    return names.includes(id) && fs.statSync(path.join(userData, id)).isDirectory() ? path.join(userData, id) : null;
  }

  /**
   * Apply pending changes. Call once at startup, before the catalog lists
   * anything. Returns what was done.
   */
  function applyPending() {
    const changes = pendingChanges();
    if (!changes.length) return [];
    const done = [];
    const applied = appliedRecords();
    const cleanup = readJson(files.cleanup, null)?.extensions || [];
    const remaining = [];
    for (const change of changes) {
      const { kind, id } = change;
      if (!KIND_FOLDER[kind] || !VALID_ID.test(id || '')) continue;
      const target = path.join(installedRoot(KIND_FOLDER[kind]), id);
      try {
        if (change.action === 'install') {
          const staged = path.join(userData, change.staged || '');
          if (!change.staged || !path.resolve(staged).startsWith(path.resolve(dirs.staging) + path.sep) || !fs.existsSync(staged)) {
            throw new Error('the downloaded package is missing');
          }
          const previous = previousFolder(kind, id);
          fs.rmSync(previous, { recursive: true, force: true });
          if (fs.existsSync(target)) moveFolder(target, previous);
          moveFolder(staged, target);
          const record = { kind, id, version: change.version, previous: fs.existsSync(previous), appliedAt: new Date().toISOString() };
          applied.splice(0, applied.length, ...applied.filter(item => !(item.kind === kind && item.id === id)), record);
          done.push({ action: 'install', kind, id, version: change.version });
        } else if (change.action === 'remove') {
          fs.rmSync(target, { recursive: true, force: true });
          fs.rmSync(previousFolder(kind, id), { recursive: true, force: true });
          if (change.deleteData) {
            const folder = dataFolder(id);
            if (folder) fs.rmSync(folder, { recursive: true, force: true });
            cleanup.push({ kind, id });
          }
          applied.splice(0, applied.length, ...applied.filter(item => !(item.kind === kind && item.id === id)));
          done.push({ action: 'remove', kind, id, deleteData: change.deleteData === true });
        }
      } catch (error) {
        warn(`[extensions] could not ${change.action} ${kind} '${id}': ${error.message}`);
        remaining.push({ ...change, error: error.message });
      }
    }
    // Failed changes are tried again next start, unless the download is gone.
    writePending(remaining.filter(change => !/missing/.test(change.error || '')));
    writeJson(files.applied, { format: 1, applied });
    if (cleanup.length) writeJson(files.cleanup, { format: 1, extensions: cleanup });
    return done;
  }

  /**
   * After trust is decided: an update that loaded no longer needs the
   * version it replaced; one that didn't stays on record, for Settings.
   * `lookup(kind, id)` returns { entry, loadable }.
   */
  function confirmApplied(lookup) {
    const keep = [];
    for (const record of appliedRecords()) {
      const { entry, loadable } = lookup(record.kind, record.id) || {};
      if (entry && entry.source === 'installed' && entry.version === record.version && loadable) {
        fs.rmSync(previousFolder(record.kind, record.id), { recursive: true, force: true });
      } else {
        keep.push({ ...record, failed: true, running: entry ? { version: entry.version, source: entry.source } : null });
      }
    }
    writeJson(files.applied, { format: 1, applied: keep });
    // Staged folders nothing refers to any more (cancelled, or left by a crash).
    const referenced = new Set(pendingChanges().map(change => change.staged && path.resolve(userData, change.staged)).filter(Boolean));
    for (const name of fs.existsSync(dirs.staging) ? fs.readdirSync(dirs.staging) : []) {
      const full = path.resolve(dirs.staging, name);
      if (!referenced.has(full)) fs.rmSync(full, { recursive: true, force: true });
    }
  }

  /** Extensions whose data the page should forget this start (their state namespaces). Read once. */
  function takeDataCleanup() {
    const list = readJson(files.cleanup, null)?.extensions || [];
    fs.rmSync(files.cleanup, { force: true });
    return list;
  }

  // ── First run: the extensions to choose from ─────────────────────────

  /** Whether the first-run choice (or the upgrade install) has been made. */
  function setupDone() {
    return !setupSources.length || readJson(files.setup, null)?.done === true;
  }

  /** Whether a first run has begun (the picker was due) without finishing. */
  function setupPending() {
    return readJson(files.setup, null)?.done === false;
  }

  /** Remember that this is a first run, so a restart before choosing isn't taken for an upgrade. */
  function beginSetup() {
    if (!fs.existsSync(files.setup)) writeJson(files.setup, { format: 1, done: false, at: new Date().toISOString() });
  }

  function finishSetup(how = 'chosen') {
    writeJson(files.setup, { format: 1, done: true, how, at: new Date().toISOString() });
  }

  /**
   * What the setup sources offer: [{ kind, id, version, displayName,
   * description, dependencies, named }]. Throws when none can be read
   * (offline, say), so the caller can say so and try again.
   */
  async function seedPackages() {
    const packages = [];
    const errors = [];
    for (const seed of setupSources) {
      try { packages.push(...(await readSource({ location: seed.location })).packages); } catch (error) {
        errors.push(error.code === 'ENOENT' ? 'Not found' : error.message);
        warn(`[extensions] ${seed.location} can't be read: ${error.message}`);
      }
    }
    if (!packages.length && errors.length) throw new Error(errors[0]);
    const best = bestPackages(packages);
    return [...best.values()].map(item => ({ ...item, named: namedDependencies(item.dependencies, best, installedByRef()) }));
  }

  /**
   * Stage the given packages (and what they need) as pending installs, from
   * the setup sources only. `wanted` is [{ kind, id }], or everything they
   * have. applyPending() then installs them. Throws if nothing can be read.
   */
  async function installFromSeed(wanted = null) {
    const packages = await seedPackages();
    const saved = lastCheck;
    lastCheck = { checkedAt: new Date().toISOString(), sources: [], packages, core: null };
    const changes = [];
    try {
      const present = installedByRef();
      for (const item of wanted || packages) {
        // Never over an installed official copy that is as new or newer.
        const have = present.get(ref(item.kind, item.id));
        const offered = packages.find(p => p.kind === item.kind && p.id === item.id);
        if (have && have.tier !== 'third-party' && have.source !== 'bundled' && offered && compareVersions(have.version || '0.0.0', offered.version) >= 0) continue;
        if (pendingChanges().some(change => change.action === 'install' && change.kind === item.kind && change.id === item.id)) continue;
        try {
          changes.push(...(await install(item.kind, item.id)).changes);
        } catch (error) {
          warn(`[extensions] could not install ${item.kind} '${item.id}' for setup: ${error.message}`);
        }
      }
    } finally {
      lastCheck = saved;
    }
    return changes;
  }

  return {
    sources, addSource, removeSource, checkForUpdates, status, plan, install, remove, cancel,
    applyPending, confirmApplied, takeDataCleanup,
    setupDone, setupPending, beginSetup, finishSetup, seedPackages, installFromSeed,
    previousRoot: kind => path.join(dirs.previous, kind),
  };
}

module.exports = { createExtensionManager };

'use strict';
/**
 * Atmos Browser's ad and tracker blocker, in the main process, as Brave's
 * shields have it: Ghostery's filter engine (@ghostery/adblocker, MPL-2.0)
 * with uBlock Origin's own lists, EasyList and EasyPrivacy.
 *
 *   requests   web-host.cjs asks, for every request a page makes, whether it
 *              goes: blocked, redirected to a harmless stand-in (a script
 *              that does nothing, a blank image: uBlock Origin's redirect
 *              resources, Atmos's own copy), or with its tracking parameters
 *              taken off ($removeparam). A page itself is never blocked.
 *   pages      Core's page preload asks, as a page starts, for what hides its
 *              ad slots (styles) and for the lists' scriptlets for it (small
 *              page scripts, uBlock Origin's, again Atmos's own copy: nothing
 *              that runs in a page is downloaded; run together as uBlock
 *              Origin runs them, in a scope of their own), then for the
 *              styles that match the class names, ids and links the page
 *              grows.
 *              web-host.cjs reads the page's address from its frame; a page
 *              can't ask for another's.
 *   lists      downloaded from uBlock Origin's CDN, each when its own
 *              "Expires" says (1–7 days), and parsed in a utility process
 *              (web-adblock-parser.cjs: a parse takes a couple of seconds);
 *              the engine they make is kept in userData/browser/adblock/
 *              and loads in milliseconds. Lists that aren't uBlock Origin's
 *              own can't use the scriptlets that need trust.
 *
 * Whether it applies to a page (the options' blockAds, a site's shield) is
 * web-host.cjs's to decide; this is the engine and its lists.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./json-files.cjs');

const FORMAT = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const RESOURCES_FILE = path.join(__dirname, 'web-adblock-resources.json');

// uBlock Origin's defaults for ads, trackers and breakage (its assets.json),
// less Peter Lowe's and URLhaus. "trusted": uBlock Origin's own, which may
// use every scriptlet.
const LISTS = Object.freeze([
  { id: 'ublock-filters', title: 'uBlock filters – Ads', path: 'filters/filters.min.txt', trusted: true },
  { id: 'ublock-badware', title: 'uBlock filters – Badware risks', path: 'filters/badware.min.txt', trusted: true },
  { id: 'ublock-privacy', title: 'uBlock filters – Privacy', path: 'filters/privacy.min.txt', trusted: true },
  { id: 'ublock-unbreak', title: 'uBlock filters – Unbreak', path: 'filters/unbreak.min.txt', trusted: true },
  { id: 'ublock-quick-fixes', title: 'uBlock filters – Quick fixes', path: 'filters/quick-fixes.min.txt', trusted: true },
  { id: 'easylist', title: 'EasyList', path: 'thirdparties/easylist.txt', trusted: false },
  { id: 'easyprivacy', title: 'EasyPrivacy', path: 'thirdparties/easyprivacy.txt', trusted: false },
].map(list => Object.freeze(list)));

// uBlock Origin's CDN for those lists, tried in this order.
const MIRRORS = Object.freeze([
  'https://ublockorigin.github.io/uAssetsCDN/',
  'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/',
  'https://ublockorigin.pages.dev/',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/',
]);

// "!#if" conditions the lists are written for: Chromium, and uBlock Origin's
// syntax; styles go in as user style sheets.
const ENV = Object.freeze([['env_chromium', true], ['ext_ublock', true], ['cap_user_stylesheet', true]]);

// How Ghostery's engine starts each scriptlet it gives out (its
// assembleScript): this line, the scriptlet's helpers, then the call.
const SCRIPTLET_GLOBALS = "if (typeof scriptletGlobals === 'undefined') { var scriptletGlobals = {}; }";
// Scriptlets uBlock Origin runs before the others (its "priority"): one that
// configures another's helpers has to come first.
const SCRIPTLET_PRIORITY = new Map([['proxy-apply-config.js', 100]]);

/** How long a list keeps: its "! Expires:" line, from a day to a week (4 days if it doesn't say). */
function expiresMs(text) {
  const found = /^!\s*Expires:\s*(\d+)\s*(day|hour)/im.exec(String(text || '').slice(0, 4000));
  const ms = found ? Number(found[1]) * (found[2].toLowerCase() === 'hour' ? HOUR : DAY) : 4 * DAY;
  return Math.max(DAY, Math.min(7 * DAY, ms));
}

/** Whether text is a filter list (and not, say, an error page). */
function looksLikeList(text) {
  if (typeof text !== 'string' || text.length < 20) return false;
  const head = text.slice(0, 2000);
  return !/^\s*</.test(head) && /^(\[Adblock|!)/m.test(head);
}

const MAX_TOKENS = 1000;
const MAX_HREFS = 300;
/** What a page's preload sends of its DOM, bounded: { classes, ids, hrefs } of short strings. */
function cleanTokens(value) {
  const list = (items, max, length) => (Array.isArray(items)
    ? [...new Set(items.filter(item => typeof item === 'string' && item.length > 0 && item.length <= length))].slice(0, max)
    : []);
  return {
    classes: list(value?.classes, MAX_TOKENS, 256),
    ids: list(value?.ids, MAX_TOKENS, 256),
    hrefs: list(value?.hrefs, MAX_HREFS, 1024).filter(href => /^https?:/i.test(href)),
  };
}

function cleanMeta(value) {
  const lists = {};
  for (const list of LISTS) {
    const saved = value?.lists?.[list.id];
    if (!saved || typeof saved !== 'object') continue;
    lists[list.id] = {
      etag: typeof saved.etag === 'string' ? saved.etag : null,
      lastModified: typeof saved.lastModified === 'string' ? saved.lastModified : null,
      fetchedAt: Number.isFinite(saved.fetchedAt) ? saved.fetchedAt : 0,
      changedAt: Number.isFinite(saved.changedAt) ? saved.changedAt : 0,
      expires: Number.isFinite(saved.expires) ? saved.expires : 4 * DAY,
      bytes: Number.isFinite(saved.bytes) ? saved.bytes : 0,
    };
  }
  const engine = value?.engine && typeof value.engine === 'object' ? value.engine : {};
  return {
    format: FORMAT,
    lists,
    engine: {
      builtAt: Number.isFinite(engine.builtAt) ? engine.builtAt : 0,
      library: typeof engine.library === 'string' ? engine.library : '',
      resources: typeof engine.resources === 'string' ? engine.resources : '',
      lists: Array.isArray(engine.lists) ? engine.lists.filter(id => typeof id === 'string') : [],
      rules: {
        network: Number.isFinite(engine.rules?.network) ? engine.rules.network : 0,
        cosmetic: Number.isFinite(engine.rules?.cosmetic) ? engine.rules.cosmetic : 0,
      },
    },
    total: Number.isFinite(value?.total) && value.total >= 0 ? Math.floor(value.total) : 0,
  };
}

/**
 * The blocker. `fetchText(url, { etag, lastModified })` resolves
 * { status, text, etag, lastModified } (web-host.cjs: a session of its own);
 * `buildEngine({ lists, resources })` resolves { buffer, rules } (a utility
 * process). `localLists`: a folder of <id>.txt used instead of downloading
 * (the end-to-end check, unpackaged only).
 */
function createAdblock({
  dir, fetchText, buildEngine, localLists = null, now = () => Date.now(), timers = globalThis, log = console,
  readResources = () => fs.readFileSync(RESOURCES_FILE, 'utf8'), onChange = () => {},
}) {
  const { FiltersEngine, Request } = require('@ghostery/adblocker');
  const LIBRARY = require('@ghostery/adblocker/package.json').version;
  const metaFile = path.join(dir, 'state.json');
  const engineFile = path.join(dir, 'engine.bin');
  const listFile = id => path.join(dir, 'lists', `${id}.txt`);
  let meta = cleanMeta(readJson(metaFile, null));
  let engine = null;
  let phase = 'off';            // off, loading, ready, error
  let lastError = null;
  let started = false;
  let running = null;           // the update in progress
  let checkTimer = null;
  let totalTimer = null;
  let resourcesText = null;
  let resourcesHash = null;
  let scriptletIndex = null;    // the engine's scriptlets by function name (bundleScripts)

  function resources() {
    if (resourcesText === null) {
      resourcesText = readResources();
      resourcesHash = crypto.createHash('sha256').update(resourcesText).digest('hex');
    }
    return resourcesText;
  }
  function setPhase(next, error = lastError) {
    phase = next;
    lastError = error;
    onChange(status());
  }
  function saveMeta() {
    try { writeJson(metaFile, meta); } catch (error) { log.warn?.('[adblock] could not save its state:', error.message); }
  }
  function install(next) {
    next.updateEnv(new Map(ENV));
    engine = next;
    scriptletIndex = null;
  }

  async function writeAtomic(file, data) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, data);
    await fs.promises.rename(`${file}.tmp`, file);
  }
  async function readList(id) {
    if (localLists) return fs.promises.readFile(path.join(localLists, `${id}.txt`), 'utf8').catch(() => null);
    return fs.promises.readFile(listFile(id), 'utf8').catch(() => null);
  }

  /** The engine kept from last time, if it's still this library's and these resources'. */
  async function loadKept() {
    resources();
    if (localLists) return false;
    if (meta.engine.library !== LIBRARY || meta.engine.resources !== resourcesHash) return false;
    const buffer = await fs.promises.readFile(engineFile).catch(() => null);
    if (!buffer) return false;
    try {
      install(FiltersEngine.deserialize(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)));
      return true;
    } catch (error) {
      log.warn?.('[adblock] the kept engine is unreadable; building it again:', error.message);
      return false;
    }
  }

  /** Fetch one list (conditionally, when there's a copy): { text, changed } or null when unreachable. */
  async function download(list, kept) {
    const saved = meta.lists[list.id] || {};
    let problem = null;
    for (const mirror of MIRRORS) {
      try {
        const answer = await fetchText(`${mirror}${list.path}`, kept ? { etag: saved.etag, lastModified: saved.lastModified } : {});
        if (answer?.status === 304 && kept) {
          meta.lists[list.id] = { ...saved, fetchedAt: now() };
          return { text: kept, changed: false };
        }
        if (answer?.status !== 200 || !looksLikeList(answer.text) || answer.text.length > MAX_LIST_BYTES) {
          problem = `${list.title}: ${answer?.status === 200 ? 'not a filter list' : `HTTP ${answer?.status}`}`;
          continue;
        }
        const changed = answer.text !== kept;
        meta.lists[list.id] = {
          etag: answer.etag || null, lastModified: answer.lastModified || null, fetchedAt: now(),
          changedAt: changed ? now() : (saved.changedAt || now()), expires: expiresMs(answer.text), bytes: answer.text.length,
        };
        return { text: answer.text, changed };
      } catch (error) {
        problem = `${list.title}: ${error.message}`;
      }
    }
    throw new Error(problem || `${list.title} couldn't be downloaded`);
  }

  /**
   * Bring the lists up to date (those past their expiry, or all with
   * `force`) and build the engine again when any changed or it's missing.
   */
  function update({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      if (!engine) setPhase('loading', null);
      resources();
      const texts = new Map();   // lists read or downloaded this time
      const problems = [];
      let changed = false;
      for (const list of LISTS) {
        const saved = meta.lists[list.id];
        const due = !localLists && (force || !saved || now() - saved.fetchedAt >= saved.expires);
        if (!due) continue;
        const kept = await readList(list.id);
        try {
          const got = await download(list, kept);
          texts.set(list.id, got.text);
          if (got.changed) {
            changed = true;
            await writeAtomic(listFile(list.id), got.text);
          }
        } catch (error) {
          problems.push(error.message);
          if (kept) texts.set(list.id, kept);
        }
      }
      // Built again when a list changed, or when there's no engine for this
      // library and these resources (the lists kept on disk will do).
      const stale = !engine || meta.engine.library !== LIBRARY || meta.engine.resources !== resourcesHash;
      if (changed || stale) {
        for (const list of LISTS) {
          if (texts.has(list.id)) continue;
          const kept = await readList(list.id);
          if (kept) texts.set(list.id, kept);
        }
      }
      if (texts.size && (changed || stale)) {
        const lists = LISTS.filter(list => texts.has(list.id)).map(list => ({ id: list.id, trusted: list.trusted, text: texts.get(list.id) }));
        const built = await buildEngine({ lists, resources: resources() });
        const buffer = built.buffer instanceof Uint8Array ? built.buffer : new Uint8Array(built.buffer);
        install(FiltersEngine.deserialize(buffer));
        meta.engine = {
          builtAt: now(), library: LIBRARY, resources: resourcesHash, lists: lists.map(list => list.id),
          rules: { network: built.rules?.network || 0, cosmetic: built.rules?.cosmetic || 0 },
        };
        if (!localLists) await writeAtomic(engineFile, buffer);
      }
      saveMeta();
      if (!engine) throw new Error(problems[0] || 'no filter lists');
      setPhase('ready', problems.length ? problems.join('; ') : null);
    })().catch(error => {
      log.warn?.('[adblock] updating the lists failed:', error.message);
      setPhase(engine ? 'ready' : 'error', error.message);
    }).finally(() => { running = null; });
    return running;
  }

  /** Load what's kept, then keep the lists up to date (checked hourly). Once. */
  async function start() {
    if (started) return running;
    started = true;
    setPhase('loading', null);
    if (await loadKept()) setPhase('ready', null);
    const done = update();
    checkTimer = timers.setInterval(() => { void update(); }, HOUR);
    checkTimer?.unref?.();
    return done;
  }

  function stop() {
    timers.clearInterval(checkTimer);
    checkTimer = null;
  }

  // ── Matching ──────────────────────────────────────────────────────────────
  /**
   * What happens to a request: { cancel: true }, { redirectURL } (a stand-in
   * resource, or the address without its tracking parameters), or null.
   * `blocked` says whether it counts as blocked. `type` is Electron's
   * resourceType; `sourceUrl` the document asking.
   */
  function match({ url, type, sourceUrl }) {
    if (!engine || !/^(https?|wss?):/i.test(url)) return null;
    const request = Request.fromRawDetails({ url, type: type || 'other', sourceUrl: sourceUrl || url });
    let result;
    try {
      result = engine.match(request);
    } catch {
      // The engine throws on a $redirect to a resource it doesn't have: the
      // filter matched, so the request is blocked (a page itself never is).
      return request.isMainFrame() ? null : { cancel: true, blocked: true };
    }
    const rewrite = result.rewrite?.url && result.rewrite.url !== url && /^https?:/i.test(result.rewrite.url) ? result.rewrite.url : null;
    // A page itself isn't blocked, but loses its tracking parameters.
    if (request.isMainFrame()) return rewrite ? { redirectURL: rewrite, blocked: false } : null;
    if (result.redirect?.dataUrl) return { redirectURL: result.redirect.dataUrl, blocked: true };
    if (result.match) return { cancel: true, blocked: true };
    if (rewrite) return { redirectURL: rewrite, blocked: false };
    return null;
  }

  /** $csp directives the lists add to a document's response, or undefined. */
  function csp({ url, type, sourceUrl }) {
    if (!engine || !/^https?:/i.test(url)) return undefined;
    return engine.getCSPDirectives(Request.fromRawDetails({ url, type, sourceUrl: sourceUrl || url })) || undefined;
  }

  function where(url) {
    const request = Request.fromRawDetails({ url });
    return { hostname: request.hostname || '', domain: request.domain || '' };
  }

  /**
   * The engine's scriptlets by the name of their function: each one's
   * helpers, the text a script of it starts with (the engine's
   * assembleScript: SCRIPTLET_GLOBALS, the helpers, then the call) and where
   * uBlock Origin puts it in the order.
   */
  function scriptlets() {
    if (scriptletIndex) return scriptletIndex;
    scriptletIndex = new Map();
    const resources = engine.resources;
    for (const scriptlet of resources?.scriptlets || []) {
      if (typeof scriptlet?.body !== 'string' || scriptlet.name.endsWith('.fn')) continue;
      const name = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(scriptlet.body)?.[1];
      if (!name || scriptletIndex.has(name)) continue;
      let helpers;
      try { helpers = resources.getScriptletDependencies(scriptlet); } catch { continue; }
      scriptletIndex.set(name, {
        helpers,
        prefix: `${[SCRIPTLET_GLOBALS, ...helpers].join(';')};`,
        call: `(${scriptlet.body})(`,
        priority: SCRIPTLET_PRIORITY.get(scriptlet.name) || 0,
      });
    }
    return scriptletIndex;
  }

  /** One of the engine's scripts as { helpers, call, priority }, or null if it isn't laid out as expected. */
  function splitScript(script) {
    if (typeof script !== 'string' || !script.startsWith(`${SCRIPTLET_GLOBALS};`)) return null;
    const index = scriptlets();
    // The call comes last, after the helpers: try each place it could start.
    for (let at = script.indexOf(';(function '); at !== -1; at = script.indexOf(';(function ', at + 1)) {
      const name = /^\(function ([A-Za-z0-9_$]+)\s*\(/.exec(script.slice(at + 1, at + 200))?.[1];
      const known = name && index.get(name);
      if (known && known.prefix.length === at + 1 && script.startsWith(known.prefix) && script.startsWith(known.call, at + 1)) {
        return { helpers: known.helpers, call: script.slice(at + 1), priority: known.priority };
      }
    }
    return null;
  }

  /**
   * A page's scriptlets as one script, run the way uBlock Origin runs them:
   * in a scope of their own, so nothing is left on the page's window (a
   * page could spot helpers left there, and trip over them); each helper
   * defined once and shared, so a scriptlet that configures another's
   * helpers works (proxy-apply-config: X shows "Some privacy related
   * extensions may cause issues" when it doesn't); the configuring ones
   * first, then in uBlock Origin's order; each call in a try of its own.
   * A script not laid out as expected (a resource the engine gives as it
   * is) runs after it, on its own, as before.
   */
  function bundleScripts(scripts) {
    const helpers = new Set();
    const calls = [];
    const others = [];
    for (const script of scripts) {
      const parts = splitScript(script);
      if (!parts) { if (typeof script === 'string' && script) others.push(script); continue; }
      for (const helper of parts.helpers) helpers.add(helper);
      calls.push(parts);
    }
    if (!calls.length) return others;
    calls.sort((a, b) => (b.priority - a.priority) || a.call.localeCompare(b.call));
    return [[
      '(function () {',
      'var scriptletGlobals = {};',
      ...helpers,
      ...calls.map(({ call }) => `try { ${call} } catch (e) {}`),
      '})();',
    ].join('\n'), ...others];
  }

  /** As a page starts: { styles, scripts } for its address, or null (nothing to do). */
  function pageStart(url) {
    if (!engine || !/^https?:/i.test(url)) return null;
    const { hostname, domain } = where(url);
    const result = engine.getCosmeticsFilters({
      url, hostname, domain,
      getBaseRules: true, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false,
    });
    if (result.active === false) return null;
    return { styles: result.styles || '', scripts: bundleScripts(Array.isArray(result.scripts) ? result.scripts : []) };
  }

  /** The styles for what the page's DOM holds (class names, ids, links): { styles }, or null. */
  function pageTokens(url, tokens) {
    if (!engine || !/^https?:/i.test(url)) return null;
    const { classes, ids, hrefs } = cleanTokens(tokens);
    if (!classes.length && !ids.length && !hrefs.length) return null;
    const { hostname, domain } = where(url);
    const result = engine.getCosmeticsFilters({
      url, hostname, domain, classes, ids, hrefs,
      getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: false, getRulesFromDOM: true,
    });
    if (result.active === false || !result.styles) return null;
    return { styles: result.styles };
  }

  /** Count blocked requests toward the total shown on the new-tab page (saved now and then; ordinary tabs only). */
  function counted(n = 1) {
    meta.total += n;
    if (!totalTimer) {
      totalTimer = timers.setTimeout(() => { totalTimer = null; saveMeta(); }, 30_000);
      totalTimer?.unref?.();
    }
  }

  function status() {
    return {
      state: phase,
      error: lastError,
      updatedAt: meta.engine.builtAt || null,
      rules: meta.engine.rules.network + meta.engine.rules.cosmetic,
      total: meta.total,
      lists: LISTS.map(list => ({
        id: list.id, title: list.title,
        changedAt: meta.lists[list.id]?.changedAt || null,
        checkedAt: meta.lists[list.id]?.fetchedAt || null,
      })),
    };
  }

  return {
    start, stop, update, match, csp, pageStart, pageTokens, counted, status,
    ready: () => !!engine,
    flush: saveMeta,
  };
}

module.exports = { createAdblock, LISTS, MIRRORS, expiresMs, looksLikeList, cleanTokens, cleanMeta, RESOURCES_FILE };

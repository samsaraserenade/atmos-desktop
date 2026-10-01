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
 *              own can't use the scriptlets that need trust, nor can a copy
 *              of uBlock Origin's own that didn't come from GitHub (MIRRORS).
 *
 * Whether it applies to a page (the options' blockAds, a site's shield) is
 * web-host.cjs's to decide; this is the engine and its lists.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { readJson, writeJson } = require('./json-files.cjs');

const FORMAT = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const RESOURCES_FILE = path.join(__dirname, 'web-adblock-resources.json');
// What the engine keeps depends on the parser too (which filters it leaves
// out): a new parser builds it again, as a new library or resources do.
const PARSER_FILE = path.join(__dirname, 'web-adblock-parser.cjs');

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

// uBlock Origin's CDN for those lists, tried in this order. Its own lists
// may use the scriptlets that need trust (which can edit what a site sends
// and shows) only as GitHub serves them: GitHub Pages, then raw GitHub,
// both uBlock Origin's repository itself, over TLS, no redirect followed
// (web-host.cjs). jsDelivr and Cloudflare Pages are other companies'
// copies of it: what they serve is used, but as an ordinary list, until
// GitHub answers again. Lists are unsigned, so trust can only come from
// where a list came from, and that is narrowed to one company.
const MIRRORS = Object.freeze([
  { url: 'https://ublockorigin.github.io/uAssetsCDN/', trusted: true },
  { url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/', trusted: true },
  { url: 'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/', trusted: false },
  { url: 'https://ublockorigin.pages.dev/', trusted: false },
].map(mirror => Object.freeze(mirror)));

/** Whether a list's copy came from a mirror that keeps a list's trust. */
const fromTrustedMirror = saved => MIRRORS.some(mirror => mirror.trusted && mirror.url === saved?.source);

/**
 * Whether a list's copy may use what its list may (trust): only uBlock
 * Origin's own, as GitHub served it. A copy an Atmos before this rule kept
 * (its record says nothing of a source) keeps the trust it had until it's
 * fetched again, which is at once (update). A copy with no record at all
 * is trusted with nothing: a record is written only once its file is.
 */
function copyTrusted(list, saved) {
  if (!list.trusted || !saved) return false;
  return saved.source === null || fromTrustedMirror(saved);
}

// "!#if" conditions the lists are written for: Chromium, and uBlock Origin's
// syntax; styles go in as user style sheets.
const ENV = Object.freeze([['env_chromium', true], ['ext_ublock', true], ['cap_user_stylesheet', true]]);

// A page's scriptlets are put together here, as uBlock Origin does, from the
// filters the engine matches, not taken as the engine assembles them: it
// puts each argument in a template literal and decodes it as if it were
// URI-encoded, so an argument with a "%" threw or changed, one with a
// backtick broke its script, and a list could end an argument early and run
// code of its own in pages. Here each call's arguments are JSON.
// Scriptlets uBlock Origin runs before the others (its "priority"): one that
// configures another's helpers has to come first.
const SCRIPTLET_PRIORITY = new Map([['proxy-apply-config.js', 100]]);
const MAX_COMPILED = 500;     // bundles whose syntax was checked, remembered

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
      // The mirror this copy came from (null: not recorded, an older Atmos's copy).
      source: typeof saved.source === 'string' ? saved.source.slice(0, 300) : null,
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
      parser: typeof engine.parser === 'string' ? engine.parser : '',
      lists: Array.isArray(engine.lists) ? engine.lists.filter(id => typeof id === 'string') : [],
      // The lists built with their trust (null: not recorded, an older Atmos's engine).
      trusted: Array.isArray(engine.trusted) ? engine.trusted.filter(id => typeof id === 'string') : null,
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
  readResources = () => fs.readFileSync(RESOURCES_FILE, 'utf8'), readParser = () => fs.readFileSync(PARSER_FILE, 'utf8'), onChange = () => {},
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
  let parserHash = null;
  const compiled = new Map();   // a bundle's hash → whether it parses

  function resources() {
    if (resourcesText === null) {
      resourcesText = readResources();
      resourcesHash = crypto.createHash('sha256').update(resourcesText).digest('hex');
      parserHash = crypto.createHash('sha256').update(readParser()).digest('hex');
    }
    return resourcesText;
  }
  /** Whether the kept engine was built by this library, resources and parser. */
  const current = () => meta.engine.library === LIBRARY && meta.engine.resources === resourcesHash && meta.engine.parser === parserHash;
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
    if (!current()) return false;
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

  /** Whether a list may use what its list may (trust), as its copy came: copyTrusted, or as declared for test lists. */
  const trustedNow = list => (localLists ? list.trusted : copyTrusted(list, meta.lists[list.id]));

  /**
   * Fetch one list: { text, changed, record } (the record to keep for it once
   * its text is on disk), or an error when no mirror served it. A copy of
   * one of uBlock Origin's own lists that has its trust is replaced only
   * from a mirror that keeps it: a copy a few days old beats one without its
   * scriptlets, and someone who can block GitHub can't make Atmos take a
   * copy from elsewhere. Only until the copy is twice its expiry old: then
   * a backup mirror's is taken (without the trust), so a network that never
   * reaches GitHub still gets fresh lists. A conditional request goes only
   * to the mirror the kept copy came from (another's ETag or date means
   * nothing to it).
   */
  async function download(list, kept) {
    const saved = meta.lists[list.id];
    const stale = !saved?.fetchedAt || now() - saved.fetchedAt >= 2 * (saved.expires || 4 * DAY);
    const mirrors = kept && copyTrusted(list, saved) && !stale ? MIRRORS.filter(mirror => mirror.trusted) : MIRRORS;
    let problem = null;
    for (const mirror of mirrors) {
      const conditional = !!kept && saved?.source === mirror.url;
      try {
        const answer = await fetchText(`${mirror.url}${list.path}`, conditional ? { etag: saved.etag, lastModified: saved.lastModified } : {});
        if (answer?.status === 304 && conditional) return { text: kept, changed: false, record: { ...saved, fetchedAt: now() } };
        if (answer?.status !== 200 || !looksLikeList(answer.text) || answer.text.length > MAX_LIST_BYTES) {
          problem = `${list.title}: ${answer?.status === 200 ? 'not a filter list' : `HTTP ${answer?.status}`}`;
          continue;
        }
        const changed = answer.text !== kept;
        return {
          text: answer.text, changed,
          record: {
            etag: answer.etag || null, lastModified: answer.lastModified || null, fetchedAt: now(),
            changedAt: changed ? now() : (saved?.changedAt || now()), expires: expiresMs(answer.text), bytes: answer.text.length,
            source: mirror.url,
          },
        };
      } catch (error) {
        problem = `${list.title}: ${error.message}`;
      }
    }
    throw new Error(problem || `${list.title} couldn't be downloaded`);
  }

  /**
   * Whether the engine was built with other trust than the lists' copies
   * have now (a copy from another mirror, or from GitHub again): built
   * again. An older Atmos's engine didn't record it: it trusted uBlock
   * Origin's own lists as declared.
   */
  function trustChanged() {
    const built = meta.engine.lists;
    const before = meta.engine.trusted ?? LISTS.filter(list => list.trusted && built.includes(list.id)).map(list => list.id);
    const after = LISTS.filter(list => built.includes(list.id) && trustedNow(list)).map(list => list.id);
    return before.length !== after.length || before.some(id => !after.includes(id));
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
        // Due past its expiry; and one of uBlock Origin's own whose copy
        // lacks its trust (from another mirror, or not recorded), hourly,
        // until GitHub serves it.
        const due = !localLists && (force || !saved || now() - saved.fetchedAt >= saved.expires
          || (list.trusted && !fromTrustedMirror(saved) && now() - saved.fetchedAt >= HOUR));
        if (!due) continue;
        const kept = await readList(list.id);
        try {
          const got = await download(list, kept);
          texts.set(list.id, got.text);
          if (got.changed) {
            changed = true;
            await writeAtomic(listFile(list.id), got.text);
          }
          // A list's record, which says where its copy came from (and so
          // what it may use), is kept only once the copy is: never a record
          // for a file that isn't there yet, nor a file without its record.
          meta.lists[list.id] = got.record;
          saveMeta();
        } catch (error) {
          problems.push(error.message);
          if (kept) texts.set(list.id, kept);
        }
      }
      // Built again when a list changed (now, or since the engine was built:
      // Atmos stopped before building it), or when there's no engine for
      // this library, resources and parser, or a list's trust changed (the
      // lists kept on disk will do).
      const newer = LISTS.some(list => (meta.lists[list.id]?.changedAt || 0) > (meta.engine.builtAt || 0));
      const stale = !engine || !current() || trustChanged() || newer;
      if (changed || stale) {
        for (const list of LISTS) {
          if (texts.has(list.id)) continue;
          const kept = await readList(list.id);
          if (kept) texts.set(list.id, kept);
        }
      }
      if (texts.size && (changed || stale)) {
        const lists = LISTS.filter(list => texts.has(list.id)).map(list => ({ id: list.id, trusted: trustedNow(list), text: texts.get(list.id) }));
        const built = await buildEngine({ lists, resources: resources() });
        const buffer = built.buffer instanceof Uint8Array ? built.buffer : new Uint8Array(built.buffer);
        install(FiltersEngine.deserialize(buffer));
        // The engine's record, like a list's, only once its file is written.
        if (!localLists) await writeAtomic(engineFile, buffer);
        meta.engine = {
          builtAt: now(), library: LIBRARY, resources: resourcesHash, parser: parserHash, lists: lists.map(list => list.id),
          trusted: lists.filter(list => list.trusted).map(list => list.id),
          rules: { network: built.rules?.network || 0, cosmetic: built.rules?.cosmetic || 0 },
        };
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

  /**
   * $csp directives the lists add to a document's response, or undefined:
   * only a clean header value that sends no reports (the parser leaves such
   * filters out; this is the last check before a header).
   */
  function csp({ url, type, sourceUrl }) {
    if (!engine || !/^https?:/i.test(url)) return undefined;
    const value = engine.getCSPDirectives(Request.fromRawDetails({ url, type, sourceUrl: sourceUrl || url }));
    if (typeof value !== 'string' || !value || !/^[\x20-\x7e]*$/.test(value) || /(?:^|[;,])\s*report-(?:to|uri)\b/i.test(value)) return undefined;
    return value;
  }

  function where(url) {
    const request = Request.fromRawDetails({ url });
    return { hostname: request.hostname || '', domain: request.domain || '' };
  }

  /** Whether `code` parses as a script (only parsed, never run), remembered by its hash. */
  function parses(code) {
    const key = crypto.createHash('sha1').update(code).digest('hex');
    let ok = compiled.get(key);
    if (ok === undefined) {
      try { new vm.Script(code); ok = true; } catch { ok = false; }
      if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value);
      compiled.set(key, ok);
    }
    return ok;
  }

  /**
   * One scriptlet filter as { world, priority, definitions, call }: the
   * scriptlet's function and its helpers (defined once per script) and a
   * call with its arguments as JSON; { other } for a resource the engine
   * gives as it is; null for a name it doesn't know.
   */
  function scriptletCall(filter) {
    const parsed = filter.parseScript();
    if (!parsed || typeof parsed.name !== 'string') return null;
    const resources = engine.resources;
    const scriptlet = resources.getRawScriptlet(parsed.name);
    if (!scriptlet) {
      const other = resources.getSurrogate(parsed.name);
      return typeof other === 'string' && other ? { other } : null;
    }
    const args = JSON.stringify(parsed.args.map(String)).slice(1, -1);
    const named = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(scriptlet.body)?.[1];
    return {
      world: scriptlet.executionWorld === 'ISOLATED' ? 'isolated' : 'main',
      priority: SCRIPTLET_PRIORITY.get(scriptlet.name) || 0,
      definitions: [...resources.getScriptletDependencies(scriptlet), ...(named ? [scriptlet.body] : [])],
      call: named ? `${named}(${args});` : `(${scriptlet.body})(${args});`,
    };
  }

  /**
   * One world's calls as one script: a scope of their own, each definition
   * once, each call once (lists repeat each other), uBlock Origin's order,
   * each call in its own try.
   */
  function bundle(calls) {
    const definitions = new Set();
    for (const call of calls) for (const definition of call.definitions) definitions.add(definition);
    const unique = [...new Map(calls.map(call => [call.call, call])).values()];
    const sorted = unique.sort((a, b) => (b.priority - a.priority) || a.call.localeCompare(b.call));
    return [
      '(function () {',
      'var scriptletGlobals = {};',
      ...definitions,
      ...sorted.map(({ call }) => `try { ${call} } catch (e) {}`),
      '})();',
    ].join('\n');
  }

  /**
   * A page's scriptlets as uBlock Origin runs them: { main, isolated }, a
   * script for each world (uBlock Origin's "isolated" ones touch the page's
   * DOM from a world of their own, out of the page's reach). In a scope of
   * their own, so nothing is left on the page's window (a page could spot
   * helpers left there, and trip over them); each helper defined once and
   * shared, so a scriptlet that configures another's helpers works
   * (proxy-apply-config: X shows "Some privacy related extensions may cause
   * issues" when it doesn't); the configuring ones first, then in uBlock
   * Origin's order; each call in a try of its own, its arguments as JSON. A
   * call that doesn't parse is left out rather than the whole script. A
   * resource the engine gives as it is runs after, on its own.
   */
  function bundleScripts(filters) {
    const byWorld = { main: [], isolated: [] };
    const others = [];
    for (const filter of filters) {
      let call = null;
      try { call = scriptletCall(filter); } catch { call = null; }
      if (!call) continue;
      if (call.other) others.push(call.other);
      else byWorld[call.world].push(call);
    }
    const out = { main: [], isolated: [] };
    for (const world of ['main', 'isolated']) {
      let calls = byWorld[world];
      if (!calls.length) continue;
      let code = bundle(calls);
      if (!parses(code)) {
        calls = calls.filter(call => parses(bundle([call])));
        log.warn?.(`[adblock] ${byWorld[world].length - calls.length} scriptlet(s) left out: they don't parse`);
        code = calls.length ? bundle(calls) : '';
        if (!code || !parses(code)) continue;
      }
      out[world].push(code);
    }
    out.main.push(...others);
    return out;
  }

  /**
   * As a page starts: { styles, scripts, isolated } for its address (the
   * scripts for the page's world, and for a world of their own), or null
   * (nothing to do). The engine's own getCosmeticsFilters, but with the
   * scriptlets put together here.
   */
  function pageStart(url) {
    if (!engine || !/^https?:/i.test(url) || engine.config?.loadCosmeticFilters === false) return null;
    const { hostname, domain } = where(url);
    const { matches, allowGenericHides } = engine.matchCosmeticFilters({
      url, hostname, domain,
      getRulesFromDOM: false, getRulesFromHostname: true, getInjectionRules: true, getExtendedRules: false,
    });
    const filters = matches.filter(({ filter, exception }) => filter !== undefined && exception === undefined).map(({ filter }) => filter);
    // Each part on its own: one that fails leaves the other.
    let styles = '';
    try {
      styles = engine.injectCosmeticFilters(filters.filter(filter => !filter.isScriptInject()), {
        url, injectScriptlets: false, injectExtended: false, allowGenericHides, getBaseRules: true,
      }).styles || '';
    } catch (error) { log.warn?.('[adblock] a page\'s styles:', error.message); }
    let scripts = { main: [], isolated: [] };
    try { scripts = bundleScripts(filters.filter(filter => filter.isScriptInject())); } catch (error) { log.warn?.('[adblock] a page\'s scriptlets:', error.message); }
    return { styles, scripts: scripts.main, isolated: scripts.isolated };
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
    const hostOf = url => { try { return new URL(url).host; } catch { return null; } };
    const inEngine = id => meta.engine.lists.includes(id);
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
        // Where its copy came from, and whether it may use the scriptlets that need trust.
        source: localLists ? 'local' : hostOf(meta.lists[list.id]?.source),
        trusted: trustedNow(list),
      })),
      // uBlock Origin's own lists in use without their trust (a copy from another mirror than GitHub).
      untrusted: LISTS.filter(list => list.trusted && inEngine(list.id) && !(meta.engine.trusted ?? [list.id]).includes(list.id)).map(list => list.title),
    };
  }

  return {
    start, stop, update, match, csp, pageStart, pageTokens, counted, status,
    ready: () => !!engine,
    flush: saveMeta,
  };
}

module.exports = { createAdblock, LISTS, MIRRORS, expiresMs, looksLikeList, cleanTokens, cleanMeta, RESOURCES_FILE, PARSER_FILE };

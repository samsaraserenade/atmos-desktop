'use strict';
/**
 * Builds Atmos Browser's filter engine from the lists' text (web-adblock.cjs).
 *
 * A parse of the lists takes a couple of seconds and a hundred megabytes on
 * the way, so it doesn't happen in the main process: web-host.cjs runs this
 * file as a utility process, sends it { lists, resources }, gets back the
 * engine serialized (which loads in milliseconds) and the utility process
 * ends. The tests call buildEngine() directly.
 *
 * Lists that aren't uBlock Origin's own lose the scriptlet filters that need
 * trust (uBlock Origin allows those only in its own lists): what runs in a
 * page is chosen by those lists alone. Each list is parsed on its own by the
 * engine's own parser (continued lines joined as the engine joins them), and
 * a scriptlet is judged by the name the engine would resolve it to, so no
 * spelling of a filter can reach a trusted scriptlet from another list.
 *
 * Whatever its list, a filter is left out when what it would put in a page
 * isn't plainly what it says: styles that could leave their rule or load an
 * address (the engine's own check needs a page to run in, and this has
 * none), a $csp that would send reports (pages' addresses to someone else)
 * or isn't a clean header value, and text too long for the engine to read
 * back (one such filter stopped every page's styles and scriptlets).
 */
const crypto = require('crypto');

// What the engine loads: network and cosmetic filters, exceptions, $csp,
// and "!#if" sections. Not procedural (extended) selectors, which need a
// script matching them in the page, nor HTML filtering, which Electron
// can't do to a response.
const ENGINE_CONFIG = Object.freeze({
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadExceptionFilters: true,
  loadCSPFilters: true,
  loadPreprocessors: true,
  loadExtendedSelectors: false,
  enableHtmlFiltering: false,
  enableMutationObserver: true,
  enableCompression: false,
  guessRequestTypeFromUrl: false,
  integrityCheck: true,
});

/**
 * Whether a parsed cosmetic filter injects a scriptlet only a trusted list
 * may use: by the name the engine resolves (aliases, with or without ".js"),
 * or any name starting "trusted-". Exceptions (#@#+js) switch scriptlets
 * off, so they stay.
 */
function needsTrustPredicate(resources) {
  const trusted = new Set((resources.scriptlets || []).filter(scriptlet => scriptlet.requiresTrust === true).map(scriptlet => scriptlet.name));
  return filter => {
    if (!filter.isScriptInject() || filter.isUnhide()) return false;
    const script = filter.parseScript();
    if (!script || typeof script.name !== 'string') return false;
    const canonical = resources.getScriptletCanonicalName(script.name);
    return /^trusted-/i.test(script.name) || (canonical !== undefined && trusted.has(canonical));
  };
}

const MAX_FILTER_TEXT = 64 * 1024;   // the engine reads back ~125 K characters at most; the longest real filter is ~17 K
// uBlock Origin's own rule: a report would carry the page's address elsewhere.
const CSP_REPORTS = /(?:^|[;,])\s*report-(?:to|uri)\b/i;
const HEADER_TEXT = /^[\x20-\x7e]*$/;
// In a :style(): what could load an address, reach outside its declarations
// or hide in an escape or comment (uBlock Origin refuses these too).
const STYLE_UNSAFE = /url\s*\(|image(?:-set)?\s*\(|cross-fade\s*\(|element\s*\(|expression\s*\(|-moz-binding|behavior\s*:|@|\\|\/\*|\/\/|[{}<>]/i;

/**
 * Whether a selector stays a selector: no rule or at-rule of its own (an
 * unquoted "{", "}", ";" or "@", a comment, an unclosed string), no control
 * characters. Escaped characters are part of names (".sm\:hidden").
 */
function selectorIsSafe(selector) {
  if (typeof selector !== 'string' || !selector || /[\x00-\x1f\x7f]/.test(selector)) return false;
  let quote = null;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '\\') { i += 1; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '}' || c === ';' || c === '@') return false;
    if (c === '/' && selector[i + 1] === '*') return false;
  }
  return quote === null;
}

const tooLong = value => typeof value === 'string' && value.length > MAX_FILTER_TEXT;

/** Whether a cosmetic filter only does what it says (scriptlets are judged by needsTrustPredicate). */
function cosmeticIsSafe(filter) {
  if (tooLong(filter.selector) || tooLong(filter.style)) return false;
  if (filter.isScriptInject() || filter.isUnhide()) return true;
  if (!selectorIsSafe(filter.getSelector())) return false;
  return !filter.hasCustomStyle() || (!STYLE_UNSAFE.test(filter.getStyle()) && !/[\x00-\x1f\x7f]/.test(filter.getStyle()));
}

/** Whether a network filter only does what it says. */
function networkIsSafe(filter) {
  if (tooLong(filter.filter) || tooLong(filter.hostname) || tooLong(filter.optionValue)) return false;
  if (!filter.isCSP()) return true;
  const csp = filter.csp;
  return csp === undefined || (HEADER_TEXT.test(csp) && !CSP_REPORTS.test(csp));
}

/**
 * The engine for `lists` ([{ id, text, trusted }]) with `resources` (the
 * JSON text of uBlock Origin's scriptlets and redirect resources, Atmos's
 * own copy): { buffer, rules: { network, cosmetic, left } } (left: filters
 * left out as unsafe).
 */
function buildEngine({ lists, resources }) {
  const { FiltersEngine, Config, Resources, Preprocessor, parseFilters } = require('@ghostery/adblocker');
  const checksum = crypto.createHash('sha256').update(resources).digest('hex');
  const needsTrust = needsTrustPredicate(Resources.parse(resources, { checksum }));
  const config = new Config(ENGINE_CONFIG);
  const networkFilters = [];
  const cosmeticFilters = [];
  const conditions = new Map(); // one preprocessor per "!#if" condition, across lists
  let left = 0;                  // filters left out as unsafe
  for (const list of lists || []) {
    if (!list || typeof list.text !== 'string') continue;
    const parsed = parseFilters(list.text, config);
    for (const filter of parsed.networkFilters) {
      if (networkIsSafe(filter)) networkFilters.push(filter);
      else left += 1;
    }
    for (const filter of parsed.cosmeticFilters) {
      if (!cosmeticIsSafe(filter)) left += 1;
      else if (list.trusted === true || !needsTrust(filter)) cosmeticFilters.push(filter);
    }
    for (const preprocessor of parsed.preprocessors) {
      const kept = conditions.get(preprocessor.condition);
      if (kept) for (const id of preprocessor.filterIDs) kept.filterIDs.add(id);
      else conditions.set(preprocessor.condition, new Preprocessor({ condition: preprocessor.condition, filterIDs: new Set(preprocessor.filterIDs) }));
    }
  }
  const engine = new FiltersEngine({ networkFilters, cosmeticFilters, preprocessors: [...conditions.values()], config });
  engine.updateResources(resources, checksum);
  return { buffer: engine.serialize(), rules: { network: networkFilters.length, cosmetic: cosmeticFilters.length, left } };
}

// As a utility process: one build, then it ends.
if (process.parentPort) {
  process.parentPort.once('message', ({ data }) => {
    try {
      const { buffer, rules } = buildEngine(data || {});
      process.parentPort.postMessage({ ok: true, buffer, rules });
    } catch (error) {
      process.parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 500) });
    }
  });
}

module.exports = { buildEngine, needsTrustPredicate, selectorIsSafe, cosmeticIsSafe, networkIsSafe, ENGINE_CONFIG, MAX_FILTER_TEXT };

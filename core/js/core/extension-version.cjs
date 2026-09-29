'use strict';
/**
 * Extension versions and version ranges: the small part of semver Atmos
 * needs to compare packages and check dependencies.
 *
 * Versions are MAJOR.MINOR.PATCH with an optional pre-release
 * (1.2.0, 1.3.0-beta.1). Build metadata (+...) is ignored.
 *
 * Ranges:
 *   1.2.3            exactly that version
 *   ^1.2.3           compatible: >=1.2.3 and <2.0.0 (for 0.x: <0.(x+1).0)
 *   ~1.2.3           patch updates: >=1.2.3 and <1.3.0
 *   >=1.2.3          that version or later
 *   *                any version
 * Pre-release versions only satisfy a range that names a pre-release of
 * the same MAJOR.MINOR.PATCH, as in npm.
 */

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** { major, minor, patch, pre: [] } or null when `text` is not a version. */
function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(VERSION);
  if (!match) return null;
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(part => part === '' || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}

function isValidVersion(text) {
  return parseVersion(text) !== null;
}

function comparePre(a, b) {
  if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const numA = /^\d+$/.test(a[i]);
    const numB = /^\d+$/.test(b[i]);
    if (numA && numB) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff) return Math.sign(diff);
    } else if (numA !== numB) {
      return numA ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1. Throws on invalid versions. */
function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) throw new TypeError(`Invalid version: ${!va ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

/** { min, max (exclusive, or null), base } or null when `range` is not valid. */
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const text = range.trim();
  if (text === '*' || text === '') return { min: null, max: null, base: null };
  const operator = text.match(/^(\^|~|>=)?\s*(.+)$/);
  const base = parseVersion(operator[2]);
  if (!base) return null;
  const at = (major, minor, patch) => ({ major, minor, patch, pre: [] });
  switch (operator[1]) {
    case '^':
      if (base.major > 0) return { min: base, max: at(base.major + 1, 0, 0), base };
      if (base.minor > 0) return { min: base, max: at(0, base.minor + 1, 0), base };
      return { min: base, max: at(0, 0, base.patch + 1), base };
    case '~':
      return { min: base, max: at(base.major, base.minor + 1, 0), base };
    case '>=':
      return { min: base, max: null, base };
    default:
      return { min: base, max: null, base, exact: true };
  }
}

function isValidRange(range) {
  return parseRange(range) !== null;
}

/** Whether `version` is inside `range`. False for anything invalid. */
function satisfies(version, range) {
  const v = parseVersion(version);
  const r = parseRange(range);
  if (!v || !r) return false;
  if (r.exact) return compareVersions(v, r.min) === 0;
  if (v.pre.length) {
    // Pre-releases only match a range that names one on the same version.
    const b = r.base;
    if (!b || !b.pre.length || b.major !== v.major || b.minor !== v.minor || b.patch !== v.patch) return false;
  }
  if (r.min && compareVersions(v, r.min) < 0) return false;
  if (r.max && compareVersions(v, r.max) >= 0) return false;
  return true;
}

/** A range in words, for "Needs Atmos …". */
function describeRange(range) {
  const text = String(range).trim();
  if (text.startsWith('>=')) return `${text.slice(2).trim()} or later`;
  const r = parseRange(text);
  if (r?.exact) return text;
  if (r?.min && r.max) return `${text} (${text.replace(/^[\^~]\s*/, '')} up to, not including, ${r.max.major}.${r.max.minor}.${r.max.patch})`;
  return text;
}

/**
 * An engines range with the version written short, as people do (">=0.15",
 * "^1", "0.15"), in full: ">=0.15.0", "^1.0.0", and "0.15" as "~0.15.0"
 * (any 0.15.x, as npm reads it). Anything else is returned as it is.
 */
function fullEngineRange(range) {
  const match = typeof range === 'string' && range.trim().match(/^(\^|~|>=)?\s*(\d+)(?:\.(\d+))?$/);
  if (!match) return range;
  const [, operator = '', major, minor] = match;
  if (minor === undefined) return operator === '>=' ? `>=${major}.0.0` : `^${major}.0.0`;
  return `${operator || '~'}${major}.${minor}.0`;
}

/**
 * Whether this Atmos (`appVersion`) is one the manifest says it runs on:
 * "engines": { "atmos": "<range>" }, as npm and VS Code extensions do.
 * { ok, reason }. No "engines" (or no "atmos" in it) is ok; a malformed one
 * never is. An Atmos whose own version isn't known (a test) passes.
 */
function checkEngines(manifest, appVersion) {
  const engines = manifest?.engines;
  if (engines === undefined || engines === null) return { ok: true, reason: null };
  if (typeof engines !== 'object' || Array.isArray(engines)) return { ok: false, reason: '"engines" must be an object, like { "atmos": ">=0.15.0" }' };
  const range = fullEngineRange(engines.atmos);
  if (range === undefined) return { ok: true, reason: null };
  if (!isValidRange(range) || String(range).trim() === '') {
    return { ok: false, reason: `"engines.atmos" isn't a version range (${JSON.stringify(range)}); use one like ">=0.15.0"` };
  }
  if (!isValidVersion(appVersion)) return { ok: true, reason: null };
  if (satisfies(appVersion, range)) return { ok: true, reason: null };
  return { ok: false, reason: `Needs Atmos ${describeRange(range)}; this is ${appVersion}` };
}

module.exports = { isValidVersion, compareVersions, isValidRange, satisfies, checkEngines, describeRange, fullEngineRange };

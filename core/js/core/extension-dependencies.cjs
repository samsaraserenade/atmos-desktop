'use strict';
/**
 * Extension dependencies (extension.json "dependencies").
 *
 *   "dependencies": {
 *     "charting":    "^1.2.0",
 *     "market-data": { "version": "^0.4.0", "optional": true },
 *     "plugin:notes": "*"
 *   }
 *
 * A bare id names a service; "plugin:<id>" or "service:<id>" names either
 * kind explicitly. A required dependency has to be present, switched on,
 * trusted and inside the version range, or the extension that needs it
 * does not load this session (and Settings says why). An optional one only
 * orders startup; the extension checks for it itself and hides what needs it.
 * An optional one marked "recommended": true is installed together with the
 * extension by the extension manager (when a source has it), but can still
 * be removed or switched off without stopping the extension:
 *
 *     "market-data": { "version": "^0.4.0", "optional": true, "recommended": true }
 *
 * Dependencies also order startup within a kind (services start before
 * plugins anyway), like the older "after" list, which still works for
 * ordering only.
 */

const { isValidRange, satisfies } = require('./extension-version.cjs');

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const KIND_PREFIX = /^(plugin|service):(.+)$/;

/**
 * { list: [{ ref, kind, id, range, optional }], errors: [string] }.
 * Invalid entries are reported in `errors` and left out of `list`.
 */
function normalizeDependencies(manifest) {
  const list = [];
  const errors = [];
  const declared = manifest?.dependencies;
  if (declared === undefined || declared === null) return { list, errors };
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    return { list, errors: ['"dependencies" must be an object of id → version range'] };
  }
  for (const [key, value] of Object.entries(declared)) {
    const prefixed = key.match(KIND_PREFIX);
    const kind = prefixed ? prefixed[1] : 'service';
    const id = prefixed ? prefixed[2] : key;
    if (!VALID_ID.test(id)) { errors.push(`dependency '${key}' is not a valid id`); continue; }
    const spec = typeof value === 'string' ? { version: value } : value;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push(`dependency '${key}' must be a version range or { version, optional }`); continue; }
    const range = spec.version === undefined ? '*' : spec.version;
    if (!isValidRange(range)) { errors.push(`dependency '${key}' has an invalid version range '${range}'`); continue; }
    if (spec.optional !== undefined && typeof spec.optional !== 'boolean') { errors.push(`dependency '${key}': "optional" must be true or false`); continue; }
    if (spec.recommended !== undefined && (typeof spec.recommended !== 'boolean' || spec.optional !== true)) {
      errors.push(`dependency '${key}': "recommended" must be true or false, on an optional dependency`); continue;
    }
    list.push({ ref: `${kind}:${id}`, kind, id, range, optional: spec.optional === true, ...(spec.recommended === true ? { recommended: true } : {}) });
  }
  return { list, errors };
}

function refOf(entry) {
  return `${entry.kind}:${entry.id}`;
}

function labelOf(entry, fallbackId) {
  const declared = entry?.manifest?.displayName || entry?.manifest?.name;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return fallbackId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Decide which extensions can load once dependencies are taken into
 * account. `entries` are catalog entries of both kinds ({ kind, id,
 * manifest }); `isUsable(entry)` says whether it is switched on and
 * trusted on its own, and `whyNotUsable(entry)` finishes the sentence
 * "Needs X, which …" when it isn't ("is switched off"). Returns a Map of ref → { ok, problems, optionalMissing }
 * for every entry. An extension whose required dependency can't load can't
 * load either, and so on down the chain.
 */
function resolveDependencies(entries, isUsable, whyNotUsable = () => 'is not loading') {
  const byRef = new Map(entries.map(entry => [refOf(entry), entry]));
  const deps = new Map(entries.map(entry => [refOf(entry), normalizeDependencies(entry.manifest).list]));
  const usable = new Set(entries.filter(entry => isUsable(entry)).map(refOf));
  const problems = new Map(entries.map(entry => [refOf(entry), []]));

  // A dependency that is present but can't load (switched off, untrusted)
  // or has the wrong version is a problem at once; one whose own
  // dependencies are missing becomes a problem as the loop removes it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const ref of [...usable]) {
      const reasons = [];
      for (const dep of deps.get(ref)) {
        if (dep.optional) continue;
        const target = byRef.get(dep.ref);
        const name = labelOf(target, dep.id);
        const wanted = dep.range === '*' ? '' : ` ${dep.range}`;
        if (!target) reasons.push(`Needs ${name}${wanted}, which is not installed`);
        else if (!satisfies(target.manifest?.version, dep.range) && dep.range !== '*') {
          reasons.push(`Needs ${name}${wanted}, but ${target.manifest?.version ? `version ${target.manifest.version}` : 'a version without a number'} is installed`);
        } else if (!usable.has(dep.ref)) {
          reasons.push(`Needs ${name}, which ${problems.get(dep.ref).length ? 'is missing a dependency' : whyNotUsable(target)}`);
        }
      }
      if (reasons.length) {
        usable.delete(ref);
        problems.set(ref, reasons);
        changed = true;
      }
    }
  }

  const result = new Map();
  for (const entry of entries) {
    const ref = refOf(entry);
    const optionalMissing = deps.get(ref)
      .filter(dep => dep.optional && !(usable.has(dep.ref) && satisfies(byRef.get(dep.ref).manifest?.version, dep.range)))
      .map(dep => dep.ref);
    result.set(ref, { ok: usable.has(ref), problems: problems.get(ref), optionalMissing });
  }
  return result;
}

/** ref → refs of the extensions that declare it as a dependency ("Used by"). */
function dependentsOf(entries) {
  const out = new Map();
  for (const entry of entries) {
    for (const dep of normalizeDependencies(entry.manifest).list) {
      if (!out.has(dep.ref)) out.set(dep.ref, []);
      out.get(dep.ref).push({ ref: refOf(entry), optional: dep.optional });
    }
  }
  return out;
}

module.exports = { normalizeDependencies, resolveDependencies, dependentsOf, refOf };

'use strict';
/**
 * What Atmos Browser keeps in Core rather than in the plugin
 * (userData/browser/), because Core applies it itself:
 *
 *   sites.json    the user's choice per site for each prompted permission
 *                 ('allow' or 'block'; Chromium checks some synchronously,
 *                 so the answer has to be here), the sites where ads and
 *                 trackers are allowed (their shield is down: "ads":
 *                 "allow"), and each site's zoom
 *   options.json  open links in Atmos Browser; ask where to save downloads;
 *                 block ads and trackers
 *
 * Private tabs' choices and zoom live in memory only and go with the
 * private session (clearPrivate). History, bookmarks and tabs are the
 * plugin's, in its own origin.
 */
const path = require('path');
const { readJson, writeJson } = require('./json-files.cjs');
const { PROMPTED, siteOf } = require('./web-policy.cjs');

const DEFAULT_OPTIONS = Object.freeze({ openLinks: false, askWhereToSave: true, blockAds: true });
const VALUES = new Set(['allow', 'block']);
// Remembered per site: the prompted permissions, and "ads" (only ever
// 'allow': blocking is the default, so its shield down is the one choice).
const SITE_SETTINGS = Object.freeze([...PROMPTED, 'ads']);
const allowedValue = (name, value) => VALUES.has(value) && (name !== 'ads' || value === 'allow');

/** { origin: { name: 'allow'|'block' } } with only known names and http(s) origins. */
function cleanPermissions(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [origin, names] of Object.entries(value)) {
    if (siteOf(origin) !== origin || !names || typeof names !== 'object') continue;
    for (const [name, setting] of Object.entries(names)) {
      if (SITE_SETTINGS.includes(name) && allowedValue(name, setting)) (out[origin] ||= {})[name] = setting;
    }
  }
  return out;
}

/** { host: factor } with sensible factors only. */
function cleanZoom(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [host, factor] of Object.entries(value)) {
    if (/^[a-z0-9.[\]:-]{1,253}$/i.test(host) && Number.isFinite(factor) && factor >= 0.25 && factor <= 5 && factor !== 1) out[host] = factor;
  }
  return out;
}

function cleanOptions(value) {
  const out = {};
  if (value && typeof value === 'object') {
    for (const key of Object.keys(DEFAULT_OPTIONS)) if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  return out;
}

function createWebSettings({ dir }) {
  const sitesFile = path.join(dir, 'sites.json');
  const optionsFile = path.join(dir, 'options.json');
  const saved = readJson(sitesFile, null);
  const kept = { permissions: cleanPermissions(saved?.permissions), zoom: cleanZoom(saved?.zoom) };
  let inPrivate = { permissions: {}, zoom: {} };
  let options = { ...DEFAULT_OPTIONS, ...cleanOptions(readJson(optionsFile, {})) };

  const store = isPrivate => (isPrivate ? inPrivate : kept);
  const save = () => writeJson(sitesFile, { format: 1, permissions: kept.permissions, zoom: kept.zoom });

  return {
    /** 'allow', 'block' or undefined: what the user chose for `name` on `origin`. */
    permission(origin, name, { private: isPrivate = false } = {}) {
      return store(isPrivate).permissions[origin]?.[name];
    },
    /** Remember a choice ('allow' | 'block'; "ads" only 'allow'), or forget it (null). */
    setPermission(origin, name, value, { private: isPrivate = false } = {}) {
      if (siteOf(origin) !== origin) throw new TypeError(`not a site: ${origin}`);
      if (!SITE_SETTINGS.includes(name)) throw new TypeError(`not a site permission: ${name}`);
      if (name === 'ads' && value === 'block') value = null; // blocking is the default
      if (value !== null && !allowedValue(name, value)) throw new TypeError(`a choice is 'allow', 'block' or null (${value})`);
      const permissions = store(isPrivate).permissions;
      if (value === null) {
        if (permissions[origin]) {
          delete permissions[origin][name];
          if (!Object.keys(permissions[origin]).length) delete permissions[origin];
        }
      } else {
        (permissions[origin] ||= {})[name] = value;
      }
      if (!isPrivate) save();
    },
    /** Every remembered choice (ordinary tabs): [{ origin, name, value }], by site. */
    listPermissions() {
      return Object.entries(kept.permissions).sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([origin, names]) => Object.entries(names).map(([name, value]) => ({ origin, name, value })));
    },
    /** Forget one choice, or everything a site was allowed or refused. */
    revoke(origin, name = null) {
      if (name === null) { delete kept.permissions[origin]; save(); return; }
      this.setPermission(origin, name, null);
    },
    /**
     * Whether the user let a site show ads and trackers (its shield down).
     * Private tabs follow the ordinary choice unless they made their own.
     */
    adsAllowed(origin, { private: isPrivate = false } = {}) {
      const own = store(isPrivate).permissions[origin]?.ads;
      return (own ?? (isPrivate ? kept.permissions[origin]?.ads : undefined)) === 'allow';
    },
    zoom(host, { private: isPrivate = false } = {}) {
      return store(isPrivate).zoom[host] ?? (isPrivate ? kept.zoom[host] : undefined) ?? 1;
    },
    setZoom(host, factor, { private: isPrivate = false } = {}) {
      if (!host) return;
      const zoom = store(isPrivate).zoom;
      if (!Number.isFinite(factor) || factor === 1) delete zoom[host];
      else zoom[host] = Math.max(0.25, Math.min(5, factor));
      if (!isPrivate) save();
    },
    /** The private session ended: its choices and zoom go with it. */
    clearPrivate() { inPrivate = { permissions: {}, zoom: {} }; },
    clear({ permissions = false, zoom = false } = {}) {
      if (permissions) kept.permissions = {};
      if (zoom) kept.zoom = {};
      save();
    },
    options() { return { ...options }; },
    setOptions(patch) {
      options = { ...options, ...cleanOptions(patch) };
      writeJson(optionsFile, options);
      return { ...options };
    },
  };
}

module.exports = { createWebSettings, DEFAULT_OPTIONS, SITE_SETTINGS };

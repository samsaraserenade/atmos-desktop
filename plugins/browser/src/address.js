/**
 * The address bar: what typed text means, and how an address reads.
 *
 * interpret() never decides what may load; Core does (web-policy.cjs), for
 * every navigation whatever its source. This only turns text into an
 * address or a search, and refuses early what Core would refuse anyway, so
 * the reason reads well.
 */

// Schemes taken as schemes even when "tel:12345" would also read as host:port.
const KNOWN_SCHEMES = new Set([
  'http', 'https', 'about', 'mailto', 'tel', 'sms', 'magnet', 'ftp', 'file', 'javascript', 'vbscript', 'data', 'blob',
  'view-source', 'chrome', 'devtools', 'atmos-app', 'atmos-ext', 'atmos-resource', 'news', 'irc', 'ircs', 'xmpp',
  'callto', 'sip', 'webcal', 'geo', 'bitcoin', 'ws', 'wss',
]);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HOST_PORT = /^([^\s/?#:@]+|\[[0-9a-f:.]+\]):(\d{1,5})(?=[/?#]|$)/i;
const DRIVE_PATH = /^[a-z]:([\\/]|$)/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;
const LOCAL = /^(localhost|[a-z0-9-]+\.localhost)$/i;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

export const REFUSED = Object.freeze({
  script: 'Atmos Browser doesn’t run script typed in the address bar.',
  file: 'Atmos Browser doesn’t open files on this computer.',
});

/** A search for `query` with a template such as "https://duckduckgo.com/?q=%s". */
export function searchUrl(template, query) {
  const encoded = encodeURIComponent(String(query ?? '').trim());
  return String(template).includes('%s') ? String(template).replace('%s', encoded) : `${template}${encoded}`;
}

function hostLike(text) {
  const authority = text.split(/[/?#]/)[0];
  // "name@example.com" is more likely an email address to look up than a
  // site to sign in to.
  if (!authority || /\s/.test(authority) || authority.includes('@')) return null;
  const hostAndPort = authority;
  const host = hostAndPort.startsWith('[') ? hostAndPort.slice(0, hostAndPort.indexOf(']') + 1) : hostAndPort.replace(/:\d{1,5}$/, '');
  if (!host) return null;
  if (LOCAL.test(host) || IPV4.test(host) || IPV6.test(host)) return { host, local: true };
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9¡-￿-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-'))) return null;
  // A name with a letter-only last part (or an IDN one) reads as a site.
  const tld = labels.at(-1);
  if (!TLD.test(tld) && !/^[¡-￿]{2,}$/.test(tld)) return null;
  return { host, local: false };
}

/**
 * What the address bar should do with `input`:
 *   { kind: 'url', url }         go there (Core may still ask or refuse)
 *   { kind: 'search', url, query }
 *   { kind: 'refused', reason }  never sent anywhere
 *   null                         nothing typed
 * `searchTemplate` is the search engine's address with %s for the words.
 */
export function interpret(input, { searchTemplate }) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const search = query => ({ kind: 'search', query, url: searchUrl(searchTemplate, query) });
  // "?" first searches for the rest, whatever it looks like.
  if (text.startsWith('?')) return text.slice(1).trim() ? search(text.slice(1).trim()) : null;
  if (DRIVE_PATH.test(text) || text.startsWith('\\\\')) return { kind: 'refused', reason: REFUSED.file };

  const scheme = text.match(SCHEME)?.[1].toLowerCase() ?? null;
  const hostPort = text.match(HOST_PORT);
  if (scheme && KNOWN_SCHEMES.has(scheme)) {
    if (scheme === 'javascript' || scheme === 'vbscript') return { kind: 'refused', reason: REFUSED.script };
    if (scheme === 'file') return { kind: 'refused', reason: REFUSED.file };
    if (scheme === 'http' || scheme === 'https') {
      try {
        const url = new URL(text);
        return url.hostname ? { kind: 'url', url: url.href } : search(text);
      } catch { return search(text); }
    }
    try { return { kind: 'url', url: new URL(text).href }; } catch { return search(text); }
  }
  // host:port (localhost:3000, example.com:8080/x): not a scheme.
  if (hostPort && !/\s/.test(text)) {
    const secure = hostPort[2] === '443';
    try { return { kind: 'url', url: new URL(`${secure ? 'https' : 'http'}://${text}`).href }; } catch { /* below */ }
  }
  if (scheme && !/\s/.test(text) && !hostLike(text)) {
    // Another program's link (steam:, spotify:, zoommtg:…): Core asks first.
    try { return { kind: 'url', url: new URL(text).href }; } catch { return search(text); }
  }
  if (/\s/.test(text)) return search(text);
  const site = hostLike(text);
  if (site) {
    // Plain http: Atmos tries https first (automatic https, Atmos 0.19.2)
    // and falls back to http, saying so, for a site that has none.
    try { return { kind: 'url', url: new URL(`http://${text}`).href }; } catch { return search(text); }
  }
  return search(text);
}

/** An http(s) address's host ('' for anything else). */
export function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : '';
  } catch { return ''; }
}

/** The origin a site setting belongs to: "https://example.com". */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}

/**
 * A site's name for prompts and titles: its host without "www.", as the
 * address has it (punycode stays punycode, so a look-alike name can't pass
 * for another).
 */
export function siteName(url) {
  const host = hostOf(url) || String(url || '');
  return host.replace(/^www\./i, '');
}

/**
 * How the address bar shows `url` while you aren't typing in it: as it is,
 * less a user name and password, as Chrome shows it. With them,
 * "https://bank.example@other.example/" reads as the bank while the site
 * is other.example.
 */
export function displayUrl(url) {
  if (!url || url === 'about:blank') return '';
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) {
      parsed.username = '';
      parsed.password = '';
      return parsed.href;
    }
  } catch { /* not an address: as it is */ }
  return String(url);
}

/** Whether `url` is one a tab can show as a page (the rest are new-tab pages or refused). */
export function isPageUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

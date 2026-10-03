'use strict';
/**
 * Links an extension asks Atmos to open (the Fable review's A5).
 *
 * A community extension's frames can't open windows themselves: their
 * iframes have no `allow-popups` (extension-frame-host.js). The SDK in
 * every frame sends link clicks and window.open to Atmos instead
 * (`links.open`), and Atmos decides here:
 *
 *   official or system   opened, as before
 *   community, clicked   opened: its frame has the focus and there was a
 *                        click or key in the Atmos window just now
 *   community otherwise  asked first ("Weather wants to open …"): from a
 *                        timer, a background frame, or a tap (Electron
 *                        reports no touch inside a frame, so a tapped link
 *                        asks rather than doing nothing)
 *   blocked, or a question already up for it   refused
 *
 * Only http(s) and mailto, as Atmos opens anywhere else.
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const MAX_URL = 8192;
const CLICK_MS = 5000; // as web-policy.cjs USER_ACTIVATION_MS

/** The address to open, normalised, or null if it isn't one Atmos opens. */
function externalLink(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.protocol !== 'mailto:' && !parsed.hostname) return null;
  return parsed.href;
}

/**
 * 'open', 'ask' or 'refuse' for a link from an extension.
 * `focused`: its frame had the focus (the Atmos page says); `actedAt`: the
 * last click or key in the Atmos window (ms).
 */
function linkDecision({ tier, focused = false, actedAt = 0, now = Date.now(), blocked = false, asking = false }) {
  if (tier !== 'third-party') return 'open';
  if (blocked) return 'refuse';
  if (focused === true && now - actedAt >= 0 && now - actedAt < CLICK_MS) return 'open';
  return asking ? 'refuse' : 'ask';
}

/** What the question says: where the link goes, in a few words. */
function describeLink(href) {
  const parsed = new URL(href);
  if (parsed.protocol === 'mailto:') return `an email to ${decodeURIComponent(parsed.pathname).slice(0, 120) || 'someone'}`;
  return parsed.host;
}

module.exports = { externalLink, linkDecision, describeLink, CLICK_MS, EXTERNAL_PROTOCOLS };

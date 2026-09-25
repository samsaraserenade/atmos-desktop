/**
 * js/plugins/matrix-chat/src/ui/html-sanitizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns untrusted message HTML (a room member's formatted_body) and plain
 * text bodies into safe markup ready to insert via innerHTML. Split out of
 * room-view.js because this is a self-contained, security-sensitive layer
 * (allowlisted tags/attrs, scheme checks) with no dependency on anything
 * else in that file — it deserves to be readable/reviewable on its own.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Plain (non-HTML) message bodies still deserve clickable links — this
// escapes the text first (so it's inert), then re-linkifies bare URLs
// inside the now-safe string. Order matters: linkifying before escaping
// would let a URL's own text smuggle unescaped HTML back in.
export function linkifyText(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/((?:https?|mxc):\/\/[^\s<]+)/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

// Matrix spec's allowed HTML subset for m.text/m.notice formatted_body
// (https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes).
// Anything not on this list — script, style, event-handler attributes,
// iframe, on*, etc — is stripped rather than passed through, since
// formatted_body is attacker-controlled content from other room members.
const ALLOWED_TAGS = new Set([
  'font', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p',
  'a', 'ul', 'ol', 'sup', 'sub', 'li', 'b', 'i', 'u', 'strong', 'em',
  'strike', 'code', 'hr', 'br', 'div', 'table', 'thead', 'tbody', 'tr',
  'th', 'td', 'caption', 'pre', 'span', 'img', 'details', 'summary',
]);

// Per-tag attribute allowlist. Anything else (onclick, onerror, style
// with url(), etc) is dropped. href/src get an extra scheme check below,
// since "allowed attribute name" isn't the same as "safe attribute value".
const ALLOWED_ATTRS = {
  a: ['name', 'target', 'href', 'rel'],
  img: ['width', 'height', 'alt', 'title', 'src'],
  font: ['color'],
  span: ['color', 'data-mx-color', 'data-mx-spoiler'],
  ol: ['start'],
  code: ['class'],
};

const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'mxc:', 'matrix:'];

// Images in a message may only come from Matrix media (mxc:), which Atmos
// fetches through your homeserver. An http(s) image would load straight
// from wherever the sender points it — a tracking pixel that tells them
// your IP address and when you read the message (the spec allows only
// mxc: here for that reason).
const isMatrixMediaUrl = value => /^mxc:\/\/[^/\s]+\/[^/\s]+$/.test(value);
// <code class> is only for a code block's language ("language-js"); any
// other class could borrow Atmos's own styles to dress a message up as UI.
const isLanguageClass = value => /^language-[A-Za-z0-9_+-]{1,32}$/.test(value);

function isSafeUrl(value) {
  try {
    // Relative/anchor links (#foo) have no scheme and are fine; anything
    // with an explicit scheme must be on the allowlist (rules out
    // javascript:, data:, vbscript:, etc).
    const url = new URL(value, 'https://placeholder.invalid/');
    if (value.startsWith('#')) return true;
    return SAFE_URL_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeNode(node) {
  // Text nodes are inert by construction — nothing to sanitize.
  if (node.nodeType === Node.TEXT_NODE) return node;

  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const tag = node.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // Disallowed wrapper (e.g. <script>, <iframe>): drop the element but
    // keep sanitizing its children as loose text/inline content, so a
    // message isn't fully erased just because of one bad wrapper tag.
    const frag = document.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) {
      const clean = sanitizeNode(child);
      if (clean) frag.appendChild(clean);
    }
    return frag;
  }

  const clean = document.createElement(tag);
  const allowedAttrs = ALLOWED_ATTRS[tag] || [];
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowedAttrs.includes(name)) continue;
    if (name === 'href' && !isSafeUrl(attr.value)) continue;
    if (name === 'src' && !isMatrixMediaUrl(attr.value)) continue;
    if (tag === 'code' && name === 'class' && !isLanguageClass(attr.value)) continue;
    // Inline <img src="mxc://...">: matrix formatted_body commonly embeds
    // images this way (custom emotes, inline stickers), but mxc: isn't a
    // real URL scheme a browser can fetch — it's a Matrix-specific pointer
    // that has to be resolved through the authenticated media API first
    // (same reason top-level m.image events need fetchMediaBytes rather
    // than a plain <img src>). Stash it as data-mx-src instead of src so
    // the element renders as a blank img rather than a broken-image icon
    // until hydrateInlineImages() (called after this HTML is inserted)
    // fetches the real bytes and fills src in.
    if (tag === 'img' && name === 'src') {
      clean.setAttribute('data-mx-src', attr.value);
      continue;
    }
    clean.setAttribute(name, attr.value);
  }
  // Outbound links open in a new tab/window without handing the linked
  // page a reference back to this one.
  if (tag === 'a') {
    clean.setAttribute('target', '_blank');
    clean.setAttribute('rel', 'noopener noreferrer');
  }

  for (const child of Array.from(node.childNodes)) {
    const cleanChild = sanitizeNode(child);
    if (cleanChild) clean.appendChild(cleanChild);
  }
  return clean;
}

/** Parses untrusted HTML (a message's formatted_body) and returns a safe,
 *  allowlisted HTML string ready to insert via innerHTML. Never returns
 *  attacker HTML verbatim — every element/attribute is checked against
 *  the allowlists above via a real parsed DOM, then re-serialized. */
export const MAX_HTML_LENGTH = 64 * 1024;

export function sanitizeHtml(html) {
  if (typeof html !== 'string' || html.length > MAX_HTML_LENGTH) throw new RangeError('message HTML is too long to show');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const wrapper = document.createElement('div');
  for (const child of Array.from(doc.body.childNodes)) {
    const clean = sanitizeNode(child);
    if (clean) wrapper.appendChild(clean);
  }
  return wrapper.innerHTML;
}

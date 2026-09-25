import { relationsForEvent } from './engine.js';
/**
 * js/plugins/matrix-chat/ui/message-render.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns Matrix timeline events into rendered/hydrated message HTML: building
 * each message row's markup, resolving edits/replies/reactions/receipts, and
 * the async "hydrate" passes that fill in media, avatars, and receipts after
 * insertion. Split out of room-view.js because this is the "event -> DOM"
 * layer proper, distinct from renderRoomView's composer/UI-chrome closure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { stripReplyFallback, onAccountChange, getUserId, getReadReceipts, fetchMediaBytes, fetchAvatarBytes, decryptAttachmentFile, getEventById, getEventTrust } from './engine.js';
import { escapeHtml, linkifyText, sanitizeHtml, MAX_HTML_LENGTH } from './html-sanitizer.js';
import { decodeBlurhashToDataUrl } from './blurhash.js';

// HH:MM, 24h, tabular — matches the compact numeric-column look the rest
// of the sidebar's panels use for timestamps/durations, rather than a
// spelled-out date on every single message.
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Renders the static (synchronous) markup for one message event. Media
// messages get a placeholder <a>/<img>/<video> with data-event-id and no
// src yet — hydrateMedia() fills those in afterward, since resolving/
// decrypting an attachment is async and can't happen while this string is
// being built. Falls back to a plain link (using content.body, matrix's
// filename-as-body convention) for any msgtype this doesn't specifically
// handle, so an unrecognized media event never just renders as nothing.
function renderEventBody(ev, content) {
  const msgtype = content.msgtype;
  const id = escapeHtml(ev.getId() || '');
  const isEncrypted = !!content.file; // encrypted rooms: content.file, not content.url

  // client.js's sendFileMessage() always sets `filename` to the file's
  // real name, and sets `body` to the caption if one was typed, or to
  // that same filename otherwise (see its own comment on why: caption
  // becomes body, original name preserved separately). So `filename`
  // being present doesn't by itself mean there's a caption — only a
  // `body` that actually differs from `filename` does. Older events
  // from before captions existed have no `filename` field at all and
  // fall back to `body` for the displayed name, same as before.
  const hasSeparateFilename = typeof content.filename === 'string' && content.filename.length > 0;
  const filename = escapeHtml(hasSeparateFilename ? content.filename : (content.body || 'file'));
  const caption = hasSeparateFilename && content.body && content.body !== content.filename
    ? content.body
    : '';
  const captionHtml = caption
    ? `<span class="mx-msg-caption">${linkifyText(caption)}</span>`
    : '';

  if (msgtype === 'm.image' || msgtype === 'm.video') {
    // Paint the blurhash placeholder (if the sender included one) as a
    // backdrop immediately, synchronously, in this same string — long
    // before hydrateMedia's async fetch/decrypt has anything real to
    // show. hydrateMedia clears this once real bytes have loaded.
    const blurhash = content.info?.['xyz.amorgan.blurhash'];
    const placeholderUrl = typeof blurhash === 'string' ? decodeBlurhashToDataUrl(blurhash) : null;

    // Reserve the media's real on-screen footprint before any bytes have
    // arrived. Senders always attach the original pixel size as
    // content.info.w/h on m.image/m.video events, so that's available
    // synchronously — no need to wait on hydrateMedia's async fetch just
    // to know the shape. Without this, the placeholder has no intrinsic
    // size at all, lays out at ~0 height, and then snaps to full height
    // the instant its src resolves; with several images/videos in the
    // same render batch resolving moments apart, that's a cascade of
    // individual jumps shoving everything below each one further down —
    // the bouncing. Setting width/height as real HTML attributes (not
    // just inline style) is what makes this work as a *placeholder*
    // rather than a post-load fix: browsers use those attributes to
    // derive a default aspect-ratio for the box even before an image has
    // loaded, so as long as the stylesheet scales width to the message
    // bubble and leaves height as `auto` (already the case — that's what
    // lets a loaded image display at bubble width at all), the reserved
    // box is already the right shape from first paint, and swapping in
    // the real src changes nothing about layout. Also set as an explicit
    // `aspect-ratio` style for the same effect on browsers/paths where
    // the attribute-derived ratio doesn't apply (e.g. if CSS ever sets
    // both width and height directly). Falls back to a generic 4:3 box
    // for the rare sender/bridge that omits info.w/h, so those still
    // reserve *something* instead of reintroducing the jump.
    const infoW = Number(content.info?.w) || 0;
    const infoH = Number(content.info?.h) || 0;
    const [dimW, dimH] = (infoW > 0 && infoH > 0) ? [infoW, infoH] : [4, 3];
    const dimsAttr = ` width="${dimW}" height="${dimH}"`;
    const placeholderStyle = placeholderUrl
      ? ` style="background-image:url(${placeholderUrl});background-size:cover;background-position:center;aspect-ratio:${dimW}/${dimH};object-fit:cover;"`
      : ` style="aspect-ratio:${dimW}/${dimH};background:var(--mx-media-placeholder-bg,rgba(127,127,127,0.15));object-fit:cover;"`;
    if (msgtype === 'm.image') {
      return `<img class="mx-msg-media mx-msg-image" data-event-id="${id}" data-encrypted="${isEncrypted}" alt="${filename}"${dimsAttr}${placeholderStyle} />` + captionHtml;
    }
    return `<video class="mx-msg-media mx-msg-video" data-event-id="${id}" data-encrypted="${isEncrypted}" controls${dimsAttr}${placeholderStyle}></video>` + captionHtml;
  }
  if (msgtype === 'm.file' || msgtype === 'm.audio') {
    return `<a class="mx-msg-file" data-event-id="${id}" data-encrypted="${isEncrypted}" data-filename="${filename}">${filename}</a>` + captionHtml;
  }

  // m.text/m.emote/m.notice: prefer the rich HTML body when the sender
  // included one. content.body is always present as a plaintext fallback
  // (for clients/notifications that can't render HTML), but showing that
  // instead of formatted_body is why links/formatting were rendering as
  // raw text — the plain body has no <a> tags, just the literal URL.
  //
  // Replies carry an extra fallback of their own on top of that (MSC2676:
  // a "> quoted text" block in body, an <mx-reply> wrapper in
  // formatted_body) — meant for clients that don't render their own
  // quote UI. This one does (renderReplyQuoteHtml, called by
  // renderMessageHtml just above this function's own output), so that
  // embedded fallback is stripped out here before display; left in,
  // it'd show the quoted original a second time as if it were part of
  // this message's own text — indistinguishable, at a glance, from
  // having just forwarded the other person's message back to them.
  const isReply = !!content['m.relates_to']?.['m.in_reply_to'];
  // Oversized formatted bodies fall back to the plain text: parsing a huge
  // one would freeze the view (MAX_HTML_LENGTH, html-sanitizer.js).
  if (content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string' && content.formatted_body.length <= MAX_HTML_LENGTH) {
    const html = isReply
      ? content.formatted_body.replace(/^\s*<mx-reply>[\s\S]*?<\/mx-reply>/i, '')
      : content.formatted_body;
    return `<span class="mx-msg-body">${sanitizeHtml(html)}</span>`;
  }
  const body = isReply ? stripReplyFallback(content.body || '') : (content.body || '');
  return `<span class="mx-msg-body">${linkifyText(body)}</span>`;
}

// Whether the timeline is currently scrolled to (or within `threshold` of)
// the bottom. Used to decide whether a late-loading attachment should
// re-pin the scroll position once it grows the content.
export function isAtBottom(listEl, threshold = 4) {
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= threshold;
}

// Assigns listEl.scrollTop to `target`, marking the 'scroll' event(s)
// that assignment triggers as ones we caused rather than the user, via
// the same _suppressScrollCheck flag onScroll (in room-view.js) checks.
// Every programmatic scroll in this file and room-view.js routes
// through here so they all share that flag safely, instead of each call
// site guessing independently when it's safe to clear it.
//
// Suppression clears when the 'scroll' event(s) it's waiting for
// actually arrive, not on a fixed timer. A single requestAnimationFrame
// was tried first, on the assumption the browser would always dispatch
// 'scroll' within one frame — it doesn't, especially while more content
// (receipts, avatars, reactions) is still growing the timeline in the
// same burst. When the real event arrived after the rAF had already
// flipped suppression back off, onScroll treated it as a genuine user
// scroll, re-checked isAtBottom() against the now-taller timeline, got
// "no", and latched stuckToBottom to false for good.
//
// A single "swap the pending listener" version of this fix was tried
// next, but it has its own race: when a second write supersedes a
// still-pending first write, removing the first write's listener and
// attaching a new one assumes the browser will coalesce both writes
// into one 'scroll' event. It doesn't always — two separate synchronous
// scrollTop assignments can each get their own 'scroll' dispatch. When
// that happens, the *first* write's event arrives, gets caught by the
// listener meant for the *second* write, and clears suppression before
// the second write's own event — the one actually still pending — has
// fired. That's exactly the shape of a render → receipts → avatars →
// reactions hydration burst, which is why it kept reproducing on
// basically every room open.
//
// Fixed with a pending count instead of a single listener: every call
// registers its own 'once' listener and increments the count; the flag
// only clears once every outstanding write's own event has arrived, in
// whatever order or grouping the browser happens to dispatch them.
//
// One case never fires 'scroll' at all: if scrollTop is already equal
// to `target`, the assignment is a no-op the browser won't dispatch an
// event for — so there's nothing to wait for. That case is
// short-circuited before suppression is even turned on.
export function scrollToSuppressed(listEl, target) {
  if (listEl.scrollTop === target) return;

  listEl._suppressScrollCheck = true;
  listEl._pendingSuppressCount = (listEl._pendingSuppressCount || 0) + 1;
  listEl.scrollTop = target;
  listEl.addEventListener('scroll', () => {
    listEl._pendingSuppressCount -= 1;
    if (listEl._pendingSuppressCount <= 0) {
      listEl._pendingSuppressCount = 0;
      listEl._suppressScrollCheck = false;
    }
  }, { once: true });
}

// Observe placeholders without retaining detached rows after timeline teardown.
const mediaJobs = new WeakMap();
function nearViewport(node, listEl, load) {
  if (mediaJobs.has(node)) return;
  const job = { cancelled: false, observer: null };
  mediaJobs.set(node, job);
  const run = () => {
    if (job.started) return;
    job.started = true;
    job.observer?.disconnect();
    if (!job.cancelled && node.isConnected) load(job);
  };
  if (typeof IntersectionObserver === 'undefined') { run(); return; }
  job.observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) run();
  }, { root: listEl.closest?.('.mx-timeline') || listEl, rootMargin: '300px' });
  job.observer.observe(node);
}

export function hydrateMedia(container, listEl, room) {
  for (const node of container.querySelectorAll('[data-event-id]')) {
    const ev = room.findEventById(node.dataset.eventId);
    if (!ev) continue;
    const content = ev.getContent();
    const encrypted = node.dataset.encrypted === 'true';
    const isVideo = node.tagName === 'VIDEO';
    // Playback is user initiated: encrypted video requires a complete download
    // and decryption, so preload=none alone cannot prevent buffer allocation.
    if (isVideo) {
      node.preload = 'none';
      node.tabIndex = 0;
      node.setAttribute('aria-label', 'Load and play video');
    }
    nearViewport(node, listEl, async job => {
      const active = () => !job.cancelled && node.isConnected;
      const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type: type || '' }));
      let loading = false;
      const load = async () => {
        if (loading || !active()) return;
        loading = true;
        try {
          const bytes = encrypted
            ? await decryptAttachmentFile(content.file)
            : await fetchMediaBytes(content.url,
                node.tagName === 'IMG' && content.info?.mimetype !== 'image/gif'
                  ? { width: 400, height: 400 } : {});
          if (!active()) return;
          const url = blobUrl(bytes, content.info?.mimetype);
          if (node.tagName === 'IMG' || isVideo) {
            const wasAtBottom = isAtBottom(listEl);
            node.addEventListener(isVideo ? 'loadedmetadata' : 'load', () => {
              if (!active()) return;
              node.style.backgroundImage = '';
              if (wasAtBottom) scrollToSuppressed(listEl, listEl.scrollHeight - listEl.clientHeight);
            }, { once: true });
            node.src = url;
            if (isVideo) {
              node.removeEventListener('click', activate);
              node.removeEventListener('keydown', activate);
              node.load();
              node.play().catch(() => {});
            }
          } else {
            node.href = url;
            node.download = node.dataset.filename;
            node.textContent = '📎 ' + node.dataset.filename;
          }
        } catch (err) {
          if (!active()) return;
          loading = false;
          console.error('[matrix-chat] failed to load attachment', err);
          if (isVideo) node.setAttribute('aria-label', 'Video failed to load; activate to retry');
          else node.replaceWith(document.createTextNode('[attachment failed to load]'));
        }
      };
      const activate = event => {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void load();
      };
      if (!isVideo) { void load(); return; }
      node.addEventListener('click', activate);
      node.addEventListener('keydown', activate);
      job.cleanup = () => {
        node.removeEventListener('click', activate);
        node.removeEventListener('keydown', activate);
      };
      try {
        const info = content.info || {};
        const poster = info.thumbnail_file
          ? await decryptAttachmentFile(info.thumbnail_file)
          : info.thumbnail_url
            ? await fetchMediaBytes(info.thumbnail_url, { width: 400, height: 400 })
            : null;
        if (poster && active()) node.poster = blobUrl(poster, info.thumbnail_info?.mimetype || 'image/jpeg');
      } catch (err) {
        if (active()) console.error('[matrix-chat] failed to load video poster', err);
      }
    });
  }
}

// Fills in src for every inline <img data-mx-src="mxc://..."> left behind
// by sanitizeNode — these come from formatted_body markup (custom emotes,
// inline images), not from a message's own event content, so they're
// looked up by their mxc: value directly rather than by event id. Sized
// small by default (these are typically emote-scale, not full images);
// an explicit width/height in the original tag is honored if present.
export function hydrateInlineImages(listEl) {
  const nodes = listEl.querySelectorAll('img[data-mx-src]');
  for (const node of nodes) {
    const mxcUrl = node.dataset.mxSrc;
    const width = parseInt(node.getAttribute('width'), 10) || 32;
    const height = parseInt(node.getAttribute('height'), 10) || 32;

    nearViewport(node, listEl, async job => {
      try {
        const bytes = await fetchMediaBytes(mxcUrl, { width, height });
        if (job.cancelled || !node.isConnected) return;
        node.src = URL.createObjectURL(new Blob([bytes]));
      } catch (err) {
        if (job.cancelled || !node.isConnected) return;
        console.error('[matrix-chat] failed to load inline image', mxcUrl, err);
        node.replaceWith(document.createTextNode(node.getAttribute('alt') || ''));
      }
    });
  }
}

// userId -> { url, failed, ts } for their avatar. Kept for the lifetime
// of this module rather than per-render, since the same handful of
// active room members tend to reappear on receipt after receipt as a
// conversation moves along — without this every hydrate pass would
// re-fetch avatars that haven't changed.
//
// Failures are cached too, but only for AVATAR_RETRY_COOLDOWN_MS, not
// forever: a permanent negative cache meant a fetch that lost a race
// (avatar not yet propagated server-side, a transient network blip)
// stayed stuck on the fallback initial until the whole plugin reloaded
// and threw the module-level cache away — which is what "icons don't
// update, needs a refresh" actually was. A short cooldown still stops
// the on-every-receipt-update hammering this cache exists to avoid,
// while letting a later hydrate pass (the next receipt, the next
// message from that sender) retry instead of being stuck.
const avatarUrlCache = new Map();
let avatarGeneration = 0;
onAccountChange(() => {
  avatarGeneration++;
  for (const entry of avatarUrlCache.values()) URL.revokeObjectURL(entry.url);
  avatarUrlCache.clear();
});
const AVATAR_RETRY_COOLDOWN_MS = 30000;

// Bounds how many distinct users' avatar blob URLs stay alive at once.
// avatarUrlCache is module-level — shared across every room for the
// life of the tab, not scoped to one room-view mount the way message
// media is — so without its own cap it just grows by one blob URL per
// distinct user ever seen (senders, receipt-readers, anyone) and never
// shrinks. 500 comfortably covers a large room's membership without
// letting a long session across many rooms accumulate indefinitely.
const MAX_AVATAR_CACHE = 500;

// Inserts/refreshes an entry and enforces MAX_AVATAR_CACHE, LRU-style.
// Map preserves insertion order, so deleting-then-re-setting a key on
// every touch (cache hit or miss) keeps "first key in iteration order"
// meaning "least recently used" rather than "least recently inserted" —
// which is what makes evicting that first key the right thing to evict.
// This is now the *only* place avatar blob URLs get revoked; see
// revokeMediaUrls()'s comment below for why per-row revocation was
// wrong for these specifically.
function cacheAvatarUrl(userId, entry) {
  const previous = avatarUrlCache.get(userId);
  if (previous?.url && previous.url !== entry.url) URL.revokeObjectURL(previous.url);
  avatarUrlCache.delete(userId);
  avatarUrlCache.set(userId, entry);
  if (avatarUrlCache.size <= MAX_AVATAR_CACHE) return;
  const oldestKey = avatarUrlCache.keys().next().value;
  const oldest = avatarUrlCache.get(oldestKey);
  avatarUrlCache.delete(oldestKey);
  // fallbackAvatarUrl() entries are data: URLs, not blob: ones —
  // revokeObjectURL on those is a documented no-op, so this doesn't
  // need to branch on `oldest.failed` first.
  URL.revokeObjectURL(oldest.url);
}

// Deterministic initial-in-a-circle SVG, used when a user has no avatar
// or the fetch fails — so a missing avatar is a coloured initial, never
// a broken-image icon in the receipt stack.
function fallbackAvatarUrl(userId) {
  const initial = (userId.replace('@', '')[0] || '?').toUpperCase();
  let hue = 0;
  for (const c of userId) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">`
    + `<circle cx="10" cy="10" r="10" fill="hsl(${hue},55%,45%)"/>`
    + `<text x="10" y="14" font-size="10" text-anchor="middle" fill="#fff" font-family="sans-serif">${initial}</text>`
    + `</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

async function getAvatarUrl(userId) {
  const cached = avatarUrlCache.get(userId);
  if (cached && (!cached.failed || Date.now() - cached.ts < AVATAR_RETRY_COOLDOWN_MS)) {
    cacheAvatarUrl(userId, cached); // touch: mark as recently used for LRU eviction
    return cached.url;
  }
  const generation = avatarGeneration;
  try {
    // fetchAvatarBytes already asks the homeserver for an animated
    // thumbnail (MSC2705), so a GIF avatar comes back still animated
    // rather than flattened to one frame — same reasoning hydrateMedia
    // applies to gif message attachments, just via the animated-thumbnail
    // flag instead of skipping thumbnailing outright, since (unlike a
    // message event) there's no content.info.mimetype available upfront
    // to branch on before the fetch. No explicit Blob type is set below:
    // <img> sniffs the real format from the bytes themselves, and every
    // common avatar format (png/jpeg/gif/webp) plays/animates correctly
    // that way without it.
    // Rendered at 38px; ask the homeserver for a nearby larger thumbnail
    // so it stays crisp instead of scaling up the old 24px source.
    const bytes = await fetchAvatarBytes(userId, 40);
    if (generation !== avatarGeneration) return null;
    const url = URL.createObjectURL(new Blob([bytes]));
    cacheAvatarUrl(userId, { url, failed: false, ts: Date.now() });
    return url;
  } catch {
    if (generation !== avatarGeneration) return null;
    const url = fallbackAvatarUrl(userId);
    cacheAvatarUrl(userId, { url, failed: true, ts: Date.now() });
    return url;
  }
}

// Caps how many rendered rows are allowed to sit in the DOM at once.
// Nothing in this file previously enforced this: renderTimeline()'s
// windowSize only ever grows (pagination adds a page, nothing ever
// takes one away), and appendEvents() had no cap at all — a long
// session in an active channel just kept mounting more <img>/<video>
// nodes onto the end forever. 400 is ~8 pages at the current PAGE_SIZE;
// generous enough that normal scrollback doesn't feel truncated, small
// enough to actually bound memory in a channel that's been open all day.
const MAX_RENDERED_MESSAGES = 400;

// Revokes every message-media object URL a row is holding onto —
// hydrateMedia() calls URL.createObjectURL for every image/video (and
// video poster) it loads, and nothing else in this file ever revokes
// those. Only meant to be called immediately before a row is actually
// removed; calling it on a row that's staying would blank out media
// still in use.
//
// Deliberately does NOT touch avatar images (.mx-receipt-avatar, or the
// sender-avatar <img> inside a [data-avatar-for] node): those blob URLs
// come from the shared avatarUrlCache above, keyed by userId, and the
// same URL is very likely rendered in *other* rows still on screen for
// the same sender/reader. Revoking it here — as this used to do,
// unconditionally, for every blob: src in the row — broke that user's
// avatar wherever else it was showing, while leaving avatarUrlCache
// still handing out the now-dead URL to future callers. Avatar URLs are
// now only ever revoked by cacheAvatarUrl()'s own LRU eviction, which is
// the one place that actually knows nothing else still needs them.
export function revokeMediaUrls(row) {
  for (const node of row.querySelectorAll('[data-event-id], img[data-mx-src]')) {
    const job = mediaJobs.get(node);
    if (job) {
      job.cancelled = true;
      job.observer?.disconnect();
      job.cleanup?.();
      mediaJobs.delete(node);
    }
  }
  for (const node of row.querySelectorAll('a[href^="blob:"]')) URL.revokeObjectURL(node.href);
  for (const node of row.querySelectorAll('img[src^="blob:"], video[src^="blob:"]')) {
    if (node.classList.contains('mx-receipt-avatar')) continue;
    if (node.closest('[data-avatar-for]')) continue;
    URL.revokeObjectURL(node.src);
  }
  for (const node of row.querySelectorAll('video[poster^="blob:"]')) {
    URL.revokeObjectURL(node.poster);
  }
}

// Full teardown for when a timeline is being discarded entirely — a
// room switch, or the room-view unmounting — rather than incrementally
// trimmed from one end. trimRenderedWindow() below only ever revokes
// the specific rows it evicts, which covers a long-running session in
// one room fine, but left every *remaining* row's media leaked the
// moment the whole timeline got replaced or thrown away: contentEl
// getting wiped on room switch doesn't revoke anything on its own, it
// just drops the DOM references while the underlying blobs stay alive
// for the rest of the tab's life. Exported so room-view.js can call this
// from its own unmount(), right before tearing down/replacing the
// timeline element.
export function revokeAllMediaUrls(listEl) {
  for (const row of listEl.children) {
    revokeMediaUrls(row);
  }
}

// Evicts rows from the top (oldest end) once the rendered window grows
// past `maxSize`, revoking their media/avatar blob URLs as they go.
// appendEvents() calls this after every live message since it always
// pins to the bottom (see its own comment), so trimming the top is
// always trimming rows that are already scrolled out of view, never
// what the user is currently looking at. Exported so room-view.js can
// also call it — e.g. once the user scrolls back down away from
// history they paginated in with prependOlderEvents() below, to bring
// the window back down instead of leaving it permanently enlarged.
export function trimRenderedWindow(listEl, maxSize = MAX_RENDERED_MESSAGES) {
  while (listEl.children.length > maxSize) {
    const row = listEl.firstElementChild;
    if (!row) break;
    revokeMediaUrls(row);
    row.remove();
  }
}

// Fills in the read-receipt avatar stack for every message currently on
// screen (centered against the sender profile icon — see styles.css).
// Mirrors hydrateMedia/hydrateInlineImages's shape: scans for placeholder
// nodes just inserted and fills them in asynchronously per-node, so one
// slow avatar fetch never blocks the others. Called after every render
// (initial load, pagination, live append) AND from the onReceipt
// subscription below, since receipts move independently of new messages
// arriving — someone reading further doesn't emit a new m.room.message.
// Guards each placeholder against overlapping async avatar loads. A receipt
// can advance again before the previous row's avatar fetch finishes; without
// a generation check, that older request can repaint an icon which the newer
// hydration already cleared.
const receiptHydrationVersions = new WeakMap();

async function hydrateReceiptsNode(node, room) {
  const version = (receiptHydrationVersions.get(node) || 0) + 1;
  receiptHydrationVersions.set(node, version);
  const eventId = node.dataset.receiptsFor;
  const receipts = getReadReceipts(room, eventId).sort((a, b) => a.ts - b.ts);
  if (receipts.length === 0) {
    if (node.childNodes.length) node.innerHTML = '';
    return;
  }
  const shown = receipts.slice(0, 3);
  const urls = await Promise.all(shown.map(r => getAvatarUrl(r.userId)));
  // node may have been removed from the DOM (scrolled out of the
  // rendered window, room switched) by the time these async avatar
  // fetches resolve — writing into a detached node is harmless but
  // pointless, so bail rather than build a string nobody will see.
  if (!node.isConnected || receiptHydrationVersions.get(node) !== version) return;
  node.innerHTML = shown
    .map((r, i) => `<img class="mx-receipt-avatar" src="${urls[i]}" alt="" title="${escapeHtml(r.userId)}" draggable="false">`)
    .join('')
    + (receipts.length > shown.length ? `<span class="mx-receipt-overflow">+${receipts.length - shown.length}</span>` : '');
}

export async function hydrateReceipts(container, room) {
  const nodes = container.querySelectorAll('[data-receipts-for]');
  await Promise.all(Array.from(nodes, node => hydrateReceiptsNode(node, room)));
}

// Updates just the one message's receipt stack instead of rescanning
// every row currently rendered. A receipt event only ever tells you
// which specific event(s) someone just read up to (see getContent()'s
// eventId -> receiptType -> userId shape at the call site in
// room-view.js) — there's no reason a receipt landing on one message
// should re-fetch and re-render the read-receipt row of every other
// message on screen too, which is what calling hydrateReceipts(listEl,
// room) on every single receipt was doing. A no-op if the row isn't
// currently rendered (paginated/scrolled out of the current window).
export async function hydrateReceiptsForEvent(listEl, room, eventId) {
  const node = listEl.querySelector(`[data-receipts-for="${CSS.escape(eventId)}"]`);
  if (!node) return;
  await hydrateReceiptsNode(node, room);
}

// Fills in the sender avatar circle for every message currently on
// screen. Mirrors hydrateReceipts exactly — same getAvatarUrl/cache, same
// "scan for the placeholder attribute just inserted, fill in async,
// per-node so one slow fetch never blocks the others" shape — just keyed
// by data-avatar-for (a userId) instead of data-receipts-for (an
// eventId). Kept as its own pass rather than folded into hydrateReceipts
// since the two placeholders resolve independently (a message's sender
// avatar doesn't change once sent; its receipts do).
// Who-sent-this warnings (client.js getEventTrust, trust-service.js): one
// line under a message whose sender Atmos can't confirm, or that arrived
// unencrypted in an encrypted room. Most messages have none and the node
// stays empty. Built with textContent: the text is Atmos's own, but no
// markup is needed.
const trustHydrationVersions = new WeakMap();

export async function hydrateTrust(container, room) {
  const nodes = container.matches?.('[data-trust-for]') ? [container] : container.querySelectorAll('[data-trust-for]');
  await Promise.all(Array.from(nodes, async node => {
    const version = (trustHydrationVersions.get(node) || 0) + 1;
    trustHydrationVersions.set(node, version);
    const event = room.findEventById?.(node.dataset.trustFor);
    const trust = event ? await getEventTrust(event) : null;
    if (!node.isConnected || trustHydrationVersions.get(node) !== version) return;
    node.replaceChildren();
    node.className = 'mx-msg-trust';
    if (!trust) return;
    node.classList.add(`mx-msg-trust-${trust.level}`);
    const icon = document.createElement('span');
    icon.className = 'mx-msg-trust-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = trust.level === 'danger' ? '⚠' : 'ⓘ';
    const text = document.createElement('span');
    text.textContent = trust.text;
    node.append(icon, text);
  }));
}

export async function hydrateSenderAvatars(container) {
  const nodes = container.querySelectorAll('[data-avatar-for]');
  for (const node of nodes) {
    const userId = node.dataset.avatarFor;
    const url = await getAvatarUrl(userId);
    if (!node.isConnected) continue; // scrolled out / room switched before this resolved
    node.innerHTML = `<img src="${url}" alt="">`;
  }
}

// Fills in the reaction-pill row for every message currently on screen —
// or, called on its own (not as part of a full render pass), refreshes
// just that row after a reaction/redaction event arrives live. Unlike
// hydrateReceipts/hydrateSenderAvatars this is synchronous: reactionsForEvent()
// only reads the room's already-synced local timeline, no fetch involved,
// so there's no async gap where the node could scroll out from under it —
// the isConnected guard those two need doesn't apply here.
export function hydrateReactions(container, room, selfId) {
  const nodes = container.querySelectorAll('[data-reactions-for]');
  for (const node of nodes) {
    const eventId = node.dataset.reactionsFor;
    node.innerHTML = renderReactionsHtml(reactionsForEvent(room, eventId, selfId));
  }
}

// Updates just one message's reaction-pill row instead of rescanning
// every row currently rendered. A live m.reaction event's own
// m.relates_to.event_id already says exactly which message it targets,
// so there's no need to re-derive every reaction pill on screen just
// because one message got reacted to — same reasoning as
// hydrateReceiptsForEvent above, just for the synchronous reaction
// path. A no-op if the row isn't currently rendered.
export function hydrateReactionsForEvent(listEl, room, eventId, selfId) {
  const node = listEl.querySelector(`[data-reactions-for="${CSS.escape(eventId)}"]`);
  if (!node) return;
  node.innerHTML = renderReactionsHtml(reactionsForEvent(room, eventId, selfId));
}

// stickToBottom: true for the normal "new message arrived" / initial-load
// case (scroll to show the latest). false when called after paginating
// older history in — jumping back to the bottom after loading history
// would undo the very scroll-up gesture that triggered the load, so that
// path instead restores the same visual scroll offset the user was at
// (anchored to scrollHeight - scrollTop, since older events are being
// *prepended*, which otherwise yanks the viewport down as content is
// added above it).
export const PAGE_SIZE = 50;

export function getMessageEvents(room) {
  return (room.getLiveTimeline()?.getEvents() || []).filter(ev => {
    if (ev.getType() !== 'm.room.message') return false;
    // A redaction deletes the message from the visible timeline. Keeping the
    // empty event here would leave a blank bubble after the homeserver accepts
    // a context-menu deletion.
    if (typeof ev.isRedacted === 'function' && ev.isRedacted()) return false;
    // An edit (m.relates_to.rel_type === 'm.replace') is a revision of an
    // existing bubble, not a new one — resolveEffectiveContent() below is
    // what actually applies it to the message it targets. Left in this
    // list, it would render as a second, redundant bubble of its own.
    const rel = ev.getContent()?.['m.relates_to'];
    return !(rel && rel.rel_type === 'm.replace');
  });
}

// Deliberately NOT room.getLiveTimeline().getEvents().find(...) — that
// only sees whichever timeline object happens to be "live" right now,
// and the SDK swaps that object out on a gappy-sync reset (see
// onTimeline's toStartOfTimeline comment above: this is common right
// after you hit Send). A message row already rendered from the old
// timeline can outlive that swap with nothing re-rendering it, so a
// live-timeline-only scan intermittently misses an event whose row is
// still sitting right there in the DOM — which is exactly why Edit was
// disappearing from the right-click menu on freshly-sent messages while
// Reply (which doesn't do this lookup at all) kept working fine.
// room.findEventById() searches every timeline/timeline-set the room
// knows about, not just the live one, so it doesn't have this gap —
// same API client.js's getReadReceipts() already relies on.
export function findEventById(room, eventId) {
  return room.findEventById(eventId) || null;
}

// Every m.replace event targeting `eventId`, oldest first. Scoped to
// `originalSenderId` — the spec requires an edit come from the same user
// who sent the original, so an edit from anyone else is spoofed/invalid
// and ignored rather than silently allowed to rewrite someone else's
// message. Redacted edits are skipped too: a redacted edit is exactly as
// if it were never sent, so the previous edit (or the original content,
// if this was the only one) should show instead, not a blank.
function editsForEvent(room, eventId, originalSenderId) {
  const edits = relationsForEvent(room, eventId, 'm.replace').filter(ev => {
    if (ev.getType() !== 'm.room.message') return false;
    if (typeof ev.isRedacted === 'function' && ev.isRedacted()) return false;
    if (ev.getSender() !== originalSenderId) return false;
    const rel = ev.getContent()?.['m.relates_to'];
    return rel?.rel_type === 'm.replace' && rel.event_id === eventId;
  });
  edits.sort((a, b) => a.getTs() - b.getTs());
  return edits;
}

// The content that should actually render for a message: its own
// content, unless a later edit targeting it exists, in which case the
// latest edit's m.new_content wins. m.new_content is what the edit
// *means* — the edit event's own top-level content is only ever the
// "* fallback text" shown by clients that don't understand m.replace,
// and isn't what should be displayed here.
export function resolveEffectiveContent(ev, room) {
  const edits = editsForEvent(room, ev.getId(), ev.getSender());
  if (edits.length === 0) return { content: ev.getContent(), isEdited: false };
  const newContent = edits[edits.length - 1].getContent()?.['m.new_content'];
  return { content: newContent || ev.getContent(), isEdited: true };
}

// Short plain-text preview used for a quoted reply — deliberately
// ignores formatting/HTML entirely (a reply quote is a hint pointing at
// the original, not a full re-render of it) and truncates so a long
// quoted message can't dwarf the reply sitting under it.
export function previewText(content) {
  if (content.msgtype === 'm.image') return '🖼 Image';
  if (content.msgtype === 'm.video') return '📹 Video';
  if (content.msgtype === 'm.audio') return '🎵 Audio';
  if (content.msgtype === 'm.file') return `📎 ${content.body || 'File'}`;
  const text = (content.body || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// Label shown for a sender anywhere in this view (the message header, a
// reply quote, the composer's "replying to" preview): their room display
// name (matrix-js-sdk already disambiguates two same-named members by
// suffixing the id), or the Matrix ID when they have none yet.
export function senderLabel(room, userId) {
  const member = typeof room.getMember === 'function' ? room.getMember(userId) : null;
  return member?.name || userId;
}

// Renders the quoted-original block shown above a reply's own body, or
// '' when the message isn't a reply at all. First checks the currently-
// loaded timeline (same source of truth as everything else in this
// file, via findEventById) — if the original's already there, this can
// render the real quote synchronously, same as before.
//
// If it's not there, that no longer means "genuinely gone" — it usually
// just means the original is older than whatever's paginated in (a
// reply to something from last week, the common case, not an edge
// case). Rather than falling back to a generic "Replying to a message"
// label forever, this renders a loading placeholder carrying
// data-reply-target, and hydrateReplyQuotes() (below, called from the
// same render passes as hydrateMedia/hydrateReceipts/etc.) resolves it
// afterward via client.js's getEventById — which does the actual
// GET /rooms/{roomId}/event/{eventId} fetch findEventById can't do.
function renderReplyQuoteHtml(content, room) {
  const replyId = content['m.relates_to']?.['m.in_reply_to']?.event_id;
  if (!replyId) return '';
  const target = findEventById(room, replyId);
  if (!target) {
    return `<div class="mx-msg-reply-quote mx-msg-reply-quote-loading" data-jump-to="${escapeHtml(replyId)}" data-reply-target="${escapeHtml(replyId)}">`
      + `<span class="mx-msg-reply-sender">Loading original message…</span>`
      + `</div>`;
  }
  const { content: targetContent } = resolveEffectiveContent(target, room);
  return `<div class="mx-msg-reply-quote" data-jump-to="${escapeHtml(replyId)}">`
    + `<span class="mx-msg-reply-sender">${escapeHtml(senderLabel(room, target.getSender()))}</span>`
    + `<span class="mx-msg-reply-text">${escapeHtml(previewText(targetContent))}</span>`
    + `</div>`;
}

// Resolves every reply-quote placeholder renderReplyQuoteHtml() left
// behind because the original wasn't already sitting in the loaded
// timeline. Mirrors hydrateMedia/hydrateReceipts/hydrateSenderAvatars's
// shape exactly: scan for the placeholder attribute just inserted,
// resolve each one asynchronously and independently (one slow or failed
// lookup can't block the others), bail if the node has scrolled out of
// the DOM (or the room's been switched) by the time the fetch resolves.
//
// The actual network call lives in client.js's getEventById, not here —
// that's what does the local-recheck-then-fetch and the per-
// roomId:eventId promise cache (so two replies quoting the same
// original share one request rather than each firing its own). This
// function's only job is turning that result into the same quote markup
// the synchronous branch above already knows how to build, or an
// "unavailable" state on null.
//
// Once a node resolves (either branch below), its data-reply-target
// attribute is stripped — so calling this again on the same container
// (e.g. room-view.js re-hydrating after a redaction elsewhere in the
// timeline) only ever re-selects genuinely still-pending placeholders,
// not every reply quote that's already resolved.
export function hydrateReplyQuotes(container, room) {
  const nodes = container.querySelectorAll('[data-reply-target]');
  for (const node of nodes) {
    const replyId = node.dataset.replyTarget;

    (async () => {
      const target = await getEventById(room.roomId, replyId);
      // Node may have scrolled out of the rendered window (or the room
      // switched entirely) by the time this resolves — same guard
      // hydrateReceipts/hydrateSenderAvatars use, for the same reason.
      if (!node.isConnected) return;

      if (!target) {
        // Covers redacted, never-existed, and network failure alike —
        // getEventById doesn't distinguish them (the SDK doesn't give a
        // clean way to tell them apart here), so all three get the same
        // "can't show this" state rather than a misleading specific one.
        node.classList.remove('mx-msg-reply-quote-loading');
        node.removeAttribute('data-reply-target');
        node.innerHTML = `<span class="mx-msg-reply-sender">Original message unavailable</span>`;
        return;
      }

      const { content: targetContent } = resolveEffectiveContent(target, room);
      node.classList.remove('mx-msg-reply-quote-loading');
      node.removeAttribute('data-reply-target');
      node.innerHTML = `<span class="mx-msg-reply-sender">${escapeHtml(senderLabel(room, target.getSender()))}</span>`
        + `<span class="mx-msg-reply-text">${escapeHtml(previewText(targetContent))}</span>`;
    })();
  }
}

// m.reaction events aren't m.room.message, so getMessageEvents() above
// never surfaces them — they live in the same getLiveTimeline().getEvents()
// array this file already treats as the one source of truth for "what's
// in this room" (getMessageEvents does exactly this same scan, just
// filtered to a different type), just with type 'm.reaction' and an
// m.relates_to pointing at the event they're reacting to. Grouped by key
// (the emoji itself — Matrix's annotation relation uses the reaction as
// its own key, there's no separate reaction id) into one entry per
// distinct emoji actually used, with a count and whether `selfId` is
// among the reactors — so a pill can render as already-toggled and
// toggleReaction() below knows whether a click should react or unreact.
// Redacted reactions are skipped: a matrix-js-sdk MatrixEvent stays in
// the timeline array after redaction (this is how retracting a reaction
// via redactEvent() takes visible effect here), just with isRedacted()
// now true and its content cleared, so this can't just check "is
// m.relates_to present" — an already-redacted reaction event still
// exists as an object here, it just no longer counts.
export function reactionsForEvent(room, eventId, selfId) {
  const events = relationsForEvent(room, eventId, 'm.annotation');

  const byKey = new Map(); // key (emoji) -> { key, count, mine, myEventId }
  for (const ev of events) {
    if (typeof ev.isRedacted === 'function' && ev.isRedacted()) continue;
    const rel = ev.getContent()?.['m.relates_to'];
    if (!rel || rel.rel_type !== 'm.annotation' || rel.event_id !== eventId || !rel.key) continue;

    const entry = byKey.get(rel.key) || { key: rel.key, count: 0, mine: false, myEventId: null };
    entry.count += 1;
    if (selfId && ev.getSender() === selfId) {
      entry.mine = true;
      entry.myEventId = ev.getId(); // needed by toggleReaction() to redact *this* user's own reaction, not just any reaction with this key
    }
    byKey.set(rel.key, entry);
  }
  return Array.from(byKey.values());
}

// Renders the actual pill row for one message's .mx-msg-reactions
// placeholder — escapeHtml on the key too, not just the count, since an
// emoji key is attacker-controlled content from whichever remote client
// sent the reaction (the Matrix spec allows any string as an annotation
// key, not just real emoji) and gets interpolated straight into markup.
function renderReactionsHtml(reactions) {
  return reactions
    .map(r => `<button class="mx-reaction-pill${r.mine ? ' mx-reaction-pill-mine' : ''}" data-reaction-key="${escapeHtml(r.key)}" title="${r.mine ? 'Remove reaction' : 'React'}" type="button">${escapeHtml(r.key)} <span class="mx-reaction-count">${r.count}</span></button>`)
    .join('');
}

// Discord-style bundling window: consecutive messages from the same
// sender land in one visual "block" (one avatar/name/timestamp header,
// shared by every message under it) as long as they're within this many
// ms of each other. 5 minutes matches Discord's own default rather than
// its (configurable) 7, since this client has no equivalent setting to
// expose that choice through.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

// Whether `ev` should render as a continuation of `prevEv`'s block
// (no avatar, no repeated name/timestamp) rather than starting a new
// one. Breaks the bundle on sender change, too large a gap, or `ev`
// being a reply — a reply's quoted-original block is a fresh piece of
// context pointing elsewhere in the room, so it reads as a new message
// on its own even when it happens to be from whoever sent the block
// just above it.
function isGroupedWithPrevious(ev, prevEv, content) {
  if (!prevEv) return false;
  if (prevEv.getSender() !== ev.getSender()) return false;
  if (ev.getTs() - prevEv.getTs() > GROUP_WINDOW_MS) return false;
  if (content['m.relates_to']?.['m.in_reply_to']?.event_id) return false;
  return true;
}

// Wraps renderEventBody()'s content with the sender line and the
// read-receipt placeholder. The placeholder starts empty — hydrateReceipts()
// fills it in afterward (async, same reason media/inline-images are
// hydrated post-insert rather than built inline) — and carries
// data-receipts-for, NOT data-event-id: hydrateMedia's `[data-event-id]`
// scan isn't scoped to img/video/a, so if the wrapper carried that
// attribute too, every plain text message would also match, get treated
// as an unresolved attachment (content.url is undefined for m.text ->
// fetchMediaBytes rejects), and land in hydrateMedia's catch block, which
// replaces the whole node — sender line, body, receipts and all — with
// "[attachment failed to load: ]". Leaving data-event-id off this div
// entirely keeps hydrateMedia's selector matching only the actual media
// placeholders renderEventBody() produces. Same reasoning is why the
// reaction pieces below use data-msg-id/data-reactions-for rather than
// data-event-id too.
//
// `grouped` (see isGroupedWithPrevious above) swaps the avatar +
// name/timestamp header for a slim gutter that only reveals its
// timestamp on hover — same trade as Discord's own bundled messages,
// where you get the per-message time back by hovering rather than it
// sitting there for every line. hydrateSenderAvatars() below only ever
// looks for `[data-avatar-for]`, so a grouped row simply has nothing
// for it to fill in; no extra branching needed on that side.
export function renderMessageHtml(ev, room, grouped = false) {
  const id = escapeHtml(ev.getId() || '');
  const senderId = ev.getSender();
  const senderDisplay = escapeHtml(senderLabel(room, senderId));
  const time = formatTime(ev.getTs());
  const { content, isEdited } = resolveEffectiveContent(ev, room);
  const editedTag = isEdited ? '<span class="mx-msg-edited" title="Edited">(edited)</span>' : '';

  const leftGutter = grouped
    ? `<div class="mx-msg-gutter"><span class="mx-msg-hover-time">${time}</span></div>`
    : `<div class="mx-msg-avatar" data-avatar-for="${escapeHtml(senderId)}"></div>`;

  const header = grouped
    ? ''
    : `<div class="mx-msg-meta"><span class="mx-msg-sender">${senderDisplay}</span><span class="mx-msg-time">${time}</span></div>`;

  // data-msg-id carries the event id for the whole row so the
  // contextmenu handler (see onTimelineContextMenu) can find it from
  // wherever inside the message the user right-clicked, without needing
  // a dedicated react button to anchor on anymore.
  return `<div class="mx-msg${grouped ? ' mx-msg-grouped' : ''}" data-msg-id="${id}">`
    + leftGutter
    + `<div class="mx-msg-receipts" data-receipts-for="${id}"></div>`
    + `<div class="mx-msg-content">`
    + header
    + renderReplyQuoteHtml(content, room)
    + `${renderEventBody(ev, content)}`
    // Keep the edit marker next to the content it qualifies. This also
    // gives grouped and ungrouped messages the same body-first order.
    + editedTag
    // Filled by hydrateTrust() when Atmos can't confirm who sent this.
    + `<div class="mx-msg-trust" data-trust-for="${id}"></div>`
    // Starts empty like .mx-msg-receipts above — hydrateReactions() (see
    // below) fills it in right after insertion. Unlike receipts this
    // doesn't need to be async (no avatar fetch, no network call at
    // all — reactionsForEvent() reads purely local timeline state), but
    // it's still done as a separate hydrate pass rather than inline here
    // so a reaction/redaction arriving later can refresh just this node
    // without renderMessageHtml needing to run again.
    + `<div class="mx-msg-reactions" data-reactions-for="${id}"></div>`
    + `</div>`
    + `</div>`;
}

// stickToBottom: true for the normal "new message arrived" / initial-load
// case (scroll to show the latest). false when called after paginating
// older history in — jumping back to the bottom after loading history
// would undo the very scroll-up gesture that triggered the load, so that
// path instead restores the same visual scroll offset the user was at
// (anchored to scrollHeight - scrollTop, since older events are being
// *prepended*, which otherwise yanks the viewport down as content is
// added above it).
//
// windowSize: only the most recent `windowSize` messages are rendered,
// not the entire history the SDK happens to have loaded — same idea as
// Discord only mounting the messages near your current scroll position.
// Without this cap, every scrollback() call just made the timeline (and
// the DOM) grow forever.
//
// Setting listEl.scrollTop below is itself what fires a real 'scroll'
// event — without suppressing that, the scroll listener in
// renderRoomView() sees it, thinks the user scrolled near the top again,
// and immediately loads (and renders, and scrolls...) more, in a tight
// loop that only stops once history is exhausted. scrollToSuppressed()
// tells that listener "this particular scroll event was us, not the
// user" until that event actually arrives (see its own comment for why
// not a fixed timer).
// Prepends the newly-revealed older messages onto the top of the
// already-rendered timeline instead of re-deriving and re-inserting
// every row in the window from scratch. renderTimeline() below re-slices
// allEvents down to `windowSize` and rebuilds that entire slice's
// innerHTML on every call — fine for the very first render (there's
// nothing on screen yet to reuse), but wasteful for pagination: each
// page loaded near the top means every row already on screen (and every
// already-loaded image, avatar, receipt, and reaction pill on it) gets
// torn down and rebuilt for no reason. That's the exact same "flash"
// appendEvents() was written to avoid on the live-message side — this
// is that fix for the scroll-up/pagination side. Only the events between
// the old and new windowSize get built and inserted; hydration only runs
// on those new nodes; everything already rendered (and already hydrated)
// is left completely untouched.
//
// Grouping (see isGroupedWithPrevious) is computed the same way full
// renderTimeline() computes it within the newly-revealed batch. The row
// that used to be topmost is also re-checked against the new row that
// now lands directly above it — if it should now bundle into that row's
// group (same sender, within GROUP_WINDOW_MS), its node is rebuilt as a
// grouped row so its header doesn't keep showing an avatar/name a full
// re-render would no longer show. That single-row rebuild is the only
// "old" content this function ever touches.
//
// Callers: this only handles pagination growing the window on a timeline
// that's already rendered. Initial load / switching rooms should still
// call renderTimeline() — there's nothing to diff against yet.
export function prependOlderEvents(listEl, room, windowSize) {
  const allEvents = getMessageEvents(room);
  const currentCount = listEl.children.length;
  const targetCount = Math.min(windowSize, allEvents.length);
  if (targetCount <= currentCount) return; // nothing new revealed by this page

  const total = allEvents.length;
  const newOlder = allEvents.slice(total - targetCount, total - currentCount);

  const oldFirstRow = listEl.firstElementChild;
  const oldFirstEv = oldFirstRow ? findEventById(room, oldFirstRow.dataset.msgId) : null;

  let prevEv = null;
  const html = newOlder.map(ev => {
    const { content } = resolveEffectiveContent(ev, room);
    const grouped = isGroupedWithPrevious(ev, prevEv, content);
    prevEv = ev;
    return renderMessageHtml(ev, room, grouped);
  }).join('');

  const container = document.createElement('div');
  container.innerHTML = html;
  const newEls = Array.from(container.children);
  if (newEls.length === 0) return;

  const prevScrollHeight = listEl.scrollHeight;
  const prevScrollTop = listEl.scrollTop;

  for (const el of newEls) listEl.insertBefore(el, listEl.firstChild);

  if (oldFirstRow && oldFirstEv && prevEv) {
    const { content: oldFirstContent } = resolveEffectiveContent(oldFirstEv, room);
    const shouldGroup = isGroupedWithPrevious(oldFirstEv, prevEv, oldFirstContent);
    const wasGrouped = oldFirstRow.classList.contains('mx-msg-grouped');
    if (shouldGroup !== wasGrouped) {
      const rebuiltWrap = document.createElement('div');
      rebuiltWrap.innerHTML = renderMessageHtml(oldFirstEv, room, shouldGroup);
      const rebuilt = rebuiltWrap.firstElementChild;
      // oldFirstRow is about to be discarded in favour of `rebuilt` — same
      // situation trimRenderedWindow() handles when it evicts a row, and it
      // needs the same fix: revoke any blob: URLs the old row's media holds
      // before dropping the DOM reference, or they leak for the rest of the
      // tab's life. Left unrevoked, this fires on every pagination boundary
      // whose grouping flips, which is a lot of leaked blob URLs over a long
      // scroll-back session — eventually enough to make new image/video
      // loads (including opening the fullscreen view) start failing.
      revokeMediaUrls(oldFirstRow);
      oldFirstRow.replaceWith(rebuilt);
      hydrateMedia(rebuilt, listEl, room);
      hydrateInlineImages(rebuilt);
      hydrateReceipts(rebuilt, room);
      hydrateSenderAvatars(rebuilt);
      hydrateTrust(rebuilt, room);
      hydrateReactions(rebuilt, room, getUserId());
      hydrateReplyQuotes(rebuilt, room);
    }
  }

  // Same anchor-to-scrollHeight-delta restore renderTimeline() uses for
  // stickToBottom:false — prepending content above the current scroll
  // position otherwise yanks the viewport down by however tall the new
  // rows are.
  const target = listEl.scrollHeight - prevScrollHeight + prevScrollTop;
  scrollToSuppressed(listEl, target);

  for (const el of newEls) {
    hydrateMedia(el, listEl, room);
    hydrateInlineImages(el);
    hydrateReceipts(el, room);
    hydrateSenderAvatars(el);
    hydrateTrust(el, room);
    hydrateReactions(el, room, getUserId());
    hydrateReplyQuotes(el, room);
  }
}

export function renderTimeline(listEl, room, { stickToBottom = true, windowSize = PAGE_SIZE } = {}) {
  const prevScrollHeight = listEl.scrollHeight;
  const prevScrollTop = listEl.scrollTop;

  const allEvents = getMessageEvents(room);
  const visible = allEvents.slice(-windowSize);

  // Walked in order so each message only ever looks at the one
  // immediately above it — same "chain" isGroupedWithPrevious expects,
  // not an all-pairs comparison.
  let prevEv = null;
  revokeAllMediaUrls(listEl);
  listEl.innerHTML = visible.map(ev => {
    const { content } = resolveEffectiveContent(ev, room);
    const grouped = isGroupedWithPrevious(ev, prevEv, content);
    prevEv = ev;
    return renderMessageHtml(ev, room, grouped);
  }).join('');

  const target = stickToBottom
    ? listEl.scrollHeight - listEl.clientHeight
    : listEl.scrollHeight - prevScrollHeight + prevScrollTop;
  scrollToSuppressed(listEl, target);

  hydrateMedia(listEl, listEl, room);
  hydrateInlineImages(listEl);
  hydrateReceipts(listEl, room);
  hydrateSenderAvatars(listEl);
  hydrateTrust(listEl, room);
  hydrateReactions(listEl, room, getUserId());
  hydrateReplyQuotes(listEl, room);
}

// Appends newly-arrived live events to the end of the already-rendered
// timeline instead of re-rendering everything from scratch. A full
// innerHTML replace on every incoming event (including your own message,
// once it round-trips back through onTimeline) was tearing down and
// recreating every message node already on screen — including images
// that were already loaded — which then had to be re-fetched/re-decrypted
// from scratch by hydrateMedia(). That's the visible flash on send:
// existing content blanking out and popping back in every time a message
// arrives. Appending only the new node(s), and scoping hydration to just
// those nodes, leaves everything already rendered completely untouched.
export function appendEvents(listEl, room, events) {
  if (events.length === 0) return;

  // The event immediately above where these are about to land, if
  // any — so the first message of this batch can still bundle under
  // whatever's already on screen (two messages sent moments apart each
  // arrive as their own live event, not as a single batch).
  const lastRow = listEl.lastElementChild;
  let prevEv = lastRow ? findEventById(room, lastRow.dataset.msgId) : null;

  const html = events.map(ev => {
    const { content } = resolveEffectiveContent(ev, room);
    const grouped = isGroupedWithPrevious(ev, prevEv, content);
    prevEv = ev;
    return renderMessageHtml(ev, room, grouped);
  }).join('');

  // Build the new nodes in a detached container first, then move them
  // into the live timeline — keeps this symmetric with renderTimeline's
  // innerHTML-based construction above.
  const container = document.createElement('div');
  container.innerHTML = html;
  const newEls = Array.from(container.children);
  for (const el of newEls) listEl.appendChild(el);

  // Live messages always pin to the bottom, same as the initial render —
  // a new message arriving (including one you just sent yourself) should
  // always be visible.
  scrollToSuppressed(listEl, listEl.scrollHeight - listEl.clientHeight);

  // Hydrate each newly-appended node individually, scoped to itself —
  // this is what stops hydrateMedia/hydrateInlineImages from re-scanning
  // (and re-fetching) every attachment already sitting on screen.
  for (const el of newEls) {
    hydrateMedia(el, listEl, room);
    hydrateInlineImages(el);
    hydrateReceipts(el, room);
    hydrateSenderAvatars(el);
    hydrateTrust(el, room);
    hydrateReactions(el, room, getUserId());
    hydrateReplyQuotes(el, room);
  }

  // appendEvents always pins to the bottom (see comment above), so
  // anything trimmed here is by definition already scrolled out of view
  // above — never the content the user is currently looking at.
  trimRenderedWindow(listEl);
}

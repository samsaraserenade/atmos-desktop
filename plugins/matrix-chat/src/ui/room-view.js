import atmos from 'atmos-sdk';
import { createTimelineController } from './timeline-controller.js';
import { createComposerController } from './composer-controller.js';
/** Room view: DOM rendering and interactions, with pagination and attachment
 * lifetimes owned by timeline-controller and composer-controller. */

// sendTextMessage/editTextMessage now also take an optional `mentions`
// array ({ userId, offset, length } triples describing @-mention ranges
// in the text being sent) — see this file's own "@mention autocomplete"
// section below for how those ranges get tracked as the composer's
// value changes, and client.js's buildMentionFields() for how they turn
// into formatted_body + m.mentions on the wire.
import { sendTextMessage, sendFileMessage, editTextMessage, getUserId, getReadReceipts, markRoomRead, onTimeline, onTimelineReset, onDecrypted, onLocalEcho, onReceipt, onAccountChange, paginateBack, invalidateEventCache, getIdentityChanges, acceptIdentityChange, onTrustChange } from './engine.js';
import { showRoom } from './engine.js';
import { attachCommandBar } from './command-bar.js';
import { createFullscreenMedia } from './fullscreen-media.js';
import { createContextMenu } from './context-menu.js';
import { createEmojiBrowser } from './emoji-browser.js';
import { escapeHtml } from './html-sanitizer.js';
import {
  isAtBottom,
  scrollToSuppressed,
  hydrateMedia,
  hydrateInlineImages,
  hydrateReceipts,
  hydrateSenderAvatars,
  hydrateTrust,
  hydrateReactions,
  hydrateReplyQuotes,
  getMessageEvents,
  findEventById,
  resolveEffectiveContent,
  previewText,
  senderLabel,
  renderMessageHtml,
  renderTimeline,
  prependOlderEvents,
  appendEvents,
  hydrateReceiptsForEvent,
  hydrateReactionsForEvent,
  reactionsForEvent,
  revokeAllMediaUrls,
  revokeMediaUrls,
  PAGE_SIZE,
} from './message-render.js';

// A bare relative src on an <img> baked into an HTML string (below) is
// resolved by the browser against the *document's* base URL once that
// string is inserted via innerHTML — NOT against this module's own URL,
// which is a completely different (and correct-for-us) resolution rule
// that only applies to actual ES module specifiers (the imports above,
// and client.js's own './matrix-sdk.bundle.js'). import.meta.url is
// this module's real atmos-plugin://.../ui/room-view.js location, so
// resolving against that — same as the browser already does correctly
// for the imports above — gets us an absolute URL that works regardless
// of where/how the resulting markup ends up in the document.
const EMOJI_ICON_URL = new URL('../../assets/emoji-white.png', import.meta.url).href;

async function saveAttachment(url, name) {
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await atmos.invoke('plugin:matrix-chat', 'save-file', { name: name || 'attachment', bytes });
  } catch (error) {
    console.error('[matrix-chat] could not save the attachment:', error);
  }
}

export function renderRoomView(contentEl, room) {
  contentEl.innerHTML = `
    <div class="mx-room-view" data-atmos-glass="panel" data-atmos-glass-inset="0 0 54 0">
      <div id="mx-timeline" class="mx-timeline"></div>
      <div id="mx-pending-tray" class="mx-pending-tray" hidden></div>
      <div class="mx-identity-notice" role="status" hidden></div>
      <div id="mx-composer-context" class="mx-composer-context" hidden></div>
      <div class="mx-composer" data-atmos-glass="shell">
        <input type="file" id="mx-composer-file" multiple hidden>
        <button id="mx-composer-attach" class="mx-composer-icon-btn" title="Attach file" aria-label="Attach file"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <input type="text" id="mx-composer-input" placeholder="Message… or rev/ for commands" autocomplete="off">
        <button id="mx-composer-emoji" class="mx-composer-icon-btn" title="Insert emoji" aria-label="Insert emoji"><img class="mx-composer-emoji-icon" src="${EMOJI_ICON_URL}" alt="" width="16" height="16" draggable="false"></button>
        <button id="mx-composer-send" class="mx-composer-icon-btn mx-composer-send-btn" title="Send" aria-label="Send"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" draggable="false"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></button>
      </div>
    </div>
  `;

  const timelineEl = contentEl.querySelector('#mx-timeline');
  // This file already manages scroll position by hand everywhere
  // (renderTimeline()'s pin, hydrateMedia()'s re-pin, the
  // stickyBottomObserver below) — but overflow-anchor is on by default
  // on any scrollable element, and Chrome/Firefox's own automatic
  // scroll-anchoring logic runs independently of all of that. It can
  // partially override an explicit scrollTop assignment right after
  // it's set, any time it decides some node "anchoring" the viewport
  // shifted — which is exactly what every hydrate pass above does. That
  // fights with our own pinning and is why the view could land a
  // message short of the real bottom (the last message's header
  // visible, its body still below the fold) even on a second open of
  // the same room, where timing/caching isn't the variable. Disabling
  // it here hands scroll control entirely to our own logic, which is
  // the only thing that should be driving it.
  timelineEl.style.overflowAnchor = 'none';
  const input = contentEl.querySelector('#mx-composer-input');
  const sendBtn = contentEl.querySelector('#mx-composer-send');
  const fileInput = contentEl.querySelector('#mx-composer-file');
  const attachBtn = contentEl.querySelector('#mx-composer-attach');
  const emojiBtn = contentEl.querySelector('#mx-composer-emoji');
  const trayEl = contentEl.querySelector('#mx-pending-tray');
  const contextEl = contentEl.querySelector('#mx-composer-context');
  const composerEl = contentEl.querySelector('.mx-composer');
  // rev/ commands (command-bar.js) share this bar with messages.
  const commandBar = attachCommandBar({ input, composerEl, getRoom: () => room, onOpenRoom: roomId => showRoom(roomId) });

  // Read once at mount rather than re-fetched on every reaction/toggle —
  // the local user's own id can't change mid-session (a change means a
  // logout/login, which tears this whole view down anyway), so there's
  // nothing to invalidate.
  const selfId = getUserId();

  // This view is a frame inside Atmos: it has focus only after a click in
  // it, so the pointer resting over it counts as looking at it too.
  let pointerInside = false;
  function isActivelyViewingRoom() {
    return document.visibilityState !== 'hidden'
      && (typeof document.hasFocus !== 'function' || document.hasFocus() || pointerInside);
  }

  function markVisibleRoomRead() {
    if (!isActivelyViewingRoom()) return;
    void markRoomRead(room).catch(error => {
      console.warn('[matrix-chat] failed to update read marker', error);
    });
  }

  // Files staged via the attach button/drop, waiting on the user to hit
  // Send. Nothing here has touched sendFileMessage yet — picking a file
  // (or dropping one) only ever adds to this array and re-renders the
  // tray; the network call happens exactly once, inside send() below,
  // same moment the typed text (if any) goes out. Each entry keeps its
  // own previewUrl (image/video thumbnails only — audio/generic files
  // don't get one) so it can be revoked individually on removal/unmount
  // without tearing down the others.
  const composer = createComposerController();

  function renderTray() {
    if (composer.pending.length === 0) {
      trayEl.hidden = true;
      trayEl.innerHTML = '';
      return;
    }
    trayEl.hidden = false;
    trayEl.innerHTML = composer.pending
      .map(({ id, file, previewUrl }) => {
        const thumb = previewUrl
          ? (file.type.startsWith('video/')
              ? `<video class="mx-pending-thumb" src="${previewUrl}" muted></video>`
              : `<img class="mx-pending-thumb" src="${previewUrl}" alt="">`)
          : `<span class="mx-pending-thumb mx-pending-thumb-generic">📄</span>`;
        return `
          <div class="mx-pending-item" data-id="${id}">
            ${thumb}
            <span class="mx-pending-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <button class="mx-pending-remove" data-id="${id}" title="Remove" type="button">✕</button>
          </div>
        `;
      })
      .join('');
  }

  function addPendingFiles(files) { composer.add(files); renderTray(); }
  function removePending(id) { composer.remove(id); renderTray(); }
  function clearPending() { composer.clear(); renderTray(); }

  function onTrayClick(e) {
    const btn = e.target.closest('.mx-pending-remove');
    if (!btn) return;
    removePending(Number(btn.dataset.id));
  }
  trayEl.addEventListener('click', onTrayClick);

  // ---- Reply / edit composer state ----
  // Mutually exclusive — the composer only has one "special mode" bar at
  // a time, and a send can't simultaneously mean "this is a reply" and
  // "this replaces an existing message". Starting one clears the other.
  let replyingToId = null;
  let editingId = null;

  function renderComposerContext() {
    if (editingId) {
      contextEl.hidden = false;
      contextEl.innerHTML = `
        <span class="mx-composer-context-label">✎ Editing message</span>
        <button class="mx-composer-context-cancel" type="button" title="Cancel edit">✕</button>
      `;
      composerEl.classList.add('mx-composer-editing');
      composerEl.classList.remove('mx-composer-replying');
      attachBtn.disabled = true; // edits are text-only — see startEdit()
      return;
    }
    attachBtn.disabled = false;
    if (replyingToId) {
      const target = findEventById(room, replyingToId);
      const { content } = target ? resolveEffectiveContent(target, room) : { content: null };
      const preview = target ? `${escapeHtml(senderLabel(room, target.getSender()))}${content ? `: ${escapeHtml(previewText(content))}` : ''}` : 'a message';
      contextEl.hidden = false;
      contextEl.innerHTML = `
        <span class="mx-composer-context-label">↩ Replying to ${preview}</span>
        <button class="mx-composer-context-cancel" type="button" title="Cancel reply">✕</button>
      `;
      composerEl.classList.add('mx-composer-replying');
      composerEl.classList.remove('mx-composer-editing');
      return;
    }
    contextEl.hidden = true;
    contextEl.innerHTML = '';
    composerEl.classList.remove('mx-composer-editing', 'mx-composer-replying');
  }

  function cancelComposerContext() {
    // Only an edit's seeded text gets cleared — it came from the message
    // being edited, not the user, so there's nothing worth keeping. A
    // reply's composer text is the user's own in-progress draft (started
    // typing, then quoted a message, or vice versa) and canceling just
    // the reply shouldn't throw that away.
    if (editingId) {
      input.value = '';
      committedMentions = [];
      previousComposerValue = '';
    }
    replyingToId = null;
    editingId = null;
    renderComposerContext();
    closeMentionMenu();
  }

  contextEl.addEventListener('click', (e) => {
    if (e.target.closest('.mx-composer-context-cancel')) cancelComposerContext();
  });

  // Reply: just remembers the target id — the actual quoted preview
  // block on the sent message is built by renderReplyQuoteHtml() once
  // the relation round-trips back through onTimeline, same as every
  // other "no optimistic local state" flow in this file.
  function startReply(eventId) {
    editingId = null;
    replyingToId = eventId;
    renderComposerContext();
    closeMentionMenu();
    input.focus();
  }

  // Edit: seeds the composer with the message's current *plain* body —
  // not formatted_body — since the composer is a plain text input with
  // no rich-text editing surface to round-trip HTML through. That also
  // means any existing mentions in the message being edited come back
  // in as plain "@Name" text with no committed range behind them (the
  // original formatted_body's pill info isn't reconstructed here) — an
  // edit that doesn't touch a mention will still send it in the body
  // text, it just won't stay a clickable/notifying pill unless the user
  // deletes and re-picks it from the dropdown. committedMentions is
  // reset to match, and previousComposerValue to this seeded value, so
  // reconcileMentions() has a correct baseline for edits from here.
  function startEdit(eventId) {
    const ev = findEventById(room, eventId);
    if (!ev) return;
    const { content } = resolveEffectiveContent(ev, room);
    replyingToId = null;
    editingId = eventId;
    input.value = content.body || '';
    committedMentions = [];
    previousComposerValue = input.value;
    renderComposerContext();
    closeMentionMenu();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mentionEl) { closeMentionMenu(); return; }
    if (e.key === 'Escape' && (replyingToId || editingId)) cancelComposerContext();
  });

  const timeline = createTimelineController({
    pageSize: PAGE_SIZE,
    count: () => getMessageEvents(room).length,
    paginate: limit => paginateBack(room, limit),
    prepend: size => prependOlderEvents(timelineEl, room, size),
    nearTop: () => timelineEl.scrollTop <= 200,
    needsFill: () => timelineEl.scrollHeight <= timelineEl.clientHeight,
  });
  const maybeLoadMore = options => timeline.load(options);
  const fillViewportIfNeeded = () => timeline.fill();

  // message-render.js's hydrateMedia() is the only hydrate pass that
  // protects the scroll position against its own async growth — it
  // captures wasAtBottom before assigning an image/video's src and
  // re-pins once it loads. hydrateReceipts() and hydrateSenderAvatars()
  // insert their <img>s with no such protection, and hydrateReactions()
  // is worse still: it's synchronous, and renderTimeline() calls it
  // right after already setting scrollTop = scrollHeight, so a reaction
  // on the last message grows the content in the very same tick, after
  // the pin already happened. Read receipts in particular land on the
  // last message almost every time another member is caught up, so this
  // isn't an occasional race — it reproduces basically every time a room
  // is opened.
  //
  // Rather than patch wasAtBottom protection into each of those three
  // spots individually (and every future hydrate pass that might be
  // added later), watch the timeline container itself and re-pin
  // whenever it grows while we're supposed to be stuck to the bottom.
  //
  // "Supposed to be stuck to the bottom" is tracked as an explicit flag
  // (stuckToBottom) rather than inferred by comparing old vs. new
  // scrollHeight inside the observer callback itself — an earlier
  // version tried the comparison approach and it was only right most of
  // the time: ResizeObserver batches notifications per animation frame,
  // so several unrelated growth events (reactions + receipts + an
  // avatar, say) landing in the same frame get coalesced into one
  // callback, and a delta computed against a single stale "before"
  // snapshot can end up checking the wrong reference point depending on
  // exactly how those mutations interleaved. A flag has no such
  // ambiguity: it's just whatever onScroll last observed to be true,
  // and every mutation source funnels through the same one check.
  let stuckToBottom = true;

  // Matrix receipt updates identify the new event a user has read up to, but
  // do not separately identify the old event whose icon must disappear. Keep
  // that position per visible reader so a move can refresh both rows.
  const receiptPositionByUser = new Map();
  function indexRenderedReceiptPositions() {
    receiptPositionByUser.clear();
    for (const node of timelineEl.querySelectorAll('[data-receipts-for]')) {
      const eventId = node.dataset.receiptsFor;
      for (const receipt of getReadReceipts(room, eventId)) {
        receiptPositionByUser.set(receipt.userId, eventId);
      }
    }
  }

  // Delegates to message-render.js's scrollToSuppressed(), which every
  // programmatic scroll of this element — renderTimeline()'s initial
  // pin, appendEvents()'s live-message pin, hydrateMedia()'s post-load
  // re-pin, and this one — now routes through, so they all coordinate
  // on the same _suppressScrollCheck flag via one implementation
  // instead of each guessing independently when it's safe to reset it.
  function pinToBottom() {
    scrollToSuppressed(timelineEl, timelineEl.scrollHeight - timelineEl.clientHeight);
  }

  const stickyBottomObserver = new ResizeObserver(() => {
    if (stuckToBottom) pinToBottom();
  });
  stickyBottomObserver.observe(timelineEl);

  // ResizeObserver above only reports timelineEl's own box (its layout
  // width/height) changing — e.g. the panel being resized while pinned.
  // It does NOT fire when content added *inside* a fixed/flex-height
  // scrollable container grows past the visible area, since that's the
  // scrollbar's job to absorb, not the box's. That's exactly what
  // hydrateReceipts/hydrateSenderAvatars/hydrateReactions do: each
  // inserts new nodes (receipt avatars, sender avatars, reaction pills)
  // well after the container's own box has already settled from the
  // initial layout pass, so ResizeObserver alone never sees that later
  // growth and pinToBottom() never re-fires for it — the pin holds
  // wherever it last was, short of the real bottom by however much that
  // hydration pass added.
  //
  // A MutationObserver on the timeline's own DOM catches exactly that:
  // it fires on the node insertions those hydrate passes actually do,
  // independent of whether the container's box size moved at all.
  const stickyBottomMutationObserver = new MutationObserver(() => {
    if (stuckToBottom) pinToBottom();
  });
  stickyBottomMutationObserver.observe(timelineEl, { childList: true, subtree: true });

  renderTimeline(timelineEl, room, { windowSize: timeline.windowSize });
  indexRenderedReceiptPositions();
  fillViewportIfNeeded();

  function onScroll() {
    if (timelineEl._suppressScrollCheck) return;
    // Real user scroll (not one of our own programmatic ones, filtered
    // out above) — this is the one place that gets to update whether
    // we're currently "stuck" to the bottom, since it's the only
    // listener that sees every genuine scroll gesture, in and out of
    // the bottom zone, as it happens.
    stuckToBottom = isAtBottom(timelineEl);
    contextMenu?.close(); // position: fixed — would drift from its anchor point as the timeline scrolls under it
    emojiBrowser?.close(); // same drift problem, same fix
    maybeLoadMore();
  }
  timelineEl.addEventListener('scroll', onScroll);

  // Coalesces a burst of live events (e.g. someone sent several messages
  // while this client was offline, all landing in one sync response)
  // into a single appendEvents() call, rather than one append per event.
  // Without this, a multi-event burst visibly "pops" — each append flashes
  // in one more message before the next fires a tick later.
  let pendingNewEvents = [];
  let renderScheduled = false;
  function scheduleLiveRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      if (unmounted) return;
      const events = pendingNewEvents;
      pendingNewEvents = [];
      renderScheduled = false;
      // windowSize still has to track the true rendered count even though
      // appendEvents() doesn't consult it directly — maybeLoadMore()'s
      // "reveal more of what's already in memory" check compares windowSize
      // against getMessageEvents(room).length, and would be wrong the next
      // time it runs if this fell out of sync with what's actually on screen.
      timeline.grow(events.length);
      appendEvents(timelineEl, room, events);
      markVisibleRoomRead();
    });
  }

  // Re-renders one already-on-screen message row in place — used when an
  // edit lands (live, or via startEdit()'s own send). Rebuilds just that
  // row's HTML (resolveEffectiveContent() inside renderMessageHtml picks
  // the edit up automatically since it re-reads the live timeline) and
  // swaps it in, rather than a full renderTimeline() pass, so every other
  // message and every already-loaded image on screen stays untouched —
  // same reasoning appendEvents() gives for not doing a full re-render on
  // every new message. A no-op if the row isn't currently rendered (out
  // of the current scroll window) — nothing on screen needs updating.
  function rerenderMessage(eventId) {
    const rowEl = timelineEl.querySelector(`.mx-msg[data-msg-id="${CSS.escape(eventId)}"]`);
    if (!rowEl) return;
    const ev = findEventById(room, eventId);
    if (!ev) return;
    const wasAtBottom = isAtBottom(timelineEl);
    // An edit changes neither who sent the message nor when — so
    // whatever this row's bundling state already was (grouped under the
    // block above it, or its own header) stays exactly as it was rather
    // than being recomputed against neighbors here.
    const grouped = rowEl.classList.contains('mx-msg-grouped');
    const container = document.createElement('div');
    container.innerHTML = renderMessageHtml(ev, room, grouped);
    const newRow = container.firstElementChild;
    revokeMediaUrls(rowEl);
    rowEl.replaceWith(newRow);
    hydrateMedia(newRow, timelineEl, room);
    hydrateInlineImages(newRow);
    hydrateReceipts(newRow, room);
    hydrateSenderAvatars(newRow);
    hydrateTrust(newRow, room);
    hydrateReactions(newRow, room, selfId);
    if (wasAtBottom) pinToBottom();
  }

  // A limited/gappy sync replaces the SDK's live timeline and replays its
  // contents with toStartOfTimeline=true. Those replayed events must not be
  // appended as new bubbles, but the open view still has to reconcile with
  // the replacement once. Coalesce the reset/replay burst into one render.
  let reconcileScheduled = false;
  function scheduleTimelineReconcile() {
    if (reconcileScheduled) return;
    reconcileScheduled = true;
    queueMicrotask(() => {
      reconcileScheduled = false;
      if (unmounted) return;
      const keepBottom = stuckToBottom;
      renderTimeline(timelineEl, room, { stickToBottom: keepBottom, windowSize: timeline.windowSize });
      indexRenderedReceiptPositions();
      markVisibleRoomRead();
    });
  }

  const offTimeline = onTimeline((event, evRoom, toStartOfTimeline) => {
    if (evRoom?.roomId !== room.roomId) return;
    // toStartOfTimeline events are backfill/history, not a new message —
    // the SDK emits these for the initial sync's timeline replay, a
    // gappy-sync reset (common right after this client comes back from
    // being idle, e.g. right after you hit Send), and scrollback landing
    // its results. All of those already have their own render path
    // (renderTimeline() at mount, and paginateBack()'s caller in
    // maybeLoadMore()) — reacting to them here too is what caused a
    // burst of ~20 "new" events to flash in as 20 separate re-renders
    // every time the SDK did one of those resets. A genuinely new live
    // event grows the total by one — grow the window to match so it's
    // included, rather than the window staying fixed and the oldest
    // currently-visible message silently vanishing off the top every
    // time someone sends a message.
    if (toStartOfTimeline) return;
    // Reactions/redactions never render as their own timeline row (they
    // have no message body of their own — renderEventBody() only knows
    // m.room.message content), so they don't go through
    // pendingNewEvents/appendEvents at all. Instead: re-derive every
    // reaction pill currently on screen from the room's live timeline —
    // same "cheap enough to just re-scan the visible window rather than
    // track exactly which row changed" reasoning the onReceipt handler
    // below already uses for read receipts. A redaction is included
    // here even though most redactions aren't reaction-related (e.g.
    // someone deleting a whole message) — reactionsForEvent() re-reads
    // isRedacted() fresh each time regardless of what was redacted, so
    // there's no cheaper way to know in advance "was this specific
    // redaction a reaction toggle-off" without duplicating the relation
    // lookup redactEvent()'s caller already did before sending it.
    // A live m.reaction event's own m.relates_to.event_id already says
    // exactly which message it's annotating, so only that one row's
    // reaction-pill strip needs rebuilding — hydrateReactionsForEvent
    // scopes to it directly instead of re-deriving every reaction pill
    // currently on screen the way a plain hydrateReactions(timelineEl,
    // ...) call would. Falls back to the full rescan only if the
    // relation is missing/malformed.
    if (event.getType() === 'm.reaction') {
      const targetId = event.getContent()?.['m.relates_to']?.event_id;
      if (targetId) {
        hydrateReactionsForEvent(timelineEl, room, targetId, selfId);
      } else {
        hydrateReactions(timelineEl, room, selfId);
      }
      return;
    }
    if (event.getType() === 'm.room.redaction') {
      // A redaction can target an event that a not-yet-loaded reply quote
      // is waiting on — hydrateReplyQuotes's own in-flight cache (inside
      // getEventById) would otherwise keep serving the pre-redaction
      // result to any placeholder that resolves after this point.
      // invalidateEventCache() drops that stale entry so the next
      // hydrateReplyQuotes() pass actually re-fetches and picks up the
      // redaction, landing on "Original message unavailable" via the
      // same getEventById() null-on-redacted contract hydrateReplyQuotes
      // already handles. Only pending (unresolved) placeholders are
      // affected — an already-rendered quote for this event, if any,
      // isn't retroactively swapped out here.
      // MatrixEvent has no getRedacts() method in the bundled SDK. Its public
      // association accessor covers redactions (as well as relations); keep a
      // wire-event fallback for older SDK-shaped events used by some clients.
      const redactedEventId = event.getAssociatedId?.() || event.event?.redacts;
      const redactedEvent = redactedEventId ? findEventById(room, redactedEventId) : null;
      if (redactedEventId) invalidateEventCache(room.roomId, redactedEventId);
      hydrateReplyQuotes(timelineEl, room);
      // A redacted message is excluded by getMessageEvents(). Reconcile the
      // visible window so its bubble disappears and adjacent message grouping
      // (avatar/header visibility) is recalculated correctly. Edits are also
      // m.room.message events, and a reconcile makes their target fall back to
      // the prior revision. Reaction redactions stay on the cheaper pill-only
      // path below.
      if (redactedEvent?.getType() === 'm.room.message') scheduleTimelineReconcile();
      // Unlike m.reaction above, a redaction can't be scoped the same
      // way: the SDK clears a redacted event's content (including its
      // own m.relates_to) once isRedacted() flips true, so by the time
      // this fires there's no reliable way to read back which message's
      // reaction row a redacted *reaction* used to belong to — and most
      // redactions aren't reaction-related at all (deleting a whole
      // message) anyway. Stays a full-window rescan rather than guessing
      // wrong and leaving a stale pill on screen.
      hydrateReactions(timelineEl, room, selfId);
      return;
    }
    // appendEvents() renders straight from the event object via
    // renderEventBody(), which only knows how to handle m.room.message
    // content — filter here rather than relying on getMessageEvents()'s
    // filter downstream, since there is no downstream re-derivation step
    // anymore for this path.
    if (event.getType() !== 'm.room.message') return;

    // An edit arriving live is a revision of a message already on
    // screen, not a new bubble — same category of thing as the
    // reaction/redaction branch above, just keyed by m.replace instead.
    // pendingNewEvents/appendEvents is for genuinely new rows only.
    const editRel = event.getContent()?.['m.relates_to'];
    if (editRel?.rel_type === 'm.replace') {
      rerenderMessage(editRel.event_id);
      return;
    }
    pendingNewEvents.push(event);
    scheduleLiveRender();
  });

  const offTimelineReset = onTimelineReset((evRoom) => {
    if (evRoom?.roomId !== room.roomId) return;
    scheduleTimelineReconcile();
  });

  // Encrypted DMs commonly emit RoomEvent.Timeline while the event still
  // presents as m.room.encrypted. The normal handler above correctly skips
  // that placeholder, but it used to have no second chance after decryption,
  // leaving the message invisible until reopening the room rebuilt the whole
  // timeline. Reconcile the decrypted event with the DOM: update relations
  // in place, append a genuinely new tail message, or rebuild once when an
  // out-of-order/history decryption needs inserting at its true position.
  const offDecrypted = onDecrypted((event, evRoom) => {
    if (evRoom?.roomId !== room.roomId) return;

    queueMicrotask(() => {
      if (unmounted) return;
      const type = event.getType();
      if (type === 'm.reaction') {
        const targetId = event.getContent()?.['m.relates_to']?.event_id;
        if (targetId) hydrateReactionsForEvent(timelineEl, room, targetId, selfId);
        else hydrateReactions(timelineEl, room, selfId);
        return;
      }
      if (type !== 'm.room.message') return;

      const relation = event.getContent()?.['m.relates_to'];
      if (relation?.rel_type === 'm.replace') {
        rerenderMessage(relation.event_id);
        return;
      }

      const eventId = event.getId();
      if (!eventId) return;
      if (timelineEl.querySelector(`.mx-msg[data-msg-id="${CSS.escape(eventId)}"]`)) {
        rerenderMessage(eventId);
        return;
      }
      // A plain timeline callback may already have queued this event if it
      // decrypted between SDK callbacks. Let that incremental path own it.
      if (pendingNewEvents.some(pendingEvent => pendingEvent.getId() === eventId)) return;

      const messages = getMessageEvents(room);
      const visible = messages.slice(-timeline.windowSize);
      const visibleIndex = visible.findIndex(message => message.getId() === eventId);
      if (visibleIndex === -1) return;

      if (visibleIndex === visible.length - 1) {
        timeline.grow(1);
        appendEvents(timelineEl, room, [event]);
        markVisibleRoomRead();
      } else {
        scheduleTimelineReconcile();
      }
    });
  });

  // The local-echo counterpart to the onTimeline subscription above: a
  // just-sent message's row is built (by the RoomEvent.Timeline handler
  // above) using its temporary local-echo id, since that's the only id
  // it has at that point. When the server confirms and the SDK swaps in
  // the real event id, RoomEvent.Timeline does NOT fire again for it —
  // RoomEvent.LocalEchoUpdated is the only notification — so without
  // this, the row's data-msg-id (and the receipts/reactions/media ids
  // nested under it) permanently keep the stale local id. That stale id
  // is exactly why Edit could vanish from a freshly-sent message's
  // right-click menu while Reply kept working: Reply just carries
  // whatever id is on the row, but Edit's eligibility check has to
  // actually look the event up by that id first, and nothing in the
  // room's live state matches a local-echo id anymore once the swap has
  // happened. Relabel the row to the real id, then hand off to
  // rerenderMessage() for a full re-render — cheaper than patching every
  // nested id (data-receipts-for, data-reactions-for, each media
  // element's data-event-id) by hand, and it's the same path a live edit
  // already goes through above.
  const offLocalEcho = onLocalEcho((event, evRoom, oldEventId) => {
    if (evRoom?.roomId !== room.roomId) return;
    if (!oldEventId || oldEventId === event.getId()) return;
    const rowEl = timelineEl.querySelector(`.mx-msg[data-msg-id="${CSS.escape(oldEventId)}"]`);
    if (!rowEl) return;
    rowEl.dataset.msgId = event.getId();
    rerenderMessage(event.getId());
  });

  // Receipts move independently of new messages — someone scrolling
  // further down their own timeline emits an m.receipt event, not a new
  // m.room.message, so this needs its own subscription rather than
  // riding along inside the onTimeline handler above.
  //
  // An m.receipt event names only the new position. Refresh both that row
  // and the previous position recorded above; otherwise every advance leaves
  // another "viewed" avatar behind and DMs accumulate one under each message.
  // Falls back to a full visible-window pass for an unexpected event shape.
  const offReceipt = onReceipt((event, evRoom) => {
    if (evRoom?.roomId !== room.roomId) return;
    const content = typeof event?.getContent === 'function' ? event.getContent() : null;
    if (!content || typeof content !== 'object') {
      void hydrateReceipts(timelineEl, room).then(indexRenderedReceiptPositions);
      return;
    }

    const affectedEventIds = new Set();
    let sawPublicReceipt = false;
    for (const [eventId, receiptTypes] of Object.entries(content)) {
      const readers = receiptTypes?.['m.read'];
      if (!readers || typeof readers !== 'object') continue;
      sawPublicReceipt = true;
      affectedEventIds.add(eventId);
      for (const userId of Object.keys(readers)) {
        if (userId === selfId) continue;
        const previousEventId = receiptPositionByUser.get(userId);
        if (previousEventId) affectedEventIds.add(previousEventId);
        receiptPositionByUser.set(userId, eventId);
      }
    }

    // Private-only receipt events are intentionally invisible. An event with
    // no recognizable receipt type is treated as an SDK-shape change.
    if (!sawPublicReceipt) {
      if (Object.values(content).some(types => types && typeof types === 'object' && 'm.read.private' in types)) return;
      void hydrateReceipts(timelineEl, room).then(indexRenderedReceiptPositions);
      return;
    }
    for (const eventId of affectedEventIds) {
      void hydrateReceiptsForEvent(timelineEl, room, eventId);
    }
  });


  // ---- Reactions: right-click quick-react menu + toggle-on-click pills ----
  //
  // The popover itself, the quick-react/reply/edit/image actions it
  // offers, and toggleReaction() all now live in context-menu.js — split
  // out once it had grown large enough to be self-contained (see that
  // file's own header comment). `contextMenu` is declared here (null)
  // but not actually constructed until later in this function, right
  // after fullscreenMedia exists — createContextMenu() needs
  // fullscreenMedia's acquireFullResUrl to resolve full-res image bytes
  // for full-resolution image actions, so it can't be built any
  // earlier than that. Every access above that point goes through the
  // `?.` guard for the same reason emojiBrowser below needs one (onScroll
  // can fire from fillViewportIfNeeded() before either construction
  // runs).
  let contextMenu = null;

  // The full search/category picker opened via the quick-react menu's
  // "+" button (see context-menu.js's openReactionPicker) — a separate
  // widget with its own internal state, so it's created once and just
  // told where to open and what to do with the pick. See emoji-browser.js.
  //
  // Declared here (null) but not actually constructed until later in
  // this function, right after roomViewEl exists — not because it's
  // appended into roomViewEl (it isn't, see the note by
  // createEmojiBrowser's call site below), but because that's the
  // earliest point this function has anything to hand it at all. Every
  // access above that point goes through the `?.` guard for the same
  // reason (onScroll can fire from fillViewportIfNeeded() before that
  // construction runs).
  let emojiBrowser = null;

  // Closes the popover on any click outside it. pointerdown rather than
  // click: fires before the timeline's own click/contextmenu handlers
  // further down, so by the time those run (and possibly open a
  // *different* message's picker) context-menu.js's own pointerdown
  // listener has already closed the old one. This handler only has
  // mentionEl left to worry about — the reaction picker's own
  // outside-click handling now lives inside context-menu.js's own
  // controller (see its destroy()/close()).
  function onDocumentPointerDown(e) {
    // input is excluded here: clicks inside it just reposition the
    // caret, which the input's own 'click' listener above already
    // handles by recomputing (and possibly closing) the menu against
    // the new cursor position — closing it unconditionally here first
    // would just cause a flash-closed-then-reopened flicker.
    if (mentionEl && !mentionEl.contains(e.target) && e.target !== input) closeMentionMenu();
  }
  document.addEventListener('pointerdown', onDocumentPointerDown);

  // Right-click anywhere on a message row opens the quick-react menu at
  // the cursor, Discord-style, instead of needing a dedicated hover
  // button. preventDefault() suppresses the browser's own context menu;
  // stopPropagation() keeps this from also bubbling up to the app-wide
  // right-click menu (e.g. the "Set Background…"/Sidebar/Settings menu)
  // that listens higher up in the tree — without it, right-clicking a
  // message opened both menus at once. Right-clicking empty timeline
  // space (no .mx-msg ancestor) is left completely alone — neither
  // prevented nor stopped — so both the browser's native menu and that
  // app-wide menu keep working there exactly as before.
  function onTimelineContextMenu(e) {
    const msgEl = e.target.closest('.mx-msg');
    if (!msgEl) return;
    e.preventDefault();
    e.stopPropagation();
    const eventId = msgEl.dataset.msgId;
    if (!eventId) return;
    // Right-clicking the same message again while its own picker is
    // already open just re-anchors it to the new cursor position rather
    // than toggling it closed — unlike the old click-a-button model,
    // there's no single fixed spot to click a second time to mean
    // "close", so closing here would just make the menu unreachable via
    // right-click again a second later.
    const imgEl = e.target.closest('img');
    contextMenu?.openReactionPicker(eventId, e.clientX, e.clientY, imgEl);
  }
  timelineEl.addEventListener('contextmenu', onTimelineContextMenu);

  // ---- @mention autocomplete ----
  //
  // Discord-style: typing "@" opens a filtered dropdown of the room's
  // joined members; picking one (click, or Enter/Tab while a match is
  // highlighted) inserts their display name as plain text at the "@"
  // position. The composer itself is still a plain <input> — there's no
  // rich-text/pill widget living inside it — so what actually gets
  // typed and shown while composing is always plain "@DisplayName "
  // text.
  //
  // What makes this a *real* Matrix mention (clickable pill + the
  // recipient's notification/highlight) rather than just text that
  // happens to start with "@" is committedMentions below: every time a
  // pick from this dropdown lands in the input, its exact
  // { userId, offset, length } range is recorded, and that record is
  // kept in sync (shifted or dropped) as the surrounding text keeps
  // changing, right up until send() hands the final ranges to
  // sendTextMessage()/editTextMessage() — see client.js's
  // buildMentionFields() for what it does with them. A mention record
  // is deliberately dropped (not repaired) the moment any edit touches
  // its own range — if the user has typed into the middle of
  // "@Alice ", there's no longer a reliable "this is still Alice"
  // signal, so it reverts to being ordinary text rather than risk
  // silently mis-mentioning someone the text no longer actually names.
  //
  // Follows the exact same "position: fixed popover appended to
  // document.body, closed on outside pointerdown, torn down on
  // unmount" shape as context-menu.js's own popover, for the same
  // reason: roomViewEl's backdrop-filter would otherwise clip a fixed
  // child to its own box instead of the viewport.
  let mentionEl = null;
  let mentionMatches = [];
  let mentionActiveIndex = 0;
  let mentionStart = -1; // index of '@' in input.value, or -1 when no mention is being composed

  // Committed @-mention ranges in the composer's *current* input.value,
  // as { userId, offset, length } triples (length covers "@Name", not
  // the trailing space) — the source of truth handed to
  // sendTextMessage()/editTextMessage() at send time. previousComposerValue
  // is this same value's previous snapshot, needed because every place
  // that sets input.value programmatically (selectMention, emoji
  // insertion, edit/reply seeding+clearing) does so without firing a
  // real 'input' event, so there's no other way to compute what changed
  // since the last time these ranges were valid.
  let committedMentions = [];
  let previousComposerValue = '';

  // Adjusts `mentions` for a single edit of the range [editStart, editEnd)
  // in the *old* text being replaced by `insertedLength` new characters —
  // ranges entirely before the edit are untouched, ranges entirely after
  // are shifted by the resulting length delta, and any range the edit
  // actually overlaps is dropped (see the section comment above on why
  // that's "drop", not "repair").
  function applyEditToMentions(mentions, editStart, editEnd, insertedLength) {
    const delta = insertedLength - (editEnd - editStart);
    const result = [];
    for (const m of mentions) {
      const mEnd = m.offset + m.length;
      if (mEnd <= editStart) {
        result.push(m);
      } else if (m.offset >= editEnd) {
        result.push({ ...m, offset: m.offset + delta });
      }
      // else: the edit overlaps this mention's own range — drop it.
    }
    return result;
  }

  // Diffs two composer values down to a single [editStart, editEnd) →
  // insertedLength edit, via longest-common-prefix / longest-common-
  // suffix — the same trick browsers' own input-diffing uses. This is
  // exact for the ordinary single-point edits a text input actually
  // produces (typing, backspace/delete, paste at the caret, cutting a
  // selection); it's a reasonable-not-exact approximation for something
  // like a full select-all-and-retype, where the true edit region is
  // ambiguous anyway — worst case there, a mention gets dropped instead
  // of shifted, which is the safe direction to be wrong in.
  function diffComposerEdit(oldValue, newValue) {
    const maxPrefix = Math.min(oldValue.length, newValue.length);
    let start = 0;
    while (start < maxPrefix && oldValue[start] === newValue[start]) start++;
    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (oldEnd > start && newEnd > start && oldValue[oldEnd - 1] === newValue[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { editStart: start, editEnd: oldEnd, insertedLength: newEnd - start };
  }

  // Re-syncs committedMentions to input's *current* value and updates
  // previousComposerValue to match. Called after every change to
  // input.value, real or programmatic — see previousComposerValue's own
  // comment above for why programmatic ones can't just rely on the
  // 'input' event.
  function reconcileMentions() {
    const { editStart, editEnd, insertedLength } = diffComposerEdit(previousComposerValue, input.value);
    committedMentions = applyEditToMentions(committedMentions, editStart, editEnd, insertedLength);
    previousComposerValue = input.value;
  }

  // Converts committedMentions (offsets into the *untrimmed* input.value)
  // into offsets into `text` = input.value.trim(), which is what
  // actually gets sent — send() trims, so a mention's offset needs to
  // shift back by however much leading whitespace got trimmed away. Any
  // range that doesn't cleanly fit inside the trimmed text afterward
  // (shouldn't happen, but this is the last checkpoint before the
  // network call) is dropped rather than sent with a wrong range.
  function mentionsForSend(fullValue, mentions) {
    if (mentions.length === 0) return undefined;
    const leadingTrim = fullValue.length - fullValue.trimStart().length;
    const trimmedLength = fullValue.trim().length;
    const result = [];
    for (const m of mentions) {
      const offset = m.offset - leadingTrim;
      if (offset < 0 || offset + m.length > trimmedLength) continue;
      result.push({ userId: m.userId, offset, length: m.length });
    }
    return result.length > 0 ? result : undefined;
  }

  // Search only SDK-loaded members and retain at most eight matches.
  function getMentionCandidates(query) {
    const matches = [];
    for (const userId in room.currentState.members) {
      const member = room.currentState.members[userId];
      if (member.membership !== 'join' || userId === selfId) continue;
      const name = member.name || userId;
      if (name.toLowerCase().includes(query) || userId.toLowerCase().includes(query)) {
        matches.push({ userId, name });
        if (matches.length === 8) break;
      }
    }
    return matches;
  }

  function closeMentionMenu() {
    mentionEl?.remove();
    mentionEl = null;
    mentionMatches = [];
    mentionStart = -1;
  }

  function renderMentionMenu() {
    if (!mentionEl) {
      mentionEl = document.createElement('div');
      // The same popover as the rev/ command list (command-bar.js).
      mentionEl.className = 'mx-palette mx-mention-menu';
      mentionEl.setAttribute('role', 'listbox');
      // mousedown (not click) so this fires before the input would
      // otherwise blur, keeping focus — and the caret position
      // selectMention() reads — right where the user left it.
      mentionEl.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.mx-mention-item');
        if (!btn) return;
        e.preventDefault();
        selectMention(Number(btn.dataset.index));
      });
      document.body.appendChild(mentionEl);
      // Anchored above the composer pill, opening upward — same
      // reasoning as openComposerEmojiPicker's rect handoff below: the
      // composer sits at the bottom of the view, so upward is the only
      // direction with room.
      const rect = composerEl.getBoundingClientRect();
      mentionEl.style.left = `${rect.left}px`;
      mentionEl.style.bottom = `${window.innerHeight - rect.top}px`;
      mentionEl.style.width = `${rect.width}px`;
    }
    mentionEl.innerHTML = `
      <div class="mx-palette-list">
        <div class="mx-palette-heading">Mention</div>
        ${mentionMatches.map((m, i) => `
          <button class="mx-palette-item mx-mention-item${i === mentionActiveIndex ? ' active' : ''}" type="button" data-index="${i}" role="option" aria-selected="${i === mentionActiveIndex}">
            <span class="mx-palette-item-text">
              <span class="mx-palette-item-title">${escapeHtml(m.name)}</span>
              <span class="mx-palette-item-sub">${escapeHtml(m.userId)}</span>
            </span>
            <span class="mx-palette-item-action">Mention</span>
          </button>`).join('')}
      </div>
      <div class="mx-palette-foot">↑↓ choose · Enter or Tab mention · Esc close</div>`;
    mentionEl.querySelector('.mx-palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function selectMention(index) {
    const match = mentionMatches[index];
    if (!match || mentionStart === -1) return;
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(cursor);
    const mentionText = `@${match.name}`;
    const insertion = `${mentionText} `;
    input.value = before + insertion + after;

    // This replaces the [mentionStart, cursor) "@query" the user was
    // typing with `insertion` — shift/drop any already-committed
    // mentions for that edit the same way a real 'input' event would,
    // then record the new one. Doesn't go through reconcileMentions()
    // itself (there's no old-vs-new diffing needed — the edit region is
    // already known exactly), but keeps previousComposerValue in sync
    // so the next real 'input' event diffs from the right baseline.
    committedMentions = applyEditToMentions(committedMentions, mentionStart, cursor, insertion.length);
    committedMentions.push({ userId: match.userId, offset: mentionStart, length: mentionText.length });
    previousComposerValue = input.value;

    closeMentionMenu();
    input.focus();
    const newCursor = before.length + insertion.length;
    input.setSelectionRange(newCursor, newCursor);
  }

  // Re-checks whether the caret currently sits inside an "@query"
  // token and opens/updates/closes the dropdown to match. Run on the
  // input's own 'input'/'click' events rather than only keydown, since
  // keydown fires before the value/caret it needs to inspect has
  // actually changed.
  function updateMentionMenu() {
    const cursor = input.selectionStart ?? input.value.length;
    const textBeforeCursor = input.value.slice(0, cursor);
    // "@" only triggers at the very start of the message or right
    // after whitespace — same rule Discord/Slack use — so an email
    // address or an "@" typed mid-word doesn't pop this open.
    // A rev/ command has its own list (command-bar.js).
    const match = commandBar.active() ? null : /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const query = match[1].toLowerCase();
    mentionStart = cursor - match[1].length - 1;
    if (query.length < 2) { closeMentionMenu(); return; }
    mentionMatches = getMentionCandidates(query);
    if (mentionMatches.length === 0) {
      closeMentionMenu();
      return;
    }
    mentionActiveIndex = Math.min(mentionActiveIndex, mentionMatches.length - 1);
    renderMentionMenu();
  }
  input.addEventListener('input', () => {
    reconcileMentions();
    updateMentionMenu();
  });
  input.addEventListener('click', updateMentionMenu);

  // There's no back button to wire up anymore — the sidebar (rail +
  // channel list) is persistent now, not a view this one replaces and
  // gets replaced by in turn. panel.js's teardownCurrentView() still
  // runs the cleanup this function returns whenever it mounts a
  // different room (or unmounts the panel entirely) in the main pane,
  // so there's exactly one place responsible for tearing this down.

  async function send() {
    if (commandBar.active()) return commandBar.run();
    return composer.run(async assertActive => {
    const text = input.value.trim();
    const attachments = [...composer.pending]; // snapshot — clearPending()/further picks shouldn't affect this in-flight send
    if (!text && attachments.length === 0) return;

    // Editing overrides everything else about this send: an edit is
    // text-only (see startEdit's comment on why), so attachments staged
    // before switching into edit mode are left in the tray rather than
    // silently dropped or sent alongside a m.replace, which the spec
    // doesn't define a meaning for.
    if (editingId) {
      if (!text) return; // an edit can't blank a message out — that's a delete, not an edit
      const targetId = editingId;
      const mentions = mentionsForSend(input.value, committedMentions);
      input.value = '';
      committedMentions = [];
      previousComposerValue = '';
      editingId = null;
      renderComposerContext();
      closeMentionMenu();
      sendBtn.disabled = true;
      try {
        await editTextMessage(room.roomId, targetId, text, mentions ? { mentions } : undefined);
        // No optimistic patch here — the edit event comes back through
        // onTimeline -> rerenderMessage() same as everyone else's edits,
        // so there's no separate local state that could drift from it.
      } catch (err) {
        console.error('[matrix-chat] failed to edit message', err);
      } finally {
        if (!composer.disposed) sendBtn.disabled = false;
      }
      return;
    }

    const replyToEventId = replyingToId;
    replyingToId = null;
    renderComposerContext();

    const mentions = mentionsForSend(input.value, committedMentions);
    input.value = '';
    committedMentions = [];
    previousComposerValue = '';
    composer.take();
    renderTray();
    closeMentionMenu();
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    try {
      if (attachments.length > 0) {
        // Discord-style: the typed text rides along as the caption on the
        // first attachment rather than going out as its own separate
        // message — avoids a redundant text bubble sitting above a batch
        // of files that were clearly meant to go together. Attachments
        // are uploaded/sent one at a time (not Promise.all) so a slow or
        // failing upload doesn't race the others out of order in the
        // timeline.
        let i = 0;
        try {
          for (; i < attachments.length; i++) {
            assertActive();
            const { file } = attachments[i];
            await sendFileMessage(room.roomId, file, {
              caption: i === 0 ? text : undefined,
            });
            composer.release(attachments[i]);
          }
        } finally {
          // If a send failed partway through, anything from i onward
          // (including the one that threw) never got revoked above.
          for (let j = i; j < attachments.length; j++) {
            composer.release(attachments[j]);
          }
        }
      } else {
        const opts = {};
        if (replyToEventId) opts.replyToEventId = replyToEventId;
        if (mentions) opts.mentions = mentions;
        await sendTextMessage(room.roomId, text, Object.keys(opts).length ? opts : undefined);
      }
      // No optimistic append here — the SDK's own timeline event for our
      // own message(s) comes back through onTimeline() same as anyone
      // else's, so renderTimeline() picks it up without special-casing.
    } catch (err) {
      console.error('[matrix-chat] failed to send message', err);
    } finally {
      if (!composer.disposed) {
        sendBtn.disabled = false;
        attachBtn.disabled = false;
      }
    }
    });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // While the mention dropdown is open, arrow keys/Enter/Tab drive
    // its selection instead of their normal composer behavior (moving
    // the caret, sending). Checked first so a highlighted mention
    // always wins over "just send the message" on Enter.
    if (mentionEl) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex + 1) % mentionMatches.length;
        renderMentionMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex - 1 + mentionMatches.length) % mentionMatches.length;
        renderMentionMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionActiveIndex);
        return;
      }
    }
    if (e.key === 'Enter') send();
  });

  function openFilePicker() {
    fileInput.click();
  }

  // Composer emoji button: opens the same full browser as the reaction
  // menu's "+" (see emoji-browser.js), just wired to insert into the
  // text input instead of reacting to a message. Anchored to
  // composerEl (the whole input bar), not emojiBtn itself — the button
  // sits mid-row, well short of the bar's right edge, and anchoring to
  // just the button left both a gap on the right and, since the
  // button's own rect sits inside the bar's padding, less clearance
  // above it than the bar's real top edge gives. right-aligned so the
  // picker's own right edge lines up with the composer's, and the
  // composer sitting at the bottom of the view means this reliably
  // ends up clamped upward by createEmojiBrowser's own on-screen
  // clamping (see open() there) rather than needing separate "open
  // above" logic here.
  function openComposerEmojiPicker() {
    const rect = composerEl.getBoundingClientRect();
    emojiBrowser?.open(rect, insertEmojiIntoInput, { align: 'right' });
  }

  // Inserts at the current cursor position (replacing any selection)
  // rather than always appending to the end, so picking an emoji mid-
  // sentence lands where the user was actually typing. Refocuses the
  // input afterward since opening the picker took focus away from it —
  // without this, the cursor would land in the picker's own search box
  // instead of back in the composer, and a quick follow-up keypress
  // would go nowhere useful.
  function insertEmojiIntoInput(emoji) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    // Same reasoning as selectMention's own commit above: this is a
    // programmatic edit (no 'input' event), so committedMentions/
    // previousComposerValue need the same manual update or an emoji
    // dropped right next to a mention would silently desync the two.
    committedMentions = applyEditToMentions(committedMentions, start, end, emoji.length);
    previousComposerValue = input.value;
    const cursor = start + emoji.length;
    closeMentionMenu();
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }

  function onFileChosen() {
    const files = Array.from(fileInput.files || []);
    // Always clear the input's value, so choosing the exact same file(s)
    // again immediately after still fires a fresh 'change' event
    // (browsers otherwise treat re-selecting an unchanged value as a
    // no-op and never notify us).
    fileInput.value = '';
    if (files.length === 0) return;
    // Stage only — no network call here. Element/Discord-style: the file
    // lands in the tray next to the composer and sits there (with any
    // others already staged) until the user hits Send, so there's a
    // beat to add a caption, drop in more files, or back out of one
    // before anything actually uploads.
    addPendingFiles(files);
  }

  // Drag-and-drop onto the room view is just another way to stage files —
  // routes through the same addPendingFiles()/tray as the file picker, so
  // dropped files get exactly the same "wait for Send" gate rather than
  // uploading on drop.
  const roomViewEl = contentEl.querySelector('.mx-room-view');
  // Constructed here rather than up where it's declared (see that
  // comment) — this is the earliest point in renderRoomView with
  // anything to hand it. Everything that uses emojiBrowser above this
  // line only ever runs from later callbacks (click/scroll/contextmenu
  // handlers), all of which fire after renderRoomView has finished
  // running top to bottom, so by the time any of them can actually reach
  // the browser, this has long since run.
  //
  // Parented to document.body, NOT roomViewEl — same reasoning as
  // reactionPickerEl above: roomViewEl carries the live
  // --mx-room-view-blur/--mx-room-view-opacity backdrop-filter, which
  // creates a new containing block for this panel's own position: fixed
  // popover and would otherwise clamp it inside roomViewEl's box instead
  // of the viewport. emojiBrowser.close() (called from this file's own
  // teardown below) is what actually cleans this up, not parent removal,
  // so being outside roomViewEl changes nothing about its lifecycle.
  emojiBrowser = createEmojiBrowser(document.body);


  function onDragOver(e) {
    e.preventDefault();
    roomViewEl.classList.add('mx-drag-over');
  }
  function onDragLeave(e) {
    if (e.target === roomViewEl) roomViewEl.classList.remove('mx-drag-over');
  }
  function onDrop(e) {
    e.preventDefault();
    roomViewEl.classList.remove('mx-drag-over');
    const files = Array.from(e.dataTransfer?.files || []);
    // --- DEBUG: what does the browser actually hand back for a drop?
    console.log('[onDrop] files:', files.map(f => ({
      name: f.name, size: f.size, type: f.type, ctor: f.constructor?.name,
    })));
    // --- END DEBUG
    if (files.length > 0) addPendingFiles(files);
  }
  roomViewEl.addEventListener('dragover', onDragOver);
  roomViewEl.addEventListener('dragleave', onDragLeave);
  roomViewEl.addEventListener('drop', onDrop);

  // Ctrl+V (Cmd+V) with a file on the clipboard — an image copied from a
  // screenshot tool/browser, or a file copied from Explorer/Finder — stages
  // it exactly like the file picker or a drop (addPendingFiles/tray, wait
  // for Send). A plain text paste has no `kind === 'file'` clipboard items
  // at all, so the check below simply finds nothing and returns without
  // calling preventDefault(), leaving the browser's normal "paste text into
  // the focused input" behavior completely untouched. Scoped to the
  // composer input specifically (not the whole room view) since that's
  // where focus naturally sits while composing — same reasoning as
  // wiring `send` to the input's own keydown rather than something wider.
  function onPaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return; // text (or nothing) — let default paste happen
    e.preventDefault();
    // --- DEBUG: what does the browser actually hand back for a paste?
    console.log('[onPaste] files:', files.map(f => ({
      name: f.name, size: f.size, type: f.type, ctor: f.constructor?.name,
    })));
    // --- END DEBUG
    addPendingFiles(files);
  }
  input.addEventListener('paste', onPaste);

  attachBtn.addEventListener('click', openFilePicker);
  emojiBtn.addEventListener('click', openComposerEmojiPicker);
  fileInput.addEventListener('change', onFileChosen);

  // ── Fullscreen media viewer ──────────────────────────────────────────
  // Lives in its own module (fullscreen-media.js) now that it had grown
  // large enough to carry its own state — see that file's header for why
  // it takes collectMediaNodes/onImageContextMenu as callbacks instead of
  // importing anything back from this file.
  //
  // Every message image and video currently rendered in the timeline, in
  // DOM order — the fullscreen viewer's wheel-nav steps through exactly
  // this list. The fullscreen loader resolves an item's original bytes,
  // so a video can open directly even before its inline player has loaded
  // (inline video deliberately waits for a user action). Re-derived fresh
  // on every open() rather than cached, so it reflects the current render
  // window rather than whatever was mounted initially.
  const fullscreenMedia = createFullscreenMedia({
    room,
    collectMediaNodes: () => Array.from(timelineEl.querySelectorAll('.mx-msg-media')),
    onImageContextMenu: (x, y, url, content) => contextMenu?.openImageOnlyMenu(x, y, url, content),
  });

  // Construct the controller only after fullscreenMedia exists, because its
  // image actions share that controller's full-resolution URL/cache path.
  contextMenu = createContextMenu({
    room,
    selfId,
    findEventById,
    resolveEffectiveContent,
    reactionsForEvent,
    acquireFullResUrl: (ev, node) => fullscreenMedia.acquireFullResUrl(ev, node),
    getEmojiBrowser: () => emojiBrowser,
    onReply: startReply,
    onEdit: startEdit,
  });

  // Video hydration installs a click listener on the <video> itself to
  // lazily fetch and play the inline player. Intercept on the timeline's
  // capture phase so the click opens Atmos fullscreen *before* it reaches
  // that listener; otherwise the inline and fullscreen players each fetch
  // and decode the same attachment.
  function onTimelineVideoCapture(e) {
    const video = e.target.closest('.mx-msg-video');
    if (!video || !timelineEl.contains(video)) return;
    e.preventDefault();
    e.stopPropagation();
    fullscreenMedia.open(video.dataset.eventId);
  }
  timelineEl.addEventListener('click', onTimelineVideoCapture, true);

  function onTimelineClick(e) {
    // A file attachment: frames can't download, so Matrix Chat's main
    // process asks where to save it.
    const attachment = e.target.closest('a[download][href^="blob:"]');
    if (attachment) {
      e.preventDefault();
      void saveAttachment(attachment.href, attachment.getAttribute('download'));
      return;
    }
    const avatar = e.target.closest('.mx-msg-avatar img[src]');
    if (avatar) {
      const userId = avatar.closest('[data-avatar-for]')?.dataset.avatarFor;
      fullscreenMedia.openAvatar(userId, avatar.currentSrc || avatar.src, userId || 'Profile picture');
      return;
    }

    // A reply's quoted-original block: jump to it if it's currently
    // rendered. Not a real navigation (no history-loading to reach a
    // quote further back than the current scroll window) — same
    // "scoped to what's actually on screen" trade-off collectMediaNodes()
    // makes for fullscreen wheel-nav, just applied to scrolling instead.
    const quote = e.target.closest('.mx-msg-reply-quote');
    if (quote) {
      const targetId = quote.dataset.jumpTo;
      const targetRow = targetId && timelineEl.querySelector(`.mx-msg[data-msg-id="${CSS.escape(targetId)}"]`);
      if (targetRow) {
        targetRow.scrollIntoView({ block: 'center' });
        targetRow.classList.add('mx-msg-highlight');
        targetRow.addEventListener('animationend', () => targetRow.classList.remove('mx-msg-highlight'), { once: true });
      }
      return;
    }

    // An existing reaction pill: toggle it (react if it's not yet the
    // local user's, retract if it already is — see toggleReaction()).
    const pill = e.target.closest('.mx-reaction-pill');
    if (pill) {
      const container = pill.closest('[data-reactions-for]');
      const eventId = container?.dataset.reactionsFor;
      if (eventId) contextMenu?.toggleReaction(eventId, pill.dataset.reactionKey);
      return;
    }

    // Videos are first-class fullscreen items too. The fullscreen viewer
    // owns playback controls once opened, matching image click behaviour
    // instead of leaving video messages in the browser's inline player.
    const media = e.target.closest('.mx-msg-image, .mx-msg-video');
    if (!media) return;
    fullscreenMedia.open(media.dataset.eventId);
  }
  timelineEl.addEventListener('click', onTimelineClick);

  // Named (rather than the inline arrow function this used to be) and
  // guarded against a double call: the onAccountChange subscription just
  // below can trigger this itself, ahead of whatever panel.js does with
  // its own copy of this return value when it next swaps views — without
  // the guard, that'd run every one of these teardown steps twice on a
  // switch. Nothing below is unsafe to call twice on its own (removing
  // an already-removed listener, disconnecting an already-disconnected
  // observer, etc are all no-ops), but the guard makes that ambient
  // safety property into a documented one instead of an accident.
  let unmounted = false;

  // Someone here changed their encryption identity (a reset, a new
  // account on the same ID, or a takeover): say so above the message bar
  // until you've seen it, as Element does. OK remembers the new identity.
  const identityEl = contentEl.querySelector('.mx-identity-notice');
  let identityCheck = 0;
  async function refreshIdentityNotice() {
    const check = ++identityCheck;
    const changes = await getIdentityChanges(room);
    if (unmounted || check !== identityCheck) return;
    identityEl.replaceChildren();
    identityEl.hidden = !changes.length;
    if (!changes.length) return;
    const [first] = changes;
    const text = document.createElement('span');
    text.className = 'mx-identity-notice-text';
    text.textContent = (first.wasVerified
      ? `${first.name}'s verified identity has changed. Check with them another way before sharing anything sensitive.`
      : `${first.name}'s identity has changed. That happens when someone resets their encryption, but it can also mean their account was taken over.`)
      + (changes.length > 1 ? ` (${changes.length - 1} more after this)` : '');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'mx-identity-notice-ok';
    ok.textContent = 'OK';
    ok.addEventListener('click', () => {
      ok.disabled = true;
      acceptIdentityChange(first.userId)
        .catch(error => console.warn('[matrix-chat] could not accept the identity change:', error))
        .finally(() => { if (!unmounted) refreshIdentityNotice(); });
    });
    identityEl.append(text, ok);
  }
  const offTrustChange = onTrustChange(() => {
    if (unmounted) return;
    hydrateTrust(timelineEl, room);
    refreshIdentityNotice();
  });
  refreshIdentityNotice();

  function unmount() {
    commandBar.dispose();
    if (unmounted) return;
    unmounted = true;
    timeline.dispose();
    composer.dispose();
    pendingNewEvents = [];
    offTimeline();
    offTimelineReset();
    offDecrypted();
    offLocalEcho();
    offReceipt();
    offAccountChange();
    offTrustChange();
    timelineEl.removeEventListener('click', onTimelineVideoCapture, true);
    timelineEl._suppressScrollCheck = false;
    timelineEl._pendingSuppressCount = 0;
    stickyBottomObserver.disconnect();
    stickyBottomMutationObserver.disconnect();
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    contextMenu?.destroy();
    closeMentionMenu();
    input.removeEventListener('input', updateMentionMenu);
    input.removeEventListener('click', updateMentionMenu);
    emojiBrowser?.close();
    timelineEl.removeEventListener('scroll', onScroll);
    timelineEl.removeEventListener('click', onTimelineClick);
    timelineEl.removeEventListener('contextmenu', onTimelineContextMenu);
    attachBtn.removeEventListener('click', openFilePicker);
    emojiBtn.removeEventListener('click', openComposerEmojiPicker);
    fileInput.removeEventListener('change', onFileChosen);
    roomViewEl.removeEventListener('dragover', onDragOver);
    roomViewEl.removeEventListener('dragleave', onDragLeave);
    roomViewEl.removeEventListener('drop', onDrop);
    window.removeEventListener('focus', onViewingStateChanged);
    document.removeEventListener('visibilitychange', onViewingStateChanged);
    document.documentElement.removeEventListener('pointerenter', onPointerEnter);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    input.removeEventListener('paste', onPaste);
    trayEl.removeEventListener('click', onTrayClick);
    clearPending();
    fullscreenMedia.close();
    // Both of these hold blob: object URLs that nothing else revokes on
    // its own — see revokeAllMediaUrls()'s comment in message-render.js
    // and clearFullResCache()'s above. Without this, every image/video
    // this room's timeline rendered (and every full-res image opened in
    // the fullscreen viewer) this session stays alive in memory for the
    // rest of the tab, even though this view — and every reference to
    // its DOM — is gone.
    revokeAllMediaUrls(timelineEl);
    fullscreenMedia.clearCache();
  }

  // `room` above belongs to whichever client was live when this view was
  // mounted — the moment the account underneath switches, that client is
  // stopped (see client.js's activateSession()) and `room` is a dead
  // reference: no further onTimeline/onLocalEcho/onReceipt event will
  // ever match it again, so without this the composer and timeline would
  // just go silently inert rather than visibly reflecting that the room
  // is gone. Tears itself down immediately (same steps panel.js's own
  // cleanup call would run — see unmount() above) and blanks contentEl,
  // rather than trying to re-mount against the new account's own version
  // of "the room with this id" in place: that room may not exist at all
  // for the new account, and even when it coincidentally does, silently
  // swapping the content under an open composer/scroll position is worse
  // than panel.js visibly deciding what to show next (a room picked from
  // the new account's own room-list, or an empty-state pane) the same
  // way it already does for every other room-to-room transition.
  const offAccountChange = onAccountChange(() => {
    unmount();
    contentEl.innerHTML = '';
  });

  const onViewingStateChanged = () => markVisibleRoomRead();
  const onPointerEnter = () => { pointerInside = true; markVisibleRoomRead(); };
  const onPointerLeave = () => { pointerInside = false; };
  document.documentElement.addEventListener('pointerenter', onPointerEnter);
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('focus', onViewingStateChanged);
  document.addEventListener('visibilitychange', onViewingStateChanged);
  markVisibleRoomRead();

  /** Put text in the message bar (the sidebar's "+" and the like). */
  unmount.fill = commandBar.fill;
  return unmount;
}

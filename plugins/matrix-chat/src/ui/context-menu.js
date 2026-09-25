/**
 * js/plugins/matrix-chat/src/ui/context-menu.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The right-click quick-react/reply/edit/delete popover room-view.js opens on a
 * timeline message (Discord-style), plus the bare "Set as Background" popover
 * the fullscreen viewer opens on a right-click of its own: both share one
 * popover element/lifecycle (at most one open at a time), so they live
 * together here rather than as two half-duplicated widgets. Also owns
 * toggleReaction() (used by the picker's quick-react row, and by
 * room-view.js's own reaction-pill click handler), and the image actions
 * reachable from an image's popover, which share the same
 * full-res-upgrade-past-the-thumbnail step.
 *
 * Split out of room-view.js, which was growing large, once this had become
 * self-contained enough to own its state without reaching back into
 * room-view's closure — except for a few things (composer state for
 * reply/edit, the shared emoji browser, resolving full-res image bytes) that
 * are legitimately room-view's (or fullscreen-media's) concern, not this
 * module's. Those are passed in as constructor params rather than imported
 * directly from room-view.js: room-view.js already imports *this* file, so
 * this file importing anything back out of room-view.js would make the two
 * a circular import. A factory that takes its room-view-specific behaviour
 * as constructor arguments keeps the dependency graph one-way — this module
 * doesn't need to know room-view.js exists at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sendReaction, redactEvent } from './engine.js';
import atmos from 'atmos-sdk';
import { confirmInMenu, tellInMenu } from './menu-dialogs.js';
import { findEventById, resolveEffectiveContent, reactionsForEvent } from './message-render.js';
import { menuIcon } from './menu-icons.js';

// Fixed quick-react set shown in the popover's quick-react row — a
// lightweight stand-in for a full emoji picker/search UI (that's
// getEmojiBrowser()'s "+" button below). Close to Slack's own default
// quick-reaction bar, so it needs no further explanation on sight. Reacting
// with anything outside this set isn't possible from the quick row —
// existing reactions from other clients (any emoji at all, per the Matrix
// spec) still display fine via reactionsForEvent()/renderReactionsHtml() in
// message-render.js, this list only bounds what the quick row itself offers.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏'];

// Creates one context-menu controller, scoped to a single room-view mount
// (i.e. call this once per renderRoomView() call, alongside its other
// per-mount state, not once globally).
//
// Params:
//   - room, selfId: same as room-view.js's own. Fixed for the controller's
//     lifetime.
//   - findEventById, resolveEffectiveContent, reactionsForEvent: re-exported
//     from message-render.js by room-view.js already — passed straight
//     through rather than this module importing them a second time, so
//     there's exactly one copy of each in the bundle.
//   - acquireFullResUrl(ev, node): room-view.js's own fullscreenMedia
//     controller's method of the same name — shares its full-res cache
//     rather than each full-resolution image action re-fetching independently.
//     See fullscreen-media.js's own comment on this method.
//   - getEmojiBrowser(): returns the shared emoji-browser instance (or null
//     before it's constructed). A getter rather than the instance itself
//     since room-view.js doesn't actually construct it until partway
//     through its own mount, after this factory is called — same
//     not-ready-yet gap room-view.js's own emojiBrowser?. accesses guard
//     against.
//   - onReply(eventId), onEdit(eventId): room-view.js's startReply/startEdit
//     — composer state (editingId, replyingToId, the input element itself)
//     that belongs to room-view.js, not this module.
//
// Returns { openReactionPicker, openImageOnlyMenu, toggleReaction, close, destroy }:
//   - openReactionPicker(eventId, x, y, imgEl): opens the full popover
//     (quick-react row + reply/edit/image actions) at viewport coordinates
//     x/y, Discord-style — see room-view.js's onTimelineContextMenu for the
//     entry point. imgEl is whatever <img> (if any) the right-click landed
//     on, so the image-only actions only show up when there's actually an
//     image under the cursor.
//   - openImageOnlyMenu(x, y, url): the bare-bones "Set as Background" popover
//     for right-clicking an image somewhere that isn't a timeline row
//     (currently: room-view.js's fullscreen viewer, via its
//     onImageContextMenu callback). Reuses the same popover element/close
//     handling as openReactionPicker rather than a second tracked popover —
//     there's still only ever one of these open at a time.
//   - toggleReaction(eventId, key): reacts (or retracts the local user's
//     existing reaction) with this emoji key. Exposed because room-view.js's
//     reaction-pill click handler needs the exact same toggle the popover's
//     quick-react row uses.
//   - close(): closes the popover if one is open; safe to call when none is.
//     Call this (not destroy()) from anywhere that just wants the popover
//     out of the way — e.g. room-view.js's onScroll, since position: fixed
//     would otherwise drift from its anchor as the timeline scrolls under it.
//   - destroy(): currently just close() — kept as its own call (rather than
//     having room-view.js's unmount() call close() directly) so this
//     controller's "end of lifecycle" and "dismiss whatever's open" call
//     sites stay textually distinct even though they do the same thing
//     today. Core's openMenu() (js/core/context-menu.js) owns the outside-
//     click/Escape listeners now, scoped to each menu instance, so there's
//     nothing construction-time left for this to tear down.
export function createContextMenu({
  room,
  selfId,
  findEventById,
  resolveEffectiveContent,
  reactionsForEvent,
  acquireFullResUrl,
  getEmojiBrowser,
  onReply,
  onEdit,
}) {
  // The popover itself — at most one open at a time (opening a second one,
  // via either entry point, replaces the first rather than stacking).
  // Built via Core's openMenu() (js/core/context-menu.js), which appends
  // straight to document.body itself — the same "don't let roomViewEl's
  // backdrop-filter clip/reposition a fixed popover" reasoning that used to
  // be handled here by hand is now Core's problem to solve once, for every
  // plugin's menus, rather than each plugin re-solving it. Positioning,
  // viewport clamping, and outside-click/Escape close are all Core's too;
  // this module only ever supplies *what's in* the popover.
  // Whether a menu this view opened is still up (close() is called on
  // every scroll, so it only asks Atmos when there is one).
  let openMenus = 0;
  function open(x, y, items, what) {
    openMenus++;
    atmos.contextMenu.open(x, y, items)
      .catch(error => console.error(`[matrix-chat] ${what} menu:`, error))
      .finally(() => { openMenus--; });
  }
  function close() {
    if (openMenus > 0) atmos.contextMenu.close().catch(() => {});
  }

  // No optimistic pill update here, on purpose — same reasoning
  // room-view.js's send() gives for not optimistically appending a
  // just-sent message: the resulting m.reaction/m.room.redaction event
  // comes back through room-view.js's own onTimeline handler (every other
  // client's reactions arrive the exact same way), which re-derives every
  // pill on screen from the room's actual state, so there's no separate
  // "local" state here that could ever drift from it.
  async function toggleReaction(eventId, key) {
    const existing = reactionsForEvent(room, eventId, selfId).find(r => r.key === key);
    try {
      if (existing?.mine) {
        await redactEvent(room.roomId, existing.myEventId);
      } else {
        await sendReaction(room.roomId, eventId, key);
      }
    } catch (err) {
      console.error('[matrix-chat] reaction toggle failed', err);
    }
  }

  // Resolves the real image bytes behind a timeline <img> (which only ever
  // holds a small preview — see message-render.js's hydrateMedia) for the
  // two actions below that need the actual attachment rather than a 400×400
  // thumbnail. Matches eventId against imgEl's own dataset the same way
  // fullscreen-media.js's collectMediaNodes/open() do, so this only
  // upgrades when imgEl really is that event's own rendered image — an
  // inline emoji, a link-preview image, etc. has no such full-res source to
  // upgrade to, and is used as-is.
  async function resolveImageUrl(eventId, imgEl) {
    const ev = room.findEventById(eventId);
    const content = ev?.getContent();
    let url = imgEl.currentSrc || imgEl.src;
    let release = () => {};
    if (ev && content?.msgtype === 'm.image' && imgEl.dataset.eventId === eventId) {
      const lease = await acquireFullResUrl(ev, imgEl).catch(() => null);
      if (lease) { url = lease.url; release = lease.release; }
    }
    return { url, content, release };
  }

  // Applies a chat image as the app-wide Atmos background — NOT anything
  // scoped to this plugin's own panel (there's no such thing; room-view.js's
  // --mx-room-view-opacity/-blur are a completely separate, plugin-local
  // concept). Goes through the same setBgFromFile() the Settings background
  // upload and the Ctrl+Shift+V paste shortcut both use (see index.html), so
  // this behaves identically to — and shares the one persisted store with —
  // every other way of setting the background.
  async function setBackgroundFromImage(eventId, imgEl) {
    if (!imgEl) return;
    let release = () => {};
    try {
      const resolved = await resolveImageUrl(eventId, imgEl);
      release = resolved.release;
      const { url, content } = resolved;
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `${eventId}-background`, {
        type: blob.type || content?.info?.mimetype || 'image/png',
      });
      await atmos.wallpaper.set(file);
    } catch (err) {
      console.log('[bg] failed to set chat image as background:', err.message);
    } finally { release(); }
  }

  // Same resolved-URL step as setBackgroundFromImage, for openImageOnlyMenu
  // below, whose caller (fullscreen-media.js's onImageContextMenu) already
  // hands over a resolved, ready-to-use image URL rather than an eventId +
  // <img> pair, so there's no upgrade-past-the-thumbnail step left to do
  // here.
  async function setBackgroundFromUrl(source) {
    let release = () => {};
    try {
      const lease = typeof source === 'function' ? await source() : { url: source, release };
      release = lease.release;
      const url = lease.url;
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'chat-image-background', { type: blob.type || 'image/png' });
      await atmos.wallpaper.set(file);
    } catch (err) {
      console.log('[bg] failed to set chat image as background:', err.message);
    } finally { release(); }
  }

  async function deleteMessage(eventId, x, y) {
    const ok = await confirmInMenu(x, y, 'Delete this message?', 'Delete Message', menuIcon('delete'));
    if (!ok) return;
    try {
      await redactEvent(room.roomId, eventId);
    } catch (err) {
      console.error('[matrix-chat] failed to delete message', eventId, err);
      tellInMenu(x, y, `Couldn't delete that message: ${err.message || err}`);
    }
  }

  function attachmentFilename(content, blob, fallback = 'chat-image') {
    const inferredExt = (blob?.type?.split('/')[1] || 'png').split('+')[0];
    const name = content?.filename || content?.body || `${fallback}.${inferredExt}`;
    const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
    // Matrix body is sometimes a caption rather than a filename. Preserve
    // any real extension (including video formats), otherwise derive one
    // from the media bytes.
    return /\.[a-z0-9]{1,12}$/i.test(safeName)
      ? safeName
      : `${safeName}.${inferredExt}`;
  }

  function mediaMimeType(bytes, declaredType) {
    // Media downloads retain their declared type. Only images need signature
    // sniffing, because Matrix avatar/object URLs can lose it.
    return declaredType?.startsWith('video/')
      ? declaredType
      : imageMimeType(bytes, declaredType);
  }

  async function withResolvedImage(source, content, action) {
    let release = () => {};
    try {
      const lease = typeof source === 'function' ? await source() : { url: source, release };
      release = lease.release || release;
      const response = await fetch(lease.url);
      if (!response.ok) throw new Error(`Image download failed (${response.status})`);
      return await action(await response.blob());
    } finally {
      release();
    }
  }

  async function downloadImage(source, content) {
    try {
      await withResolvedImage(source, content, async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mimeType = mediaMimeType(bytes, blob.type || content?.info?.mimetype);
        const typedBlob = new Blob([bytes], { type: mimeType });
        // Frames can't start downloads; Matrix Chat's main process asks
        // where to save and writes the file.
        await atmos.invoke('plugin:matrix-chat', 'save-file', { name: attachmentFilename(content, typedBlob), bytes });
      });
    } catch (err) {
      console.error('[matrix-chat] failed to download full-resolution image:', err);
    }
  }

  async function clipboardReadyBlob(blob, content) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mimeType = imageMimeType(bytes, blob.type || content?.info?.mimetype);
    const typedBlob = new Blob([bytes], { type: mimeType });
    // Chromium's image clipboard contract is reliably PNG. Preserve PNGs as
    // is; decode every other supported Matrix image format onto a canvas.
    if (mimeType === 'image/png') return typedBlob;
    const bitmap = await createImageBitmap(typedBlob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('Could not encode clipboard image')),
        'image/png',
      ));
    } finally {
      bitmap.close();
    }
  }

  async function copyImage(source, content) {
    try {
      // A menu choice leaves focus on the Atmos page, so Atmos writes the
      // clipboard for this frame.
      const png = await withResolvedImage(source, content, blob => clipboardReadyBlob(blob, content));
      await atmos.clipboard.writeImage(png);
    } catch (err) {
      console.error('[matrix-chat] failed to copy full-resolution image:', err);
    }
  }

  // Authenticated Matrix downloads do not always preserve Content-Type when
  // they are passed through an object URL (avatars are the common case). Read
  // the file signature so downstream importers see an image, not a generic
  // octet-stream/plain file.
  function imageMimeType(bytes, declaredType) {
    if (declaredType?.startsWith('image/')) return declaredType;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF8')) return 'image/gif';
    if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (String.fromCharCode(...bytes.slice(4, 12)).includes('ftypavif')) return 'image/avif';
    const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart();
    if (prefix.startsWith('<svg') || prefix.startsWith('<?xml') && prefix.includes('<svg')) return 'image/svg+xml';
    return 'image/png';
  }

  // x/y are viewport coordinates (straight from the triggering MouseEvent)
  // rather than an anchor element, since a right-click can land anywhere in
  // the message row, not just on a dedicated button. imgEl is whatever <img>
  // (if any) the right-click actually landed on — passed through from
  // room-view.js's onTimelineContextMenu — so the image-only actions below
  // only show up when there's an actual image under the cursor, not for
  // every right-click in a row that happens to contain one somewhere.
  function openReactionPicker(eventId, x, y, imgEl = null) {
    // Edit is only offered on the local user's own text/emote messages —
    // editing someone else's message isn't something the Matrix spec
    // supports (an m.replace from a different sender than the original is
    // invalid per editsForEvent()'s own check), and media/file edits aren't
    // handled by this UI (see room-view.js's startEdit()).
    const ev = findEventById(room, eventId);
    const { content: currentContent } = ev ? resolveEffectiveContent(ev, room) : { content: null };
    const canEdit = !!ev && ev.getSender() === selfId
      && (currentContent?.msgtype === 'm.text' || currentContent?.msgtype === 'm.emote');
    // Use the SDK's room-state permission check rather than limiting this to
    // the sender: moderators may redact other people's events when the room's
    // power levels allow it. Pending local echoes and already-redacted events
    // are rejected by this check too, so the menu never offers a dead action.
    const canDelete = !!ev && !!room.currentState?.maySendRedactionForEvent?.(ev, selfId);

    // The quick-react row: a row of buttons at the top of the menu, the
    // last opening the full emoji browser where the menu was.
    const quickRow = {
      type: 'buttons',
      id: 'quick-react',
      buttons: [
        ...QUICK_REACTIONS.map(key => ({ id: `react:${key}`, label: key, run: () => toggleReaction(eventId, key) })),
        {
          id: 'react-more', label: 'More emoji…', icon: menuIcon('plus'),
          run: () => getEmojiBrowser()?.open(new DOMRect(x, y, 0, 0), emoji => toggleReaction(eventId, emoji)),
        },
      ],
    };

    const items = [
      quickRow,
      { type: 'separator' },
      { id: 'reply', label: 'Reply', icon: menuIcon('reply'), run: () => onReply(eventId) },
      canEdit && { id: 'edit', label: 'Edit', icon: menuIcon('edit'), run: () => onEdit(eventId) },
      canDelete && { id: 'delete', label: 'Delete Message', icon: menuIcon('delete'), run: () => deleteMessage(eventId, x, y) },
      imgEl && { id: 'download', label: 'Download', icon: menuIcon('download'), run: () => downloadImage(() => resolveImageUrl(eventId, imgEl), currentContent) },
      imgEl && { id: 'copy-image', label: 'Copy Image', icon: menuIcon('copy'), run: () => copyImage(() => resolveImageUrl(eventId, imgEl), currentContent) },
      imgEl && { id: 'set-bg', label: 'Set as Background', icon: menuIcon('background'), run: () => setBackgroundFromImage(eventId, imgEl) },
    ].filter(Boolean);

    open(x, y, items, 'message');
  }

  // A bare-bones one-item version of openReactionPicker, for right-clicking
  // an image somewhere that isn't a timeline message row (currently: the
  // fullscreen viewer, via fullscreen-media.js's onImageContextMenu
  // callback). Just another openMenu() call — Core already guarantees only
  // one of these (or openReactionPicker's) is ever open at a time, and it
  // gets the same "click outside closes it" handling for free.
  function openImageOnlyMenu(x, y, url, content) {
    const isImage = content?.msgtype !== 'm.video';
    const items = [
      { id: 'download', label: 'Download', icon: menuIcon('download'), run: () => downloadImage(url, content) },
      isImage && { id: 'copy-image', label: 'Copy Image', icon: menuIcon('copy'), run: () => copyImage(url, content) },
      isImage && { id: 'set-bg', label: 'Set as Background', icon: menuIcon('background'), run: () => setBackgroundFromUrl(url) },
    ].filter(Boolean);
    open(x, y, items, 'image');
  }

  // Outside-click/Escape close, and closing an old popover when a new one
  // (from either entry point above) opens, are all Core's openMenu()'s job
  // now — nothing left here to wire or tear down for that.
  function destroy() {
    close();
  }

  return { openReactionPicker, openImageOnlyMenu, toggleReaction, close, destroy };
}

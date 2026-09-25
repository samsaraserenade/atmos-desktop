import { fetchMediaBytes, fetchAvatarBytes, decryptAttachmentFile } from './engine.js';
import { MediaUrlCache } from '../media-url-cache.js';
import atmos from 'atmos-sdk';

const { createFullscreenViewer } = await import(await atmos.library('service:fullscreen-viewer', 'index.js'));

// Full-resolution URLs have a byte budget independent of raw/decrypted buffers.
// The selected image is leased until navigation/close; oversized idle images
// are released immediately. Small neighbours may be prefetched, one at a time.
const MAX_NEIGHBOUR_BYTES = 8 * 1024 * 1024;

export function createFullscreenMedia({ room, collectMediaNodes, onImageContextMenu }) {
  const cache = new MediaUrlCache({ maxBytes: 64 * 1024 * 1024, maxEntries: 12 });
  let fsViewer = null;
  let fsOverlayEl = null;
  let selectedLease = null;
  let selection = 0;

  function close() {
    selection++;
    fsViewer?.close();
    fsViewer?.destroy();
    fsViewer = null;
    fsOverlayEl?.remove();
    fsOverlayEl = null;
    selectedLease?.release();
    selectedLease = null;
    document.removeEventListener('keydown', onFsKeydown);
  }

  function onFsKeydown(event) {
    if (event.key === 'Escape') close();
  }

  // Callers must release after consuming the URL, including failed save/import
  // operations. Shared requests each receive their own lease.
  function acquireFullResUrl(ev, node) {
    const content = ev.getContent();
    const key = JSON.stringify([ev.getId(), content.file || content.url]);
    return cache.acquire(key, async () => {
      // A fullscreen video may be opened before its lazy inline player has
      // received a src. Its Matrix content is still sufficient to resolve
      // the original attachment, so do not require a hydrated DOM node.
      const bytes = content.file
        ? await decryptAttachmentFile(content.file)
        : await fetchMediaBytes(content.url);
      return new Blob([bytes], { type: content.info?.mimetype || '' });
    });
  }

  function clearCache() {
    close();
    cache.clear();
  }

  function open(eventId) {
    const nodes = collectMediaNodes();
    if (!nodes.some(node => node.dataset.eventId === eventId)) return;
    close();
    // Keep gallery order and preview URLs stable. Only the selected DOM image
    // is upgraded; cached full-res URLs never become unleased gallery entries.
    const items = nodes.map(node => ({
      id: node.dataset.eventId,
      url: node.currentSrc || node.src,
      kind: node.tagName === 'VIDEO' ? 'video' : 'image',
      alt: node.alt || '',
    }));
    const nodesById = new Map(nodes.map(node => [node.dataset.eventId, node]));
    const overlay = document.createElement('div');
    fsOverlayEl = overlay;
    overlay.className = 'mx-fs-overlay';
    overlay.innerHTML = '<div class="mx-fs-media" id="mx-fs-media"></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    const mediaSlot = overlay.querySelector('#mx-fs-media');

    async function prefetchNeighbours(item, token) {
      const index = items.indexOf(item);
      for (const neighbour of [items[index + 1], items[index - 1]]) {
        if (token !== selection || overlay !== fsOverlayEl) return;
        if (!neighbour || neighbour.kind !== 'image') continue;
        const ev = room.findEventById(neighbour.id);
        const size = ev?.getContent()?.info?.size;
        // Unknown or large uploads are fetched only when selected.
        if (!Number.isFinite(size) || size <= 0 || size > MAX_NEIGHBOUR_BYTES) continue;
        try {
          const lease = await acquireFullResUrl(ev, nodesById.get(neighbour.id));
          lease.release();
        } catch { /* A speculative neighbour must never block browsing. */ }
      }
    }

    async function showSelected(item) {
      const token = ++selection;
      selectedLease?.release();
      selectedLease = null;
      if (!item || (item.kind !== 'image' && item.kind !== 'video')) return;
      const ev = room.findEventById(item.id);
      if (!ev) return;
      try {
        const lease = await acquireFullResUrl(ev, nodesById.get(item.id));
        if (token !== selection || overlay !== fsOverlayEl) {
          lease.release();
          return;
        }
        const media = mediaSlot.querySelector(item.kind === 'video' ? 'video' : 'img');
        if (!media) { lease.release(); return; }
        selectedLease = lease;
        // Updating src preserves the viewer's existing shift-wheel zoom state.
        media.src = lease.url;
        if (item.kind === 'video') {
          media.load();
          media.play().catch(() => {});
        } else {
          void prefetchNeighbours(item, token);
        }
      } catch (error) {
        // The preview stays visible; navigating back retries failed downloads.
        if (token === selection) console.error('[matrix-chat] full-resolution image failed', error);
      }
    }

    fsViewer = createFullscreenViewer(mediaSlot, {
      wheelCooldownMs: 350,
      zoomMin: 1,
      zoomMax: 6,
      zoomSensitivity: 0.0015,
      onOpen: item => { void showSelected(item); },
      onNavigate: item => { void showSelected(item); },
    });
    fsViewer.open(items, eventId);
    mediaSlot.addEventListener('contextmenu', event => {
      const media = event.target.closest('img, video');
      if (!media) return;
      event.preventDefault();
      // The host app installs its own contextmenu handler higher in the DOM.
      // Cancelling the browser default alone does not stop that handler, so
      // keep this fullscreen-image menu from being replaced by the app menu.
      event.stopPropagation();
      const item = fsViewer.current();
      const ev = item && room.findEventById(item.id);
      // The preview can still be visible while full resolution downloads.
      // Acquire a separate lease on action, so saving always uses the original
      // and remains valid even if the viewer navigates or closes meanwhile.
      const source = ev ? () => acquireFullResUrl(ev, nodesById.get(item.id)) : media.currentSrc || media.src;
      onImageContextMenu(event.clientX, event.clientY, source, ev?.getContent());
    });
    document.addEventListener('keydown', onFsKeydown);
  }

  // Opens a sender avatar through the same viewer as message media, but as a
  // one-item gallery. The small inline thumbnail paints immediately and is
  // replaced with the original avatar bytes once the authenticated download
  // finishes.
  function openAvatar(userId, previewUrl, alt = '') {
    if (!userId || !previewUrl) return;
    close();
    const overlay = document.createElement('div');
    fsOverlayEl = overlay;
    overlay.className = 'mx-fs-overlay';
    overlay.innerHTML = '<div class="mx-fs-media" id="mx-fs-media"></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    const mediaSlot = overlay.querySelector('#mx-fs-media');
    const acquireAvatar = () => cache.acquire(`avatar:${userId}`, async () =>
      new Blob([await fetchAvatarBytes(userId, null)]));

    async function upgradeAvatar() {
      const token = ++selection;
      try {
        const lease = await acquireAvatar();
        if (token !== selection || overlay !== fsOverlayEl) {
          lease.release();
          return;
        }
        const img = mediaSlot.querySelector('img');
        if (!img) { lease.release(); return; }
        selectedLease = lease;
        img.src = lease.url;
      } catch (error) {
        if (token === selection) console.error('[matrix-chat] full-resolution avatar failed', error);
      }
    }

    fsViewer = createFullscreenViewer(mediaSlot, {
      wheelCooldownMs: 350,
      zoomMin: 1,
      zoomMax: 6,
      zoomSensitivity: 0.0015,
      onOpen: () => { void upgradeAvatar(); },
    });
    fsViewer.open([{ id: `avatar:${userId}`, url: previewUrl, kind: 'image', alt }], `avatar:${userId}`);
    mediaSlot.addEventListener('contextmenu', event => {
      if (!event.target.closest('img')) return;
      event.preventDefault();
      event.stopPropagation();
      onImageContextMenu(event.clientX, event.clientY, acquireAvatar);
    });
    document.addEventListener('keydown', onFsKeydown);
  }

  return { open, openAvatar, close, acquireFullResUrl, clearCache };
}

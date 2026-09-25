/**
 * services/fullscreen-viewer/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A small, app-agnostic engine for fullscreen media: the wheel steps to the
 * next or previous item in a flat list, and Shift+wheel zooms towards the
 * cursor on whichever image or video is showing.
 *
 * Two layers:
 * - findMedia() / applyZoom() are stateless helpers with no listener of
 *   their own. A caller that already owns navigation passes in the media
 *   element, the wheel event and its own current zoom, and gets the new
 *   zoom back. The caller keeps the zoom state.
 * - createFullscreenViewer() wraps those and its own wheel navigation into
 *   one instance bound to a container: for a caller that wants the whole
 *   open / navigate / zoom / close lifecycle in one place. A caller with its
 *   own wheel listener should use the helpers instead, so zoom isn't
 *   applied twice per wheel tick.
 *
 * Deliberately doesn't know about:
 * - what the items are (messages, library files…). Callers hand it
 *   [{ id, url, kind, alt? }] and are told which id is current through
 *   callbacks; anything outside the media slot stays in the caller's code.
 * - history or persistence; a caller that wants either does it in its own
 *   onOpen / onNavigate.
 * - the chrome around the media (backdrop, sidebar, close button, Escape).
 *   The instance only ever touches the one container it's given: it puts
 *   a single <img> or <video> there and listens for wheel events on it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** The <img> or <video> currently rendered under `root`, if any. */
export function findMedia(root) {
  return root ? root.querySelector('img, video') : null;
}

/**
 * One zoom step: sets a cursor-anchored transform-origin and a
 * multiplicative scale from `currentZoom` on `media`, and returns the new
 * zoom. Stateless: the caller owns the zoom level and resets it to 1 when a
 * new item shows.
 *
 * transform-origin is re-derived from the live rect on every tick, with no
 * correction for earlier steps: CSS resolves transform-origin percentages
 * against the untransformed layout box, and a pure scale() keeps the point
 * at the origin fixed on screen, so the point under the cursor stays put.
 *
 * Negative deltaY (scrolling up) zooms in; positive zooms out. At zoomMin
 * the transform is cleared rather than left as scale(1), so object-fit's
 * own centring isn't fighting a redundant transform.
 */
export function applyZoom(media, e, currentZoom, { zoomMin, zoomMax, zoomSensitivity }) {
  if (!media) return currentZoom;

  const rect = media.getBoundingClientRect();
  if (rect.width && rect.height) {
    const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const yPct = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    media.style.transformOrigin = `${xPct}% ${yPct}%`;
  }

  const factor = Math.exp(-e.deltaY * zoomSensitivity);
  const zoom = clamp(currentZoom * factor, zoomMin, zoomMax);
  media.style.transform = zoom === zoomMin ? '' : `scale(${zoom})`;
  return zoom;
}

/**
 * A viewer bound to `containerEl`, owning wheel navigation and zoom.
 *
 * Options:
 * - wheelCooldownMs: the minimum gap between wheel steps, so one physical
 *   scroll (many small wheel events) doesn't skip a dozen items.
 * - zoomMin / zoomMax / zoomSensitivity: Shift+wheel zoom bounds and curve.
 * - onOpen(item): after open() shows the first item.
 * - onNavigate(item): after a wheel step shows a new item — the caller's cue
 *   to update anything outside the container that depends on it.
 * - onClose(): from close(); the caller still hides whatever wraps the container.
 */
export function createFullscreenViewer(containerEl, options) {
  const {
    wheelCooldownMs,
    zoomMin,
    zoomMax,
    zoomSensitivity,
    onOpen,
    onNavigate,
    onClose,
  } = options;

  let items = [];
  let currentId = null;
  let zoom = 1;
  let cooldownTimer = null;

  function current() {
    return items.find(i => i.id === currentId) || null;
  }

  function isOpen() {
    return currentId !== null;
  }

  // Built as elements, not markup: an item's url and alt are only ever
  // property values, so nothing in them can become HTML.
  function render() {
    const item = current();
    if (!item) return;
    const doc = containerEl.ownerDocument;
    let media;
    if (item.kind === 'video') {
      media = doc.createElement('video');
      media.controls = true;
      media.autoplay = true;
      media.muted = true;
      media.preload = 'metadata';
    } else {
      media = doc.createElement('img');
      media.alt = item.alt ? String(item.alt) : '';
    }
    media.src = String(item.url ?? '');
    containerEl.replaceChildren(media);
  }

  /** Opens `list` (a snapshot [{ id, url, kind, alt? }]) at `startId`, at 1x.
   *  Call again if the list changes while open. */
  function open(list, startId) {
    items = Array.isArray(list) ? list : [];
    currentId = startId;
    zoom = 1;
    render();
    onOpen?.(current());
  }

  function close() {
    currentId = null;
    items = [];
    onClose?.();
  }

  function onWheel(e) {
    if (!isOpen()) return;
    if (e.ctrlKey) return; // a pinch-zoom gesture, not a scroll

    if (e.shiftKey) {
      e.preventDefault();
      zoomAt(e);
      return;
    }

    e.preventDefault();
    if (cooldownTimer) return;

    const delta = e.deltaY;
    if (!delta) return;

    const idx = items.findIndex(i => i.id === currentId);
    if (idx === -1) return;

    const nextIdx = idx + (delta > 0 ? 1 : -1);
    if (nextIdx < 0 || nextIdx >= items.length) return; // stops at the ends

    cooldownTimer = setTimeout(() => { cooldownTimer = null; }, wheelCooldownMs);

    currentId = items[nextIdx].id;
    zoom = 1;
    render();
    onNavigate?.(current());
  }

  /** Zoom this instance's current media, keeping the zoom level here. */
  function zoomAt(e) {
    const media = findMedia(containerEl);
    if (!media) return;
    zoom = applyZoom(media, e, zoom, { zoomMin, zoomMax, zoomSensitivity });
  }

  containerEl.addEventListener('wheel', onWheel, { passive: false });

  /** Detaches the wheel listener; call from the caller's own teardown. */
  function destroy() {
    containerEl.removeEventListener('wheel', onWheel);
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  return { open, close, isOpen, current, destroy };
}

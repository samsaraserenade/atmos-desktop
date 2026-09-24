/**
 * File drops onto framed extensions.
 *
 * A frame can't learn a dropped file's path on disk (Electron only tells
 * the Atmos page, through the preload's getPathForFile). So when a drag
 * carrying files enters a frame whose surface declared "fileDrops": true,
 * the frame tells Core (the SDK does this), and Core lays a transparent
 * drop target over that frame in the Atmos page. The rest of the drag
 * lands on the overlay; on drop Core resolves the paths and hands the frame
 * { paths, files, data, x, y }. The overlay goes away on drop, when the
 * drag leaves, or when the drag stops arriving.
 */

const IDLE_MS = 1500;           // no dragover for this long: the drag ended elsewhere
const DATA_TYPES = ['text/uri-list', 'text/plain', 'text/html'];

let _overlay = null;
let _target = null;             // { iframe, deliver(topic, payload) }
let _idleTimer = null;

function _hide(reason) {
  clearTimeout(_idleTimer);
  _idleTimer = null;
  if (_overlay) _overlay.hidden = true;
  const target = _target;
  _target = null;
  if (target && reason) target.deliver('fileDrag', { state: 'leave', reason });
}

function _touch() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _hide('idle'), IDLE_MS);
}

function _pathFor(file) {
  try { return window.atmos?.getPathForFile?.(file) || ''; } catch { return ''; }
}

function _ensureOverlay() {
  if (_overlay) return _overlay;
  _overlay = document.createElement('div');
  _overlay.id = 'atmos-extension-drop-overlay';
  _overlay.hidden = true;
  Object.assign(_overlay.style, { position: 'fixed', zIndex: '2147483000', background: 'transparent' });
  _overlay.addEventListener('dragenter', event => { event.preventDefault(); _touch(); });
  _overlay.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    _touch();
  });
  _overlay.addEventListener('dragleave', event => {
    // Leaving the overlay itself (not moving between its own pixels).
    const rect = _overlay.getBoundingClientRect();
    const inside = event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom;
    if (!inside) _hide('left');
  });
  _overlay.addEventListener('drop', event => {
    event.preventDefault();
    const target = _target;
    const transfer = event.dataTransfer;
    if (!target || !transfer) { _hide('dropped'); return; }
    const files = [...(transfer.files || [])];
    const rect = target.iframe.getBoundingClientRect();
    const data = {};
    for (const type of DATA_TYPES) {
      const value = transfer.getData(type);
      if (value) data[type] = value;
    }
    target.deliver('fileDrop', {
      paths: files.map(_pathFor),
      files,
      types: [...(transfer.types || [])],
      data,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    _hide('dropped');
  });
  window.addEventListener('dragend', () => _hide('ended'), true);
  document.body.appendChild(_overlay);
  return _overlay;
}

/**
 * Called when a frame reports a file drag entering it. `deliver(topic,
 * payload)` posts to that frame. Returns false when the frame isn't
 * visible (nothing to cover).
 */
export function armFileDrop(iframe, deliver) {
  const rect = iframe?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !iframe.isConnected) return false;
  const overlay = _ensureOverlay();
  if (_target && _target.iframe !== iframe) _hide('moved');
  Object.assign(overlay.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  overlay.hidden = false;
  if (!_target) deliver('fileDrag', { state: 'over' });
  _target = { iframe, deliver };
  _touch();
  return true;
}

/** Drop any overlay for this frame (it is going away). */
export function disarmFileDrop(iframe) {
  if (_target?.iframe === iframe) _hide(null);
}

/**
 * Atmos's keyboard shortcuts on its page, in one place.
 *
 * Atmos's own keys (keymap.mjs, group 'atmos') are taken here, in the
 * capture phase, before anything else on the page sees them: pressed on
 * Atmos's page, handed over by a frame (its SDK takes them before the
 * extension's code and posts them as `ui.key`, which the frame host
 * dispatches on `document`), or taken from a web page by Core
 * (web-policy.cjs → web-layer.js → `atmos:shortcut`). Whoever owns one
 * registers with onShortcut().
 *
 * Escape is one stack: each layer that Escape closes registers with
 * onEscape(), and one press closes the topmost open one only (a menu over
 * Settings closes the menu, not both).
 */
import { atmosKeyFor } from './keymap.mjs';

const _handlers = new Map();
const _escapeLayers = new Set();

/** Run `fn(event)` when Atmos's key `id` ('switcher', 'sidebar'…) is pressed. */
export function onShortcut(id, fn) {
  _handlers.set(id, fn);
  return () => { if (_handlers.get(id) === fn) _handlers.delete(id); };
}

/** Run Atmos's key `id` as if pressed (a web page's, the command bar's). */
export function runShortcut(id, event = null) {
  const fn = _handlers.get(id);
  if (!fn) return false;
  fn(event);
  return true;
}

/**
 * A layer Escape closes: { priority, isOpen(), close(event) }. Higher
 * priorities are on top. Returns a function that removes it.
 */
export function onEscape(layer) {
  _escapeLayers.add(layer);
  return () => _escapeLayers.delete(layer);
}

/** The open layer Escape would close now, or null. */
export function topEscapeLayer() {
  let top = null;
  for (const layer of _escapeLayers) {
    let open = false;
    try { open = !!layer.isOpen(); } catch { open = false; }
    if (open && (!top || layer.priority > top.priority)) top = layer;
  }
  return top;
}

// Keys typed in the command bar are its own (Esc there clears, then closes it).
const _ownEscape = target => !!target?.closest?.('#command-bar-field, #command-bar-list, #sidebar-footer.is-commanding');

document.addEventListener('keydown', event => {
  const id = atmosKeyFor(event);
  if (id) {
    event.preventDefault();
    event.stopImmediatePropagation();
    // Held down, only the switcher moves on; the rest would flicker.
    if (event.repeat && id !== 'switcher') return;
    runShortcut(id, event);
    return;
  }
  if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (event.defaultPrevented || _ownEscape(event.target)) return;
  const layer = topEscapeLayer();
  if (!layer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  layer.close(event);
}, true);

window.addEventListener('atmos:shortcut', event => runShortcut(String(event.detail?.id || '')));

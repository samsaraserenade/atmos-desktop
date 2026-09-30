/**
 * The browser's shortcuts while one of its own frames has focus (the
 * address bar, the tab strip). While a page has focus, Core takes the same
 * keys before the page sees them (web-policy.cjs shortcutFor) and sends the
 * command; this is the same table for a KeyboardEvent. None of these keys
 * edits text, so they are the browser's in the address bar too.
 */
export function commandFor(event) {
  if (!event || event.isComposing) return null;
  const ctrl = !!(event.ctrlKey || event.metaKey);
  const key = String(event.key || '');
  const lower = key.toLowerCase();
  if (ctrl && !event.altKey) {
    if (lower === 'l') return 'focus-address';
    if (lower === 't') return event.shiftKey ? 'reopen-tab' : 'new-tab';
    if (lower === 'n' && event.shiftKey) return 'new-private-tab';
    if (lower === 'w' || key === 'F4') return 'close-tab';
    if (key === 'Tab') return event.shiftKey ? 'previous-tab' : 'next-tab';
    if (key === 'PageDown') return 'next-tab';
    if (key === 'PageUp') return 'previous-tab';
    if (/^[1-8]$/.test(key)) return `tab-${key}`;
    if (key === '9') return 'last-tab';
    if (lower === 'r') return event.shiftKey ? 'hard-reload' : 'reload';
    if (lower === 'f') return 'find';
    if (lower === 'd' && !event.shiftKey) return 'bookmark';
    if (lower === 'h' && !event.shiftKey) return 'history';
    if (lower === 'j' && !event.shiftKey) return 'downloads';
    if (key === '+' || key === '=') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    if (lower === 'p' && !event.shiftKey) return 'print';
  }
  if (!ctrl && !event.altKey && key === 'F5') return event.shiftKey ? 'hard-reload' : 'reload';
  if (!ctrl && !event.altKey && !event.shiftKey && key === 'F6') return 'focus-address';
  if (event.altKey && !ctrl && !event.shiftKey && key === 'ArrowLeft') return 'back';
  if (event.altKey && !ctrl && !event.shiftKey && key === 'ArrowRight') return 'forward';
  return null;
}

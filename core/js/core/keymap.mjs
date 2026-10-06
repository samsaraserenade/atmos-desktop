/**
 * Every keyboard shortcut Atmos and Atmos Browser answer, in one table: what
 * Atmos's page listens for (sidebar-shell.js, task-view.js, command-bar.js),
 * what a frame hands over before its extension's own code sees it (the SDK,
 * from `atmosKeys` in its init), what Core takes before a web page sees it
 * (web-policy.cjs shortcutFor, which requires this file), and what Settings →
 * Atmos lists. Plain data and pure functions, for the page and for Node.
 *
 * A binding's `match`:
 *   ctrl   Ctrl (or Cmd on a Mac) held; must be exactly so
 *   alt    Alt held; must be exactly so (AltGr is Ctrl+Alt, so never ours)
 *   shift  true / false: must be so; left out: either
 *   keys   KeyboardEvent.key values (letters in lower case match either case)
 *   codes  KeyboardEvent.code values (a physical key, whatever it types)
 *
 * Groups:
 *   atmos    Atmos's own, from anywhere: its page, any frame (even while
 *            typing; an extension never sees them), any web page.
 *   browser  Atmos Browser's, in its panel and its pages.
 */

const BACKQUOTE = Object.freeze({ codes: ['Backquote'], keys: ['`'] });
// The \ | key: US \, UK's left of Z (IntlBackslash, whose key some layouts
// report as 'Unidentified').
const BACKSLASH = Object.freeze({ codes: ['IntlBackslash'], keys: ['\\', '|'] });

const binding = (id, group, label, display, match, extra = {}) => Object.freeze({
  id, group, label, display, match: Object.freeze({ ...match }), ...extra,
});

export const BINDINGS = Object.freeze([
  // ── Atmos ──
  binding('switcher', 'atmos', 'Switch panels (hold Alt, press ` again to move on)', 'Alt+`',
    { alt: true, ctrl: false, shift: false, ...BACKQUOTE }),
  binding('command-bar', 'atmos', 'Command bar', 'Alt+\\',
    { alt: true, ctrl: false, ...BACKSLASH }),
  binding('settings', 'atmos', 'Open or close Settings', 'Ctrl+`',
    { ctrl: true, alt: false, shift: false, ...BACKQUOTE }, { command: 'settings' }),
  // Shifted, the key types ~ (US) or ¬ (UK), or is a dead key elsewhere.
  binding('sidebar', 'atmos', 'Open or close the sidebar', 'Ctrl+Shift+`',
    { ctrl: true, alt: false, shift: true, codes: ['Backquote'], keys: ['`', '~', '¬'] }, { command: 'sidebar' }),

  // ── Atmos Browser ──
  binding('focus-address', 'browser', 'Go to the address bar', 'Ctrl+L, F6', { ctrl: true, alt: false, keys: ['l'] }),
  binding('focus-address-f6', 'browser', null, null, { ctrl: false, alt: false, shift: false, keys: ['F6'] }, { command: 'focus-address' }),
  binding('new-tab', 'browser', 'New tab', 'Ctrl+T', { ctrl: true, alt: false, shift: false, keys: ['t'] }),
  binding('reopen-tab', 'browser', 'Reopen the last closed tab', 'Ctrl+Shift+T', { ctrl: true, alt: false, shift: true, keys: ['t'] }),
  binding('new-private-tab', 'browser', 'New private tab', 'Ctrl+Shift+N', { ctrl: true, alt: false, shift: true, keys: ['n'] }),
  binding('close-tab', 'browser', 'Close the tab', 'Ctrl+W', { ctrl: true, alt: false, keys: ['w', 'F4'] }),
  binding('next-tab', 'browser', 'Next tab', 'Ctrl+Tab', { ctrl: true, alt: false, shift: false, keys: ['Tab'] }),
  binding('previous-tab', 'browser', 'Previous tab', 'Ctrl+Shift+Tab', { ctrl: true, alt: false, shift: true, keys: ['Tab'] }),
  binding('next-tab-page', 'browser', null, null, { ctrl: true, alt: false, keys: ['PageDown'] }, { command: 'next-tab' }),
  binding('previous-tab-page', 'browser', null, null, { ctrl: true, alt: false, keys: ['PageUp'] }, { command: 'previous-tab' }),
  ...['1', '2', '3', '4', '5', '6', '7', '8'].map(digit => binding(`tab-${digit}`, 'browser',
    digit === '1' ? 'Go to tab 1 to 8' : null, digit === '1' ? 'Ctrl+1…8' : null, { ctrl: true, alt: false, keys: [digit] })),
  binding('last-tab', 'browser', 'Go to the last tab', 'Ctrl+9', { ctrl: true, alt: false, keys: ['9'] }),
  binding('reload', 'browser', 'Reload the page', 'Ctrl+R, F5', { ctrl: true, alt: false, shift: false, keys: ['r'] }),
  binding('reload-f5', 'browser', null, null, { ctrl: false, alt: false, shift: false, keys: ['F5'] }, { command: 'reload' }),
  binding('hard-reload', 'browser', 'Reload without the cache', 'Ctrl+Shift+R, Shift+F5', { ctrl: true, alt: false, shift: true, keys: ['r'] }),
  binding('hard-reload-f5', 'browser', null, null, { ctrl: false, alt: false, shift: true, keys: ['F5'] }, { command: 'hard-reload' }),
  binding('back', 'browser', 'Back', 'Alt+←', { ctrl: false, alt: true, shift: false, keys: ['ArrowLeft'] }),
  binding('forward', 'browser', 'Forward', 'Alt+→', { ctrl: false, alt: true, shift: false, keys: ['ArrowRight'] }),
  binding('find', 'browser', 'Find in the page', 'Ctrl+F', { ctrl: true, alt: false, keys: ['f'] }),
  binding('bookmark', 'browser', 'Bookmark the page', 'Ctrl+D', { ctrl: true, alt: false, shift: false, keys: ['d'] }),
  binding('history', 'browser', 'History', 'Ctrl+H', { ctrl: true, alt: false, shift: false, keys: ['h'] }),
  binding('downloads', 'browser', 'Downloads', 'Ctrl+J', { ctrl: true, alt: false, shift: false, keys: ['j'] }),
  binding('zoom-in', 'browser', 'Zoom in', 'Ctrl++', { ctrl: true, alt: false, keys: ['+', '='] }),
  binding('zoom-out', 'browser', 'Zoom out', 'Ctrl+−', { ctrl: true, alt: false, keys: ['-', '_'] }),
  binding('zoom-reset', 'browser', 'Actual size', 'Ctrl+0', { ctrl: true, alt: false, keys: ['0'] }),
  binding('print', 'browser', 'Print', 'Ctrl+P', { ctrl: true, alt: false, shift: false, keys: ['p'] }),
]);

/** The command a binding runs: its own `command`, else its id. */
export const commandOf = item => item.command || item.id;

/**
 * Whether a key event is a binding's. Takes a KeyboardEvent (or its init) or
 * Electron's before-input-event Input (control/alt/shift/meta).
 */
export function matches(item, event) {
  if (!item || !event) return false;
  const m = item.match;
  const ctrl = !!(event.ctrlKey ?? event.control) || !!(event.metaKey ?? event.meta);
  const alt = !!(event.altKey ?? event.alt);
  const shift = !!(event.shiftKey ?? event.shift);
  if (ctrl !== !!m.ctrl || alt !== !!m.alt) return false;
  if (m.shift !== undefined && shift !== m.shift) return false;
  const key = String(event.key ?? '');
  if (m.codes?.includes(String(event.code ?? ''))) return true;
  return !!m.keys?.some(k => k === key || (k.length === 1 && k === key.toLowerCase()));
}

/** The first binding of `group` (or any group) an event is, or null. */
export function bindingFor(event, group = null) {
  for (const item of BINDINGS) {
    if ((!group || item.group === group) && matches(item, event)) return item;
  }
  return null;
}

/** The id of Atmos's own binding an event is ('switcher', 'sidebar'…), or null. */
export function atmosKeyFor(event) {
  return bindingFor(event, 'atmos')?.id || null;
}

/** Atmos's bindings as plain data, for a frame's SDK (its init's `atmosKeys`). */
export function atmosKeysForFrames() {
  return BINDINGS.filter(item => item.group === 'atmos').map(item => ({ id: item.id, ...item.match }));
}

/** Keys Settings lists that aren't in the table above (each is handled where it acts). */
const OTHER_ROWS = Object.freeze({
  atmos: [
    { id: 'reload-frame', label: 'Reload what has the keyboard: a panel, a web page, or Atmos', display: 'Ctrl+R' },
    { id: 'escape', label: 'Close what\u2019s on top: a menu, the switcher, Settings', display: 'Esc' },
  ],
});

/** Commands without a key, listed with the keys (command-list.js has them). */
export const KEYLESS_COMMANDS = Object.freeze([
  { command: 'rev/sidebar-side', label: 'Move the sidebar to the other side' },
  { command: 'rev/wallpaper paste', label: 'Use the copied image as the wallpaper' },
  { command: 'rev/reload', label: 'Reload Atmos' },
]);

/** What Settings → Atmos lists: [{ group, title, rows: [{ id, label, display }] }]. */
export function shortcutSections() {
  const titles = { atmos: 'Atmos', browser: 'Atmos Browser' };
  return Object.keys(titles).map(group => ({
    group,
    title: titles[group],
    rows: [
      ...BINDINGS.filter(item => item.group === group && item.display).map(item => ({ id: item.id, label: item.label, display: item.display })),
      ...(OTHER_ROWS[group] || []),
    ],
  }));
}

/** A display string as keys to draw: 'Ctrl+L, F6' → [['Ctrl', 'L'], ['F6']]; 'Ctrl++' → [['Ctrl', '+']]. */
export function displayKeys(display) {
  return String(display || '').split(', ').map(alternative => alternative.split(/\+(?=.)/));
}

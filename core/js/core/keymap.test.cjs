'use strict';
// Every shortcut Atmos and Atmos Browser answer (keymap.mjs): no key is two
// things, Atmos's never type, the browser panel's own table agrees with
// Core's, and Settings lists them.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('./keymap.mjs');

// Every way a binding's own keys can be pressed: each key and code under
// every set of modifiers.
function* presses(keymap) {
  const keys = new Set(), codes = new Set();
  for (const item of keymap.BINDINGS) {
    for (const key of item.match.keys || []) { keys.add(key); keys.add(key.toUpperCase()); }
    for (const code of item.match.codes || []) codes.add(code);
  }
  for (const ctrlKey of [false, true]) for (const altKey of [false, true]) for (const shiftKey of [false, true]) {
    for (const key of keys) yield { key, code: '', ctrlKey, altKey, shiftKey, metaKey: false };
    for (const code of codes) yield { key: 'Unidentified', code, ctrlKey, altKey, shiftKey, metaKey: false };
  }
}

test('no key press is two shortcuts', async () => {
  const keymap = await load();
  for (const event of presses(keymap)) {
    const hits = keymap.BINDINGS.filter(item => keymap.matches(item, event)).map(item => item.id);
    assert.ok(hits.length <= 1, `${JSON.stringify(event)}: ${hits.join(', ')}`);
  }
});

test('Atmos\'s keys are Ctrl or Alt chords, never AltGr, and never a key that types alone', async () => {
  const keymap = await load();
  const atmos = keymap.BINDINGS.filter(item => item.group === 'atmos');
  assert.deepEqual(atmos.map(item => `${item.id} ${item.display}`), [
    'switcher Alt+`', 'command-bar Alt+\\', 'settings Ctrl+`', 'sidebar Ctrl+Shift+`',
  ]);
  for (const item of atmos) {
    assert.ok(item.match.ctrl !== item.match.alt, `${item.id}: Ctrl or Alt, not both (AltGr types)`);
  }
  assert.equal(keymap.atmosKeyFor({ key: '`', code: 'Backquote', altKey: true }), 'switcher');
  assert.equal(keymap.atmosKeyFor({ key: '`', code: 'Backquote', metaKey: true }), 'settings', 'Cmd on a Mac');
  assert.equal(keymap.atmosKeyFor({ key: '¬', code: 'Backquote', ctrlKey: true, shiftKey: true }), 'sidebar');
  assert.equal(keymap.atmosKeyFor({ key: '\\', code: 'IntlBackslash', altKey: true }), 'command-bar');
  assert.equal(keymap.atmosKeyFor({ key: 'Tab', code: 'Tab', ctrlKey: true }), null, 'Ctrl+Tab is the browser\'s tabs, no longer Task View');
  assert.equal(keymap.atmosKeyFor({ key: 'Tab', code: 'Tab' }), null, 'Tab is never Atmos\'s');
  assert.equal(keymap.atmosKeyFor({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+V is paste as plain text');
  // Electron's Input names its modifiers otherwise.
  assert.equal(keymap.atmosKeyFor({ key: '`', code: 'Backquote', control: true, shift: true }), 'sidebar');
});

test('what a frame is given matches as the table does', async () => {
  const keymap = await load();
  const forFrames = keymap.atmosKeysForFrames();
  assert.deepEqual(forFrames.map(m => m.id), ['switcher', 'command-bar', 'settings', 'sidebar']);
  assert.deepEqual(JSON.parse(JSON.stringify(forFrames)), forFrames, 'plain data (posted to the frame)');
});

test('Atmos Browser\'s own table (its panel\'s keys) agrees with Core\'s (its pages\' keys)', async () => {
  const keymap = await load();
  const { commandFor } = await import('../../../plugins/browser/src/shortcuts.js');
  let compared = 0;
  for (const event of presses(keymap)) {
    for (const metaKey of [false, true]) {
      const press = { ...event, ctrlKey: event.ctrlKey && !metaKey, metaKey: metaKey && event.ctrlKey };
      const core = keymap.bindingFor(press, 'browser');
      assert.equal(commandFor(press), core ? keymap.commandOf(core) : null, JSON.stringify(press));
      compared += 1;
    }
  }
  assert.ok(compared > 500);
});

test('Settings lists every shortcut once, with the commands that have none', async () => {
  const keymap = await load();
  const sections = keymap.shortcutSections();
  assert.deepEqual(sections.map(section => section.title), ['Atmos', 'Atmos Browser']);
  const atmos = sections[0].rows.map(row => row.display);
  assert.deepEqual(atmos, ['Alt+`', 'Alt+\\', 'Ctrl+`', 'Ctrl+Shift+`', 'Ctrl+R', 'Esc']);
  for (const row of sections.flatMap(section => section.rows)) assert.ok(row.label && row.display, row.id);
  const browser = sections[1].rows.map(row => row.id);
  assert.ok(browser.includes('new-tab') && browser.includes('tab-1') && !browser.includes('tab-2'), 'Ctrl+1…8 is one row');
  assert.deepEqual(keymap.KEYLESS_COMMANDS.map(item => item.command), ['rev/sidebar-side', 'rev/wallpaper paste', 'rev/reload']);
  assert.deepEqual(keymap.displayKeys('Ctrl+L, F6'), [['Ctrl', 'L'], ['F6']]);
  assert.deepEqual(keymap.displayKeys('Ctrl++'), [['Ctrl', '+']]);
  assert.deepEqual(keymap.displayKeys('Alt+\\'), [['Alt', '\\']]);
});

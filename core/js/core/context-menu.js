/**
 * Core workspace context-menu controller, plus the generalized transient-menu
 * primitive (openMenu) any plugin can use for its own per-target right-click
 * menus (an album row, a chat message, a library tile, ...) instead of
 * hand-building its own popover + CSS. Both share the same row renderer and
 * the same frosted-glass chrome (.ctx-menu-surface / .ctx-item / .ctx-sep /
 * .ctx-item-meta, defined once in index.html) — a plugin only ever supplies
 * *what* the menu contains, never how it looks or positions itself.
 */

import { listContextMenuItems } from './context-menu-registry.js';

const menu = document.getElementById('ctx-menu');
const extensionItems = document.getElementById('ctx-extension-items');

// ── Shared row rendering ─────────────────────────────────────────────────────
// One item shape for both the workspace menu's registry-contributed items and
// any transient openMenu() call: { id?, label, icon?, run?, type? }.
//   - type: 'separator' — a thin divider, no label/run.
//   - type: 'heading'   — a non-interactive section label.
//   - type: 'toggle'    — checked, run(checked).
//   - type: 'range'     — min, max, step, value, format(value), run(value).
//   - type: 'number'    — min, max, step, value, suffix, run(value).
//   - type: 'text'      — value, placeholder, maxLength; Enter runs
//                         run(value) with the trimmed text and closes the
//                         menu (closeOnChange: false keeps it open).
//   - type: 'select'    — options [{value, label}], value, run(value).
//   - type: 'colors'    — values, onPickerActive(active), run(values).
//   - type: 'meta'      — a non-interactive info row (icon + label, no click).
//   - type: 'buttons'   — a row of small buttons (an emoji, an icon):
//                         buttons [{ id, label, icon?, title?, run() }];
//                         a click runs that button and closes the menu.
//   - (default)          — a clickable action row; run() is awaited, then
//                           closeFn() is called (before running, on any
//                           thrown/rejected error the row still closes so a
//                           failure can't leave a stuck-open menu).
//                           hold: true asks for a press and hold (a bar
//                           fills the row) before it runs, for destructive
//                           actions; tone: 'danger' draws it in the
//                           semantic negative colour.
// How long a hold-to-confirm row ({ hold: true }) must be held.
const HOLD_MS = 900;

function renderMenuRow(container, entry, closeFn) {
  if (entry.type === 'separator') {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    container.appendChild(sep);
    return;
  }
  if (entry.type === 'heading') {
    const heading = document.createElement('div');
    heading.className = 'ctx-lbl';
    heading.textContent = entry.label ?? '';
    container.appendChild(heading);
    return;
  }
  if (entry.type === 'buttons') {
    const row = document.createElement('div');
    row.className = 'ctx-buttons';
    if (entry.id) row.dataset.contextMenuItem = entry.id;
    for (const button of entry.buttons || []) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'ctx-button';
      if (button.id) element.dataset.contextMenuItem = button.id;
      if (button.icon) element.innerHTML = button.icon;
      else element.textContent = button.label ?? '';
      const title = button.title || (button.icon ? button.label : '');
      if (title) { element.title = title; element.setAttribute('aria-label', title); }
      element.addEventListener('click', async event => {
        event.stopPropagation();
        closeFn();
        try { await button.run?.(); }
        catch (error) { console.error('[context-menu] button failed:', button.id || button.label, error); }
      });
      row.appendChild(element);
    }
    container.appendChild(row);
    return;
  }
  const row = document.createElement('div');
  const interactiveControl = ['toggle', 'range', 'number', 'text', 'select', 'colors'].includes(entry.type);
  row.className = 'ctx-item'
    + (entry.type === 'meta' ? ' ctx-item-meta' : '')
    + (interactiveControl ? ' ctx-control-row' : '');
  if (entry.id) row.dataset.contextMenuItem = entry.id;
  row.innerHTML = `${entry.icon || ''}<span class="ctx-lbl2"></span>`;
  row.querySelector('.ctx-lbl2').textContent = entry.label ?? '';
  const runControl = async (value, kind = entry.type) => {
    try { await entry.run?.(value); }
    catch (error) { console.error(`[context-menu] ${kind} action failed:`, entry.id || entry.label, error); }
  };
  const keepControlEvent = event => event.stopPropagation();

  if (entry.type === 'toggle') {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'ctx-control-toggle';
    toggle.checked = !!entry.checked;
    toggle.setAttribute('aria-label', entry.label || 'Toggle setting');
    toggle.addEventListener('click', keepControlEvent);
    toggle.addEventListener('change', async event => {
      event.stopPropagation();
      if (entry.closeOnChange === true) closeFn();
      await runControl(toggle.checked);
    });
    row.appendChild(toggle);
  } else if (entry.type === 'range') {
    const range = document.createElement('input');
    range.type = 'range';
    if (entry.min != null) range.min = entry.min;
    if (entry.max != null) range.max = entry.max;
    if (entry.step != null) range.step = entry.step;
    range.value = entry.value ?? entry.min ?? 0;
    range.setAttribute('aria-label', entry.label || 'Adjust setting');
    const value = document.createElement('output');
    value.className = 'ctx-control-value';
    const renderValue = numericValue => {
      value.value = String(numericValue);
      value.textContent = typeof entry.format === 'function'
        ? entry.format(numericValue)
        : String(numericValue);
    };
    renderValue(Number(range.value));
    range.addEventListener('click', keepControlEvent);
    range.addEventListener('input', async event => {
      event.stopPropagation();
      const numericValue = Number(range.value);
      renderValue(numericValue);
      await runControl(numericValue);
    });
    range.addEventListener('change', event => {
      event.stopPropagation();
      if (entry.closeOnChange === true) closeFn();
    });
    row.append(range, value);
  } else if (entry.type === 'number') {
    const control = document.createElement('span');
    control.className = 'ctx-control-number';
    const number = document.createElement('input');
    number.type = 'number';
    if (entry.min != null) number.min = entry.min;
    if (entry.max != null) number.max = entry.max;
    if (entry.step != null) number.step = entry.step;
    number.value = entry.value ?? '';
    number.setAttribute('aria-label', entry.label || 'Enter a number');
    control.appendChild(number);
    if (entry.suffix) {
      const suffix = document.createElement('span');
      suffix.textContent = entry.suffix;
      control.appendChild(suffix);
    }
    number.addEventListener('click', keepControlEvent);
    number.addEventListener('change', async event => {
      event.stopPropagation();
      const numericValue = Number(number.value);
      if (!Number.isFinite(numericValue)) return;
      if (entry.closeOnChange === true) closeFn();
      await runControl(numericValue);
    });
    row.appendChild(control);
  } else if (entry.type === 'text') {
    const control = document.createElement('span');
    control.className = 'ctx-control-text';
    const text = document.createElement('input');
    text.type = 'text';
    text.value = entry.value ?? '';
    text.spellcheck = false;
    if (entry.placeholder) text.placeholder = entry.placeholder;
    if (Number.isFinite(entry.maxLength)) text.maxLength = entry.maxLength;
    text.setAttribute('aria-label', entry.label || 'Enter text');
    control.appendChild(text);
    text.addEventListener('click', keepControlEvent);
    text.addEventListener('keydown', async event => {
      event.stopPropagation();
      if (event.key === 'Escape') { closeFn(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = text.value.trim();
      if (entry.closeOnChange !== false) closeFn();
      await runControl(value);
    });
    row.appendChild(control);
  } else if (entry.type === 'select') {
    const select = document.createElement('select');
    select.setAttribute('aria-label', entry.label || 'Choose an option');
    select.style.cssText = 'margin-left:auto;max-width:160px;min-width:0;padding:3px 5px;border:1px solid rgba(var(--ink-rgb),.18);border-radius:4px;background:rgba(var(--ink-rgb),.06);color:inherit;font:inherit';
    for (const option of entry.options || []) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = entry.value ?? '';
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', async event => {
      event.stopPropagation();
      const value = select.value;
      if (entry.closeOnChange !== false) closeFn();
      await runControl(value);
    });
    row.appendChild(select);
  } else if (entry.type === 'colors') {
    const colors = document.createElement('span');
    colors.className = 'ctx-control-colors';
    const inputs = (entry.values || []).map((color, index) => {
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = color;
      picker.setAttribute('aria-label', `${entry.label || 'Colour'} ${index + 1}`);
      picker.addEventListener('click', keepControlEvent);
      picker.addEventListener('pointerdown', () => entry.onPickerActive?.(true));
      picker.addEventListener('focus', () => entry.onPickerActive?.(true));
      picker.addEventListener('blur', () => entry.onPickerActive?.(false));
      picker.addEventListener('input', async event => {
        event.stopPropagation();
        await runControl(inputs.map(input => input.value));
      });
      picker.addEventListener('change', event => {
        event.stopPropagation();
        entry.onPickerActive?.(false);
        if (entry.closeOnChange === true) closeFn();
      });
      colors.appendChild(picker);
      return picker;
    });
    row.appendChild(colors);
  } else if (entry.type !== 'meta' && typeof entry.run === 'function') {
    const runRow = async () => {
      closeFn();
      try { await entry.run(); }
      catch (error) { console.error(`[context-menu] '${entry.id || entry.label}' failed:`, error); }
    };
    if (entry.hold === true) {
      // Press and hold: a bar fills across the row, and the action runs
      // when it's full. Letting go (or leaving the row) first cancels.
      row.classList.add('ctx-item-hold');
      row.style.setProperty('--ctx-hold-ms', `${HOLD_MS}ms`);
      const hint = document.createElement('span');
      hint.className = 'ctx-hold-hint';
      hint.textContent = 'Hold';
      row.appendChild(hint);
      let timer = null;
      const cancel = () => {
        clearTimeout(timer);
        timer = null;
        row.classList.remove('ctx-holding');
      };
      row.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        cancel();
        row.classList.add('ctx-holding');
        timer = setTimeout(() => { timer = null; row.classList.remove('ctx-holding'); runRow(); }, HOLD_MS);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) row.addEventListener(type, cancel);
      row.addEventListener('click', event => event.stopPropagation());
    } else {
      row.addEventListener('click', async event => {
        event.stopPropagation();
        await runRow();
      });
    }
  }
  if (entry.tone === 'danger') row.classList.add('ctx-item-danger');
  container.appendChild(row);
}

function positionAt(el, x, y) {
  el.style.cssText = 'left:0;top:0;visibility:hidden';
  el.classList.add('visible');
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  el.style.left = `${x + width > innerWidth - 8 ? x - width : x}px`;
  el.style.top = `${y + height > innerHeight - 8 ? y - height : y}px`;
  el.style.visibility = '';
}

// ── Core's own workspace menu (right-click on empty workspace) ──────────────
// Static, additive contributions from context-menu-registry.js, rendered
// alongside the two built-in Sidebar/Settings rows already in index.html.

function renderExtensionItems() {
  if (!extensionItems) return;
  extensionItems.innerHTML = '';
  for (const item of listContextMenuItems()) {
    renderMenuRow(extensionItems, item, closeContextMenu);
  }
}

export function openContextMenu(x, y) {
  if (!menu) return;
  renderExtensionItems();
  menu.classList.remove('visible');
  positionAt(menu, x, y);
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
}

export function closeContextMenu() {
  menu?.classList.remove('visible');
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
}

document.addEventListener('contextmenu', event => {
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeContextMenu();
});

document.querySelectorAll('.ctx-panel').forEach(panel => {
  panel.addEventListener('click', event => event.stopPropagation());
  panel.addEventListener('mousedown', event => event.stopPropagation());
});

document.addEventListener('click', event => {
  if (menu?.contains(event.target)) return;
  const request = new CustomEvent('atmos:before-context-menu-close', { cancelable: true });
  window.dispatchEvent(request);
  if (!request.defaultPrevented) closeContextMenu();
});

// ── Transient, per-target menus ──────────────────────────────────────────────
// For a plugin's own right-click menu on a specific thing it owns — an album
// row, a chat message, a library tile — where the item list depends on
// *what* was clicked, not a fixed global contribution. Unlike the workspace
// menu above, each call builds and tears down its own element; only one such
// menu is ever open at a time (opening a second closes the first).
//
// items: array of { id?, label, icon?, run?, type? } — see renderMenuRow.
// opts.before: an optional, already-wired HTMLElement prepended above the
//   items (e.g. a row of quick-reaction buttons) — the caller owns its
//   markup and listeners entirely; openMenu only positions and hosts it.
// opts.className: extra class(es) on the menu surface, for a plugin that
//   needs a wider/narrower menu than the 250–260px default.
// opts.owner: what opened it (an extension's <iframe>), see openMenuOwner().
// opts.onClose: called when the menu closes for ANY reason (item click,
//   outside click, Escape, or a new openMenu() call replacing this one) —
//   for a plugin that mirrors "is a menu open" into its own state (e.g. to
//   suppress a keyboard shortcut while the menu is up).
//
// Returns { element, close }. Calling the returned close() is idempotent.
let _openMenu = null;

export function closeOpenMenu() {
  _openMenu?.close();
}

/** What opened the current menu (opts.owner), e.g. an extension's frame. */
export function openMenuOwner() {
  return _openMenu?.owner ?? null;
}

export function openMenu(x, y, items, opts = {}) {
  closeOpenMenu();

  const el = document.createElement('div');
  el.className = 'ctx-menu-surface' + (opts.className ? ` ${opts.className}` : '');
  if (opts.before) el.appendChild(opts.before);
  if (opts.title) renderMenuRow(el, { type: 'heading', label: opts.title }, () => close());
  for (const entry of items || []) renderMenuRow(el, entry, () => close());
  document.body.appendChild(el);
  positionAt(el, x, y);
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));

  function close() {
    if (_openMenu?.element !== el) return;
    el.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKeydown, true);
    _openMenu = null;
    window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
    opts.onClose?.();
  }
  function onOutside(event) { if (!el.contains(event.target)) close(); }
  function onKeydown(event) { if (event.key === 'Escape') close(); }
  // pointerdown (capture), not click: fires before whatever's under the
  // pointer reacts to its own click/contextmenu, so opening a second menu
  // (or clicking through to something else) doesn't fight this one for
  // ordering — same contract the plugins this replaces already relied on.
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKeydown, true);

  _openMenu = { element: el, close, owner: opts.owner ?? null };
  return { element: el, close };
}

/**
 * Atmos's command bar: rev/ commands, typed. Ctrl+\ (from anywhere: Atmos's
 * page, an extension's frame, a web page in Atmos Browser) opens it; Ctrl+\
 * or Esc closes it. Where it opens (Settings → Appearance → Command Bar):
 *
 *   panel (the default)  over the bottom bar of the panel you're in, when
 *       the panel says where its bar is (atmos.commands.bar), else as a bar
 *       of Atmos's own along the panel's bottom. The list rises above it,
 *       as wide as the panel.
 *   sidebar   the sidebar's footer row (ATMOS · Version) becomes the field;
 *       a closed sidebar opens with it and closes again after.
 *
 * Commands are Atmos's own and those extensions declare (SDK 1.3), listed
 * by what's showing; what's offered for what's typed is command-list.js.
 * An extension's command runs in its own frame (extension-frame-host.js
 * requestExtensionCommand): what's typed after its name goes to it alone,
 * and what it sends back is cleaned and shown as text. ↑↓ choose, Enter
 * runs (or completes a command that needs more), Tab completes, Esc clears
 * and then closes. Shift+Enter runs an extension's command and goes to its
 * panel; Alt+Enter runs it where you are (runExtensionCommand).
 *
 * A frame can open the bar with text (rev/ typed in a field of its own),
 * and keys typed there before the bar had the keyboard follow while nothing
 * has been typed in the bar. While part of a command's name in the bar came
 * from an extension, the bar chooses no row of another extension for the
 * user (as the default, or by Tab), and in a bar an extension opened or put
 * text in, no destructive row of another's at all: the user picks those
 * themselves (↑↓, a click). What a command answers belongs to the opening it was asked in:
 * an answer arriving after the bar closed, or for what was typed before,
 * never acts on what's there now, and a destructive row runs only once it
 * has been in the list a moment.
 */
import {
  PREFIX, SETTINGS_PAGES, suggest, cleanSuggestions, cleanResult, cleanOptionValues, parseCommand,
  textFromExtension, fromAnotherExtension, ownCommand,
} from './command-list.js';
import { activatePanelPlugin, getActivePanelPluginId, listPanelPlugins } from './panel-registry.js';
import { sidebarState } from './sidebar-state.js';
import { closeSidebar, openSidebar } from './sidebar-shell.js';
import { appearanceState } from './appearance.js';
import { escapeHtml } from './escape-html.js';
import {
  commandBarTarget, extensionCommandSources, extensionHasPanel, giveKeyboardBack, requestExtensionCommand, runExtensionCommand,
  showExtensionPanel,
} from './extension-frame-host.js';

const BAR_HEIGHT = 54;
const FLASH_MS = 3200;
const FLASH_OVER_FRAME_MS = 1600; // over a frame's own bar, which has the keyboard again
const FOLLOW_MS = 1500;           // keys typed in the frame that opened the bar, before it had the keyboard
const DANGER_SEEN_MS = 500;       // a destructive row runs only once it has been in the list this long

const footer = document.getElementById('sidebar-footer');
const brand = footer?.querySelector('.sidebar-footer-brand');
const wordmark = footer?.querySelector('.sidebar-footer-name');

let sidebarInput = null; // the footer's field (sidebar mode)
let field = null;        // Atmos's bar over a panel (panel mode)
let fieldInput = null;
let input = null;        // whichever of the two is in use
let listEl = null;
let flashEl = null;
let flashTimer = null;
let rows = [];
let options = [];        // what the extension offers for its command (cleanSuggestions)
let activeIndex = -1;
let chosenKey = null;    // the row the user chose (↑↓, a click), kept while answers arrive; not a default
let choiceLost = false;  // the row they chose isn't in the latest answer
const dangerSince = new Map(); // row key -> when that destructive row first showed
let open = false;
let session = 0;         // each opening; what's answered for an earlier one is dropped
let mode = 'panel';
let sidebarWasOpen = false;
let previousFocus = null;
let opener = null;       // the frame that opened it with text: { iframe, extension, at, text }
let typedBy = null;      // { extension, text }: what's in the bar came from this extension (its start, and the command's name in it)
let status = null;       // { text, error }
let busy = false;
// An extension's suggestions: the last answer, what's being asked, the
// options the user changed (sent back with each ask and the run), and
// options a frame preset for its own command.
let fetched = null;      // { source, name, args, key, rows, options }
let pendingKey = null;
let fetchTimer = null;
let fetchSeq = 0;        // the newest ask; older answers are dropped
let userOptions = {};
let optionsFor = '';
let presetOptions = null;
let presetSource = null; // whose presets they are: they apply to its commands only
let preferred = null;    // { name, source }: what the text means when two extensions share a name
let currentAsk = null;   // the extension command being typed: { source, name, args }
let enterWhenFresh = false; // Enter came before the answer for what's typed: run its first row then
let enterGo;                // …with the key it was: true Shift+Enter (and go there), false Alt+Enter (stay here)

const settingsMenu = () => import('./settings-menu.js');

function panels() {
  return listPanelPlugins().map(panel => ({ id: panel.id, label: panel.label || panel.id }));
}

function wire(element) {
  element.type = 'text';
  element.autocomplete = 'off';
  element.spellcheck = false;
  element.placeholder = `${PREFIX} a command…`;
  element.setAttribute('aria-label', 'Command');
  element.setAttribute('role', 'combobox');
  element.setAttribute('aria-expanded', 'false');
  element.setAttribute('aria-controls', 'command-bar-list');
  element.addEventListener('input', () => {
    activeIndex = 0;
    chosenKey = null;
    enterWhenFresh = false;
    // Typed over what an extension put there: what's left of it is still
    // its, until no part of a command's name is.
    if (typedBy && !element.value.startsWith(typedBy.text)) {
      const kept = sharedStart(typedBy.text, element.value);
      typedBy = parseCommand(kept).name ? { ...typedBy, text: kept } : null;
    }
    if (status && !status.error) status = null;
    paint();
  });
  element.addEventListener('keydown', onKeydown);
  // Focus going anywhere else (a click on the page, another window) closes it.
  element.addEventListener('blur', () => setTimeout(() => {
    if (!open || document.activeElement === input || listEl?.contains(document.activeElement)) return;
    closeBar({ restoreFocus: false });
  }, 0));
  return element;
}

function ensureSidebarInput() {
  if (sidebarInput || !brand) return sidebarInput;
  sidebarInput = wire(document.createElement('input'));
  sidebarInput.className = 'sidebar-command-input';
  sidebarInput.id = 'sidebar-command-input';
  brand.append(sidebarInput);
  return sidebarInput;
}

function ensureField() {
  if (field) return field;
  field = document.createElement('div');
  field.id = 'command-bar-field';
  field.className = 'command-bar-field';
  fieldInput = wire(document.createElement('input'));
  fieldInput.className = 'command-bar-input';
  fieldInput.id = 'command-bar-input';
  field.append(fieldInput);
  return field;
}

/** Atmos's bar over the panel the bar is for: on its own bar, or along its bottom (within the window). */
function placeField() {
  const target = commandBarTarget(previousFocus);
  let box = target.bar;
  if (!box) {
    const left = Math.max(0, target.area.left);
    const bottom = Math.min(target.area.top + target.area.height, innerHeight);
    box = { left, width: Math.min(target.area.left + target.area.width, innerWidth) - left, top: bottom - BAR_HEIGHT, height: BAR_HEIGHT };
  }
  field.classList.toggle('is-own', !target.bar);
  Object.assign(field.style, {
    left: `${Math.round(box.left)}px`, top: `${Math.round(box.top)}px`,
    width: `${Math.round(box.width)}px`, height: `${Math.round(Math.max(36, box.height))}px`,
  });
}

/**
 * Where the list goes: above the field, as wide (below it when the panel's
 * bar is near the top, as Music's is while its drawer is up); in the
 * sidebar, above the footer, at least 380 px from its edge.
 */
function position() {
  if (!listEl) return;
  const tallest = Math.min(420, innerHeight * 0.6);
  if (mode === 'panel') {
    if (field?.isConnected) placeField();
    const rect = field.getBoundingClientRect();
    const above = rect.top, below = innerHeight - rect.bottom;
    const down = above < 200 && below > above;
    listEl.classList.toggle('is-below', down);
    Object.assign(listEl.style, {
      left: `${rect.left}px`, width: `${rect.width}px`,
      top: down ? `${rect.bottom}px` : '', bottom: down ? '' : `${innerHeight - rect.top}px`,
      maxHeight: `${Math.max(120, Math.min(tallest, (down ? below : above) - 8))}px`,
    });
    return;
  }
  const rect = footer.getBoundingClientRect();
  const width = Math.min(innerWidth - 16, Math.max(rect.width, 380));
  const left = appearanceState.sidebarPosition === 'left' ? rect.left : rect.right - width;
  listEl.classList.remove('is-below');
  Object.assign(listEl.style, { left: `${Math.max(0, left)}px`, width: `${width}px`, top: '', bottom: `${innerHeight - rect.top}px`, maxHeight: '' });
}

function actionable() {
  return rows.map((row, index) => (row.enter ? index : -1)).filter(index => index !== -1);
}

/** Which row is which, across answers: its title, whose it is and what it does. */
function rowKey(row) {
  const run = row?.enter?.run;
  return row ? `${row.title}\u0000${run?.source ?? ''}\u0000${run?.value ?? run?.target ?? row.enter?.complete ?? ''}` : null;
}

/**
 * Whether the bar may choose this row for the user (as the default, or by
 * Tab); ↑↓ and a click choose any. Not another extension's row while a
 * command name an extension typed is in the bar (it could line one up for
 * the user's next Enter), nor another extension's destructive row whoever
 * typed its name, in a bar an extension opened or while text one put there
 * is in it (a bare rev/ handed over, or filled in by a result, just as you
 * were about to type "leave now").
 */
function choosableForUser(row) {
  if (typedBy && parseCommand(typedBy.text).name && fromAnotherExtension(row, typedBy.extension)) return false;
  if (row?.danger && [opener, typedBy].some(by => by && fromAnotherExtension(row, by.extension))) return false;
  return true;
}

/** Whether a destructive row has been in the list long enough to run (not a double Enter, nor a click on a row just redrawn there). */
function seenLongEnough(row) {
  if (!row?.danger) return true;
  const since = dangerSince.get(rowKey(row));
  return since !== undefined && performance.now() - since >= DANGER_SEEN_MS;
}

/** The common start of two texts. */
function sharedStart(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return a.slice(0, index);
}

/** The keys line: Shift+Enter and Alt+Enter when the row chosen runs an extension's command that has a panel. */
function footText() {
  const source = rows[activeIndex]?.enter?.run?.source;
  const where = source && extensionHasPanel(source) ? ' · Shift+Enter go there · Alt+Enter stay here' : '';
  return `↑↓ choose · Enter run${where} · Tab complete · Esc ${input.value ? 'clear' : 'close'}`;
}

/** What a key or click with Shift or Alt asks of an extension's command: go there, stay here, or as it does. */
const goFrom = event => (event?.shiftKey ? true : event?.altKey ? false : undefined);

const optionValue = option => (Object.hasOwn(userOptions, option.id) ? userOptions[option.id] : option.value);

function optionsHtml() {
  if (!options.length) return '';
  const chip = (attrs, label, on) => `<button type="button" class="command-bar-chip${on ? ' on' : ''}" ${attrs}>${escapeHtml(label)}</button>`;
  return `<div class="command-bar-chips">${options.map(option => {
    const value = optionValue(option);
    const id = escapeHtml(option.id);
    if (option.type === 'toggle') return chip(`data-option="${id}" data-toggle`, option.label || option.id, value === true);
    if (option.type === 'select' && option.style === 'chips') {
      return `<span class="command-bar-chip-group" role="radiogroup"${option.label ? ` aria-label="${escapeHtml(option.label)}"` : ''}>${option.options
        .map(choice => chip(`data-option="${id}" data-value="${escapeHtml(choice.value)}" role="radio" aria-checked="${choice.value === value}"`, choice.label, choice.value === value)).join('')}</span>`;
    }
    if (option.type === 'select') {
      return `<label class="command-bar-chip command-bar-chip-select${value ? ' on' : ''}">${option.label ? `<span>${escapeHtml(option.label)}</span>` : ''}
        <select data-option="${id}"${option.label ? ` aria-label="${escapeHtml(option.label)}"` : ''}>${option.options
          .map(choice => `<option value="${escapeHtml(choice.value)}"${choice.value === value ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select></label>`;
    }
    const text = String(value ?? '');
    return `<label class="command-bar-chip command-bar-chip-text on">${option.prefix ? `<span>${escapeHtml(option.prefix)}</span>` : ''}<input data-option="${id}" value="${escapeHtml(text)}" size="${Math.max(6, text.length)}" spellcheck="false"${option.placeholder ? ` placeholder="${escapeHtml(option.placeholder)}"` : ''} aria-label="${escapeHtml(option.label || option.id)}">${option.suffix ? `<span>${escapeHtml(option.suffix)}</span>` : ''}</label>`;
  }).join('')}</div>`;
}

function paint() {
  if (!open) return;
  const sources = extensionCommandSources(previousFocus);
  const result = suggest(input.value, { panels: panels(), activePanel: getActivePanelPluginId(), pages: SETTINGS_PAGES, sources, fetched, prefer: preferred });
  // The command a row chose stands while its name does.
  if (preferred && result.parsed.name !== preferred.name) preferred = null;
  rows = result.rows;
  options = result.options || [];
  currentAsk = result.ask;
  if (result.ask) {
    // Options belong to one command: another resets them. A frame's presets
    // are for its own command only, never another extension's.
    const owner = `${result.ask.source} ${result.ask.name}`;
    if (owner !== optionsFor) {
      optionsFor = owner;
      userOptions = presetOptions && presetSource === result.ask.source ? presetOptions : {};
    }
    presetOptions = null;
    presetSource = null;
    scheduleFetch(result.ask);
  } else {
    optionsFor = '';
  }
  // The row the user chose stays chosen as answers arrive; otherwise the
  // first the bar may choose for them (typing starts again at the top).
  const choosable = actionable();
  const kept = chosenKey ? rows.findIndex((row, index) => choosable.includes(index) && rowKey(row) === chosenKey) : -1;
  choiceLost = !!chosenKey && kept === -1;
  if (choiceLost) chosenKey = null;
  activeIndex = kept !== -1 ? kept : (choosable.find(index => choosableForUser(rows[index])) ?? -1);
  // "Press Enter again" is about one row: gone or no longer chosen, so is it.
  if (status?.heldFor && status.heldFor !== rowKey(rows[activeIndex])) status = null;
  // When each destructive row first showed (it runs only once it's been seen).
  const showing = new Set(rows.filter(row => row.danger).map(rowKey));
  for (const key of [...dangerSince.keys()]) if (!showing.has(key)) dangerSince.delete(key);
  for (const key of showing) if (!dangerSince.has(key)) dangerSince.set(key, performance.now());
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.id = 'command-bar-list';
    listEl.className = 'command-bar-list';
    listEl.setAttribute('role', 'listbox');
    // Choosing with the mouse keeps the field's focus and caret (not in an option's own field).
    listEl.addEventListener('mousedown', event => { if (!event.target.closest('select, input')) event.preventDefault(); });
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('change', onOptionChange);
    listEl.addEventListener('input', onOptionInput);
    listEl.addEventListener('keydown', onOptionKeydown);
    // Focus leaving the bar and its options altogether closes it, as from the field.
    listEl.addEventListener('focusout', () => setTimeout(() => {
      if (open && document.activeElement !== input && !listEl?.contains(document.activeElement)) closeBar({ restoreFocus: false });
    }, 0));
    document.body.append(listEl);
  }
  // An option's own field being typed in keeps its focus and caret through the redraw.
  const editing = listEl.contains(document.activeElement) && document.activeElement.dataset?.option
    ? { id: document.activeElement.dataset.option, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  listEl.innerHTML = `
    ${optionsHtml()}
    ${status ? `<div class="command-bar-status${status.error ? ' is-error' : ''}" role="status">${escapeHtml(status.text)}</div>` : ''}
    <div class="command-bar-rows">
      ${rows.map((row, index) => (row.heading !== undefined
        ? `<div class="command-bar-heading">${escapeHtml(row.heading)}</div>`
        : row.note !== undefined
          ? `<div class="command-bar-note">${escapeHtml(row.note)}</div>`
          : `<button type="button" class="command-bar-item${index === activeIndex ? ' active' : ''}${row.danger ? ' danger' : ''}${row.stale ? ' is-stale' : ''}" data-index="${index}" role="option" aria-selected="${index === activeIndex}" tabindex="-1">
              <span class="command-bar-item-text">
                <span class="command-bar-item-title">${escapeHtml(row.title)}${row.hint ? ` <span class="command-bar-item-hint">${escapeHtml(row.hint)}</span>` : ''}</span>
                ${row.sub ? `<span class="command-bar-item-sub">${escapeHtml(row.sub)}</span>` : ''}
              </span>
              ${row.source ? `<span class="command-bar-item-source">${escapeHtml(row.source)}</span>` : ''}
              ${row.action ? `<span class="command-bar-item-action">${busy && index === activeIndex ? '…' : escapeHtml(row.action)}</span>` : ''}
            </button>`)).join('')}
    </div>
    <div class="command-bar-foot">${footText()}</div>`;
  input.setAttribute('aria-expanded', 'true');
  position();
  listEl.querySelector('.command-bar-item.active')?.scrollIntoView({ block: 'nearest' });
  if (editing) {
    const again = [...listEl.querySelectorAll('input[data-option]')].find(element => element.dataset.option === editing.id);
    if (again) { again.focus(); try { again.setSelectionRange(editing.start, editing.end); } catch { /* not a text field */ } }
  }
}

/**
 * Ask the extension what to list (a moment after typing stops), unless it's
 * what it last answered or is answering. Only the newest ask's answer counts.
 */
function scheduleFetch(ask, { force = false } = {}) {
  const key = JSON.stringify([ask.source, ask.name, ask.args, userOptions]);
  if (!force && (key === fetched?.key || key === pendingKey)) return;
  clearTimeout(fetchTimer);
  const quick = !fetched || fetched.source !== ask.source || fetched.name !== ask.name;
  const mine = session;
  // A new command at once; typing a moment after it stops; a refresh soon (and only one).
  fetchTimer = setTimeout(async () => {
    const seq = ++fetchSeq;
    pendingKey = key;
    let answer;
    try {
      answer = cleanSuggestions(await requestExtensionCommand(ask.source, ask.name, 'suggest', { args: ask.args, options: { ...userOptions } }));
    } catch (error) {
      answer = { rows: [{ note: error?.message || 'It didn’t answer.' }], options: [] };
    }
    if (seq !== fetchSeq || session !== mine || !open) return;
    pendingKey = null;
    fetched = { source: ask.source, name: ask.name, args: ask.args, key, ...answer };
    paint();
    // Enter came before this answer: now that it's for what's typed, its
    // first row (or the one chosen, if it's still there). A destructive row
    // isn't run unseen: it waits for another Enter, and says so.
    if (enterWhenFresh && !awaitingAnswer()) {
      enterWhenFresh = false;
      if (activeIndex === -1 || choiceLost) return;
      if (rows[activeIndex]?.danger) hold();
      else choose(activeIndex, 'enter', enterGo);
    }
  }, force ? 60 : quick ? 0 : 120);
}

/** Whether what's listed for the extension's command isn't yet its answer for what's typed now. */
function awaitingAnswer() {
  return !!currentAsk && (!fetched || fetched.source !== currentAsk.source || fetched.name !== currentAsk.name || fetched.args !== currentAsk.args);
}

function fill(text) {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  activeIndex = 0;
  chosenKey = null;
  enterWhenFresh = false;
  if (typedBy && !text.startsWith(typedBy.text)) typedBy = null;
  paint();
}

/** Enter, in the bar or an option's field; `go` from Shift or Alt with it (goFrom). */
function enter(go) {
  // The list still answers what was typed before (or nothing yet): Enter
  // runs the answer for what's typed, once it's in. (Never a later answer:
  // one that only refreshes the list never runs anything.)
  if (awaitingAnswer()) { enterWhenFresh = true; enterGo = go; return; }
  if (activeIndex === -1) return;
  // A destructive row runs once it has been seen (not on a double Enter).
  if (!seenLongEnough(rows[activeIndex])) { hold(); return; }
  choose(activeIndex, 'enter', go);
}

/** A destructive row chosen too soon: say so, rather than nothing (while it's the one chosen). */
function hold(how = 'enter') {
  status = { text: how === 'click' ? 'Click it again to do it.' : 'Press Enter again to do it.', heldFor: rowKey(rows[activeIndex]) };
  paint();
}

function choose(index, key, go) {
  const row = rows[index];
  const step = key === 'tab' ? row?.tab : row?.enter;
  if (!step || busy) return;
  if (step.complete !== undefined) {
    if (step.prefer) preferred = step.prefer;
    fill(step.complete);
    return;
  }
  if (step.run?.source) runExtension(step.run, index, go);
  else if (step.run) run(step.run);
}

/** One of an extension's commands, in its frame; what it answers decides what the bar does next. */
async function runExtension({ command, source, args, value }, index, go) {
  const mine = session;
  activeIndex = index;
  chosenKey = rowKey(rows[index]);
  busy = true;
  status = null;
  paint();
  let reply;
  try {
    reply = cleanResult(await runExtensionCommand(source, command, { args: args || '', value: value ?? null, options: { ...userOptions } }, { go }));
  } catch (error) {
    // Closed meanwhile (and maybe opened again): what it says is for a bar that's gone.
    if (!open || session !== mine) return;
    busy = false;
    status = { text: error?.message || 'That didn’t work. Try again.', error: true };
    paint();
    return;
  }
  if (!open || session !== mine) return;
  busy = false;
  if (reply.fill !== null) {
    // A next step, typed by the extension: its options for its own commands,
    // and none of another's chosen for the user.
    const text = textFromExtension(reply.fill);
    presetOptions = reply.options;
    presetSource = source;
    preferred = ownCommand(parseCommand(text).name, source, extensionCommandSources(previousFocus)) || preferred;
    optionsFor = '';
    fetched = null;
    status = reply.done ? { text: reply.done } : null;
    typedBy = { extension: source, text };
    fill(text);
    return;
  }
  if (reply.keep) {
    status = reply.done ? { text: reply.done } : null;
    fetched = null;
    paint();
    return;
  }
  const where = barRect();
  const back = previousFocus;
  if (go === true) {
    // Shift+Enter: done, so to its panel (the keyboard isn't given back to
    // the one the bar was over: that's going away).
    closeBar({ restoreFocus: false });
    showExtensionPanel(source);
    if (reply.done) flash(reply.done, where, FLASH_MS);
    return;
  }
  closeBar();
  if (reply.done) flash(reply.done, where, back?.tagName === 'IFRAME' ? FLASH_OVER_FRAME_MS : FLASH_MS);
}

/** Do one of Atmos's commands. The bar closes first; the sidebar goes back as it was unless the command is about it. */
function run({ command, target }) {
  if (command === 'sidebar') {
    const wanted = mode === 'sidebar' ? !sidebarWasOpen : !(sidebarState.open === true);
    closeBar({ restoreSidebar: false });
    if (wanted) openSidebar(); else closeSidebar();
    return;
  }
  if (command === 'switch') {
    closeBar();
    try { activatePanelPlugin(target); }
    catch (error) { console.warn('[commands] switch failed:', error.message); }
    return;
  }
  if (command === 'settings' || command === 'extensions') {
    closeBar({ restoreFocus: false });
    settingsMenu()
      .then(menu => (command === 'extensions' ? menu.openExtensionManager() : target ? menu.openSettingsPage(target) : menu.openSettingsMenu()))
      .catch(error => console.warn('[commands] settings failed to load:', error.message));
  }
}

/** Where the bar is now (for what's shown after it closes). */
function barRect() {
  const rect = (mode === 'panel' ? field : footer)?.getBoundingClientRect();
  return rect && rect.width ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
}

/** What a command said it did, shown for a moment where the bar was. */
function flash(text, rect, ms = FLASH_MS) {
  if (!rect) return;
  flashEl?.remove();
  clearTimeout(flashTimer);
  flashEl = document.createElement('div');
  flashEl.className = 'command-bar-flash';
  flashEl.setAttribute('role', 'status');
  flashEl.textContent = text;
  Object.assign(flashEl.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.append(flashEl);
  const shown = flashEl;
  flashTimer = setTimeout(() => {
    shown.classList.add('is-leaving');
    setTimeout(() => shown.remove(), 300);
  }, ms);
}

function onKeydown(event) {
  if (event.isComposing || event.target !== input) return;
  const choosable = actionable();
  // ↑↓ reach every row; Tab only those the bar may choose for the user.
  const move = (step, among = choosable) => {
    if (!among.length) return;
    const at = among.indexOf(activeIndex);
    activeIndex = at === -1 ? among[step > 0 ? 0 : among.length - 1] : among[(at + step + among.length) % among.length];
    chosenKey = rowKey(rows[activeIndex]);
    paint();
  };
  const handled = () => { event.preventDefault(); event.stopPropagation(); };
  if (event.key === 'ArrowDown') { handled(); move(1); }
  else if (event.key === 'ArrowUp') { handled(); move(-1); }
  else if (event.key === 'Enter') { handled(); enter(goFrom(event)); }
  else if (event.key === 'Tab') {
    handled();
    // Completes what the row says to type; a row with nothing to complete, Tab moves on (Shift+Tab back).
    if (rows[activeIndex]?.tab) choose(activeIndex, 'tab');
    else move(event.shiftKey ? -1 : 1, choosable.filter(index => choosableForUser(rows[index])));
  }
  else if (event.key === 'Escape') {
    handled();
    enterWhenFresh = false;
    if (input.value) { status = null; fill(''); } else closeBar();
  }
}

function onListClick(event) {
  const chip = event.target.closest('button[data-option]');
  if (chip) {
    const id = chip.dataset.option;
    const option = options.find(item => item.id === id);
    if (option?.type === 'toggle') userOptions = { ...userOptions, [id]: optionValue(option) !== true };
    else if (option) userOptions = { ...userOptions, [id]: chip.dataset.value };
    input.focus();
    paint();
    return;
  }
  // A row clicked runs as it's shown (an answer for what was typed before,
  // too: it's the one seen), a destructive one once it has been there a moment.
  const item = event.target.closest('[data-index]');
  if (item) {
    const index = Number(item.dataset.index);
    activeIndex = index;
    chosenKey = rowKey(rows[index]);
    if (!seenLongEnough(rows[index])) { hold('click'); return; }
    choose(index, 'enter', goFrom(event));
  }
}

function onOptionChange(event) {
  const id = event.target.dataset?.option;
  if (!id || event.target.tagName !== 'SELECT') return;
  userOptions = { ...userOptions, [id]: event.target.value };
  input.focus();
  paint();
}

function onOptionInput(event) {
  const id = event.target.dataset?.option;
  if (!id || event.target.tagName !== 'INPUT') return;
  userOptions = { ...userOptions, [id]: event.target.value.slice(0, 200) };
  event.target.size = Math.max(6, event.target.value.length);
  // Asked again once typing stops; the field keeps its focus through the redraw.
  if (currentAsk) scheduleFetch(currentAsk);
}

/** In an option's own field: Enter runs what's chosen, Esc goes back to the bar. */
function onOptionKeydown(event) {
  if (!event.target.dataset?.option || event.target.tagName !== 'INPUT') return;
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); enter(goFrom(event)); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); input.focus(); }
}

export function isCommandBarOpen() { return open; }

/**
 * Open the bar with `text`. `from` is where the keyboard was (an extension's
 * frame that asked, say), which decides the panel it's for; `options`, a
 * frame's preset option values, for `source`'s commands only.
 */
export function openCommandBar(text = '', { from = null, options: preset = null, source = null } = {}) {
  if (!open) {
    // What the last command said has had its moment.
    clearTimeout(flashTimer);
    flashEl?.remove();
    flashEl = null;
    mode = appearanceState.commandBar === 'sidebar' ? 'sidebar' : 'panel';
    const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    previousFocus = from || focused;
    sidebarWasOpen = sidebarState.open === true;
    if (mode === 'sidebar') {
      if (!ensureSidebarInput()) return;
      input = sidebarInput;
      if (!sidebarWasOpen) openSidebar();
      footer.classList.add('is-commanding');
    } else {
      document.body.append(ensureField());
      input = fieldInput;
      placeField();
    }
    open = true;
    session += 1;
    status = null;
    fetched = null;
    userOptions = {};
    optionsFor = '';
    // Settings covers the workspace: the bar is for going somewhere else.
    settingsMenu().then(menu => { if (menu.isSettingsMenuOpen()) menu.closeSettingsMenu(); }).catch(() => {});
  }
  presetOptions = preset && Object.keys(preset).length ? cleanOptionValues(preset) : null;
  presetSource = presetOptions ? source : null;
  preferred = source ? ownCommand(parseCommand(text).name, source, extensionCommandSources(previousFocus)) : null;
  typedBy = source ? { extension: source, text } : null;
  opener = source && from ? { iframe: from, extension: source, at: performance.now(), text } : null;
  enterWhenFresh = false;
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  activeIndex = 0;
  chosenKey = null;
  paint();
}

export function closeBar({ restoreSidebar = true, restoreFocus = true } = {}) {
  if (!open) return;
  open = false;
  busy = false;
  rows = [];
  options = [];
  status = null;
  clearTimeout(fetchTimer);
  pendingKey = null;
  currentAsk = null;
  opener = null;
  typedBy = null;
  preferred = null;
  presetOptions = null;
  presetSource = null;
  enterWhenFresh = false;
  chosenKey = null;
  dangerSince.clear();
  listEl?.remove();
  listEl = null;
  input?.setAttribute('aria-expanded', 'false');
  if (input) input.value = '';
  if (mode === 'sidebar') {
    footer?.classList.remove('is-commanding');
    if (restoreSidebar && !sidebarWasOpen) closeSidebar();
  }
  const back = previousFocus;
  previousFocus = null;
  if (restoreFocus && back?.isConnected && typeof back.focus === 'function') {
    back.focus();
    // A frame's own field (where rev/ was typed) gets the keyboard back too.
    if (back.tagName === 'IFRAME') giveKeyboardBack(back);
  } else if (document.activeElement === input) input.blur();
  // Atmos's bar over the panel goes once nothing needs its place (a flash may).
  if (mode === 'panel') field?.remove();
}

export function toggleCommandBar() {
  if (open) closeBar(); else openCommandBar();
}

/** Ctrl+\ (the \ | key; Ctrl+| with Shift), Cmd+\ on a Mac. */
export function isCommandBarKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return event.key === '\\' || event.key === '|' || event.code === 'IntlBackslash';
}

// Atmos's page, and frames (their SDK passes keys with Ctrl on as a
// keydown here). Taken even while typing: the key types nothing.
document.addEventListener('keydown', event => {
  if (!isCommandBarKey(event)) return;
  event.preventDefault();
  event.stopPropagation();
  toggleCommandBar();
}, true);
// A web page in Atmos Browser (web-layer.js, from web-policy.cjs's shortcuts).
window.addEventListener('atmos:command-bar', () => toggleCommandBar());
// rev/ typed into an extension's field (atmos.commands.open, .field): the
// bar takes over there, with the text (what it may then choose is limited:
// choosableForUser).
window.addEventListener('atmos:command-bar-open', event => {
  const { text = '', options: preset = null, from = null, extension = null } = event.detail || {};
  const typed = extension ? textFromExtension(text) : String(text);
  if (open) closeBar({ restoreFocus: false });
  openCommandBar(typed, { from, options: preset, source: extension });
});
// Keys typed in that field before the bar had the keyboard (atmos.commands.field):
// taken for a moment after it opened, while nothing has been typed in the bar.
window.addEventListener('atmos:command-bar-follow', event => {
  const detail = event.detail || {};
  if (!open || !opener || opener.iframe !== detail.from || performance.now() - opener.at > FOLLOW_MS) return;
  const next = textFromExtension(detail.text);
  if (input.value !== opener.text || next === opener.text || !next.startsWith(opener.text)) return;
  input.value = next;
  opener.text = next;
  typedBy = { extension: opener.extension, text: next };
  input.setSelectionRange(next.length, next.length);
  preferred = ownCommand(parseCommand(next).name, opener.extension, extensionCommandSources(previousFocus)) || preferred;
  activeIndex = 0;
  chosenKey = null;
  detail.accepted = true;
  paint();
});
// An extension's suggestions changed (atmos.commands.refresh), or it began
// handling a command (its background frame started): ask again about what's typed.
window.addEventListener('atmos:command-bar-refresh', event => {
  if (!open || !currentAsk || currentAsk.source !== event.detail?.extension) return;
  scheduleFetch(currentAsk, { force: true });
});
// A panel's bar moved (atmos.commands.bar): the field and list follow.
window.addEventListener('atmos:command-bar-moved', () => { if (open) position(); });
window.addEventListener('resize', position);
// The sidebar's wordmark opens it there, when that's where it lives.
wordmark?.addEventListener('click', () => { if (appearanceState.commandBar === 'sidebar') openCommandBar(); });

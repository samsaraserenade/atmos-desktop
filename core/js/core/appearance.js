/**
 * js/core/appearance.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core-owned, app-wide APPEARANCE SERVICE -- not a single feature but a
 * small registry of "how the app looks" settings that all share one state
 * namespace. Its controls mount on the Settings menu's About page (see
 * js/core/settings-menu.js's _renderHome()) rather than in the always-
 * visible sidebar or inside any one plugin's section: font/theme are a
 * Core-owned, app-wide concern, not a per-plugin preference, and the
 * Settings menu is Core's own dedicated home for exactly that kind of
 * control (its own file header explains the same distinction for Sidebar/
 * Panels/Plugins/Services). Today that includes font, theme, and plugin-owned
 * panel-background blur/opacity; the shape is meant to take more without
 * redesign (accent color, density, etc. would each just be another
 * exported registry + apply step here):
 *
 *   Appearance service
 *     ├── font   (APP_FONTS / getAllAppFonts / setAppFont / importAppFont)
 *     ├── theme  (APP_THEMES / setAppTheme)
 *     └── panels (app defaults plus sparse sidebar/plugin overrides)
 *
 * Font: one CSS custom property (--app-font-family) is set on <html>;
 * nearly every other font-family declaration in Core and in every plugin
 * already reads `inherit` rather than hardcoding its own stack, so
 * changing this single property re-skins the whole app's text live, with
 * no per-plugin wiring needed. The small handful of places that didn't
 * inherit (a few SVG chart-label spots, a couple of plugin-local hardcoded
 * stacks) were switched over to `inherit` / var(--app-font-family)
 * alongside this file landing.
 *
 * Theme: two CSS custom properties -- --ink-rgb (the R,G,B triplet behind
 * virtually every text/border/hover-overlay color in Core and plugins,
 * which are almost universally expressed as rgba(255,255,255,X))
 * and --surface-rgb (the triplet behind the handful of actual panel/menu
 * background colors: #settings-drawer, #ctx-menu, plugins' own dropdown
 * surfaces). A theme is just a { ink, surface } pair of "R,G,B" strings --
 * adding Atmos Light was adding one entry to APP_THEMES, not touching any
 * of the ~800 individual color declarations those two variables now stand
 * in for. AMOLED also uses a root theme attribute for opaque surfaces.
 *
 * Imported fonts apply to the whole app: font-face registration happens
 * once, here, and framed extensions are told the active font and load it
 * themselves. This is for ordinary UI text (accordion labels, rows,
 * buttons -- everything using `inherit`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { registerCoreStateNamespace, scheduleSave, onStateLoaded } from '../persist.js';
import { getSemanticColors, setSemanticColor, onSemanticColorChange } from './semantic-colors.js';

export const APP_FONTS = Object.freeze([
  { id: 'default',   label: 'System Default', stack: `'Segoe UI',Roboto,Helvetica,sans-serif` },
  { id: 'arial',      label: 'Arial',          stack: `Arial,'Segoe UI',sans-serif` },
  { id: 'verdana',    label: 'Verdana',        stack: `Verdana,'Segoe UI',sans-serif` },
  { id: 'tahoma',     label: 'Tahoma',         stack: `Tahoma,'Segoe UI',sans-serif` },
  { id: 'trebuchet',  label: 'Trebuchet MS',   stack: `'Trebuchet MS','Segoe UI',sans-serif` },
  { id: 'georgia',    label: 'Georgia',        stack: `Georgia,'Segoe UI',serif` },
  { id: 'consolas',   label: 'Consolas',       stack: `Consolas,'Courier New',monospace` },
]);
const DEFAULT_APP_FONT_ID = 'default';

// Each theme is just an { ink, surface } pair of "R,G,B" strings (no
// leading "rgb"/alpha -- callers wrap them in rgba(var(--x-rgb),alpha) or
// rgb(var(--x-rgb)) same as any other CSS custom property triplet). ink
// stands in for the ~800 rgba(255,255,255,X) / #fff-family text, border,
// and hover-overlay declarations across Core and plugins; surface stands in
// for the much smaller set of actual opaque/translucent panel and menu
// backgrounds (#settings-drawer, #ctx-menu, plugins' dropdown surfaces).
export const APP_THEMES = Object.freeze([
  { id: 'atmos-dark',  label: 'Atmos Dark',  ink: '255,255,255', surface: '22,22,24' },
  { id: 'amoled',      label: 'AMOLED Black', ink: '255,255,255', surface: '0,0,0' },
  { id: 'atmos-light', label: 'Atmos Light', ink: '15,15,18',    surface: '255,255,255' },
]);
const DEFAULT_APP_THEME_ID = 'atmos-dark';
const DEFAULT_SHELL_BLUR = 30;
const DEFAULT_SHELL_OPACITY = 88;
const DEFAULT_PANEL_BLUR = 0;
const DEFAULT_PANEL_OPACITY = 69;

function normalizeShellBlur(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(60, value)))
    : DEFAULT_SHELL_BLUR;
}

function normalizeShellOpacity(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value)))
    : DEFAULT_SHELL_OPACITY;
}

function normalizePanelBlur(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(60, value)))
    : DEFAULT_PANEL_BLUR;
}

function normalizePanelOpacity(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value)))
    : DEFAULT_PANEL_OPACITY;
}

function normalizePanelOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [id, override] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !override || typeof override !== 'object') continue;
    const blur = Number.isFinite(override.blur) ? normalizePanelBlur(override.blur) : undefined;
    const opacity = Number.isFinite(override.opacity) ? normalizePanelOpacity(override.opacity) : undefined;
    if (blur !== undefined || opacity !== undefined) result[id] = { blur, opacity };
  }
  return result;
}

// Limits for imported fonts (stored as data URLs in Core state).
const MAX_CUSTOM_FONTS = 8;
const MAX_CUSTOM_FONT_BYTES = 2 * 1024 * 1024; // 2MB source file (~2.7MB once base64-encoded for storage)
const CUSTOM_FONT_EXTENSIONS = /\.(ttf|otf|woff2?|ttc)$/i;
const _customFontFaces = new Map(); // id -> FontFace registered with document.fonts this session

export const appearanceState = registerCoreStateNamespace('appearance', {
  version: 1,
  defaults: {
    fontFamily: DEFAULT_APP_FONT_ID,
    customFonts: [], // { id, label, dataUrl }
    theme: DEFAULT_APP_THEME_ID,
    sidebarShadowVisible: true,
    sidebarPosition: 'right',
    shellBlur: DEFAULT_SHELL_BLUR,
    shellOpacity: DEFAULT_SHELL_OPACITY,
    defaultPanelBlur: DEFAULT_PANEL_BLUR,
    defaultPanelOpacity: DEFAULT_PANEL_OPACITY,
    panelOverrides: {},
  },
  hydrate(state, saved) {
    state.fontFamily = typeof saved.fontFamily === 'string' ? saved.fontFamily : DEFAULT_APP_FONT_ID;
    state.customFonts = Array.isArray(saved.customFonts) ? saved.customFonts : [];
    // Added after v1 shipped -- old saved state simply won't have this key,
    // same reasoning as fontFamily/customFonts's own fallbacks above, so no
    // version bump/migrate() needed for what's just a new optional field.
    state.theme = typeof saved.theme === 'string' ? saved.theme : DEFAULT_APP_THEME_ID;
    state.sidebarShadowVisible = typeof saved.sidebarShadowVisible === 'boolean' ? saved.sidebarShadowVisible : true;
    state.sidebarPosition = saved.sidebarPosition === 'left' ? 'left' : 'right';
    state.shellBlur = normalizeShellBlur(
      Number.isFinite(saved.shellBlur) ? saved.shellBlur : saved.surfaceBlur,
    );
    state.shellOpacity = normalizeShellOpacity(saved.shellOpacity);
    state.defaultPanelBlur = normalizePanelBlur(saved.defaultPanelBlur);
    state.defaultPanelOpacity = normalizePanelOpacity(saved.defaultPanelOpacity);
    state.panelOverrides = normalizePanelOverrides(saved.panelOverrides);
  },
});

function _slugifyFontLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || 'font';
}

function _uniqueCustomFontId(baseSlug) {
  const suffix = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `custom-${baseSlug}-${suffix}`;
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the font file'));
    reader.readAsDataURL(file);
  });
}

function _registerCustomFont(font) {
  if (_customFontFaces.has(font.id)) return _customFontFaces.get(font.id);
  try {
    const face = new FontFace(font.label, `url(${font.dataUrl})`);
    _customFontFaces.set(font.id, face);
    document.fonts?.add(face);
    face.load().catch(error => {
      console.warn('[appearance] custom app font failed to load:', font.label, error?.message);
    });
    return face;
  } catch (error) {
    console.warn('[appearance] could not register custom app font:', font.label, error?.message);
    return null;
  }
}

// Re-registers every persisted custom font's FontFace -- document.fonts
// doesn't survive a reload, only the data URLs in appearanceState do.
function _registerAllCustomFonts() {
  for (const font of appearanceState.customFonts ?? []) _registerCustomFont(font);
}

/** Built-ins plus whatever's been imported, in the shape both the picker
 *  and applyAppearance() expect. */
export function getAllAppFonts() {
  const custom = (appearanceState.customFonts ?? []).map(font => ({
    id: font.id,
    label: font.label,
    stack: `'${font.label.replace(/'/g, "\\'")}','Segoe UI',sans-serif`,
  }));
  return [...APP_FONTS, ...custom];
}

/** Currently active theme id (e.g. 'atmos-dark'). Read through here
 *  rather than appearanceState.theme directly -- same convention every
 *  other module's persisted state is meant to be consumed through. */
export function getAppTheme() {
  return appearanceState.theme || DEFAULT_APP_THEME_ID;
}

/** Currently active app font id (e.g. 'default', or a 'custom-...' id).
 *  See getAllAppFonts() for the full font descriptor if you need the
 *  label/stack rather than just the id. */
export function getAppFont() {
  return appearanceState.fontFamily || DEFAULT_APP_FONT_ID;
}

/** Resolve the plugin-owned background treatment for a panel. Overrides are sparse, so
 * either value can continue following the app-wide default independently. */
export function getPanelAppearance(id) {
  const override = appearanceState.panelOverrides?.[id] || {};
  return Object.freeze({
    blur: Number.isFinite(override.blur) ? normalizePanelBlur(override.blur) : normalizePanelBlur(appearanceState.defaultPanelBlur),
    opacity: Number.isFinite(override.opacity) ? normalizePanelOpacity(override.opacity) : normalizePanelOpacity(appearanceState.defaultPanelOpacity),
    overridden: Number.isFinite(override.blur) || Number.isFinite(override.opacity),
  });
}

// Anything outside this module that displays something theme/font-
// dependent beyond ordinary CSS (e.g. a flat wordmark PNG with no
// currentColor equivalent -- see settings-menu.js's _renderHome()) needs
// to know a setting actually changed, not just read it once at mount
// time. CSS custom properties alone don't give a JS-side hook for that,
// so applyAppearance() below notifies this tiny listener set every time
// it runs.
const _changeListeners = new Set();

/** Subscribe to any Appearance-service change (font OR theme) -- fires
 *  whenever applyAppearance() does: on initial state hydration and after
 *  every setAppFont()/setAppTheme()/removeAppFont() call. Returns an
 *  unsubscribe function. */
export function onAppearanceChange(fn) {
  _changeListeners.add(fn);
  return () => _changeListeners.delete(fn);
}

/** Applies every current Appearance-service setting -- font AND theme --
 *  as CSS custom properties on <html>. Wired to run once state has
 *  hydrated (see onStateLoaded below), and again any time a setting
 *  changes. Kept as one function (not split per sub-setting) since both
 *  are cheap, idempotent, and "apply everything Appearance owns" is the
 *  one thing every setter below needs to trigger. */
export function applyAppearance() {
  _registerAllCustomFonts();
  const font = getAllAppFonts().find(f => f.id === appearanceState.fontFamily);
  document.documentElement.style.setProperty('--app-font-family', (font || APP_FONTS[0]).stack);

  const theme = APP_THEMES.find(t => t.id === appearanceState.theme) || APP_THEMES[0];
  document.documentElement.style.setProperty('--ink-rgb', theme.ink);
  document.documentElement.style.setProperty('--surface-rgb', theme.surface);
  document.documentElement.dataset.appTheme = theme.id;
  document.documentElement.style.setProperty('--shell-blur', `${normalizeShellBlur(appearanceState.shellBlur)}px`);
  document.documentElement.style.setProperty('--shell-opacity', (normalizeShellOpacity(appearanceState.shellOpacity) / 100).toFixed(2));
  document.documentElement.style.setProperty('--default-panel-blur', `${normalizePanelBlur(appearanceState.defaultPanelBlur)}px`);
  document.documentElement.style.setProperty('--default-panel-opacity', (normalizePanelOpacity(appearanceState.defaultPanelOpacity) / 100).toFixed(2));
  document.documentElement.dataset.sidebarShadow = appearanceState.sidebarShadowVisible === false ? 'hidden' : 'visible';
  document.documentElement.dataset.sidebarPosition = appearanceState.sidebarPosition === 'left' ? 'left' : 'right';
  document.documentElement.style.colorScheme = theme.id === 'atmos-light' ? 'light' : 'dark';
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));

  for (const listener of _changeListeners) {
    try { listener(); } catch (error) { console.warn('[appearance] onAppearanceChange listener failed:', error?.message); }
  }
}

export function setAppFont(id) {
  const match = getAllAppFonts().find(font => font.id === id);
  appearanceState.fontFamily = match ? match.id : DEFAULT_APP_FONT_ID;
  scheduleSave();
  applyAppearance();
}

export function setAppTheme(id) {
  const match = APP_THEMES.find(theme => theme.id === id);
  appearanceState.theme = match ? match.id : DEFAULT_APP_THEME_ID;
  scheduleSave();
  applyAppearance();
}

export function setSidebarShadowVisible(visible) {
  appearanceState.sidebarShadowVisible = Boolean(visible);
  scheduleSave();
  applyAppearance();
}

export function setShellBlur(value) {
  appearanceState.shellBlur = normalizeShellBlur(value);
  scheduleSave();
  applyAppearance();
}

export function setShellOpacity(value) {
  appearanceState.shellOpacity = normalizeShellOpacity(value);
  scheduleSave();
  applyAppearance();
}

export function setDefaultPanelBlur(value) {
  appearanceState.defaultPanelBlur = normalizePanelBlur(value);
  scheduleSave();
  applyAppearance();
}

export function setDefaultPanelOpacity(value) {
  appearanceState.defaultPanelOpacity = normalizePanelOpacity(value);
  scheduleSave();
  applyAppearance();
}

export function setPanelAppearanceOverride(id, values) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new TypeError('appearance: panel id must contain lowercase letters, numbers, and hyphens');
  }
  values = values && typeof values === 'object' ? values : {};
  const existing = appearanceState.panelOverrides?.[id] || {};
  const next = { ...existing };
  if ('blur' in values) next.blur = values.blur == null ? undefined : normalizePanelBlur(values.blur);
  if ('opacity' in values) next.opacity = values.opacity == null ? undefined : normalizePanelOpacity(values.opacity);
  appearanceState.panelOverrides ||= {};
  if (!Number.isFinite(next.blur) && !Number.isFinite(next.opacity)) delete appearanceState.panelOverrides[id];
  else appearanceState.panelOverrides[id] = next;
  scheduleSave();
  applyAppearance();
}

export function clearPanelAppearanceOverride(id) {
  if (!appearanceState.panelOverrides?.[id]) return;
  delete appearanceState.panelOverrides[id];
  scheduleSave();
  applyAppearance();
}

export function setSidebarPosition(position) {
  appearanceState.sidebarPosition = position === 'left' ? 'left' : 'right';
  scheduleSave();
  applyAppearance();
}

/**
 * Loads a user-supplied .ttf/.otf/.woff/.woff2 file as a new App Font
 * choice: registers it with the page's FontFaceSet right away and persists
 * it (as a data URL) so it survives a reload. Awaiting FontFace.load()
 * before persisting means a corrupt/unsupported file rejects here instead
 * of silently saving a choice that would never actually render. Doesn't
 * switch the active font itself -- pair with setAppFont(id) to select it.
 *
 * @param {File} file
 * @returns {Promise<{id: string, label: string}>}
 */
export async function importAppFont(file) {
  if (!file) throw new Error('No file selected');
  if (!CUSTOM_FONT_EXTENSIONS.test(file.name || '')) {
    throw new Error('Choose a .ttf, .otf, .woff, or .woff2 file');
  }
  if (file.size > MAX_CUSTOM_FONT_BYTES) {
    throw new Error(`Font file is too large (max ${(MAX_CUSTOM_FONT_BYTES / (1024 * 1024)).toFixed(1)}MB)`);
  }
  const existing = appearanceState.customFonts ?? [];
  if (existing.length >= MAX_CUSTOM_FONTS) {
    throw new Error(`Remove an imported font first (max ${MAX_CUSTOM_FONTS})`);
  }

  const dataUrl = await _readFileAsDataUrl(file);
  const label = (file.name || 'Custom Font').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 40) || 'Custom Font';
  const id = _uniqueCustomFontId(_slugifyFontLabel(label));

  const face = new FontFace(label, `url(${dataUrl})`);
  try {
    await face.load();
  } catch (error) {
    throw new Error(`That file doesn't look like a valid font (${error?.message || 'failed to parse'})`);
  }
  _customFontFaces.set(id, face);
  document.fonts?.add(face);

  appearanceState.customFonts = [...existing, { id, label, dataUrl }];
  scheduleSave();
  return { id, label };
}

/** Removes a previously imported font. Falls back to System Default if it
 *  was the active app font. */
export function removeAppFont(id) {
  const existing = appearanceState.customFonts ?? [];
  if (!existing.some(font => font.id === id)) return;
  appearanceState.customFonts = existing.filter(font => font.id !== id);
  const face = _customFontFaces.get(id);
  if (face) { document.fonts?.delete(face); _customFontFaces.delete(id); }
  if (appearanceState.fontFamily === id) appearanceState.fontFamily = DEFAULT_APP_FONT_ID;
  scheduleSave();
  applyAppearance();
}

onStateLoaded(applyAppearance);

// ── Picker UI: mountAppearanceControls() ────────────────────────────────────
// A plain mount(body, context) function (same signature a registry
// section's own mount gets) rather than a registerSection() call of its
// own, so a host page can drop it into a larger layout instead of owning a
// whole accordion section. Its host is the Settings menu's About page
// (js/core/settings-menu.js's _renderHome()) -- font/theme are Core-owned,
// app-wide settings, not any one plugin's preference, so they live on
// Core's own settings surface rather than borrowing a plugin's sidebar
// section (which is where this used to live, merged into the background
// plugin's "Appearance" section, before the Settings menu became the
// better fit).

function _escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/* The Appearance page is built from a few shared pieces (styles in
 * index.html under "Appearance page"): titled sections (.sa-section), rows
 * with the label on the left and the control on the right (.sa-row), and
 * sliders with their value beside them (.sa-slider). Services that add a
 * section here (Wallpaper, Location) use the same classes, so every row on
 * the page has the same shape. */

/** A row: label (with an optional hint under it) and its control. */
function _row(label, controlHtml, hint = '') {
  const hintHtml = hint ? `<small>${_escapeHtml(hint)}</small>` : '';
  return `<div class="sa-row"><span class="sa-label">${_escapeHtml(label)}${hintHtml}</span><span class="sa-control">${controlHtml}</span></div>`;
}

/** A slider row: the value is written into the <output> by the sync code. */
function _sliderRow(label, id, min, max, hint = '') {
  return _row(label, `<span class="sa-slider"><input id="${id}" class="crange" type="range" min="${min}" max="${max}" step="1" aria-label="${_escapeHtml(label)}"><output id="${id}-value" for="${id}"></output></span>`, hint);
}

function _toggle(id, label) {
  return `<label class="sm-toggle"><input id="${id}" type="checkbox" aria-label="${_escapeHtml(label)}"><span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span></label>`;
}

function _section(title, bodyHtml) {
  return `<section class="sa-section"><div class="sa-heading">${_escapeHtml(title)}</div>${bodyHtml}</section>`;
}

/** Registers `fn` to re-run whenever persisted state (re)loads, and wires
 *  its unsubscribe into `context.onCleanup` -- the two-line
 *  onStateLoaded()+onCleanup() pair every synced control below needs. */
function _syncOnStateLoaded(context, fn) {
  const stop = onStateLoaded(fn);
  if (typeof stop === 'function') context.onCleanup(stop);
}

/** Keeps a slider and its <output> in step with a value from state. */
function _bindSlider(body, context, id, read, write, unit) {
  const slider = body.querySelector(`#${id}`);
  const output = body.querySelector(`#${id}-value`);
  const sync = () => {
    const value = read();
    slider.value = String(value);
    slider.setAttribute('aria-valuetext', `${value}${unit}`);
    output.textContent = `${value}${unit}`;
  };
  sync();
  context.listen(slider, 'input', () => write(Number(slider.value)));
  context.onCleanup(onAppearanceChange(sync));
  _syncOnStateLoaded(context, sync);
  return slider;
}

/**
 * Renders Core's part of Settings → Appearance into `body`: the Theme,
 * Sidebar and Glass sections (Glass includes the per-panel overrides for
 * the panels passed in). Extensions' own Appearance contributions follow
 * as further sections (settings-menu.js).
 *
 * @param {HTMLElement} body
 * @param {{listen: Function, onCleanup: Function}} context
 * @param {Array} [panels] registered panels (listPanelPlugins())
 */
export function mountAppearanceControls(body, context, panels = []) {
  const colours = [['positive', 'Positive'], ['negative', 'Negative'], ['neutral', 'Neutral']];
  body.innerHTML = [
    _section('Style', [
      _row('Theme', `<select id="app-theme-select" class="sa-select" aria-label="Theme" title="AMOLED Black uses solid black surfaces and hides the wallpaper while selected."></select>`),
      _row('Font', `
        <select id="app-font-select" class="sa-select" aria-label="App font"></select>
        <button type="button" id="app-font-remove" class="sa-btn sa-btn-icon" title="Remove this imported font" aria-label="Remove this imported font" hidden>&times;</button>
        <button type="button" id="app-font-import" class="sa-btn sa-btn-icon" title="Import a .ttf, .otf, .woff or .woff2 font" aria-label="Import a font file">+</button>
        <input type="file" id="app-font-file" accept=".ttf,.otf,.woff,.woff2" hidden>`),
      _row('Colours', `<span class="sa-swatches">${colours.map(([role, label]) => `
        <label class="sa-swatch" title="${label} colour">
          <span class="sa-swatch-dot"><input type="color" id="app-color-${role}" aria-label="${label} colour"></span>${label}
        </label>`).join('')}</span>`),
    ].join('')),
    _section('Sidebar', [
      _row('Position', `<span class="sa-segmented" id="app-sidebar-position" role="radiogroup" aria-label="Sidebar position">
        <button type="button" data-value="left" role="radio">Left</button><button type="button" data-value="right" role="radio">Right</button></span>`),
      _row('Backdrop Shadow', _toggle('app-sidebar-shadow', 'Show sidebar backdrop shadow')),
    ].join('')),
    _section('Glass', [
      _sliderRow('Interface Blur', 'app-shell-blur', 0, 60, 'Sidebar, Settings and menus'),
      _sliderRow('Interface Opacity', 'app-shell-opacity', 0, 100),
      _sliderRow('Panel Blur', 'app-panel-blur', 0, 60, 'Default for every panel'),
      _sliderRow('Panel Opacity', 'app-panel-opacity', 0, 100),
      '<div class="sa-panel-overrides"></div>',
    ].join('')),
  ].join('');

  // Theme
  const themeSelect = body.querySelector('#app-theme-select');
  themeSelect.innerHTML = APP_THEMES
    .map(theme => `<option value="${_escapeHtml(theme.id)}">${_escapeHtml(theme.label)}</option>`)
    .join('');
  themeSelect.value = getAppTheme();
  context.listen(themeSelect, 'change', () => setAppTheme(themeSelect.value));
  _syncOnStateLoaded(context, () => { themeSelect.value = getAppTheme(); });

  // Colours
  for (const [role] of colours) {
    const input = body.querySelector(`#app-color-${role}`);
    const dot = input.parentElement;
    const sync = () => {
      input.value = getSemanticColors()[role];
      dot.style.background = input.value;
    };
    sync();
    context.listen(input, 'input', () => { dot.style.background = input.value; setSemanticColor(role, input.value); });
    context.onCleanup(onSemanticColorChange(sync));
  }

  // Sidebar
  const position = body.querySelector('#app-sidebar-position');
  const syncPosition = () => {
    const value = appearanceState.sidebarPosition === 'left' ? 'left' : 'right';
    for (const button of position.querySelectorAll('button')) {
      const on = button.dataset.value === value;
      button.classList.toggle('active', on);
      button.setAttribute('aria-checked', String(on));
    }
  };
  syncPosition();
  for (const button of position.querySelectorAll('button')) {
    context.listen(button, 'click', () => setSidebarPosition(button.dataset.value));
  }
  context.onCleanup(onAppearanceChange(syncPosition));
  _syncOnStateLoaded(context, syncPosition);

  const shadowToggle = body.querySelector('#app-sidebar-shadow');
  const syncShadowToggle = () => { shadowToggle.checked = appearanceState.sidebarShadowVisible !== false; };
  syncShadowToggle();
  context.listen(shadowToggle, 'change', () => setSidebarShadowVisible(shadowToggle.checked));
  context.onCleanup(onAppearanceChange(syncShadowToggle));
  _syncOnStateLoaded(context, syncShadowToggle);

  // Glass. AMOLED uses solid surfaces, so the interface sliders do nothing there.
  const shellBlur = _bindSlider(body, context, 'app-shell-blur', () => normalizeShellBlur(appearanceState.shellBlur), setShellBlur, 'px');
  const shellOpacity = _bindSlider(body, context, 'app-shell-opacity', () => normalizeShellOpacity(appearanceState.shellOpacity), setShellOpacity, '%');
  const syncAmoled = () => {
    const solid = getAppTheme() === 'amoled';
    shellBlur.disabled = solid;
    shellOpacity.disabled = solid;
  };
  syncAmoled();
  context.onCleanup(onAppearanceChange(syncAmoled));
  _bindSlider(body, context, 'app-panel-blur', () => normalizePanelBlur(appearanceState.defaultPanelBlur), setDefaultPanelBlur, 'px');
  _bindSlider(body, context, 'app-panel-opacity', () => normalizePanelOpacity(appearanceState.defaultPanelOpacity), setDefaultPanelOpacity, '%');
  mountPanelAppearanceOverrides(body.querySelector('.sa-panel-overrides'), context, panels);

  // Font
  const select = body.querySelector('#app-font-select');
  const removeBtn = body.querySelector('#app-font-remove');
  const importBtn = body.querySelector('#app-font-import');
  const fileInput = body.querySelector('#app-font-file');

  // Rebuilds the <select>'s options from built-ins + whatever's imported,
  // and shows the remove button only for an imported (custom-) font.
  const renderOptions = () => {
    select.innerHTML = getAllAppFonts()
      .map(font => `<option value="${_escapeHtml(font.id)}">${_escapeHtml(font.label)}</option>`)
      .join('');
    select.value = appearanceState.fontFamily || DEFAULT_APP_FONT_ID;
    removeBtn.hidden = !select.value.startsWith('custom-');
  };
  renderOptions();

  const setImportFeedback = (message, isError) => {
    importBtn.textContent = isError ? '!' : '✓';
    importBtn.style.color = isError ? 'var(--color-negative, #f87171)' : 'var(--color-positive, #34d399)';
    importBtn.title = message;
    clearTimeout(importBtn._feedbackTimer);
    importBtn._feedbackTimer = setTimeout(() => {
      importBtn.textContent = '+';
      importBtn.style.color = '';
      importBtn.title = 'Import a .ttf, .otf, .woff or .woff2 font';
    }, isError ? 4000 : 1200);
  };

  context.listen(select, 'change', () => {
    setAppFont(select.value);
    removeBtn.hidden = !select.value.startsWith('custom-');
  });
  context.listen(importBtn, 'click', () => { fileInput.value = ''; fileInput.click(); });
  context.listen(fileInput, 'change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // let re-picking the same file re-fire 'change'
    if (!file) return;
    try {
      const { id } = await importAppFont(file);
      renderOptions();
      select.value = id;
      setAppFont(id);
      removeBtn.hidden = false;
      setImportFeedback('Imported', false);
    } catch (error) {
      setImportFeedback(error?.message || 'Import failed', true);
    }
  });
  context.listen(removeBtn, 'click', () => {
    removeAppFont(select.value);
    renderOptions();
  });

  _syncOnStateLoaded(context, renderOptions);
}

/**
 * Per-panel overrides, inside the Glass section: one row per panel that
 * opted into Core's panel appearance, with a Custom toggle; its own blur
 * and opacity sliders show only while Custom is on.
 */
export function mountPanelAppearanceOverrides(body, context, panels = []) {
  const targets = panels.filter(panel => panel.panelAppearance === true)
    .filter((panel, index, all) => panel?.id && all.findIndex(item => item.id === panel.id) === index);
  body.innerHTML = '';
  for (const target of targets) {
    const row = document.createElement('div');
    row.className = 'sa-panel-override';
    const name = _escapeHtml(target.label || target.id);
    row.innerHTML = `
      ${_row(`${target.label || target.id} Panel`, `<label class="sa-inline-toggle">Custom <label class="sm-toggle"><input type="checkbox" data-panel-override aria-label="Custom glass for ${name}"><span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span></label></label>`, 'Uses the panel defaults')}
      <div class="sa-nested" data-panel-controls>
        ${_row('Blur', `<span class="sa-slider"><input data-panel-blur class="crange" type="range" min="0" max="60" step="1" aria-label="${name} blur"><output data-panel-blur-value></output></span>`)}
        ${_row('Opacity', `<span class="sa-slider"><input data-panel-opacity class="crange" type="range" min="0" max="100" step="1" aria-label="${name} opacity"><output data-panel-opacity-value></output></span>`)}
      </div>`;
    body.appendChild(row);
    const toggle = row.querySelector('[data-panel-override]');
    const hint = row.querySelector('.sa-label small');
    const controls = row.querySelector('[data-panel-controls]');
    const blur = row.querySelector('[data-panel-blur]');
    const opacity = row.querySelector('[data-panel-opacity]');
    const blurValue = row.querySelector('[data-panel-blur-value]');
    const opacityValue = row.querySelector('[data-panel-opacity-value]');
    const sync = () => {
      const resolved = getPanelAppearance(target.id);
      toggle.checked = resolved.overridden;
      controls.hidden = !resolved.overridden;
      hint.textContent = resolved.overridden ? 'Its own blur and opacity' : 'Uses the panel defaults';
      blur.value = String(resolved.blur);
      opacity.value = String(resolved.opacity);
      blurValue.textContent = `${resolved.blur}px`;
      opacityValue.textContent = `${resolved.opacity}%`;
    };
    sync();
    context.listen(toggle, 'change', () => {
      if (toggle.checked) {
        const current = getPanelAppearance(target.id);
        setPanelAppearanceOverride(target.id, { blur: current.blur, opacity: current.opacity });
      } else clearPanelAppearanceOverride(target.id);
    });
    context.listen(blur, 'input', () => setPanelAppearanceOverride(target.id, { blur: Number(blur.value) }));
    context.listen(opacity, 'input', () => setPanelAppearanceOverride(target.id, { opacity: Number(opacity.value) }));
    context.onCleanup(onAppearanceChange(sync));
  }
}

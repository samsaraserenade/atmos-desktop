/**
 * js/core/settings-menu.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CORE — modal overlay ("Settings" in the ctx menu). Structured as a real
 * settings app for Core-owned controls. Plugin and service pages are built
 * from discovery metadata, so Atmos never needs to import an extension's
 * settings module merely to let the user disable that extension.
 *
 * The left navigation is entirely Core-owned: Appearance, About, Sidebar,
 * Panels, System, Plugins, and Services. Extension rows expose lifecycle controls
 * rather than extension-owned preference forms.
 *
 * Distinct from #settings-drawer (the "Sidebar" ctx-menu item) on purpose:
 * the sidebar is non-modal, always-visible widget content, driven by
 * sidebar-registry.js. This overlay is modal and on-demand.
 *
 * Deliberately NOT built on panel-registry.js: that registry owns workspace
 * panel mounting, layouts and section assignment. None of that applies to a
 * settings overlay, and reusing it would stretch "panel" to mean two
 * unrelated things.
 *
 * Crucially, this file reads installed extensions through the Core bridge;
 * it never imports their renderer modules to construct the management UI.
 *
 * DOM is built once, lazily, on first openSettingsMenu() call — not at
 * module-load time — same reasoning panel-registry.js's _panelEls() gives:
 * this module can be imported (e.g. by index.html's inline module script)
 * before <body> has finished parsing.
 *
 * Enablement changes are persisted by the main process and applied at the
 * next full restart. That lets both privileged main.cjs entry points and
 * renderer-side persist/sidebar/panel/boot modules be skipped before load.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getRegisteredSections, setSectionEnabled } from './sidebar-registry.js';
import { escapeHtml } from './escape-html.js';
import {
  PANEL_LAYOUTS, listPanelPlugins, getPanelLayout, getPanelSections,
  setPanelLayout, assignPanelPlugin,
} from './panel-registry.js';
import {
  getAppTheme, mountAppearanceControls, onAppearanceChange,
} from './appearance.js';
import {
  listSettingsPanels, mountSettingsPanel, unmountSettingsPanel,
} from './settings-registry.js';

// The first static page, handled directly by _renderNav()/_renderList().
// Declared up top since _activeCategory's default below references it.
const _HOME_PAGE_ID = '__home__';
const _ONBOARDING_PAGE_ID = '__onboarding__';

// Second static, non-registry page — same reasoning as _HOME_PAGE_ID above:
// which widgets show in the always-visible sidebar is a core concern
// (owned by sidebar-registry.js), not a plugin's own settings UI, so it
// doesn't belong to the Plugins/Services lifecycle controls either.
const _SIDEBAR_PAGE_ID = '__sidebar__';

// Third static, non-registry page — same reasoning again: which plugin
// currently occupies each workspace panel section (core/panel-registry.js) is a core
// concern, not any one plugin's own settings. Previously there was no
// dedicated switcher UI at all (panel-registry.js's listPanelPlugins() was
// added for exactly this, but nothing consumed it yet) — plugins could
// only activate a panel from their own code (e.g. total-chart.js's "]"
// shortcut). This page is that switcher, reusing the same accordion
// row shell as everything else in this file rather than introducing a new
// pattern — see _renderPanelsPage().
const _PANELS_PAGE_ID = '__panels__';

// Fourth static, non-registry page -- pulled the Theme/App Font controls
// out of the Atmos page (see _renderHome()) into their own destination so
// Atmos is just the "what version is this, what does it look like" page
// again, rather than doubling as the app-wide appearance settings.
const _APPEARANCE_PAGE_ID = '__appearance__';
// The extension manager: install, update and remove packages from sources
// (extension-manager.cjs in the main process), opened from the footer's
// Extensions button too.
const _EXTENSIONS_PAGE_ID = '__extensions__';
const _SYSTEM_PAGE_ID = 'System';
const _PLUGINS_PAGE_ID = 'Plugins';
const _SERVICES_PAGE_ID = 'Services';

let _overlay    = null;
let _navEl      = null;
let _listEl     = null;
let _headerEl   = null;
let _searchEl   = null;

// Refreshed on every open; search filtering uses this in-memory inventory.
let _extensions = { Plugins: [], Services: [] };

// Which Core-owned page is currently showing. Persists across opens/closes
// within a session so re-opening
// Settings doesn't dump you back on the first page. Starts on Home, same
// as Obsidian opening on "General".
let _activeCategory = _HOME_PAGE_ID;

// Current search text, scoped to the active page only (matches how the
// nav already scopes everything else — searching one page's rows, not a
// global search across pages).
let _searchTerm = '';
let _onboardingVisible = false;

// Shown in place of a plugin's own icon when it didn't register one — a
// generic puzzle-piece glyph, so a row never renders with a bare empty
// square. Plugins are free to pass their own `icon` to look distinct.
// Recentered via a translate — the raw path's ink sits from x:1–15 (not
// 5–19) within the 24x24 viewBox, so it renders visibly left-of-center
// inside its box without this offset.
const _FALLBACK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(4,0)"><path d="M4 7h3a2 2 0 1 1 4 0h3a1 1 0 0 1 1 1v3a2 2 0 1 0 0 4v3a1 1 0 0 1-1 1h-3a2 2 0 1 0-4 0H4a1 1 0 0 1-1-1v-3a2 2 0 1 1 0-4V8a1 1 0 0 1 1-1z"/></g></svg>`;

// Generic nav icon for the installed Plugins and Services pages.
const _CATEGORY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="18" r="1.6" fill="currentColor" stroke="none"/></svg>`;

const _SYSTEM_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.55 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.55a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.45 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.33.72.6 1 .3.28.68.42 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>`;

const _PACKAGE_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>`;

const _SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

// The Atmos page is a utility destination, so it uses the same restrained
// outline language as the rest of the settings navigation rather than the
// full-colour application icon.
const _INFO_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>`;

// Nav icon for the Sidebar page — a panel with a distinct left column, i.e.
// literally what the always-visible sidebar looks like next to the rest of
// the app.
const _SIDEBAR_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>`;

// Nav icon for the Panels page — a distinct bottom strip rather than a
// left column, distinct from the workspace panel layout above.
const _PANELS_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>`;
const _ONBOARDING_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>`;

// Nav icon for the Appearance page -- a paint brush, distinct from the
// info-circle Atmos glyph above it.
const _APPEARANCE_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.37 2.63 14 7l-1.5 4L9 13.5l-3.5 3.5 3.5 3.5L12.5 17l4-1.5 4.37-4.37a2.12 2.12 0 0 0-3-3z"/><path d="M9 13.5 3 21"/></svg>`;

// ── Home ─────────────────────────────────────────────────────────────────
const APP_NAME = 'ATMOS';

// Tiers as users see them: system (part of Atmos), official (bundled or
// signed with an official key), community (anything else; sandboxed).
const _TIER_LABELS = Object.freeze({ system: 'System', 'first-party': 'Official', 'third-party': 'Community' });

// Version comes from package.json's "version" field — the single source of
// truth electron-builder itself reads from — via app.getVersion() in the
// main process. Requested lazily (once, cached) so opening Settings never
// waits on it.
let _appVersion = null;
let _versionPromise = null;

// Cleanup callbacks registered by whatever's currently mounted on the Home
// page (see mountAppearanceControls() below) -- run and cleared at the top
// of every _renderHome() call, so navigating away and back (or the version
// fetch triggering a second render, see _loadVersion() below) never piles
// up duplicate onStateLoaded subscriptions.
let _pageCleanups = [];
function _clearPageCleanups() {
  for (const cleanup of _pageCleanups) { try { cleanup(); } catch (_error) { /* best effort */ } }
  _pageCleanups = [];
}
// mountAppearanceControls(body, context) just needs .listen()/.onCleanup() --
// the same minimal contract every registry section's own mount(body, context)
// gets -- not a whole panel/section context, which this modal doesn't have.
const _homeContext = {
  listen: (element, event, handler) => element.addEventListener(event, handler),
  onCleanup: fn => _pageCleanups.push(fn),
};

function _loadVersion() {
  if (_versionPromise) return _versionPromise;
  _versionPromise = Promise.resolve(window.atmosCore?.getAppVersion?.())
    .then(version => { _appVersion = version || null; })
    .catch(() => { _appVersion = null; })
    .then(() => {
      // If Home is already showing (version arrives after first paint),
      // re-render it so the placeholder gets replaced in place.
      if (_overlay && _activeCategory === _HOME_PAGE_ID) _renderHome();
    });
  return _versionPromise;
}


// The settings window is laid out for 1080p–1440p. On a larger window (a
// 4K screen at 100% Windows scaling, say) it grows with it: 1 up to
// 2560×1440 CSS pixels, then in proportion to the smaller of width and
// height, up to 2×. At 150% scaling a 4K screen is 2560 CSS pixels wide, so
// it stays 1 there.
const _BASE_WIDTH = 2560, _BASE_HEIGHT = 1440, _MAX_SCALE = 2;
export function settingsScale(width = window.innerWidth, height = window.innerHeight) {
  const scale = Math.min(width / _BASE_WIDTH, height / _BASE_HEIGHT);
  return Math.round(Math.min(_MAX_SCALE, Math.max(1, scale)) * 100) / 100;
}
function _applyScale() {
  document.documentElement.style.setProperty('--settings-scale', String(settingsScale()));
}

function _build() {
  if (_overlay) return;
  _applyScale();
  window.addEventListener('resize', _applyScale);

  _overlay = document.createElement('div');
  _overlay.id = 'settings-menu';
  _overlay.innerHTML = `
    <div id="settings-menu-backdrop"></div>
    <div id="settings-menu-panel">
      <div class="sm-sidebar">
        <div class="sm-sidebar-header">
          <div class="sm-sidebar-title">Settings</div>
          <button id="settings-menu-close" aria-label="Close">&times;</button>
        </div>
        <div class="sm-nav" id="sm-nav"></div>
      </div>
      <div class="sm-main">
        <div class="sm-main-header">
          <div class="sm-search">
            ${_SEARCH_ICON}
            <input type="text" id="sm-search-input" placeholder="Search…" autocomplete="off">
          </div>
        </div>
        <div id="settings-menu-list"></div>
      </div>
    </div>`;
  document.body.appendChild(_overlay);

  _navEl      = _overlay.querySelector('#sm-nav');
  _listEl     = _overlay.querySelector('#settings-menu-list');
  _headerEl   = _overlay.querySelector('.sm-main-header');
  _searchEl   = _overlay.querySelector('#sm-search-input');

  _overlay.querySelector('#settings-menu-backdrop').addEventListener('click', closeSettingsMenu);
  _overlay.querySelector('#settings-menu-close').addEventListener('click', closeSettingsMenu);

  _searchEl.addEventListener('input', () => {
    _searchTerm = _searchEl.value.trim().toLowerCase();
    _renderList();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _overlay.classList.contains('open')) closeSettingsMenu();
  });
}

function _renderNav() {
  _navEl.innerHTML = '';

  // Fall back to Home if a stale session value no longer names a page.
  const validPages = new Set([_HOME_PAGE_ID, _APPEARANCE_PAGE_ID, _SIDEBAR_PAGE_ID, _PANELS_PAGE_ID, _EXTENSIONS_PAGE_ID, _SYSTEM_PAGE_ID, _PLUGINS_PAGE_ID, _SERVICES_PAGE_ID]);
  if (_onboardingVisible) validPages.add(_ONBOARDING_PAGE_ID);
  if (!_activeCategory || !validPages.has(_activeCategory)) {
    _activeCategory = _HOME_PAGE_ID;
  }

  if (_onboardingVisible) {
    const onboardingItem = document.createElement('div');
    onboardingItem.className = 'sm-nav-item' + (_activeCategory === _ONBOARDING_PAGE_ID ? ' active' : '');
    onboardingItem.innerHTML = `
      <span class="sm-nav-icon">${_ONBOARDING_NAV_ICON}</span>
      <span class="sm-nav-label">Get Started</span>`;
    onboardingItem.addEventListener('click', () => {
      if (_activeCategory === _ONBOARDING_PAGE_ID) return;
      _activeCategory = _ONBOARDING_PAGE_ID;
      _searchTerm = '';
      _searchEl.value = '';
      _renderNav();
      _renderList();
    });
    _navEl.appendChild(onboardingItem);
  }

  const homeItem = document.createElement('div');
  homeItem.className = 'sm-nav-item' + (_activeCategory === _HOME_PAGE_ID ? ' active' : '');
  homeItem.innerHTML = `
    <span class="sm-nav-icon">${_INFO_NAV_ICON}</span>
    <span class="sm-nav-label">Atmos</span>`;
  homeItem.addEventListener('click', () => {
    if (_activeCategory === _HOME_PAGE_ID) return;
    _activeCategory = _HOME_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(homeItem);

  const appearanceItem = document.createElement('div');
  appearanceItem.className = 'sm-nav-item' + (_activeCategory === _APPEARANCE_PAGE_ID ? ' active' : '');
  appearanceItem.innerHTML = `
    <span class="sm-nav-icon">${_APPEARANCE_NAV_ICON}</span>
    <span class="sm-nav-label">Appearance</span>`;
  appearanceItem.addEventListener('click', () => {
    if (_activeCategory === _APPEARANCE_PAGE_ID) return;
    _activeCategory = _APPEARANCE_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(appearanceItem);

  const homeDivider = document.createElement('div');
  homeDivider.className = 'sm-nav-divider';
  homeDivider.setAttribute('aria-hidden', 'true');
  _navEl.appendChild(homeDivider);

  const sidebarItem = document.createElement('div');
  sidebarItem.className = 'sm-nav-item' + (_activeCategory === _SIDEBAR_PAGE_ID ? ' active' : '');
  sidebarItem.innerHTML = `
    <span class="sm-nav-icon">${_SIDEBAR_NAV_ICON}</span>
    <span class="sm-nav-label">Sidebar</span>`;
  sidebarItem.addEventListener('click', () => {
    if (_activeCategory === _SIDEBAR_PAGE_ID) return;
    _activeCategory = _SIDEBAR_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(sidebarItem);

  const panelsItem = document.createElement('div');
  panelsItem.className = 'sm-nav-item' + (_activeCategory === _PANELS_PAGE_ID ? ' active' : '');
  panelsItem.innerHTML = `
    <span class="sm-nav-icon">${_PANELS_NAV_ICON}</span>
    <span class="sm-nav-label">Panels</span>`;
  panelsItem.addEventListener('click', () => {
    if (_activeCategory === _PANELS_PAGE_ID) return;
    _activeCategory = _PANELS_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(panelsItem);

  const workspaceDivider = document.createElement('div');
  workspaceDivider.className = 'sm-nav-divider';
  workspaceDivider.setAttribute('aria-hidden', 'true');
  _navEl.appendChild(workspaceDivider);

  const managerItem = document.createElement('div');
  const attention = _managerAttentionCount();
  managerItem.className = 'sm-nav-item' + (_activeCategory === _EXTENSIONS_PAGE_ID ? ' active' : '');
  managerItem.innerHTML = `
    <span class="sm-nav-icon">${_PACKAGE_NAV_ICON}</span>
    <span class="sm-nav-label">Extensions</span>
    ${attention ? `<span class="sm-nav-count sm-nav-attention">${attention}</span>` : ''}`;
  managerItem.addEventListener('click', () => {
    if (_activeCategory === _EXTENSIONS_PAGE_ID) return;
    _activeCategory = _EXTENSIONS_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(managerItem);

  for (const category of [_SYSTEM_PAGE_ID, _PLUGINS_PAGE_ID, _SERVICES_PAGE_ID]) {
    const groupEntries = _extensionsForPage(category);
    const item = document.createElement('div');
    item.className = 'sm-nav-item' + (category === _activeCategory ? ' active' : '');
    item.innerHTML = `
      <span class="sm-nav-icon">${category === _SYSTEM_PAGE_ID ? _SYSTEM_NAV_ICON : _CATEGORY_ICON}</span>
      <span class="sm-nav-label">${category}</span>
      <span class="sm-nav-count">${groupEntries.length}</span>`;
    item.addEventListener('click', () => {
      if (_activeCategory === category) return;
      _activeCategory = category;
      _searchTerm = '';
      _searchEl.value = '';
      _renderNav();
      _renderList();
    });
    _navEl.appendChild(item);
  }
  _makeNavKeyboardFriendly();
}

/** The page list works from the keyboard too: Tab to an item, Enter or Space to open it. */
function _makeNavKeyboardFriendly() {
  _navEl.querySelectorAll('.sm-nav-item').forEach(item => {
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      item.click();
      _navEl.querySelector('.sm-nav-item.active')?.focus();
    });
  });
}

// First run of an installed Atmos: the extensions that come with it, to
// choose from (extension-manager.cjs installFromSeed). null until asked.
let _setup = null;

function _renderOnboarding() {
  _headerEl.classList.add('sm-no-search');
  if (_setup === null && window.atmosCore?.extensionManager?.setup) {
    _setup = { loading: true };
    window.atmosCore.extensionManager.setup().then(result => { _setup = result || { needed: false }; }, () => { _setup = { needed: false }; })
      .finally(() => { if (_activeCategory === _ONBOARDING_PAGE_ID) _renderList(); });
  }
  if (_setup?.loading) { _listEl.innerHTML = '<div id="settings-menu-empty">Loading…</div>'; return; }
  const plugins = (_setup?.packages || []).filter(item => item.kind === 'plugin');
  if (_setup?.needed && plugins.length) { _renderPicker(plugins); return; }
  if (_setup?.needed && _setup.error) { _renderPickerOffline(_setup.error); return; }
  _listEl.innerHTML = `
    <div class="sm-onboarding">
      <div class="sm-onboarding-kicker">Your space is ready</div>
      <h1>Make Atmos yours.</h1>
      <p>Atmos starts clean. Add only the plugins and shared services you want; the core discovers them when it starts.</p>
      <div class="sm-onboarding-steps">
        <div><span>1</span><strong>Choose</strong><small>Pick an Atmos extension.</small></div>
        <div><span>2</span><strong>Install</strong><small>From Settings → Extensions, or its folder.</small></div>
        <div><span>3</span><strong>Restart</strong><small>Atmos activates it automatically.</small></div>
      </div>
      <div class="sm-onboarding-actions">
        <button type="button" data-open-extension-root="plugins">Open plugins folder</button>
        <button type="button" class="secondary" data-open-extension-root="services">Open services folder</button>
      </div>
    </div>`;
  _listEl.querySelectorAll('[data-open-extension-root]').forEach(button => {
    button.addEventListener('click', () => window.atmosCore?.openExtensionRoot(button.dataset.openExtensionRoot));
  });
}

/** The first run without a connection: the extensions are downloaded, so offer to try again. */
function _renderPickerOffline(reason) {
  _listEl.innerHTML = `
    <div class="sm-onboarding sm-picker">
      <div class="sm-onboarding-kicker">Welcome to Atmos</div>
      <h1>Choose your extensions.</h1>
      <p>Atmos downloads its extensions, and the list couldn't be reached (${escapeHtml(reason)}). Check your connection and try again, or start with none and add them later in Settings → Extensions.</p>
      <div class="sm-onboarding-actions">
        <button type="button" data-picker="retry">Try again</button>
        <button type="button" class="secondary" data-picker="skip">Start with none</button>
      </div>
    </div>`;
  _listEl.querySelector('[data-picker="retry"]').addEventListener('click', () => { _setup = null; _renderList(); });
  _listEl.querySelector('[data-picker="skip"]').addEventListener('click', async () => {
    await window.atmosCore.extensionManager.finishSetup([]).catch(() => {});
    _setup = { needed: false };
    _onboardingVisible = false;
    _activeCategory = _HOME_PAGE_ID;
    closeSettingsMenu();
  });
}

/** The first-run picker: tick the plugins to install; what they need comes with them. */
function _renderPicker(plugins) {
  _listEl.innerHTML = `
    <div class="sm-onboarding sm-picker">
      <div class="sm-onboarding-kicker">Welcome to Atmos</div>
      <h1>Choose your extensions.</h1>
      <p>Atmos starts with nothing but its core. Tick what you want; the services each one needs are installed with it. You can add or remove any of them later in Settings → Extensions.</p>
      <div class="sm-picker-list">
        ${plugins.map(item => `
          <label class="sm-card sm-picker-item">
            <input type="checkbox" value="${escapeHtml(`${item.kind}:${item.id}`)}">
            <span class="sm-card-text">
              <span class="sm-card-name">${escapeHtml(item.displayName || item.id)}</span>
              <span class="sm-card-detail">${escapeHtml(item.description || '')}</span>
              ${_needsHtml({ dependencies: item.dependencies })}
            </span>
          </label>`).join('')}
      </div>
      <div class="sm-onboarding-actions">
        <button type="button" data-picker="install" disabled>Install and restart</button>
        <button type="button" class="secondary" data-picker="skip">Start with none</button>
      </div>
      <div class="sm-picker-error"></div>
    </div>`;
  const install = _listEl.querySelector('[data-picker="install"]');
  const chosen = () => [..._listEl.querySelectorAll('.sm-picker-item input:checked')].map(input => {
    const [kind, id] = input.value.split(':');
    return { kind, id };
  });
  _listEl.querySelectorAll('.sm-picker-item input').forEach(input => input.addEventListener('change', () => { install.disabled = !chosen().length; }));
  const finish = async (list, button) => {
    _listEl.querySelectorAll('[data-picker]').forEach(item => { item.disabled = true; });
    button.textContent = list.length ? 'Downloading…' : 'Starting…';
    try {
      await window.atmosCore.extensionManager.finishSetup(list);
      _setup = { needed: false };
      if (list.length) return window.atmosCore.restartAtmos();
      _onboardingVisible = false;
      _activeCategory = _HOME_PAGE_ID;
      closeSettingsMenu();
    } catch (error) {
      _listEl.querySelector('.sm-picker-error').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      _listEl.querySelectorAll('[data-picker]').forEach(item => { item.disabled = false; });
      button.textContent = list.length ? 'Install and restart' : 'Start with none';
    }
    return undefined;
  };
  install.addEventListener('click', () => finish(chosen(), install));
  _listEl.querySelector('[data-picker="skip"]').addEventListener('click', event => finish([], event.currentTarget));
}

function _renderHome() {
  _headerEl.classList.add('sm-no-search');
  _clearPageCleanups();

  // Wordmark image sits where the plain "ATMOS" text used to — falls back
  // to that same text (hidden by default) if assets/title.png 404s. The
  // app icon itself no longer duplicates here — it already shows next to
  // "About" in the sidebar nav (see _renderNav()), so title+version now
  // sit at the top of this column instead of below it.
  // The wordmark is a flat PNG (not currentColor-able like an SVG icon),
  // so a light theme needs its own dark-ink render of it rather than a CSS
  // filter -- assets/blacktitle.png is that counterpart to assets/title.png.
  const wordmarkSrc = getAppTheme() === 'atmos-light' ? 'assets/blacktitle.png' : 'assets/title.png';
  _listEl.innerHTML = `
    <div class="sm-home">
      <div class="sm-home-info">
        <div class="sm-home-title">
          <img src="${wordmarkSrc}" alt="${APP_NAME}">
          <div class="sm-home-title-fallback">${APP_NAME}</div>
        </div>
        <div class="sm-home-version">${_appVersion ? `Version ${_appVersion}` : 'Version —'}</div>
      </div>
      <div class="sm-about-logo">
        <img src="assets/Rev2.png" alt="Atmos mascot" id="sm-about-mascot">
      </div>
    </div>`;

  // Theme still affects the wordmark shown on this page even though its
  // own controls moved to the Appearance page (see _renderAppearancePage()
  // below) -- keep repainting it in place via the same pub/sub so a theme
  // change elsewhere doesn't require leaving and re-entering this page.
  const wordmarkImg = _listEl.querySelector('.sm-home-title img');
  // Without the image, the text fallback. (A listener, not an onerror
  // attribute: the page's Content-Security-Policy refuses inline handlers.)
  wordmarkImg?.addEventListener('error', () => {
    wordmarkImg.style.display = 'none';
    if (wordmarkImg.nextElementSibling) wordmarkImg.nextElementSibling.style.display = 'block';
  });
  _pageCleanups.push(onAppearanceChange(() => {
    if (wordmarkImg) wordmarkImg.src = getAppTheme() === 'atmos-light' ? 'assets/blacktitle.png' : 'assets/title.png';
  }));

  // A little "boop" reaction -- swap to the click variant for as long as the
  // mascot is actually being pressed, then revert. Covers mouse and touch,
  // and also reverts on mouseleave/cancel so a press-then-drag-off doesn't
  // strand it on the click frame.
  const mascotImg = _listEl.querySelector('#sm-about-mascot');
  if (mascotImg) {
    const restMascotSrc = 'assets/Rev2.png';
    const clickMascotSrc = 'assets/RevClickTSP.png';
    const press = () => { mascotImg.src = clickMascotSrc; };
    const release = () => { mascotImg.src = restMascotSrc; };
    mascotImg.addEventListener('mousedown', press);
    mascotImg.addEventListener('mouseup', release);
    mascotImg.addEventListener('mouseleave', release);
    mascotImg.addEventListener('touchstart', press, { passive: true });
    mascotImg.addEventListener('touchend', release);
    mascotImg.addEventListener('touchcancel', release);
  }
}

// Settings → Appearance: Core's Theme, Sidebar and Glass sections
// (appearance.js), then each extension's Appearance contribution as a
// section of its own, in `order` (Wallpaper, Location, then any others).
function _renderAppearancePage() {
  _headerEl.classList.add('sm-no-search');
  _clearPageCleanups();
  _listEl.innerHTML = `<div class="sm-appearance" id="sm-appearance-controls"></div>`;
  const page = _listEl.querySelector('#sm-appearance-controls');
  mountAppearanceControls(page, _homeContext, listPanelPlugins());

  const contributions = listSettingsPanels().filter(panel => panel.category === 'Appearance');
  for (const contribution of contributions) {
    const section = document.createElement('section');
    section.className = 'sa-section sm-appearance-contribution';
    const heading = document.createElement('div');
    heading.className = 'sa-heading';
    heading.textContent = contribution.label || contribution.id;
    const body = document.createElement('div');
    body.className = 'sm-appearance-contribution-body';
    section.append(heading, body);
    page.appendChild(section);
    mountSettingsPanel(contribution.id, body);
    _pageCleanups.push(() => unmountSettingsPanel(contribution.id));
  }
}

// The Extensions, System, Plugins, Services and Sidebar pages show their
// cards as a list or a grid: one choice for all of them, per viewer.
const _VIEW_KEY = 'atmos:extensions-view';
let _view = (() => { try { return localStorage.getItem(_VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } })();

function _viewToggleHtml() {
  return `<span class="sm-view-toggle" role="group" aria-label="Show as">
    <button type="button" data-view="list" aria-pressed="${_view === 'list'}" title="List"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg></button>
    <button type="button" data-view="grid" aria-pressed="${_view === 'grid'}" title="Grid"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg></button>
  </span>`;
}

/** Apply the list/grid choice to the page just rendered, and wire its toggle. */
function _applyView() {
  _listEl.classList.toggle('sm-as-grid', _view === 'grid');
  _listEl.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    _view = button.dataset.view === 'grid' ? 'grid' : 'list';
    try { localStorage.setItem(_VIEW_KEY, _view); } catch { /* per viewer only */ }
    _renderList();
  }));
}

/** An on/off switch; only the switch itself toggles (not the whole card). */
function _toggleHtml(checked, label) {
  return `<label class="sm-toggle" title="${checked ? 'On' : 'Off'}">
    <input type="checkbox" ${checked ? 'checked' : ''} aria-label="${escapeHtml(label)}">
    <span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span>
  </label>`;
}

function _renderSidebarPage() {
  _headerEl.classList.add('sm-no-search');

  // Sorted by `order` so the list reads in the same top-to-bottom sequence
  // the sidebar itself uses for a freshly-registered widget — not
  // necessarily the user's actual drag order (that's a DOM-order concept
  // owned by sidebar-shell.js's restoreSidebarOrder(), not something
  // getRegisteredSections() knows about), but a stable, sensible default.
  const widgets = getRegisteredSections().sort((a, b) => a.order - b.order);

  if (!widgets.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No sidebar widgets are registered yet.</div>`;
    return;
  }

  _listEl.innerHTML = `
    <div class="sm-extension-toolbar">
      <span>Choose which widgets appear in the sidebar.</span>
      <span class="sm-manager-actions">${_viewToggleHtml()}</span>
    </div>`;

  // Grouped by the extension each widget comes from, in sidebar order.
  const groups = new Map();
  for (const widget of widgets) {
    const owner = widget.owner || 'Atmos';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(widget);
  }
  for (const [owner, items] of groups) {
    _listEl.insertAdjacentHTML('beforeend', `<div class="sm-manager-subheading">${escapeHtml(owner)}<span>${items.length}</span></div>`);
    const group = document.createElement('div');
    group.className = 'sm-card-group';
    for (const { id, icon, label, enabled } of items) {
      const card = document.createElement('div');
      card.className = `sm-card sm-widget-card${enabled ? '' : ' disabled'}`;
      card.dataset.key = `widget:${id}`;
      card.innerHTML = `
        <div class="sm-card-main">
          <div class="sm-icon">${icon || _FALLBACK_ICON}</div>
          <div class="sm-card-text">
            <div class="sm-card-name">${escapeHtml(label || id)}</div>
          </div>
          ${_toggleHtml(enabled, `Show ${label || id}`)}
        </div>`;
      card.querySelector('input[type="checkbox"]').addEventListener('change', e => {
        setSectionEnabled(id, e.target.checked);
        card.classList.toggle('disabled', !e.target.checked);
      });
      group.appendChild(card);
    }
    _listEl.appendChild(group);
  }
  _applyView();
}

function _renderPanelsPage() {
  _headerEl.classList.add('sm-no-search');

  const panels = listPanelPlugins();

  if (!panels.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No panel plugins are registered yet.</div>`;
    return;
  }

  _listEl.innerHTML = `<div class="sm-sidebar-page-hint">Choose a tiled or freeform workspace, then assign a plugin to each section. The wallpaper stays behind the whole workspace.</div>`;

  const layouts = document.createElement('div');
  layouts.className = 'sm-panel-layouts';
  const activeLayout = getPanelLayout();
  for (const layout of PANEL_LAYOUTS) {
    const button = document.createElement('button');
    button.className = `sd-pill${layout.id === activeLayout ? ' active' : ''}`;
    button.textContent = layout.label;
    button.addEventListener('click', () => {
      setPanelLayout(layout.id);
      _renderPanelsPage();
    });
    layouts.appendChild(button);
  }
  _listEl.appendChild(layouts);

  const sections = getPanelSections();
  for (const section of sections) {
    const row = document.createElement('label');
    row.className = 'sm-panel-section';
    row.innerHTML = `<span class="sm-panel-section-name">${escapeHtml(section.label)}</span>`;
    const select = document.createElement('select');
    select.className = 'sm-panel-select';
    if (section.id !== 'main' || activeLayout === 'freeform') select.add(new Option('Empty', ''));
    for (const panel of panels) select.add(new Option(panel.label || panel.id, panel.id));
    select.value = section.pluginId || '';
    select.addEventListener('change', () => {
      try {
        assignPanelPlugin(section.id, select.value || null);
        _renderPanelsPage();
      } catch (error) {
        console.error('[settings-menu] panel assignment failed:', error);
        _renderPanelsPage();
      }
    });
    row.appendChild(select);
    _listEl.appendChild(row);
  }
}


function _extensionLabel(extension) {
  const declared = extension.manifest?.displayName || extension.manifest?.name;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return extension.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Trust states that keep an extension from loading (see extension-trust.cjs).
const _UNTRUSTED = new Set(['pending', 'changed', 'blocked', 'tampered', 'incompatible']);
const _STATUS_TEXT = {
  pending: 'needs approval',
  changed: 'changed since approval',
  blocked: 'blocked',
  tampered: 'files modified',
  incompatible: 'not for this Atmos',
};

/** Whether a restart would load or unload this extension. */
function _needsRestart(extension) {
  if (extension.approvalChanged || extension.developerRestart) return true;
  const wouldLoad = extension.enabled && !_UNTRUSTED.has(extension.status) && !(extension.dependencyProblems || []).length;
  return wouldLoad !== extension.active;
}

function _hasPendingRestart() {
  return [..._extensions.Plugins, ..._extensions.Services].some(_needsRestart);
}

function _extensionStatusText(extension) {
  if (extension.tier === 'system') return _UNTRUSTED.has(extension.status) ? _STATUS_TEXT[extension.status] : 'always on';
  if (extension.status === 'developer' && !_needsRestart(extension)) return 'developer folder, reloads when you save';
  if (extension.approvalChanged) return 'restart required';
  if (_UNTRUSTED.has(extension.status) && extension.enabled) return _STATUS_TEXT[extension.status];
  if (extension.enabled && (extension.dependencyProblems || []).length && !_needsRestart(extension)) {
    return extension.activationFailed ? "didn't start" : 'missing a dependency';
  }
  if (_needsRestart(extension)) return 'restart required';
  return extension.enabled ? 'loaded at startup' : 'not loaded';
}

const _SANDBOX_WARNING = 'Community extensions run in their own sandboxed frame: they cannot see the rest of Atmos, '
  + 'your other extensions or your files, can use only what other extensions share with community extensions, '
  + 'and can only connect to the sites listed above. They can still show you anything '
  + 'inside their own panel, so only approve extensions from people you trust.';

function _permissionList(lines, highlight = []) {
  const added = new Set(highlight);
  return `<ul class="sm-permission-list">${(lines || []).map(line => (
    `<li${added.has(line) ? ' class="sm-permission-new"' : ''}>${escapeHtml(line)}${added.has(line) ? ' <span>new</span>' : ''}</li>`
  )).join('')}</ul>`;
}

/** The summary with what an update added (named host by host) after it, where the summary doesn't already say it. */
function _withAdded(summary, added) {
  const lines = [...(summary || [])];
  for (const line of added || []) if (!lines.includes(line)) lines.push(line);
  return lines;
}

/** What it can use of the other extensions it declares (their "exports"). */
function _sharingHtml(extension) {
  const lines = extension.sharing || [];
  if (!lines.length) return '';
  return `<div class="sm-sharing-heading">From other extensions</div>${_permissionList(lines)}`;
}

/** Version, signer and dependencies, shown in the row's details. */
function _packageDetailsHtml(extension) {
  const names = list => list.map(item => escapeHtml(item.name)).join(', ');
  const required = (extension.dependencies || []).filter(dep => !dep.optional);
  const optional = (extension.dependencies || []).filter(dep => dep.optional);
  const lines = [];
  if (extension.version) lines.push(`Version ${escapeHtml(extension.version)}${extension.publisher ? ` · ${escapeHtml(extension.publisher)}` : ''}`);
  if (extension.tier === 'first-party') {
    lines.push(extension.source === 'installed' ? 'Signed package, checked against its signature'
      : extension.status === 'verified' ? 'Bundled with Atmos, checked' : 'Bundled with Atmos (running from source)');
  }
  if (required.length) lines.push(`Needs ${names(required)}`);
  if (optional.length) lines.push(`Works better with ${names(optional)}${(extension.optionalMissing || []).length ? ` (not loaded: ${extension.optionalMissing.map(escapeHtml).join(', ')})` : ''}`);
  if ((extension.usedBy || []).length) lines.push(`Used by ${names(extension.usedBy)}`);
  return lines.length ? `<ul class="sm-permission-list sm-package-details">${lines.map(line => `<li>${line}</li>`).join('')}</ul>` : '';
}

/** Approval, status and permissions shown under an extension's row. */
function _extensionTrustHtml(extension) {
  const summary = extension.permissionSummary || [];
  const status = extension.status;
  if (extension.approvalChanged) {
    return `<div class="sm-trust-note">${status === 'approved' ? 'Approval removed.' : 'Approved.'} Restart Atmos to apply.</div>`;
  }
  if (extension.tier !== 'third-party' && status === 'tampered') {
    const repair = extension.source === 'installed' ? 'Remove it and install it again.' : 'Reinstall Atmos to repair it.';
    return `<div class="sm-trust-note sm-trust-alert">Not loaded: ${escapeHtml(extension.statusReason)}. ${repair}</div>`;
  }
  if (extension.enabled && (extension.dependencyProblems || []).length && !_UNTRUSTED.has(status)) {
    return `<div class="sm-trust-note sm-trust-alert">Not loaded: ${extension.dependencyProblems.map(escapeHtml).join('. ')}.</div>`;
  }
  if (status === 'blocked' || status === 'incompatible') {
    return `<div class="sm-trust-note sm-trust-alert">Not loaded: ${escapeHtml(extension.statusReason)}.</div>`;
  }
  if ((status === 'pending' || status === 'changed') && extension.enabled) {
    const title = status === 'pending'
      ? 'This extension asks to:'
      : `${escapeHtml(extension.statusReason)}. Review it again. It asks to:`;
    return `
      <div class="sm-trust-note sm-trust-review">
        <div>${title}</div>
        ${_permissionList(status === 'changed' ? _withAdded(summary, extension.newPermissions) : summary, status === 'changed' ? extension.newPermissions : [])}
        ${_sharingHtml(extension)}
        <p class="sm-trust-warning">${_SANDBOX_WARNING}</p>
        <div class="sm-trust-actions">
          <button type="button" class="sm-restart-button" data-trust-action="approve">Approve</button>
          <button type="button" class="sm-trust-secondary" data-trust-action="keep-disabled">Keep disabled</button>
        </div>
        <div class="sm-trust-error" hidden></div>
      </div>`;
  }
  // Started with --dev-extension: loaded from where it's being written.
  const developer = status === 'developer'
    ? `<div class="sm-trust-note">Loaded for development from ${escapeHtml(extension.path || '')}, without approval. Its frames reload when you save a file; new or removed surfaces need a restart. It has the same limits as any community extension.</div>`
    : extension.developerIgnored
      ? `<div class="sm-trust-note sm-trust-alert">The developer folder ${escapeHtml(extension.developerIgnored)} has this extension's id, so it wasn't loaded: it would have used this copy's data. Remove this copy to develop it, or rename the folder.</div>`
      : '';
  const fellBack = extension.fellBackFrom
    ? `<div class="sm-trust-note sm-trust-alert">Version ${escapeHtml(extension.fellBackFrom.version || '')} couldn't load, so ${escapeHtml(extension.version || 'the bundled version')} is running instead. ${escapeHtml(extension.fellBackFrom.reason || extension.fellBackFrom.status)}.</div>`
    : '';
  return `${developer}${fellBack}
    <details class="sm-permissions">
      <summary>Details</summary>
      ${_packageDetailsHtml(extension)}
      ${_permissionList(summary)}
      ${_sharingHtml(extension)}
      ${extension.tier === 'third-party' && status === 'approved'
        ? '<button type="button" class="sm-trust-secondary" data-trust-action="revoke">Remove approval</button>'
        : ''}
    </details>`;
}

function _renderExtensionsPage() {
  _headerEl.classList.remove('sm-no-search');
  const extensions = _extensionsForPage(_activeCategory);
  const kind = _activeCategory === _PLUGINS_PAGE_ID ? 'plugin' : 'service'; // System and Services are services
  const filtered = _searchTerm
    ? extensions.filter(extension => `${_extensionLabel(extension)} ${extension.id}`.toLowerCase().includes(_searchTerm))
    : extensions;

  const pageNoun = _activeCategory === _SYSTEM_PAGE_ID ? 'system capabilities' : _activeCategory.toLowerCase();
  _searchEl.placeholder = `Search ${pageNoun}…`;

  if (!extensions.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No ${pageNoun} are installed.</div>`;
    return;
  }
  if (!filtered.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No matches for "${escapeHtml(_searchEl.value.trim())}".</div>`;
    return;
  }

  _listEl.innerHTML = `
    <div class="sm-extension-toolbar">
      <span>${_activeCategory === _SYSTEM_PAGE_ID
        ? 'System capabilities are built into Atmos and are always available.'
        : 'Disabled extensions are skipped before any of their code is loaded.'}</span>
      <span class="sm-manager-actions">
        ${_hasPendingRestart() ? '<button type="button" class="sm-restart-button">Restart Atmos</button>' : ''}
        ${_viewToggleHtml()}
      </span>
    </div>`;
  const group = document.createElement('div');
  group.className = 'sm-card-group';

  _listEl.querySelector('.sm-restart-button')?.addEventListener('click', () => {
    window.atmosCore?.restartAtmos?.();
  });

  for (const extension of filtered) {
    const label = _extensionLabel(extension);
    const system = extension.tier === 'system';
    const tierLabel = _TIER_LABELS[extension.tier] || _TIER_LABELS['third-party'];
    const card = document.createElement('div');
    card.className = `sm-card sm-extension-card${extension.enabled ? '' : ' disabled'}`;
    card.dataset.key = `${kind}:${extension.id}`;
    card.innerHTML = `
      <div class="sm-card-main">
        <div class="sm-icon">${_FALLBACK_ICON}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${escapeHtml(label)} <span class="sm-tier-badge" data-tier="${escapeHtml(extension.tier || 'third-party')}">${tierLabel}</span>${extension.source === 'developer' ? ' <span class="sm-tier-badge" data-tier="developer">Developer</span>' : ''}</div>
          <div class="sm-card-detail">${escapeHtml(extension.id)}${extension.version ? ` ${escapeHtml(extension.version)}` : ''} · ${escapeHtml(_extensionStatusText(extension))}</div>
        </div>
        ${system ? '' : _toggleHtml(extension.enabled, `Enable ${label}`)}
      </div>
      <div class="sm-extension-trust">${_extensionTrustHtml(extension)}</div>`;

    card.querySelectorAll('[data-trust-action]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.trustAction;
      const errorEl = card.querySelector('.sm-trust-error');
      button.disabled = true;
      try {
        if (action === 'approve') {
          await window.atmosCore?.approveExtension?.(kind, extension.id, extension.fingerprint);
          extension.approvalChanged = true;
        } else if (action === 'revoke') {
          await window.atmosCore?.revokeExtensionApproval?.(kind, extension.id);
          extension.approvalChanged = true;
        } else if (action === 'keep-disabled') {
          await window.atmosCore?.setExtensionEnabled?.(kind, extension.id, false);
          extension.enabled = false;
        }
        _renderNav();
        _renderExtensionsPage();
      } catch (error) {
        button.disabled = false;
        console.warn(`[settings] ${action} failed for ${kind} '${extension.id}':`, error.message);
        if (errorEl) {
          errorEl.hidden = false;
          errorEl.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        }
      }
    }));

    const toggle = card.querySelector('input[type="checkbox"]');
    toggle?.addEventListener('change', async () => {
      const nextEnabled = toggle.checked;
      toggle.disabled = true;
      try {
        await window.atmosCore?.setExtensionEnabled?.(kind, extension.id, nextEnabled);
        extension.enabled = nextEnabled;
        _renderNav();
        _renderExtensionsPage();
      } catch (error) {
        toggle.checked = !nextEnabled;
        toggle.disabled = false;
        console.warn(`[settings] failed to update ${kind} '${extension.id}':`, error.message);
      }
    });

    group.appendChild(card);
  }
  _listEl.appendChild(group);
  _applyView();
}

function _extensionsForPage(category) {
  if (category === _SYSTEM_PAGE_ID) return _extensions.Services.filter(extension => extension.tier === 'system');
  if (category === _SERVICES_PAGE_ID) return _extensions.Services.filter(extension => extension.tier !== 'system');
  return _extensions[category] || [];
}

function _renderList() {
  _clearPageCleanups();
  _headerEl.classList.remove('sm-no-search');
  _listEl.classList.remove('sm-as-grid');

  if (_activeCategory === _ONBOARDING_PAGE_ID) {
    _renderOnboarding();
    return;
  }

  if (_activeCategory === _HOME_PAGE_ID) {
    _renderHome();
    return;
  }

  if (_activeCategory === _APPEARANCE_PAGE_ID) {
    _renderAppearancePage();
    return;
  }

  if (_activeCategory === _SIDEBAR_PAGE_ID) {
    _renderSidebarPage();
    return;
  }

  if (_activeCategory === _EXTENSIONS_PAGE_ID) {
    _renderExtensionManagerPage();
    return;
  }

  if (_activeCategory === _PANELS_PAGE_ID) {
    _renderPanelsPage();
    return;
  }

  _renderExtensionsPage();
}

function _render() {
  _renderNav();
  _renderList();
}

/**
 * Redraw the current page for a change that came from elsewhere (a
 * background update check, an extension list refresh) without losing what
 * the user was doing: typed text, focus, open Details and scroll position.
 */
function _redrawKeepingState() {
  const typed = [..._listEl.querySelectorAll('input[type="text"], input:not([type])')].map(input => input.value);
  const focused = document.activeElement && _listEl.contains(document.activeElement)
    ? [..._listEl.querySelectorAll('input, button, select')].indexOf(document.activeElement) : -1;
  const openDetails = new Set([..._listEl.querySelectorAll('[data-key] details[open]')]
    .map(details => `${details.closest('[data-key]').dataset.key}|${[...details.closest('[data-key]').querySelectorAll('details')].indexOf(details)}`));
  const scroll = _listEl.scrollTop;
  _renderNav();
  _renderList();
  _listEl.querySelectorAll('input[type="text"], input:not([type])').forEach((input, index) => {
    if (typed[index] && !input.value) input.value = typed[index];
  });
  _listEl.querySelectorAll('[data-key]').forEach(card => card.querySelectorAll('details').forEach((details, index) => {
    if (openDetails.has(`${card.dataset.key}|${index}`)) details.open = true;
  }));
  _listEl.scrollTop = scroll;
  if (focused >= 0) _listEl.querySelectorAll('input, button, select')[focused]?.focus({ preventScroll: true });
}

async function _refreshExtensions() {
  try {
    const [plugins, services] = await Promise.all([
      window.atmosCore?.listPlugins?.() ?? [],
      window.atmosCore?.listServices?.() ?? [],
    ]);
    _extensions = { Plugins: plugins, Services: services };
    if (_overlay?.classList.contains('open')) _redrawKeepingState();
  } catch (error) {
    console.warn('[settings] failed to discover extensions:', error.message);
  }
}

// ── Extension manager page ───────────────────────────────────────────────

// Latest { status, summary } from the main process (extensions:manager-*).
let _manager = null;
let _managerBusy = new Set();     // "kind:id" or 'check'/'source' while a request runs
let _managerError = null;          // { key, message } shown beside what failed
let _confirmRemove = null;         // "kind:id" whose remove confirmation is open
let _managerSubscribed = false;

function _managerAttentionCount() {
  const summary = _manager?.summary;
  return summary ? (summary.atmosUpdate ? 1 : 0) + (summary.updates || 0) + (summary.pending || 0) + (summary.problems?.length || 0) : 0;
}

function _setManager(payload) {
  if (!payload?.status) return;
  _manager = { status: payload.status, summary: payload.summary };
  if (!_overlay?.classList.contains('open')) return;
  if (_activeCategory === _EXTENSIONS_PAGE_ID) _redrawKeepingState();
  else _renderNav();
}

async function _loadManager() {
  const api = window.atmosCore?.extensionManager;
  if (!api) return;
  if (!_managerSubscribed) {
    _managerSubscribed = true;
    api.onChange(payload => {
      _setManager(payload);
      // Installed lists (versions, "Used by") may have changed too.
      void _refreshExtensions();
    });
  }
  try { _setManager(await api.status()); } catch (error) { console.warn('[settings] extension manager unavailable:', error.message); }
}

/** Run a manager request, showing it as busy and its error beside `key`. */
async function _managerRequest(key, run) {
  _managerBusy.add(key);
  _managerError = null;
  _renderList();
  try {
    const payload = await run(window.atmosCore.extensionManager);
    if (payload?.status) _setManager(payload);
    return payload;
  } catch (error) {
    _managerError = { key, message: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    return null;
  } finally {
    _managerBusy.delete(key);
    if (_activeCategory === _EXTENSIONS_PAGE_ID) _renderList();
  }
}

function _formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function _formatWhen(iso) {
  if (!iso) return 'not yet';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
}

function _managerErrorHtml(key) {
  return _managerError?.key === key ? `<div class="sm-trust-error">${escapeHtml(_managerError.message)}</div>` : '';
}


/**
 * What an extension needs, as chips: its required dependencies ("Needs"),
 * its optional ones ("Optional"), and for a service what uses it ("Used by").
 * `dependencies` is [{ name, optional }]; `usedBy` is [{ name }].
 */
function _needsHtml({ dependencies = [], usedBy = [] } = {}) {
  const chips = (items, extra = '') => items.map(item => `<span class="sm-manager-chip${extra}">${escapeHtml(item.name)}</span>`).join('');
  // System services (Audio, Wallpaper, Location) are always there: not worth a chip.
  const required = dependencies.filter(dep => !dep.optional && !dep.system);
  const optional = dependencies.filter(dep => dep.optional && !dep.system);
  const parts = [];
  if (required.length) parts.push(`<span class="sm-manager-needs-label">Needs</span>${chips(required)}`);
  if (optional.length) parts.push(`<span class="sm-manager-needs-label">Optional</span>${chips(optional, ' optional')}`);
  if (usedBy.length) parts.push(`<span class="sm-manager-needs-label">Used by</span>${chips(usedBy, ' used-by')}`);
  return parts.length ? `<div class="sm-manager-needs">${parts.join('')}</div>` : '';
}

/** Rows split into Plugins and Services, each a list or grid of cards. */
function _groupByKind(items, render) {
  const out = [];
  for (const [kind, label] of [['plugin', 'Plugins'], ['service', 'Services']]) {
    const mine = items.filter(item => item.kind === kind);
    if (!mine.length) continue;
    out.push(`<div class="sm-manager-subheading">${label}<span>${mine.length}</span></div>`);
    out.push(`<div class="sm-card-group">${mine.map(render).join('')}</div>`);
  }
  return out.join('');
}

function _managerRow({ key, name, detail, actions = '', extra = '', needs = '' }) {
  return `
    <div class="sm-card sm-manager-row" data-key="${escapeHtml(key)}">
      <div class="sm-card-main sm-manager-main">
        <div class="sm-icon">${_FALLBACK_ICON}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${name}</div>
          <div class="sm-card-detail">${detail}</div>
          ${needs}
        </div>
        <div class="sm-manager-actions">${actions}</div>
      </div>
      ${extra}
      ${_managerErrorHtml(key)}
    </div>`;
}

function _button(action, label, { key, primary = false, busyLabel = null } = {}) {
  const busy = key && _managerBusy.has(key);
  return `<button type="button" class="${primary ? 'sm-restart-button' : 'sm-trust-secondary'}" data-manager-action="${action}"${busy ? ' disabled' : ''}>${escapeHtml(busy && busyLabel ? busyLabel : label)}</button>`;
}

/**
 * Optional extensions a row's extension can use (its optional dependencies
 * that a source has and that aren't installed), each with its own Install.
 */
function _optionalOffersHtml(key) {
  const offers = _manager?.status?.optional?.[key] || [];
  return offers.map(offer => {
    const target = `${offer.kind}:${offer.id}`;
    const busy = _managerBusy.has(target);
    return `
      <div class="sm-trust-note sm-manager-optional" data-target="${escapeHtml(target)}">
        <span>Optional: ${escapeHtml(offer.displayName || offer.id)} ${escapeHtml(offer.version)}${offer.description ? ` · ${escapeHtml(offer.description)}` : ''}</span>
        <button type="button" class="sm-trust-secondary" data-manager-action="install-optional"${busy ? ' disabled' : ''}>${busy ? 'Downloading…' : 'Install'}</button>
        ${_managerErrorHtml(target)}
      </div>`;
  }).join('');
}

/**
 * What removing `extension` would leave unused: installed, removable
 * extensions it depends on (and so on down) that nothing else installed
 * uses, and that aren't already being removed.
 */
function _leftUnused(extension, installed, pendingByKey) {
  const byRef = new Map(installed.map(item => [`${item.kind}:${item.id}`, item]));
  const going = new Set([`${extension.kind}:${extension.id}`,
    ...[...pendingByKey.values()].filter(change => change.action === 'remove').map(change => `${change.kind}:${change.id}`)]);
  const out = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const ref of going) {
      for (const dep of byRef.get(ref)?.dependencies || []) {
        const target = byRef.get(dep.ref);
        if (!target || going.has(dep.ref) || !target.removable || target.tier === 'system') continue;
        if ((target.usedBy || []).some(user => !going.has(user.ref) && byRef.has(user.ref))) continue;
        going.add(dep.ref);
        out.push(target);
        changed = true;
      }
    }
  }
  return out;
}

function _renderExtensionManagerPage() {
  _headerEl.classList.add('sm-no-search');
  if (!window.atmosCore?.extensionManager) {
    _listEl.innerHTML = '<div id="settings-menu-empty">The extension manager is not available.</div>';
    return;
  }
  if (!_manager) {
    _listEl.innerHTML = '<div id="settings-menu-empty">Loading…</div>';
    return;
  }
  const { status, summary } = _manager;
  const pendingByKey = new Map(status.pending.map(change => [`${change.kind}:${change.id}`, change]));
  const installedExtensions = [..._extensions.Plugins, ..._extensions.Services];
  const sections = [];

  // Header: when the sources were last checked, and restart when changes wait.
  sections.push(`
    <div class="sm-extension-toolbar">
      <span>${status.checkedAt ? `Checked ${escapeHtml(_formatWhen(status.checkedAt))}` : 'Not checked yet'}. Updates are only downloaded when you press Update.</span>
      <span class="sm-manager-actions">
        ${status.pending.length ? '<button type="button" class="sm-restart-button" data-manager-action="restart">Restart to apply</button>' : ''}
        ${_button('check', 'Check for updates', { key: 'check', busyLabel: 'Checking…' })}
        ${_viewToggleHtml()}
      </span>
    </div>
    ${_managerErrorHtml('check')}`);

  // A newer Atmos: the version from a source's signed index, the download
  // page from Core's own settings (the main process opens it).
  if (summary.atmosUpdate) {
    const { version, current, download } = summary.atmosUpdate;
    sections.push(`<div class="sm-manager-heading">Atmos</div><div class="sm-card-group">`);
    sections.push(_managerRow({
      key: 'atmos',
      name: `Atmos ${escapeHtml(version)} is available`,
      detail: `You have ${escapeHtml(current || 'an older version')}. Download the new installer and run it; your settings and extensions stay.`,
      actions: download ? _button('download-atmos', 'Download', { key: 'atmos', primary: true, busyLabel: 'Opening…' }) : '',
    }));
    sections.push('</div>');
  }

  if (summary.problems.length) {
    sections.push(`<div class="sm-manager-heading">Needs attention</div>`);
    for (const problem of summary.problems) {
      sections.push(`<div class="sm-trust-note sm-trust-alert sm-manager-problem">${escapeHtml(problem.name)}: ${escapeHtml(problem.reason)}</div>`);
    }
  }

  const failed = (status.applied || []).filter(record => record.failed);
  for (const record of failed) {
    sections.push(`<div class="sm-trust-note sm-trust-alert sm-manager-problem">The update of ${escapeHtml(record.id)} to ${escapeHtml(record.version)} couldn't load${record.running ? `; ${escapeHtml(record.running.version || '')} is running instead` : ''}.</div>`);
  }

  if (status.pending.length) {
    sections.push(`<div class="sm-manager-heading">Waiting for a restart</div><div class="sm-card-group">`);
    for (const change of status.pending) {
      const key = `${change.kind}:${change.id}`;
      const what = change.action === 'remove'
        ? `Remove${change.deleteData ? ', and delete its data' : ', keeping its data'}`
        : `${change.reason === 'update' ? 'Update to' : change.reason === 'dependency' ? 'Install (needed by another extension)' : change.reason === 'recommended' ? 'Install (comes with another extension)' : 'Install'} ${change.version}`;
      sections.push(_managerRow({
        key,
        name: escapeHtml(change.displayName || change.id),
        detail: `${escapeHtml(what)}${change.error ? ` · failed last time: ${escapeHtml(change.error)}` : ''}`,
        actions: _button('cancel', 'Cancel', { key }),
        extra: change.action === 'install' ? _optionalOffersHtml(key) : '',
      }));
    }
    sections.push('</div>');
  }

  const updates = status.packages.filter(item => item.action === 'update' && !pendingByKey.has(`${item.kind}:${item.id}`));
  if (updates.length) {
    sections.push(`<div class="sm-manager-heading">Updates</div>`);
    sections.push(_groupByKind(updates, item => {
      const key = `${item.kind}:${item.id}`;
      return _managerRow({
        key,
        name: escapeHtml(item.displayName || item.id),
        detail: `${escapeHtml(item.installedVersion)} → ${escapeHtml(item.version)} · ${escapeHtml(_formatSize(item.size))}`,
        actions: _button('install', 'Update', { key, primary: true, busyLabel: 'Downloading…' }),
      });
    }));
  }

  const available = status.packages.filter(item => item.action === 'install' && !pendingByKey.has(`${item.kind}:${item.id}`));
  if (available.length) {
    sections.push(`<div class="sm-manager-heading">Available</div>`);
    sections.push(_groupByKind(available, item => {
      const key = `${item.kind}:${item.id}`;
      const replaces = item.installedTier === 'third-party' ? ' · replaces the community copy' : '';
      return _managerRow({
        key,
        name: `${escapeHtml(item.displayName || item.id)} <span class="sm-tier-badge" data-tier="first-party">Official</span>`,
        detail: `${escapeHtml(item.version)} · ${escapeHtml(_formatSize(item.size))}${item.description ? ` · ${escapeHtml(item.description)}` : ''}${replaces}`,
        needs: _needsHtml({ dependencies: item.dependencies }),
        actions: _button('install', 'Install', { key, primary: true, busyLabel: 'Downloading…' }),
        extra: _optionalOffersHtml(key),
      });
    }));
  }

  const removable = installedExtensions.filter(extension => extension.removable && !pendingByKey.has(`${extension.kind}:${extension.id}`));
  if (removable.length) {
    sections.push(`<div class="sm-manager-heading">Installed</div>`);
    sections.push(_groupByKind(removable, extension => {
      const key = `${extension.kind}:${extension.id}`;
      const confirming = _confirmRemove === key;
      const bundled = extension.bundledFallback === true;
      return _managerRow({
        key,
        name: `${escapeHtml(_extensionLabel(extension))} <span class="sm-tier-badge" data-tier="${escapeHtml(extension.tier)}">${_TIER_LABELS[extension.tier] || ''}</span>`,
        detail: `${extension.version ? escapeHtml(extension.version) : ''}${extension.manifest?.description ? ` · ${escapeHtml(extension.manifest.description)}` : ''}`,
        needs: _needsHtml({ dependencies: extension.dependencies, usedBy: extension.usedBy }),
        actions: confirming ? '' : _button('ask-remove', 'Remove', { key }),
        extra: confirming ? `
          <div class="sm-trust-note sm-trust-review sm-manager-confirm">
            <div>Remove ${escapeHtml(_extensionLabel(extension))} when Atmos restarts?${bundled ? ' The version that comes with Atmos is used again.' : ''}</div>
            <label class="sm-manager-choice"><input type="radio" name="remove-data-${escapeHtml(key)}" value="keep" checked> Keep its settings and data</label>
            <label class="sm-manager-choice"><input type="radio" name="remove-data-${escapeHtml(key)}" value="delete"> Delete its settings and data</label>
            ${(() => {
              const unused = _leftUnused(extension, installedExtensions, pendingByKey);
              return unused.length ? `<div class="sm-manager-also">Nothing else uses these; remove them too:</div>
                ${unused.map(item => `<label class="sm-manager-choice"><input type="checkbox" data-also-remove="${escapeHtml(`${item.kind}:${item.id}`)}" checked> ${escapeHtml(_extensionLabel(item))}</label>`).join('')}` : '';
            })()}
            <div class="sm-trust-actions">
              ${_button('remove', 'Remove', { key, primary: true })}
              <button type="button" class="sm-trust-secondary" data-manager-action="keep">Cancel</button>
            </div>
          </div>` : _optionalOffersHtml(key),
      });
    }));
  }

  // Sources: where packages come from.
  sections.push(`<div class="sm-manager-heading">Sources</div>`);
  if (!status.sources.length) {
    sections.push('<div class="sm-trust-note sm-manager-empty">No sources yet. Add a folder or an https:// address that has an index.json.</div>');
  }
  for (const source of status.sources) {
    const state = source.ok === null || source.ok === undefined ? 'not checked yet'
      : source.ok ? `${source.packages} package${source.packages === 1 ? '' : 's'}` : source.error;
    sections.push(`
      <div class="sm-manager-source${source.ok === false ? ' sm-trust-alert' : ''}" data-location="${escapeHtml(source.location)}">
        <span class="sm-manager-source-name">${escapeHtml(source.name ? `${source.name} · ` : '')}${escapeHtml(source.location)}</span>
        <span class="sm-manager-source-state">${escapeHtml(state)}${source.origin === 'built-in' ? ' · built in' : source.origin === 'session' ? ' · this session' : ''}</span>
        ${source.origin === 'user' ? '<button type="button" class="sm-trust-secondary" data-manager-action="remove-source">Remove</button>' : ''}
      </div>`);
  }
  sections.push(`
    <form class="sm-manager-add-source">
      <input type="text" placeholder="Folder or https:// address" aria-label="New source">
      ${_button('add-source', 'Add source', { key: 'source' })}
    </form>
    ${_managerErrorHtml('source')}`);

  _listEl.innerHTML = sections.join('');
  _applyView();

  _listEl.querySelector('.sm-manager-add-source')?.addEventListener('submit', event => {
    event.preventDefault();
    _listEl.querySelector('.sm-manager-add-source [data-manager-action="add-source"]')?.click();
  });

  _listEl.querySelectorAll('[data-manager-action]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const action = button.dataset.managerAction;
    const row = button.closest('[data-key]');
    const key = row?.dataset.key;
    const [kind, id] = (key || '').split(':');
    if (action === 'restart') return window.atmosCore?.restartAtmos?.();
    if (action === 'check') return _managerRequest('check', api => api.checkForUpdates());
    if (action === 'download-atmos') return _managerRequest('atmos', api => api.openAtmosDownload());
    if (action === 'install') return _managerRequest(key, api => api.install(kind, id));
    if (action === 'install-optional') {
      const target = button.closest('[data-target]')?.dataset.target || '';
      const [targetKind, targetId] = target.split(':');
      return _managerRequest(target, api => api.install(targetKind, targetId));
    }
    if (action === 'cancel') return _managerRequest(key, api => api.cancel(kind, id));
    if (action === 'ask-remove') { _confirmRemove = key; _managerError = null; return _renderList(); }
    if (action === 'keep') { _confirmRemove = null; return _renderList(); }
    if (action === 'remove') {
      const deleteData = row.querySelector('input[value="delete"]')?.checked === true;
      const also = [...row.querySelectorAll('input[data-also-remove]:checked')].map(input => input.dataset.alsoRemove.split(':'));
      // The extension first, so what only it needed is free to go.
      return _managerRequest(key, async api => {
        let payload = await api.remove(kind, id, { deleteData });
        for (const [alsoKind, alsoId] of also) payload = await api.remove(alsoKind, alsoId, { deleteData });
        return payload;
      }).then(payload => {
        if (payload) _confirmRemove = null;
        _renderList();
      });
    }
    if (action === 'remove-source') {
      const location = button.closest('[data-location]')?.dataset.location;
      return _managerRequest('source', api => api.removeSource(location));
    }
    if (action === 'add-source') {
      const input = _listEl.querySelector('.sm-manager-add-source input');
      return _managerRequest('source', api => api.addSource(input?.value || ''));
    }
    return undefined;
  }));
}

// ── Public API ───────────────────────────────────────────────────────────

/** Settings, opened on the extension manager (the footer's Extensions button). */
export function openExtensionManager() {
  _activeCategory = _EXTENSIONS_PAGE_ID;
  openSettingsMenu();
}

export function openSettingsMenu() {
  _build();
  _loadVersion();
  _render();
  _overlay.classList.add('open');
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
  _refreshExtensions();
  void _loadManager();
}

export function openOnboardingSettings() {
  _onboardingVisible = true;
  _activeCategory = _ONBOARDING_PAGE_ID;
  openSettingsMenu();
}

export function closeSettingsMenu() {
  _overlay?.classList.remove('open');
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
}

export function toggleSettingsMenu() {
  if (_overlay?.classList.contains('open')) closeSettingsMenu();
  else openSettingsMenu();
}

export function isSettingsMenuOpen() {
  return !!_overlay?.classList.contains('open');
}

/**
 * js/core/settings-menu.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CORE — modal overlay ("Settings" in the ctx menu). Structured as a real
 * settings app for Core-owned controls. Plugin and service pages are built
 * from discovery metadata, so Atmos never needs to import an extension's
 * settings module merely to let the user disable that extension.
 *
 * The left navigation is entirely Core-owned: Atmos, Appearance, Sidebar,
 * Panels, Browser, Extensions and System. Extensions is one page: Atmos's
 * own update, approvals, updates, what's available and the sources at the
 * top, then the installed plugins and services, each split into Official
 * and Community. Extension cards expose lifecycle controls rather than
 * extension-owned preference forms.
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
// only activate a panel from their own code. This page is that switcher, reusing the same accordion
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
// Atmos Browser's settings: a page of their own above Extensions, since the
// browser is what Atmos is built around (extension-frames.cjs gives its
// settings contribution the "Browser" category).
const _BROWSER_PAGE_ID = '__browser__';
// Atmos's own capabilities (Audio, Wallpaper): always on. Every
// other plugin and service is on the Extensions page.
const _SYSTEM_PAGE_ID = 'System';

let _overlay    = null;
let _navEl      = null;
let _listEl     = null;
let _headerEl   = null;
let _headerActionsEl = null; // the page's own buttons, beside the search box
let _searchEl   = null;

// Refreshed on every open; search filtering uses this in-memory inventory.
let _extensions = { Plugins: [], Services: [] };
// "kind:id" of community extensions approved and loaded this session.
const _approvedThisSession = new Set();

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

const _SYSTEM_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.55 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.55a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.45 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.33.72.6 1 .3.28.68.42 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>`;

const _BROWSER_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>`;
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
          <div class="sm-header-actions" id="sm-header-actions"></div>
        </div>
        <div id="settings-menu-list"></div>
      </div>
    </div>`;
  document.body.appendChild(_overlay);

  _navEl      = _overlay.querySelector('#sm-nav');
  _listEl     = _overlay.querySelector('#settings-menu-list');
  _headerEl   = _overlay.querySelector('.sm-main-header');
  _headerActionsEl = _overlay.querySelector('#sm-header-actions');
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
  const browserSettings = _browserSettingsPanels();
  const validPages = new Set([_HOME_PAGE_ID, _APPEARANCE_PAGE_ID, _SIDEBAR_PAGE_ID, _PANELS_PAGE_ID, _EXTENSIONS_PAGE_ID, _SYSTEM_PAGE_ID]);
  if (browserSettings.length) validPages.add(_BROWSER_PAGE_ID);
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
    <span class="sm-nav-label">Atmos</span>
    ${_manager?.summary?.atmosUpdate ? '<span class="sm-nav-count sm-nav-attention" aria-label="A newer Atmos">1</span>' : ''}`;
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

  // Atmos Browser, while it runs (switched off, it has no settings to show).
  if (browserSettings.length) {
    const browserItem = document.createElement('div');
    browserItem.className = 'sm-nav-item' + (_activeCategory === _BROWSER_PAGE_ID ? ' active' : '');
    browserItem.innerHTML = `
      <span class="sm-nav-icon">${_BROWSER_NAV_ICON}</span>
      <span class="sm-nav-label">Browser</span>`;
    browserItem.addEventListener('click', () => {
      if (_activeCategory === _BROWSER_PAGE_ID) return;
      _activeCategory = _BROWSER_PAGE_ID;
      _searchTerm = '';
      _searchEl.value = '';
      _renderNav();
      _renderList();
    });
    _navEl.appendChild(browserItem);
  }

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

  const systemItem = document.createElement('div');
  systemItem.className = 'sm-nav-item' + (_activeCategory === _SYSTEM_PAGE_ID ? ' active' : '');
  systemItem.innerHTML = `
    <span class="sm-nav-icon">${_SYSTEM_NAV_ICON}</span>
    <span class="sm-nav-label">System</span>
    <span class="sm-nav-count">${_systemExtensions().length}</span>`;
  systemItem.addEventListener('click', () => {
    if (_activeCategory === _SYSTEM_PAGE_ID) return;
    _activeCategory = _SYSTEM_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  _navEl.appendChild(systemItem);
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

/** What Atmos ships with (Atmos Browser), already there before anything is chosen: names. */
function _pickerBuiltIn() {
  return (_setup?.builtIn || []).map(item => String(item?.displayName || item?.id || '')).filter(Boolean);
}

/** "Atmos Browser", "A and B", "A, B and C". */
function _namesText(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The picker's way out: nothing more than what Atmos comes with. */
function _pickerSkipLabel() {
  const builtIn = _pickerBuiltIn();
  return builtIn.length ? `Just ${builtIn.length === 1 ? builtIn[0] : 'these'}` : 'Start with none';
}

/** The first run without a connection: the extensions are downloaded, so offer to try again. */
function _renderPickerOffline(reason) {
  const builtIn = _pickerBuiltIn();
  const later = builtIn.length
    ? `or start with just ${escapeHtml(_namesText(builtIn))} and add the rest later in Settings → Extensions`
    : 'or start with none and add them later in Settings → Extensions';
  _listEl.innerHTML = `
    <div class="sm-onboarding sm-picker">
      <div class="sm-onboarding-kicker">Welcome to Atmos</div>
      <h1>Choose your extensions.</h1>
      <p>Atmos downloads its extensions, and the list couldn't be reached (${escapeHtml(reason)}). Check your connection and try again, ${later}.</p>
      <div class="sm-onboarding-actions">
        <button type="button" data-picker="retry">Try again</button>
        <button type="button" class="secondary" data-picker="skip">${escapeHtml(_pickerSkipLabel())}</button>
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
  const builtIn = _pickerBuiltIn();
  const intro = builtIn.length
    ? `${escapeHtml(_namesText(builtIn))} ${builtIn.length === 1 ? 'is' : 'are'} built in. Tick what else you want beside ${builtIn.length === 1 ? 'it' : 'them'}; the services each one needs are installed with it. You can add or remove any of them later in Settings → Extensions.`
    : 'Atmos starts with nothing but its core. Tick what you want; the services each one needs are installed with it. You can add or remove any of them later in Settings → Extensions.';
  _listEl.innerHTML = `
    <div class="sm-onboarding sm-picker">
      <div class="sm-onboarding-kicker">Welcome to Atmos</div>
      <h1>Choose your extensions.</h1>
      <p>${intro}</p>
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
        <button type="button" class="secondary" data-picker="skip">${escapeHtml(_pickerSkipLabel())}</button>
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
      button.textContent = list.length ? 'Install and restart' : _pickerSkipLabel();
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
        <div class="sm-home-updates">${_atmosHomeHtml()}</div>
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

  _wireManagerActions();
}

// Settings → Appearance: Core's Theme, Sidebar and Glass sections
// (appearance.js), then each extension's Appearance contribution as a
// section of its own, in `order` (Wallpaper, then Location and any others).
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

/** Settings contributions for the Browser page (Atmos Browser's). */
function _browserSettingsPanels() {
  return listSettingsPanels().filter(panel => panel.category === 'Browser');
}

// Settings → Browser: Atmos Browser's own settings (search engine, links,
// downloads, ads and trackers, tabs, site permissions, clearing data), the
// whole page, its sections drawn by the browser itself.
function _renderBrowserPage() {
  _headerEl.classList.add('sm-no-search');
  _clearPageCleanups();
  _listEl.innerHTML = '<div class="sm-appearance sm-browser-settings" id="sm-browser-settings"></div>';
  const page = _listEl.querySelector('#sm-browser-settings');
  for (const contribution of _browserSettingsPanels()) {
    const body = document.createElement('div');
    body.className = 'sm-appearance-contribution-body';
    page.appendChild(body);
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
  [..._listEl.querySelectorAll('[data-view]'), ..._headerActionsEl.querySelectorAll('[data-view]')].forEach(button => button.addEventListener('click', () => {
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

/**
 * An extension's own icon (its panel's, else its first surface's), drawn as
 * a mask in the text colour like everywhere else in Atmos. Only for one that
 * is running: Atmos serves nothing of an extension that isn't (one waiting
 * for approval, say), so those keep the puzzle piece.
 */
function _extensionIconHtml(extension) {
  const frame = extension?.frame;
  if (!extension?.active || !frame?.origin || !Array.isArray(frame.contributions)) return _FALLBACK_ICON;
  const withIcon = frame.contributions.find(item => item.surface === 'panel' && item.icon)
    || frame.contributions.find(item => item.icon);
  if (!withIcon) return _FALLBACK_ICON;
  const src = `${frame.origin}${frame.base}${String(withIcon.icon).split('/').map(encodeURIComponent).join('/')}`;
  const safe = src.replace(/['"()\\\s]/g, character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `<span class="atmos-extension-icon" aria-hidden="true" style="--atmos-extension-icon:url('${safe}')"></span>`;
}

function _extensionLabel(extension) {
  const declared = extension.manifest?.displayName || extension.manifest?.name;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return extension.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Trust states that keep an extension from loading (see extension-trust.cjs).
const _UNTRUSTED = new Set(['pending', 'changed', 'blocked', 'tampered', 'incompatible']);

/** Whether a restart would load or unload this extension. */
function _needsRestart(extension) {
  // Its approval removed this session: it stopped then, so nothing waits
  // for a restart, unless it was approved again since.
  if (extension.stoppedNow) return !extension.approvalChanged;
  if (extension.approvalChanged || extension.developerRestart) return true;
  const wouldLoad = extension.enabled && !_UNTRUSTED.has(extension.status) && !(extension.dependencyProblems || []).length;
  return wouldLoad !== extension.active;
}

function _hasPendingRestart() {
  return [..._extensions.Plugins, ..._extensions.Services].some(_needsRestart);
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

/**
 * A community extension's signed or unsigned badge. Signed: the files are
 * exactly what its author's key signed. It says who made it as far as that
 * key goes, never that Atmos vouches for it.
 */
function _signatureBadge(extension) {
  if (extension.tier !== 'third-party' || extension.status === 'developer') return '';
  const signature = extension.authorSignature;
  if (!signature) return '';
  const signed = signature.status === 'signed';
  const title = signed
    ? `Signed by its author (key ${signature.keyId}): its files are exactly what that key signed`
    : 'Not signed: Atmos can’t tell who made it, or whether an update comes from the same person';
  return ` <span class="sm-tier-badge" data-tier="${signed ? 'signed' : 'unsigned'}" title="${escapeHtml(title)}">${signed ? 'Signed' : 'Unsigned'}</span>`;
}

/** Where a community extension came from and whether it is signed, as lines (HTML). */
function _communityLines(extension) {
  if (extension.tier !== 'third-party' || extension.status === 'developer') return [];
  const lines = [];
  const origin = extension.origin;
  lines.push(origin?.repo
    ? `From github.com/${escapeHtml(origin.repo)}`
    : 'Added by hand (not from a source)');
  const signature = extension.authorSignature;
  if (signature?.status === 'signed') lines.push(`Signed by its author, key ${escapeHtml(signature.keyId)}`);
  else if (signature) lines.push(`Not signed${signature.reason ? ` (${escapeHtml(signature.reason.replace(/^It is /, 'it is '))})` : ''}: Atmos can’t tell who made it, or whether an update comes from the same person`);
  return lines;
}

/** The author's key changed with this version: said where it matters. */
function _keyChangedHtml(extension, tag = 'div') {
  if (!extension.origin?.keyChanged) return '';
  const what = extension.authorSignature?.status === 'signed'
    ? 'This version is signed with a different key than the one before it.'
    : 'This version isn’t signed, though the one before it was.';
  return `<${tag} class="sm-trust-note sm-trust-caution">${what} If you didn’t expect that, the repository may have changed hands.</${tag}>`;
}

/** What it can use of the other extensions it declares (their "exports"). */
function _sharingHtml(extension) {
  const lines = extension.sharing || [];
  if (!lines.length) return '';
  return `<div class="sm-sharing-heading">From other extensions</div>${_permissionList(lines)}`;
}

/** What it shares with other extensions (its own "exports"), and with whom. */
function _sharesHtml(extension) {
  const lines = extension.shares || [];
  if (!lines.length) return '';
  return `<div class="sm-sharing-heading">Shares with other extensions</div>${_permissionList(lines)}`;
}

/** Holds something sensitive and shares with every extension: say so where it's seen. */
function _sharingRiskHtml(extension, tag = 'div') {
  if (!extension.sharingRisk) return '';
  return `<${tag} class="sm-trust-note sm-trust-caution">${escapeHtml(extension.sharingRisk)}</${tag}>`;
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
  lines.push(..._communityLines(extension));
  if (required.length) lines.push(`Needs ${names(required)}`);
  if (optional.length) lines.push(`Works better with ${names(optional)}${(extension.optionalMissing || []).length ? ` (not loaded: ${extension.optionalMissing.map(escapeHtml).join(', ')})` : ''}`);
  if ((extension.usedBy || []).length) lines.push(`Used by ${names(extension.usedBy)}`);
  return lines.length ? `<ul class="sm-permission-list sm-package-details">${lines.map(line => `<li>${line}</li>`).join('')}</ul>` : '';
}

/** Approval, status and permissions shown under an extension's row. */
function _extensionTrustHtml(extension) {
  const summary = extension.permissionSummary || [];
  const status = extension.status;
  // Its approval was removed this session: it stopped then (main.js _stopNow).
  if (extension.stoppedNow) {
    return extension.approvalChanged
      ? `<div class="sm-trust-note">Approval removed. It has stopped, and it stays off until you approve it again.
      <button type="button" class="sm-trust-secondary" data-trust-action="approve">Approve again</button></div>`
      : `<div class="sm-trust-note">Approved again. It starts when Atmos restarts.
      <button type="button" class="sm-trust-secondary" data-trust-action="restart">Restart now</button></div>`;
  }
  if (extension.approvalChanged) {
    return `<div class="sm-trust-note">${status === 'approved' ? 'Approval removed.' : 'Approved.'} Restart Atmos to apply.
      <button type="button" class="sm-trust-secondary" data-trust-action="restart">Restart now</button></div>`;
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
      // Installed from a repository and changed since: an update.
      : extension.origin?.repo
        ? `Updated to ${escapeHtml(extension.version || 'a new version')} since you approved it${(extension.newPermissions || []).length ? ', and it now asks for more' : ''}. Review it again. It asks to:`
        : `${escapeHtml(extension.statusReason)}. Review it again. It asks to:`;
    const origin = _communityLines(extension);
    return `
      <div class="sm-trust-note sm-trust-review">
        ${origin.length ? `<ul class="sm-permission-list sm-package-details">${origin.map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
        ${_keyChangedHtml(extension, 'p')}
        <div>${title}</div>
        ${_permissionList(status === 'changed' ? _withAdded(summary, extension.newPermissions) : summary, status === 'changed' ? extension.newPermissions : [])}
        ${_sharingHtml(extension)}
        ${_sharesHtml(extension)}
        ${_sharingRiskHtml(extension, 'p')}
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
  // Approved just now and loaded without a restart (_loadApprovedNow in main.js).
  const loadedNow = _approvedThisSession.has(`${extension.kind}:${extension.id}`) && extension.active
    ? '<div class="sm-trust-note">Approved. It\u2019s running now.</div>'
    : '';
  return `${developer}${fellBack}${loadedNow}${_keyChangedHtml(extension)}${_sharingRiskHtml(extension)}
    <details class="sm-permissions">
      <summary hidden>Details</summary>
      ${_packageDetailsHtml(extension)}
      ${_permissionList(summary)}
      ${_sharingHtml(extension)}
      ${_sharesHtml(extension)}
      ${extension.tier === 'third-party' && status === 'approved'
        ? '<button type="button" class="sm-trust-secondary" data-trust-action="revoke">Remove approval</button>'
        : ''}
    </details>`;
}

/**
 * Its version, and whether it's off or waits for a restart. Anything else
 * (approval, problems, a developer folder) is said under the card.
 */
function _cardDetail(extension) {
  let state = '';
  if (extension.tier !== 'system') {
    const blocked = _UNTRUSTED.has(extension.status) || (extension.dependencyProblems || []).length || extension.approvalChanged;
    if (!extension.enabled) state = extension.active ? 'off after a restart' : 'off';
    else if (!blocked && _needsRestart(extension)) state = 'on after a restart';
  }
  return [extension.version, state].filter(Boolean).map(escapeHtml).join(' · ');
}

/**
 * An installed extension's card: its switch, Remove where it can be
 * removed (`remove`), and its approval, problems and Details below.
 * `below` goes under the card (Remove's confirmation, optional extras).
 */
function _installedCardHtml(extension, { remove = '', below = '' } = {}) {
  const key = `${extension.kind}:${extension.id}`;
  const label = _extensionLabel(extension);
  const system = extension.tier === 'system';
  return `
    <div class="sm-card sm-extension-card sm-manager-row${extension.enabled ? '' : ' disabled'}" data-key="${escapeHtml(key)}">
      <div class="sm-card-main">
        <div class="sm-icon">${_extensionIconHtml(extension)}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${escapeHtml(label)}${extension.source === 'developer' ? ' <span class="sm-tier-badge" data-tier="developer">Developer</span>' : ''}${_signatureBadge(extension)}</div>
          <div class="sm-card-detail">${_cardDetail(extension)}</div>
        </div>
        <div class="sm-manager-actions">${remove}${system ? '' : _toggleHtml(extension.enabled, `Enable ${label}`)}</div>
      </div>
      <div class="sm-extension-trust">${_extensionTrustHtml(extension)}</div>
      ${below}
      ${_managerErrorHtml(key)}
    </div>`;
}

/** Approve, Keep disabled, Remove approval, Restart and the switch on the cards just drawn. */
function _wireInstalledCards() {
  const all = [..._extensions.Plugins, ..._extensions.Services];
  _listEl.querySelectorAll('.sm-extension-card[data-key]').forEach(card => {
    const extension = all.find(item => `${item.kind}:${item.id}` === card.dataset.key);
    if (!extension) return;
    const { kind, id } = extension;
    card.querySelectorAll('[data-trust-action]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.trustAction;
      const errorEl = card.querySelector('.sm-trust-error');
      button.disabled = true;
      try {
        if (action === 'restart') {
          window.atmosCore?.restartAtmos?.();
          return;
        }
        if (action === 'approve') {
          const result = await window.atmosCore?.approveExtension?.(kind, id, extension.fingerprint);
          if (result?.loaded?.length) {
            // Loaded at once (the frame host registers its surfaces, from
            // the main process's extensions:loaded): say so on its card.
            for (const item of result.loaded) _approvedThisSession.add(`${item.kind}:${item.id}`);
            await _refreshExtensions();
            return;
          }
          // Stopped this session: it starts at the next start; the card says so.
          if (extension.stoppedNow) { await _refreshExtensions(); return; }
          extension.approvalChanged = true;
        } else if (action === 'revoke') {
          const result = await window.atmosCore?.revokeExtensionApproval?.(kind, id);
          extension.approvalChanged = true;
          // Stopped at once (main.js _stopNow), with anything that needed it.
          if (result?.stopped?.length) { await _refreshExtensions(); return; }
        } else if (action === 'keep-disabled') {
          await window.atmosCore?.setExtensionEnabled?.(kind, id, false);
          extension.enabled = false;
        }
        _redrawKeepingState();
      } catch (error) {
        button.disabled = false;
        console.warn(`[settings] ${action} failed for ${kind} '${id}':`, error.message);
        if (errorEl) {
          errorEl.hidden = false;
          errorEl.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        }
      }
    }));

    // Clicking the card (not its switch or buttons) shows or hides its details.
    const details = card.querySelector('.sm-extension-trust > details.sm-permissions');
    const main = card.querySelector('.sm-card-main');
    if (details && main) {
      const sync = () => {
        main.setAttribute('aria-expanded', String(details.open));
        card.classList.toggle('open', details.open);
      };
      main.setAttribute('role', 'button');
      main.tabIndex = 0;
      sync();
      details.addEventListener('toggle', sync);
      main.addEventListener('click', event => {
        if (event.target.closest('button, input, label, a, select, textarea')) return;
        details.open = !details.open;
      });
      main.addEventListener('keydown', event => {
        if (event.target !== main || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        details.open = !details.open;
      });
    }

    const toggle = card.querySelector('.sm-card-main input[type="checkbox"]');
    toggle?.addEventListener('change', async () => {
      const nextEnabled = toggle.checked;
      toggle.disabled = true;
      try {
        await window.atmosCore?.setExtensionEnabled?.(kind, id, nextEnabled);
        extension.enabled = nextEnabled;
        _redrawKeepingState();
      } catch (error) {
        toggle.checked = !nextEnabled;
        toggle.disabled = false;
        console.warn(`[settings] failed to update ${kind} '${id}':`, error.message);
      }
    });
  });
}

function _systemExtensions() {
  return _extensions.Services.filter(extension => extension.tier === 'system');
}

/** Whether the search box's text is in its name or id. */
function _matchesSearch(name, id) {
  return !_searchTerm || `${name} ${id}`.toLowerCase().includes(_searchTerm);
}

function _renderSystemPage() {
  _headerEl.classList.add('sm-no-search');
  const extensions = _systemExtensions();
  if (!extensions.length) {
    _listEl.innerHTML = '<div id="settings-menu-empty">No system capabilities are installed.</div>';
    return;
  }
  _listEl.innerHTML = `
    <div class="sm-extension-toolbar">
      <span>Built into Atmos and always available.</span>
      <span class="sm-manager-actions">${_viewToggleHtml()}</span>
    </div>
    <div class="sm-card-group">${extensions.map(extension => _installedCardHtml(extension)).join('')}</div>`;
  _wireInstalledCards();
  _applyView();
}

function _renderList() {
  _clearPageCleanups();
  _headerEl.classList.remove('sm-no-search');
  _headerActionsEl.innerHTML = '';
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

  if (_activeCategory === _BROWSER_PAGE_ID) {
    _renderBrowserPage();
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

  _renderSystemPage();
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
  return summary ? (summary.updates || 0) + (summary.pending || 0) + (summary.problems?.length || 0) + (summary.approvals?.length || 0) : 0;
}

/** Settings on an extension's own card (from "Review" on the Extensions page, or elsewhere). */
export function openExtensionCard(kind, id) {
  const system = _systemExtensions().some(item => item.id === id && kind === 'service');
  _extensionsMode = 'installed';
  _activeCategory = system ? _SYSTEM_PAGE_ID : _EXTENSIONS_PAGE_ID;
  _searchTerm = '';
  if (_searchEl) _searchEl.value = '';
  if (!_overlay?.classList.contains('open')) openSettingsMenu();
  else _render();
  const show = () => {
    const card = _listEl?.querySelector(`.sm-extension-card[data-key="${CSS.escape(`${kind}:${id}`)}"]`);
    if (!card) return false;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('sm-card-highlight');
    setTimeout(() => card.classList.remove('sm-card-highlight'), 1600);
    return true;
  };
  // The list may still be arriving (openSettingsMenu refreshes it).
  if (!show()) setTimeout(show, 250);
}

function _setManager(payload) {
  if (!payload?.status) return;
  _manager = { status: payload.status, summary: payload.summary };
  if (!_overlay?.classList.contains('open')) return;
  if (_activeCategory === _EXTENSIONS_PAGE_ID || _activeCategory === _HOME_PAGE_ID) _redrawKeepingState();
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
    if (_activeCategory === _EXTENSIONS_PAGE_ID || _activeCategory === _HOME_PAGE_ID) _renderList();
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
  // System services (Audio, Wallpaper) are always there: not worth a chip.
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
  const running = [..._extensions.Plugins, ..._extensions.Services].find(item => `${item.kind}:${item.id}` === key);
  return `
    <div class="sm-card sm-manager-row" data-key="${escapeHtml(key)}">
      <div class="sm-card-main sm-manager-main">
        <div class="sm-icon">${_extensionIconHtml(running)}</div>
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

/**
 * Settings → Atmos, under the version: whether it's up to date, or the
 * newer version and what to do about it, and "Update automatically". A
 * newer version comes from a source's signed index; an installed copy on
 * Windows downloads it, checks it and installs it (atmos-update.cjs; its
 * offer outlasts a check that couldn't reach the source), any other copy
 * offers the download page (the main process opens it).
 */
function _atmosHomeHtml() {
  if (!window.atmosCore?.extensionManager || !_manager) return '';
  const { status, summary } = _manager;
  const atmos = summary.atmos || {};
  const offer = summary.atmosUpdate;
  const current = escapeHtml(atmos.current || offer?.current || '');
  const mine = !!atmos.version && atmos.version === offer?.version;
  const page = offer?.download ? _button('atmos-page', 'Download page', { key: 'atmos-page', busyLabel: 'Opening…' }) : '';
  let name;
  let detail;
  let actions = '';
  const auto = atmos.canInstall ? `
    <div class="sm-home-auto sm-manager-row" data-key="atmos-auto">
      <span title="${atmos.perMachine
        ? 'Downloads new versions in the background; Restart to update installs them'
        : 'Downloads new versions in the background and installs them when you quit'}">Update automatically</span>
      ${_toggleHtml(atmos.auto !== false, 'Update Atmos automatically')}
    </div>` : '';
  if (!offer) {
    const updated = atmos.justInstalled ? `Updated from ${escapeHtml(atmos.justInstalled.from || 'an older version')} · ` : '';
    const firstError = (status.sources || []).find(source => source.error)?.error;
    let state;
    if (_managerBusy.has('check')) state = 'Checking…';
    else if (!status.checkedAt) state = 'Not checked yet';
    else if (summary.reached === false) state = `<span title="${escapeHtml(firstError || '')}">Couldn't check</span>`;
    else state = `Up to date · ${escapeHtml(_formatWhen(status.checkedAt))}`;
    return `
      <div class="sm-home-status sm-manager-row" data-key="atmos">${updated}${state}${_managerBusy.has('check') ? '' : ' · <button type="button" class="sm-home-link" data-manager-action="check">Check now</button>'}</div>
      ${_managerErrorHtml('check')}
      ${auto}`;
  } else {
    const version = escapeHtml(offer.version);
    if (mine && atmos.phase === 'ready') {
      name = `Atmos ${version} is ready to install`;
      if (atmos.startFailed) detail = `The installer couldn't be started last time: ${escapeHtml(atmos.startFailed)}`;
      else if (atmos.failedBefore) detail = `The last try to install it didn't finish; you have ${current}.`;
      else if (atmos.perMachine) detail = 'Restart to update. Atmos is installed for every user, so Windows asks first.';
      else if (atmos.installsOnQuit) detail = 'It installs when you quit Atmos, or restart now.';
      else detail = `Restart to install it. You have ${current}.`;
      const again = atmos.failedBefore || !!atmos.startFailed;
      actions = _button('install-atmos', again ? 'Try again' : 'Restart to update', { key: 'atmos', primary: true, busyLabel: 'Restarting…' })
        + (again ? page : '');
    } else if (mine && atmos.phase === 'downloading') {
      const progress = atmos.progress;
      if (progress?.total) {
        const percent = Math.floor((progress.bytes / progress.total) * 100);
        name = `Downloading Atmos ${version}…`;
        detail = `${percent}% of ${escapeHtml(_formatSize(progress.total))}. You have ${current}.`;
      } else {
        name = `Checking Atmos ${version}…`;
        detail = `The download, against the signed index. You have ${current}.`;
      }
    } else if (mine && atmos.phase === 'error') {
      name = `Atmos ${version} couldn't be downloaded`;
      detail = escapeHtml(atmos.error || 'Something went wrong');
      actions = _button('get-atmos', 'Try again', { key: 'atmos', primary: true, busyLabel: 'Downloading…' }) + page;
    } else if (mine && atmos.installable) {
      name = `Atmos ${version} is available`;
      detail = `You have ${current}. Atmos downloads it, checks it against the signed index, then installs it when you restart.`;
      actions = _button('get-atmos', 'Download', { key: 'atmos', primary: true, busyLabel: 'Downloading…' });
    } else {
      name = `Atmos ${version} is available`;
      detail = `You have ${current || 'an older version'}. Download the new installer and run it; your settings and extensions stay.`;
      actions = offer.download ? _button('download-atmos', 'Download', { key: 'atmos', primary: true, busyLabel: 'Opening…' }) : '';
    }
  }
  return `
    <div class="sm-home-update sm-manager-row" data-key="atmos">
      <div class="sm-home-update-name">${name}</div>
      <div class="sm-home-update-detail">${detail}</div>
      ${actions ? `<div class="sm-manager-actions">${actions}</div>` : ''}
      ${_managerErrorHtml('atmos')}${_managerErrorHtml('atmos-page')}
    </div>
    ${auto}`;
}

// ── Sources ──
let _addingSource = false; // the Add a source row is open

const _SOURCE_WEB_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>`;
const _SOURCE_FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const _SOURCE_ADD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

/** A source's error in a few words; the full message is its tooltip. */
function _sourceProblem(error) {
  const text = String(error || '');
  if (/CERT|certificate/i.test(text)) return 'Certificate not trusted';
  if (/NAME_NOT_RESOLVED|ENOTFOUND|NAME_RESOLUTION/i.test(text)) return 'Address not found';
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|ENETUNREACH/i.test(text)) return 'Offline';
  if (/TIMED_OUT|timed out|stalled/i.test(text)) return 'Timed out';
  if (/ENOENT|no such file|not found/i.test(text)) return 'Not found';
  if (/signature|signed/i.test(text)) return 'Signature not valid';
  return "Couldn't be read";
}

const _SOURCE_REPO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6"/><path d="M18 10.2c0 4-6 3-11 6"/></svg>`;

function _sourceCardHtml(source) {
  const web = /^https?:/i.test(source.location);
  let title = source.name;
  let where = source.location;
  if (source.community) {
    title = source.repo;
    where = `github.com/${source.repo} · latest release`;
  } else if (web) {
    try {
      const url = new URL(source.location);
      title ||= url.hostname;
      where = `${url.hostname}${url.pathname.replace(/\/$/, '')}`;
    } catch { /* shown as written */ }
  } else {
    title ||= source.location.split(/[\\/]/).filter(Boolean).pop() || source.location;
  }
  const state = source.ok === true ? 'ok' : source.ok === false ? 'error' : 'idle';
  const label = state === 'ok' ? `${source.packages} package${source.packages === 1 ? '' : 's'}`
    : state === 'error' ? _sourceProblem(source.error) : 'Not checked yet';
  const origin = source.community ? 'Community' : source.origin === 'built-in' ? 'Built in' : source.origin === 'session' ? 'This session' : '';
  const refused = (source.refused || []).map(item => `${escapeHtml(item.id)} (${escapeHtml(item.reason)})`);
  return `
    <div class="sm-card sm-manager-source${state === 'error' ? ' sm-trust-alert' : ''}" data-location="${escapeHtml(source.location)}">
      <div class="sm-card-main">
        <div class="sm-icon">${source.community ? _SOURCE_REPO_ICON : web ? _SOURCE_WEB_ICON : _SOURCE_FOLDER_ICON}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${escapeHtml(title)}${origin ? ` <span class="sm-source-tag">${origin}</span>` : ''}</div>
          <div class="sm-card-detail" title="${escapeHtml(source.location)}">${escapeHtml(where)}</div>
        </div>
        <span class="sm-source-state ${state}"${state === 'error' ? ` title="${escapeHtml(source.error || '')}"` : ''}><i class="sm-source-dot ${state}"></i>${escapeHtml(label)}</span>
        ${source.origin === 'user' ? '<button type="button" class="sm-trust-secondary" data-manager-action="remove-source">Remove</button>' : ''}
      </div>
      ${refused.length ? `<div class="sm-trust-note sm-trust-caution">Not offered: ${refused.join(', ')}.</div>` : ''}
    </div>`;
}

// What Settings → Extensions lists: what's installed, or the sources.
let _extensionsMode = 'installed';
const _MODE_INSTALLED_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>`;
const _MODE_SOURCES_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;

/** Settings → Extensions switched to its sources: where packages come from, and adding one. */
function _renderSourcesList(status, sections) {
  const shown = status.sources.filter(source => _matchesSearch(source.name || '', source.location));
  sections.push(`
    <div class="sm-source-list">
      ${shown.map(_sourceCardHtml).join('')}
      ${_searchTerm && !shown.length ? `<div id="settings-menu-empty">No matches for "${escapeHtml(_searchEl.value.trim())}".</div>` : ''}
      ${_addingSource ? `
        <form class="sm-manager-add-source">
          <span class="sm-icon">${_SOURCE_ADD_ICON}</span>
          <input type="text" placeholder="A GitHub repository (github.com/owner/repo), a folder, or an https:// address" aria-label="New source">
          ${_button('add-source', 'Add', { key: 'source', primary: true, busyLabel: 'Checking…' })}
          <button type="button" class="sm-trust-secondary" data-manager-action="cancel-add-source">Cancel</button>
        </form>
        ${_managerErrorHtml('source')}`
        : `<button type="button" class="sm-source-add" data-manager-action="show-add-source"><span class="sm-icon">${_SOURCE_ADD_ICON}</span>Add a source</button>`}
      <p class="sm-source-hint">A GitHub repository adds community extensions from its latest release. They run sandboxed, load only once you approve them, and ask again after every update.</p>
    </div>`);
  _listEl.innerHTML = sections.join('');
  _wireManagerActions();
}

function _renderExtensionManagerPage() {
  _headerEl.classList.remove('sm-no-search');
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

  // Beside the search box: restart when changes wait, check now (when it
  // last did, on hover), what the page lists (installed or sources), and
  // list or grid.
  const sourcesMode = _extensionsMode === 'sources';
  const sourceTrouble = status.sources.some(source => source.ok === false);
  _headerActionsEl.innerHTML = `
    ${status.pending.length || _hasPendingRestart() ? '<button type="button" class="sm-restart-button" data-manager-action="restart">Restart to apply</button>' : ''}
    ${_button('check', 'Check for updates', { key: 'check', busyLabel: 'Checking…' }).replace('<button ', `<button title="${status.checkedAt ? `Checked ${escapeHtml(_formatWhen(status.checkedAt))}` : 'Not checked yet'}" `)}
    <span class="sm-view-toggle" role="group" aria-label="Show">
      <button type="button" data-extensions-mode="installed" aria-pressed="${!sourcesMode}" title="Extensions">${_MODE_INSTALLED_ICON}</button>
      <button type="button" data-extensions-mode="sources" aria-pressed="${sourcesMode}" title="${sourceTrouble ? 'Sources: one has a problem' : 'Sources'}">${_MODE_SOURCES_ICON}${sourceTrouble ? '<i class="sm-source-dot error"></i>' : ''}</button>
    </span>
    ${sourcesMode ? _viewToggleHtml().replace(/<button /g, '<button disabled ') : _viewToggleHtml()}`;
  _searchEl.placeholder = sourcesMode ? 'Search sources…' : 'Search extensions…';
  sections.push(_managerErrorHtml('check'));

  if (sourcesMode) {
    _renderSourcesList(status, sections);
    return;
  }

  // Community extensions copied in by hand wait for approval without
  // showing anything; say which, and take the user to each one's card.
  if (summary.approvals?.length) {
    sections.push(`<div class="sm-manager-heading">Waiting for your approval</div><div class="sm-card-group">`);
    for (const item of summary.approvals) {
      sections.push(_managerRow({
        key: `${item.kind}:${item.id}`,
        name: escapeHtml(item.name),
        detail: item.status === 'changed'
          ? 'Updated or changed since you approved it. It stays off until you review it again'
          : 'Not loaded until you approve it. Review what it asks for',
        actions: _button('review', 'Review', { key: `${item.kind}:${item.id}`, primary: true }),
      }));
    }
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
    const what = record.reason ? `didn't start (${escapeHtml(record.reason)})` : "couldn't load";
    sections.push(`<div class="sm-trust-note sm-trust-alert sm-manager-problem">The update of ${escapeHtml(record.id)} to ${escapeHtml(record.version)} ${what}${record.running ? `; ${escapeHtml(record.running.version || '')} is running instead` : record.reason ? '; the version before it runs from the next start' : ''}.</div>`);
  }

  if (status.pending.length) {
    sections.push(`<div class="sm-manager-heading">Waiting for a restart</div><div class="sm-card-group">`);
    for (const change of status.pending) {
      const key = `${change.kind}:${change.id}`;
      const what = change.action === 'remove'
        ? `Remove${change.deleteData ? ', and delete its data' : ', keeping its data'}`
        : `${change.reason === 'update' ? 'Update to' : change.reason === 'dependency' ? 'Install (needed by another extension)' : change.reason === 'recommended' ? 'Install (comes with another extension)' : 'Install'} ${change.version}`;
      const fromRepo = change.community?.repo ? ` · from ${escapeHtml(change.community.repo)}, you’ll review it after the restart` : '';
      sections.push(_managerRow({
        key,
        name: escapeHtml(change.displayName || change.id),
        detail: `${escapeHtml(what)}${fromRepo}${change.error ? ` · failed last time: ${escapeHtml(change.error)}` : ''}`,
        actions: _button('cancel', 'Cancel', { key }),
        extra: change.action === 'install' ? _optionalOffersHtml(key) : '',
      }));
    }
    sections.push('</div>');
  }

  const updates = status.packages.filter(item => item.action === 'update' && !pendingByKey.has(`${item.kind}:${item.id}`) && _matchesSearch(item.displayName || '', item.id));
  if (updates.length) {
    sections.push(`<div class="sm-manager-heading">Updates</div>`);
    sections.push(_groupByKind(updates, item => {
      const key = `${item.kind}:${item.id}`;
      return _managerRow({
        key,
        name: escapeHtml(item.displayName || item.id),
        detail: `${escapeHtml(item.installedVersion)} → ${escapeHtml(item.version)} · ${escapeHtml(_formatSize(item.size))}${item.community ? ` · ${escapeHtml(item.repo)} · asks for approval again` : ''}`,
        actions: _button('install', 'Update', { key, primary: true, busyLabel: 'Downloading…' }),
      });
    }));
  }

  const available = status.packages.filter(item => item.action === 'install' && !pendingByKey.has(`${item.kind}:${item.id}`) && _matchesSearch(item.displayName || '', item.id));
  if (available.length) {
    sections.push(`<div class="sm-manager-heading">Available</div>`);
    sections.push(_groupByKind(available, item => {
      const key = `${item.kind}:${item.id}`;
      // Over a copy added by hand: possibly someone else's extension with the same id.
      const replaces = item.installedTier === 'third-party'
        ? (item.community ? ` · replaces the copy you added by hand, which may not be from ${escapeHtml(item.repo)}` : ' · replaces the community copy')
        : '';
      return _managerRow({
        key,
        name: `${escapeHtml(item.displayName || item.id)}${item.community ? ` <span class="sm-tier-badge" data-tier="third-party" title="From ${escapeHtml(item.repo)}: a community extension, which loads only once you approve it">Community</span>` : ''}`,
        detail: `${escapeHtml(item.version)} · ${escapeHtml(_formatSize(item.size))}${item.community ? ` · ${escapeHtml(item.repo)}` : ''}${item.description ? ` · ${escapeHtml(item.description)}` : ''}${replaces}`,
        needs: _needsHtml({ dependencies: item.dependencies }),
        actions: _button('install', 'Install', { key, primary: true, busyLabel: 'Downloading…' }),
        extra: _optionalOffersHtml(key),
      });
    }));
  }

  // What's installed: plugins, then services, each Official then Community.
  // (System capabilities have their own page.)
  const removeHtml = extension => {
    const key = `${extension.kind}:${extension.id}`;
    if (!extension.removable || pendingByKey.has(key)) return { remove: '', below: '' };
    if (_confirmRemove !== key) return { remove: _button('ask-remove', 'Remove', { key }), below: _optionalOffersHtml(key) };
    const bundled = extension.bundledFallback === true;
    const unused = _leftUnused(extension, installedExtensions, pendingByKey);
    return {
      remove: '',
      below: `
        <div class="sm-trust-note sm-trust-review sm-manager-confirm">
          <div>Remove ${escapeHtml(_extensionLabel(extension))} when Atmos restarts?${bundled ? ' The version that comes with Atmos is used again.' : ''}</div>
          <label class="sm-manager-choice"><input type="radio" name="remove-data-${escapeHtml(key)}" value="keep" checked> Keep its settings and data</label>
          <label class="sm-manager-choice"><input type="radio" name="remove-data-${escapeHtml(key)}" value="delete"> Delete its settings and data</label>
          ${unused.length ? `<div class="sm-manager-also">Nothing else uses these; remove them too:</div>
            ${unused.map(item => `<label class="sm-manager-choice"><input type="checkbox" data-also-remove="${escapeHtml(`${item.kind}:${item.id}`)}" checked> ${escapeHtml(_extensionLabel(item))}</label>`).join('')}` : ''}
          <div class="sm-trust-actions">
            ${_button('remove', 'Remove', { key, primary: true })}
            <button type="button" class="sm-trust-secondary" data-manager-action="keep">Cancel</button>
          </div>
        </div>`,
    };
  };
  let shown = 0;
  for (const [label, list] of [['Plugins', _extensions.Plugins], ['Services', _extensions.Services.filter(item => item.tier !== 'system')]]) {
    const mine = list.filter(extension => _matchesSearch(_extensionLabel(extension), extension.id));
    if (!mine.length) continue;
    shown += mine.length;
    sections.push(`<div class="sm-manager-heading">${label}</div>`);
    for (const [segment, inSegment] of [['Official', item => item.tier !== 'third-party'], ['Community', item => item.tier === 'third-party']]) {
      const cards = mine.filter(inSegment);
      if (!cards.length) continue;
      sections.push(`<div class="sm-manager-subheading">${segment}<span>${cards.length}</span></div>`);
      sections.push(`<div class="sm-card-group">${cards.map(extension => _installedCardHtml(extension, removeHtml(extension))).join('')}</div>`);
    }
  }
  if (_searchTerm && !shown && !updates.length && !available.length) {
    sections.push(`<div id="settings-menu-empty">No matches for "${escapeHtml(_searchEl.value.trim())}".</div>`);
  }

  _listEl.innerHTML = sections.join('');
  _wireInstalledCards();
  _applyView();

  _wireManagerActions();
}

/** The manager's buttons, switches and forms on the page just drawn (Extensions, or Atmos's own). */
function _wireManagerActions() {
  _headerActionsEl.querySelectorAll('[data-extensions-mode]').forEach(button => button.addEventListener('click', () => {
    if (_extensionsMode === button.dataset.extensionsMode) return;
    _extensionsMode = button.dataset.extensionsMode;
    _searchTerm = '';
    _searchEl.value = '';
    _renderList();
  }));
  _listEl.querySelector('.sm-manager-row[data-key="atmos-auto"] input[type="checkbox"]')?.addEventListener('change', event => {
    const on = event.target.checked;
    _managerRequest('atmos-auto', api => api.setAtmosAutoUpdate(on));
  });

  _listEl.querySelector('.sm-manager-add-source')?.addEventListener('submit', event => {
    event.preventDefault();
    _listEl.querySelector('.sm-manager-add-source [data-manager-action="add-source"]')?.click();
  });

  [..._listEl.querySelectorAll('[data-manager-action]'), ..._headerActionsEl.querySelectorAll('[data-manager-action]')].forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const action = button.dataset.managerAction;
    const row = button.closest('[data-key]');
    const key = row?.dataset.key;
    const [kind, id] = (key || '').split(':');
    if (action === 'restart') return window.atmosCore?.restartAtmos?.();
    if (action === 'review') return openExtensionCard(kind, id);
    if (action === 'check') return _managerRequest('check', api => api.checkForUpdates());
    if (action === 'download-atmos') return _managerRequest('atmos', api => api.openAtmosDownload());
    if (action === 'atmos-page') return _managerRequest('atmos-page', api => api.openAtmosDownload());
    if (action === 'get-atmos') return _managerRequest('atmos', api => api.downloadAtmosUpdate());
    if (action === 'install-atmos') return _managerRequest('atmos', api => api.installAtmosUpdate());
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
    if (action === 'show-add-source') {
      _addingSource = true;
      _managerError = null;
      _renderList();
      return _listEl.querySelector('.sm-manager-add-source input')?.focus();
    }
    if (action === 'cancel-add-source') { _addingSource = false; _managerError = null; return _renderList(); }
    if (action === 'add-source') {
      const input = _listEl.querySelector('.sm-manager-add-source input');
      const value = input?.value || '';
      return _managerRequest('source', api => api.addSource(value)).then(payload => {
        if (payload) { _addingSource = false; _renderList(); }
        else {
          const again = _listEl.querySelector('.sm-manager-add-source input');
          if (again) { again.value = value; again.focus(); }
        }
      });
    }
    return undefined;
  }));
}

// ── Public API ───────────────────────────────────────────────────────────

/** Settings, opened on Atmos's own page: its version and updates (the footer's version). */
export function openAtmosSettings() {
  _activeCategory = _HOME_PAGE_ID;
  openSettingsMenu();
}

/** Settings, opened on the extension manager (the footer's Extensions button). */
export function openExtensionManager() {
  _activeCategory = _EXTENSIONS_PAGE_ID;
  openSettingsMenu();
}

// Settings' pages by the names the command bar uses (command-list.js:
// SETTINGS_PAGES). Browser shows only when Atmos Browser has settings.
const _PAGES_BY_NAME = Object.freeze({
  atmos: _HOME_PAGE_ID, appearance: _APPEARANCE_PAGE_ID, sidebar: _SIDEBAR_PAGE_ID, panels: _PANELS_PAGE_ID,
  browser: _BROWSER_PAGE_ID, extensions: _EXTENSIONS_PAGE_ID, system: _SYSTEM_PAGE_ID,
});

/** Settings, opened on a page by name (rev/settings appearance); an unknown name opens where it was. */
export function openSettingsPage(name) {
  const page = _PAGES_BY_NAME[String(name || '').toLowerCase()];
  if (page) _activeCategory = page;
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

/**
 * js/core/settings-menu.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CORE — modal overlay ("Settings" in the ctx menu). Structured as a real
 * settings app for Core-owned controls. Plugin and service pages are built
 * from discovery metadata, so Atmos never needs to import an extension's
 * settings module merely to let the user disable that extension.
 *
 * The left navigation is entirely Core-owned: Appearance, About, Sidebar,
 * Panels, Plugins, and Services. Extension rows expose lifecycle controls
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
// out of the About page (see _renderHome()) into their own destination so
// About is just the "what version is this, what does it look like" page
// again, rather than doubling as the app-wide appearance settings. Icon
// button sits to the LEFT of the About button (see _renderNav()) in the
// same compact top row, rather than a full-width row below the divider
// like Sidebar/Panels -- it's a peer of About (both are single-purpose
// utility destinations), not part of the page list.
const _APPEARANCE_PAGE_ID = '__appearance__';
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

const _SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

// The About page is a utility destination, so it uses the same restrained
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

// Nav icon for the new Appearance page -- a paint brush, distinct from the
// info-circle "About" glyph it now sits beside.
const _APPEARANCE_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.37 2.63 14 7l-1.5 4L9 13.5l-3.5 3.5 3.5 3.5L12.5 17l4-1.5 4.37-4.37a2.12 2.12 0 0 0-3-3z"/><path d="M9 13.5 3 21"/></svg>`;

// ── Home ─────────────────────────────────────────────────────────────────
const APP_NAME = 'ATMOS';

const _TIER_LABELS = Object.freeze({ system: 'System', 'first-party': 'First-party', 'third-party': 'Third-party' });

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

const _HOME_NAV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5L12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9"/></svg>`;

function _build() {
  if (_overlay) return;

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
  const validPages = new Set([_HOME_PAGE_ID, _APPEARANCE_PAGE_ID, _SIDEBAR_PAGE_ID, _PANELS_PAGE_ID, _PLUGINS_PAGE_ID, _SERVICES_PAGE_ID]);
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

  // Appearance + About are peer utility buttons, side by side above the
  // full-width page list -- About comes first, Appearance sits to its right.
  const topRow = document.createElement('div');
  topRow.className = 'sm-nav-top-row';

  const homeItem = document.createElement('button');
  homeItem.type = 'button';
  homeItem.setAttribute('aria-label', 'About Atmos');
  homeItem.title = 'About Atmos';
  homeItem.className = 'sm-nav-item sm-nav-home' + (_activeCategory === _HOME_PAGE_ID ? ' active' : '');
  homeItem.innerHTML = `
    <span class="sm-nav-icon" aria-hidden="true">${_INFO_NAV_ICON}</span>`;
  homeItem.addEventListener('click', () => {
    if (_activeCategory === _HOME_PAGE_ID) return;
    _activeCategory = _HOME_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  topRow.appendChild(homeItem);

  const appearanceItem = document.createElement('button');
  appearanceItem.type = 'button';
  appearanceItem.setAttribute('aria-label', 'Appearance');
  appearanceItem.title = 'Appearance';
  appearanceItem.className = 'sm-nav-item sm-nav-home' + (_activeCategory === _APPEARANCE_PAGE_ID ? ' active' : '');
  appearanceItem.innerHTML = `
    <span class="sm-nav-icon" aria-hidden="true">${_APPEARANCE_NAV_ICON}</span>`;
  appearanceItem.addEventListener('click', () => {
    if (_activeCategory === _APPEARANCE_PAGE_ID) return;
    _activeCategory = _APPEARANCE_PAGE_ID;
    _searchTerm = '';
    _searchEl.value = '';
    _renderNav();
    _renderList();
  });
  topRow.appendChild(appearanceItem);

  _navEl.appendChild(topRow);
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

  for (const category of [_PLUGINS_PAGE_ID, _SERVICES_PAGE_ID]) {
    const groupEntries = _extensions[category];
    const item = document.createElement('div');
    item.className = 'sm-nav-item' + (category === _activeCategory ? ' active' : '');
    item.innerHTML = `
      <span class="sm-nav-icon">${_CATEGORY_ICON}</span>
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
}

function _renderOnboarding() {
  _headerEl.classList.add('sm-no-search');
  _listEl.innerHTML = `
    <div class="sm-onboarding">
      <div class="sm-onboarding-kicker">Your space is ready</div>
      <h1>Make Atmos yours.</h1>
      <p>Atmos starts clean. Add only the plugins and shared services you want; the core discovers them when it starts.</p>
      <div class="sm-onboarding-steps">
        <div><span>1</span><strong>Choose</strong><small>Pick an Atmos extension.</small></div>
        <div><span>2</span><strong>Install</strong><small>Place it in the matching folder.</small></div>
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
          <img src="${wordmarkSrc}" alt="${APP_NAME}"
               onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
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

  _listEl.innerHTML = `<div class="sm-sidebar-page-hint">Choose which sections appear in the sidebar.</div>`;

  // Reuses .sm-card/.sm-icon/.sm-card-text — the same row shell the plugin
  // list uses below — just with a toggle switch in place of the expand
  // chevron, since there's no body to expand here.
  for (const { id, icon, label, enabled } of widgets) {
    const card = document.createElement('div');
    card.className = 'sm-card';
    card.innerHTML = `
      <label class="sm-card-main">
        <div class="sm-icon">${icon || _FALLBACK_ICON}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${label || id}</div>
        </div>
        <span class="sm-toggle">
          <input type="checkbox" ${enabled ? 'checked' : ''}>
          <span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span>
        </span>
      </label>`;

    card.querySelector('input[type="checkbox"]').addEventListener('change', e => {
      setSectionEnabled(id, e.target.checked);
    });

    _listEl.appendChild(card);
  }
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
    row.innerHTML = `<span class="sm-panel-section-name">${_escape(section.label)}</span>`;
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

function _escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function _extensionLabel(extension) {
  const declared = extension.manifest?.displayName || extension.manifest?.name;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return extension.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Trust states that keep an extension from loading (see extension-trust.cjs).
const _UNTRUSTED = new Set(['pending', 'changed', 'blocked', 'tampered']);
const _STATUS_TEXT = {
  pending: 'needs approval',
  changed: 'changed since approval',
  blocked: 'blocked',
  tampered: 'files modified',
};

/** Whether a restart would load or unload this extension. */
function _needsRestart(extension) {
  if (extension.approvalChanged) return true;
  const wouldLoad = extension.enabled && !_UNTRUSTED.has(extension.status);
  return wouldLoad !== extension.active;
}

function _hasPendingRestart() {
  return [..._extensions.Plugins, ..._extensions.Services].some(_needsRestart);
}

function _extensionStatusText(extension) {
  if (extension.tier === 'system') return _UNTRUSTED.has(extension.status) ? _STATUS_TEXT[extension.status] : 'always on';
  if (extension.approvalChanged) return 'restart required';
  if (_UNTRUSTED.has(extension.status) && extension.enabled) return _STATUS_TEXT[extension.status];
  if (_needsRestart(extension)) return 'restart required';
  return extension.enabled ? 'loaded at startup' : 'not loaded';
}

const _SANDBOX_WARNING = 'Third-party extensions run in their own sandboxed frame: they cannot see the rest of Atmos, '
  + 'your other extensions or your files, and can only connect to the sites listed above. They can still show you anything '
  + 'inside their own panel, so only approve extensions from people you trust.';

function _permissionList(lines, highlight = []) {
  const added = new Set(highlight);
  return `<ul class="sm-permission-list">${(lines || []).map(line => (
    `<li${added.has(line) ? ' class="sm-permission-new"' : ''}>${_escape(line)}${added.has(line) ? ' <span>new</span>' : ''}</li>`
  )).join('')}</ul>`;
}

/** Approval, status and permissions shown under an extension's row. */
function _extensionTrustHtml(extension) {
  const summary = extension.permissionSummary || [];
  const status = extension.status;
  if (extension.approvalChanged) {
    return `<div class="sm-trust-note">${status === 'approved' ? 'Approval removed.' : 'Approved.'} Restart Atmos to apply.</div>`;
  }
  if (extension.tier !== 'third-party' && status === 'tampered') {
    return `<div class="sm-trust-note sm-trust-alert">Not loaded: ${_escape(extension.statusReason)}. Reinstall Atmos to repair it.</div>`;
  }
  if (status === 'blocked') {
    return `<div class="sm-trust-note sm-trust-alert">Not loaded: ${_escape(extension.statusReason)}.</div>`;
  }
  if ((status === 'pending' || status === 'changed') && extension.enabled) {
    const title = status === 'pending'
      ? 'This extension asks to:'
      : `${_escape(extension.statusReason)}. Review it again. It asks to:`;
    return `
      <div class="sm-trust-note sm-trust-review">
        <div>${title}</div>
        ${_permissionList(summary, status === 'changed' ? extension.newPermissions : [])}
        <p class="sm-trust-warning">${_SANDBOX_WARNING}</p>
        <div class="sm-trust-actions">
          <button type="button" class="sm-restart-button" data-trust-action="approve">Approve</button>
          <button type="button" class="sm-trust-secondary" data-trust-action="keep-disabled">Keep disabled</button>
        </div>
        <div class="sm-trust-error" hidden></div>
      </div>`;
  }
  return `
    <details class="sm-permissions">
      <summary>Permissions</summary>
      ${_permissionList(summary)}
      ${extension.tier === 'third-party' && status === 'approved'
        ? '<button type="button" class="sm-trust-secondary" data-trust-action="revoke">Remove approval</button>'
        : ''}
    </details>`;
}

function _renderExtensionsPage() {
  _headerEl.classList.remove('sm-no-search');
  const extensions = _extensions[_activeCategory] || [];
  const kind = _activeCategory === _PLUGINS_PAGE_ID ? 'plugin' : 'service';
  const filtered = _searchTerm
    ? extensions.filter(extension => `${_extensionLabel(extension)} ${extension.id}`.toLowerCase().includes(_searchTerm))
    : extensions;

  _searchEl.placeholder = `Search ${_activeCategory.toLowerCase()}…`;

  if (!extensions.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No ${_activeCategory.toLowerCase()} are installed.</div>`;
    return;
  }
  if (!filtered.length) {
    _listEl.innerHTML = `<div id="settings-menu-empty">No matches for "${_escape(_searchEl.value.trim())}".</div>`;
    return;
  }

  _listEl.innerHTML = `
    <div class="sm-extension-toolbar">
      <span>Disabled extensions are skipped before any of their code is loaded.</span>
      ${_hasPendingRestart() ? '<button type="button" class="sm-restart-button">Restart Atmos</button>' : ''}
    </div>`;

  _listEl.querySelector('.sm-restart-button')?.addEventListener('click', () => {
    window.atmosCore?.restartAtmos?.();
  });

  for (const extension of filtered) {
    const label = _extensionLabel(extension);
    const system = extension.tier === 'system';
    const tierLabel = _TIER_LABELS[extension.tier] || _TIER_LABELS['third-party'];
    const card = document.createElement('div');
    card.className = `sm-card sm-extension-card${extension.enabled ? '' : ' disabled'}`;
    card.innerHTML = `
      <label class="sm-card-main">
        <div class="sm-icon">${_FALLBACK_ICON}</div>
        <div class="sm-card-text">
          <div class="sm-card-name">${_escape(label)} <span class="sm-tier-badge" data-tier="${_escape(extension.tier || 'third-party')}">${tierLabel}</span></div>
          <div class="sm-card-detail">${_escape(extension.id)} · ${_escape(_extensionStatusText(extension))}</div>
        </div>
        ${system ? '' : `<span class="sm-toggle">
          <input type="checkbox" ${extension.enabled ? 'checked' : ''} aria-label="Enable ${_escape(label)}">
          <span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span>
        </span>`}
      </label>
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

    _listEl.appendChild(card);
  }
}

function _renderList() {
  _clearPageCleanups();
  _headerEl.classList.remove('sm-no-search');

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

async function _refreshExtensions() {
  try {
    const [plugins, services] = await Promise.all([
      window.atmosCore?.listPlugins?.() ?? [],
      window.atmosCore?.listServices?.() ?? [],
    ]);
    _extensions = { Plugins: plugins, Services: services };
    if (_overlay?.classList.contains('open')) _render();
  } catch (error) {
    console.warn('[settings] failed to discover extensions:', error.message);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export function openSettingsMenu() {
  _build();
  _loadVersion();
  _render();
  _overlay.classList.add('open');
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
  _refreshExtensions();
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

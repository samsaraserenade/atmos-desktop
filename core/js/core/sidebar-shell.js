import { save, onStateLoaded } from '../persist.js';
import { sidebarState } from './sidebar-state.js';
import { appearanceState, setSidebarPosition } from './appearance.js';
import { openMenu } from './context-menu.js';
import { onShortcut } from './shortcuts.js';
import { getActivePanelPluginId, listPanelPlugins } from './panel-registry.js';

const LEGACY_ORDER_KEY = 'atmos_section_order';
const MIDDLE_CLICK_MAX_MS = 250;
const MIDDLE_CLICK_MOVE_PX = 5;
// Rows in Atmos's widgets are 28px high. Core uses that rhythm for resize
// increments and as the smallest compressed section, but leaves untouched
// sections at their natural content height.
const DEFAULT_SECTION_RESIZE_STEP = 28;
const wiredSections = new WeakSet();

let dragging = null;
let middleClick = null;

function toggleSettings() {
  import('./settings-menu.js')
    .then(module => module.toggleSettingsMenu())
    .catch(error => console.warn('[settings] settings menu failed to load:', error.message));
}

function openSettings() {
  import('./settings-menu.js')
    .then(module => module.openSettingsMenu())
    .catch(error => console.warn('[settings] settings menu failed to load:', error.message));
}

let footerVersion = null;  // this Atmos's version, once known
let footerUpdate = null;   // what the footer says about a newer one, if any

function renderFooterVersion() {
  const element = document.getElementById('sidebar-footer-version');
  if (!element) return;
  const text = footerVersion ? `Version ${footerVersion}` : 'Version —';
  element.textContent = footerUpdate ? `${text} · ${footerUpdate.short}` : text;
  element.classList.toggle('update', !!footerUpdate);
  element.title = footerUpdate ? footerUpdate.long : '';
  if (footerUpdate) {
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
  } else {
    element.removeAttribute('role');
    element.removeAttribute('tabindex');
  }
}

function loadSidebarFooterVersion() {
  Promise.resolve(window.atmosCore?.getAppVersion?.())
    .then(appVersion => { footerVersion = appVersion || null; })
    .catch(() => { footerVersion = null; })
    .finally(renderFooterVersion);
  const element = document.getElementById('sidebar-footer-version');
  const open = () => {
    if (!footerUpdate) return;
    import('./settings-menu.js')
      .then(module => module.openAtmosSettings())
      .catch(error => console.warn('[settings] settings menu failed to load:', error.message));
  };
  element?.addEventListener('click', open);
  element?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
}

/** A newer Atmos, said beside the version in the footer; clicking it opens Settings → Atmos. */
function describeAtmosUpdate(summary) {
  if (!summary?.atmosUpdate) return null;
  const { version } = summary.atmosUpdate;
  const self = summary.atmos?.version === version ? summary.atmos : null;
  if (self?.phase === 'ready') return { short: `${version} ready`, long: `Atmos ${version} is ready: restart to update` };
  if (self?.phase === 'downloading') return { short: `downloading ${version}`, long: `Downloading Atmos ${version}` };
  return { short: `${version} available`, long: `Atmos ${version} is available` };
}

function panel() { return document.getElementById('settings-panel-main'); }
function scrollRegion() { return document.getElementById('sidebar-scroll-region'); }
function bottomDock() { return document.getElementById('sidebar-bottom-dock'); }
function topDock() { return document.getElementById('sidebar-top-dock'); }
function sections() { return [...(panel()?.querySelectorAll('.fin-section') || [])]; }

/**
 * Put a section (a widget, holding its extension's frame) in `parent`
 * before `before` (null: at the end). Moving an element that holds an
 * iframe reloads the iframe, so a widget would start over (a docked
 * Balance redrew from scratch whenever another widget was dragged), unless
 * it's moved with moveBefore(), Chromium's state-preserving move. Nothing
 * moves when it's already there.
 */
function place(parent, element, before = null) {
  if (element.parentElement === parent && (before ? element.nextElementSibling === before : parent.lastElementChild === element)) return;
  if (before === element) return;
  if (typeof parent.moveBefore === 'function' && element.isConnected && parent.isConnected) {
    try { parent.moveBefore(element, before); return; } catch { /* not movable atomically: below */ }
  }
  parent.insertBefore(element, before);
}

/** Put `wanted` (in order) at the end of `host`, moving only what isn't already in place. */
function arrange(host, wanted) {
  const current = [...host.children].filter(item => item.matches('.fin-section'));
  const tail = current.slice(current.length - wanted.length);
  if (tail.length === wanted.length && tail.every((item, index) => item === wanted[index])) return;
  for (const section of wanted) place(host, section);
}

function sectionId(section, fallbackIndex = 0) {
  if (!section.dataset.sid) section.dataset.sid = section.id || `sec-${fallbackIndex}`;
  return section.dataset.sid;
}

function isDocked(section) {
  const id = sectionId(section);
  return sidebarState.topDockedSections.includes(id) ? 'top'
    : sidebarState.dockedSections.includes(id) ? 'bottom' : null;
}

/** A widget can say which panels it shows beside by default (`showIn`);
 *  the person's own choice, including an explicit Global (`[]`), wins. */
function defaultPanelScope(section) {
  try {
    const value = JSON.parse(section.dataset.defaultScope || '[]');
    return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : [];
  } catch { return []; }
}

function sectionPanelScope(section) {
  const saved = sidebarState.panelScopes[sectionId(section)];
  return Array.isArray(saved) ? saved : defaultPanelScope(section);
}

/** Re-evaluate every mounted accordion when the active workspace panel changes. */
export function applySidebarPanelScopes() {
  const activePanelId = getActivePanelPluginId();
  const registeredPanelIds = new Set(listPanelPlugins().map(plugin => plugin.id));
  for (const section of sections()) {
    const scope = sectionPanelScope(section);
    // A scope whose plugin is temporarily unavailable must not strand the
    // accordion with no route back to its context menu. Treat it as Global
    // until that panel is registered again, while preserving the preference.
    const availableScopes = scope.filter(id => registeredPanelIds.has(id));
    section.hidden = availableScopes.length > 0 && !availableScopes.includes(activePanelId);
  }
}

function setSectionPanelScope(section, panelId) {
  const id = sectionId(section);
  const scope = sectionPanelScope(section);
  const next = panelId
    ? (scope.includes(panelId) ? scope.filter(item => item !== panelId) : [...scope, panelId])
    : [];
  const fallback = defaultPanelScope(section);
  const sameAsDefault = next.length === fallback.length && next.every(item => fallback.includes(item));
  if (sameAsDefault) delete sidebarState.panelScopes[id];
  else sidebarState.panelScopes[id] = next; // [] = Global, kept so a default can't override it
  applySidebarPanelScopes();
  save();
}

function dataNumber(section, key, fallback = null) {
  const value = Number(section.dataset[key]);
  return Number.isFinite(value) ? value : fallback;
}

function configuredSectionHeight(section) {
  if (section.dataset.resizable === 'false') return null;
  const id = sectionId(section);
  if (Object.prototype.hasOwnProperty.call(sidebarState.sectionHeights, id)) {
    const saved = sidebarState.sectionHeights[id];
    // Older builds stored "auto" when the resize edge was double-clicked.
    // Treat that as a reset to natural/plugin-defined height.
    if (saved !== 'auto' && Number.isFinite(saved)) return saved;
  }
  return dataNumber(section, 'defaultHeight');
}

function clampSectionHeight(section, height) {
  const minimum = Math.max(DEFAULT_SECTION_RESIZE_STEP, dataNumber(section, 'minHeight', DEFAULT_SECTION_RESIZE_STEP));
  return Math.round(Math.max(minimum, height));
}

function snapSectionHeight(section, height) {
  const step = Math.max(1, dataNumber(section, 'resizeStep', DEFAULT_SECTION_RESIZE_STEP));
  const origin = dataNumber(section, 'defaultHeight', DEFAULT_SECTION_RESIZE_STEP);
  return clampSectionHeight(section, origin + Math.round((height - origin) / step) * step);
}

function applySectionHeight(section, previewHeight) {
  const height = previewHeight ?? configuredSectionHeight(section);
  const custom = Number.isFinite(height);
  section.classList.toggle('has-custom-height', custom);
  if (custom) section.style.setProperty('--sidebar-section-height', `${clampSectionHeight(section, height)}px`);
  else section.style.removeProperty('--sidebar-section-height');
}

function applySidebarSectionHeights() {
  sections().forEach(section => applySectionHeight(section));
}

function setSectionHeight(section, height) {
  const id = sectionId(section);
  if (height === null) delete sidebarState.sectionHeights[id];
  else sidebarState.sectionHeights[id] = snapSectionHeight(section, height);
  applySectionHeight(section);
  save();
}

function attachSectionResizeHandle(section) {
  let resizeHandle = section.querySelector('.fin-section-resize-handle');
  if (section.dataset.resizable === 'false') {
    resizeHandle?.remove();
    return;
  }
  if (!resizeHandle) {
    resizeHandle = document.createElement('div');
    resizeHandle.className = 'fin-section-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-orientation', 'horizontal');
    resizeHandle.tabIndex = 0;
    resizeHandle.setAttribute('aria-label', 'Resize sidebar section');
    section.appendChild(resizeHandle);
  }

  let resize = null;
  resizeHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !section.classList.contains('open')) return;
    event.preventDefault();
    event.stopPropagation();
    const body = section.querySelector('.fin-section-body');
    const startHeight = body?.getBoundingClientRect().height || 80;
    resize = { pointerId: event.pointerId, startY: event.clientY, startHeight, previewHeight: startHeight };
    resizeHandle.setPointerCapture(event.pointerId);
    section.classList.add('resizing');
    document.body.classList.add('sidebar-section-resizing');
  });
  resizeHandle.addEventListener('pointermove', event => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    resize.previewHeight = snapSectionHeight(section, resize.startHeight + event.clientY - resize.startY);
    applySectionHeight(section, resize.previewHeight);
  });
  const finishResize = event => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    const height = resize.previewHeight;
    resize = null;
    section.classList.remove('resizing');
    document.body.classList.remove('sidebar-section-resizing');
    setSectionHeight(section, height);
  };
  resizeHandle.addEventListener('pointerup', finishResize);
  resizeHandle.addEventListener('pointercancel', event => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    resize = null;
    section.classList.remove('resizing');
    document.body.classList.remove('sidebar-section-resizing');
    applySectionHeight(section);
  });
  resizeHandle.addEventListener('dblclick', event => {
    event.preventDefault();
    event.stopPropagation();
    setSectionHeight(section, null);
  });
  resizeHandle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      setSectionHeight(section, null);
      return;
    }
    const body = section.querySelector('.fin-section-body');
    const current = body?.getBoundingClientRect().height || configuredSectionHeight(section);
    const step = Math.max(1, dataNumber(section, 'resizeStep', DEFAULT_SECTION_RESIZE_STEP));
    setSectionHeight(section, current + (event.key === 'ArrowDown' ? step : -step));
  });
}

function applyDockedSections() {
  const normalHost = scrollRegion();
  const dockHost = bottomDock();
  const topHost = topDock();
  if (!normalHost || !dockHost || !topHost) return;
  for (const section of sections()) {
    const docked = isDocked(section);
    section.classList.toggle('docked-bottom', docked === 'bottom');
    section.classList.toggle('docked-top', docked === 'top');
    if (!docked && section.parentElement !== normalHost) place(normalHost, section);
  }
  const byIds = ids => ids.map(id => sections().find(item => sectionId(item) === id)).filter(Boolean);
  arrange(dockHost, byIds(sidebarState.dockedSections));
  arrange(topHost, byIds(sidebarState.topDockedSections));
  applySidebarSectionHeights();
}

function setSectionDocked(section, docked) {
  const id = sectionId(section);
  sidebarState.dockedSections = sidebarState.dockedSections.filter(item => item !== id);
  sidebarState.topDockedSections = sidebarState.topDockedSections.filter(item => item !== id);
  if (docked === 'bottom') sidebarState.dockedSections.push(id);
  if (docked === 'top') sidebarState.topDockedSections.push(id);
  applyDockedSections();
  saveOrder();
  save();
}

function saveOpenSections() {
  sidebarState.openSections = sections()
    .filter(section => section.classList.contains('open'))
    .map((section, index) => sectionId(section, index));
  save();
}

export function restoreSidebarOpenState() {
  const openIds = new Set(sidebarState.openSections);
  sections().forEach((section, index) => {
    section.classList.toggle('open', openIds.has(sectionId(section, index)));
  });
}

function saveOrder() {
  sidebarState.order = sections().map((section, index) => sectionId(section, index));
  // Keep preferences for temporarily unmounted sections while saving dock order.
  for (const [key, host] of [['dockedSections', bottomDock()], ['topDockedSections', topDock()]]) {
    const ids = [...(host?.children || [])].filter(item => item.matches('.fin-section')).map(item => sectionId(item));
    sidebarState[key] = [...ids, ...sidebarState[key].filter(id => !ids.includes(id))];
  }
  save();
}

function migrateLegacyOrder() {
  if (sidebarState.order.length) return;
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY));
    if (Array.isArray(legacy) && legacy.length) {
      sidebarState.order = legacy;
      save();
    }
  } catch {}
  localStorage.removeItem(LEGACY_ORDER_KEY);
}

export function restoreSidebarOrder() {
  const host = scrollRegion();
  if (!host) return;
  sections().forEach(sectionId);
  migrateLegacyOrder();
  arrange(host, sidebarState.order.map(id => sections().find(section => section.dataset.sid === id)).filter(Boolean));
  applyDockedSections();
}

export function attachSidebarSection(section, { contextMenuItems } = {}) {
  if (!section || wiredSections.has(section)) return;
  wiredSections.add(section);
  const handle = section.querySelector('.fin-section-label');
  attachSectionResizeHandle(section);
  applySectionHeight(section);

  handle?.addEventListener('click', event => {
    if (event.target.closest('.sd-action, .lib-header-actions, .fin-section-header-extra, input, button')) return;
    event.stopPropagation();
    section.classList.toggle('open');
    saveOpenSections();
  });
  section.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    const docked = isDocked(section);
    const label = section.querySelector('.fin-section-name')?.textContent?.trim() || 'Accordion';
    const showMenu = () => {
      const scope = sectionPanelScope(section);
      const panelChoices = listPanelPlugins().map(plugin => ({
        id: `sidebar.scope.${plugin.id}`,
        label: `${scope.includes(plugin.id) ? '✓ ' : ''}${plugin.label}`,
        run: () => { setSectionPanelScope(section, plugin.id); showMenu(); },
      }));
      let settingsItems = [];
      try {
        const contributed = contextMenuItems?.();
        if (Array.isArray(contributed)) {
          settingsItems = contributed.filter(item => item && (
            item.type === 'separator' || item.type === 'meta' ||
            (typeof item.label === 'string' && typeof item.run === 'function')
          ));
        }
      } catch (error) {
        console.error('[sidebar] context menu settings failed for', section.id, error);
      }
      openMenu(event.clientX, event.clientY, [
        { type: 'meta', label },
        { type: 'separator' },
        { type: 'meta', label: 'Show in' },
        {
          id: 'sidebar.scope.global',
          label: `${scope.length ? '' : '✓ '}Global`,
          run: () => { setSectionPanelScope(section, null); showMenu(); },
        },
        ...panelChoices,
        { type: 'separator' },
        {
          id: docked === 'top' ? 'sidebar.release-top' : 'sidebar.dock-top',
          label: docked === 'top' ? 'Release from top' : 'Dock to top',
          run: () => setSectionDocked(section, docked === 'top' ? null : 'top'),
        },
        {
          id: docked === 'bottom' ? 'sidebar.release-bottom' : 'sidebar.dock-bottom',
          label: docked === 'bottom' ? 'Release from bottom' : 'Dock to bottom',
          run: () => setSectionDocked(section, docked === 'bottom' ? null : 'bottom'),
        },
        ...(settingsItems.length ? [
          { type: 'separator' },
          { type: 'meta', label: 'Settings' },
          ...settingsItems,
        ] : []),
      ]);
    };
    showMenu();
  });
  applySidebarPanelScopes();
  section.addEventListener('mousedown', event => {
    section.draggable = !!(handle && handle.contains(event.target));
  });
  section.addEventListener('mouseup', () => { section.draggable = false; });
  section.addEventListener('dragstart', event => {
    dragging = section;
    event.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => { section.style.opacity = '0.35'; });
  });
  section.addEventListener('dragend', () => {
    section.style.opacity = '';
    sections().forEach(item => item.classList.remove('drag-over'));
    dragging = null;
    saveOrder();
    applyDockedSections();
  });
  section.addEventListener('dragover', event => {
    if (!dragging || dragging === section || dragging.parentElement !== section.parentElement) return;
    event.preventDefault();
    const bounds = section.getBoundingClientRect();
    sections().forEach(item => item.classList.remove('drag-over'));
    section.classList.add('drag-over');
    if (event.clientY > bounds.top + bounds.height / 2) place(section.parentElement, dragging, section.nextElementSibling);
    else place(section.parentElement, dragging, section);
  });
  section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
  section.addEventListener('drop', event => {
    event.preventDefault();
    section.classList.remove('drag-over');
  });
}

export function openSidebar() {
  document.getElementById('settings-drawer')?.classList.add('open');
  document.body.classList.add('drawer-open');
  sidebarState.open = true;
  save();
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
}

export function closeSidebar() {
  document.getElementById('settings-drawer')?.classList.remove('open');
  document.body.classList.remove('drawer-open');
  sidebarState.open = false;
  save();
  window.dispatchEvent(new Event('atmos:interactive-ui-changed'));
}

export function toggleSidebar() {
  sidebarState.open ? closeSidebar() : openSidebar();
}

document.getElementById('acc-sidebar')?.addEventListener('click', event => {
  event.stopImmediatePropagation();
  event.stopPropagation();
  toggleSidebar();
}, true);

document.getElementById('acc-plugin-settings')?.addEventListener('click', event => {
  event.stopImmediatePropagation();
  event.stopPropagation();
  toggleSettings();
}, true);

// Ctrl+Shift+` opens and closes the sidebar and Ctrl+` Settings, from
// anywhere, even while typing (shortcuts.js; keymap.mjs has every key).
// Moving the sidebar to the other side is a command (rev/sidebar-side).
onShortcut('sidebar', () => toggleSidebar());
onShortcut('settings', () => toggleSettings());

/** The sidebar to the other side of the window (rev/sidebar-side). */
export function flipSidebarSide() {
  setSidebarPosition(appearanceState.sidebarPosition === 'left' ? 'right' : 'left');
}

// An older event name for the same (e2e scripts).
window.addEventListener('atmos:toggle-sidebar', () => toggleSidebar());

document.getElementById('sidebar-footer-settings')?.addEventListener('click', event => {
  event.stopPropagation();
  openSettings();
});

// The Extensions button: opens Settings on the extension manager, and turns
// the negative colour when a community extension waits for approval, an
// update is available, a change waits for a restart, or an extension failed
// to load. The tooltip says which.
const extensionsButton = document.getElementById('sidebar-footer-extensions');
extensionsButton?.addEventListener('click', event => {
  event.stopPropagation();
  import('./settings-menu.js')
    .then(module => module.openExtensionManager())
    .catch(error => console.warn('[settings] settings menu failed to load:', error.message));
});

function describeExtensionAttention(summary) {
  const lines = [];
  // A community extension copied in by hand shows nothing until approved.
  const approvals = summary?.approvals || [];
  if (approvals.length) {
    lines.push(approvals.length === 1
      ? `${approvals[0].name} needs your approval`
      : `${approvals.length} extensions need your approval`);
  }
  if (summary?.problems?.length) {
    lines.push(summary.problems.length === 1
      ? `${summary.problems[0].name} didn't load`
      : `${summary.problems.length} extensions didn't load`);
  }
  if (summary?.updates) lines.push(`${summary.updates} update${summary.updates === 1 ? '' : 's'} available`);
  if (summary?.pending) lines.push('Restart to apply changes');
  return lines;
}

function showExtensionAttention(summary) {
  if (!extensionsButton) return;
  const lines = describeExtensionAttention(summary);
  extensionsButton.classList.toggle('attention', lines.length > 0);
  const label = lines.length ? `Extensions: ${lines.join(', ')}` : 'Extensions';
  extensionsButton.title = label;
  extensionsButton.setAttribute('aria-label', label);
}

function showManagerSummary(summary) {
  showExtensionAttention(summary);
  footerUpdate = describeAtmosUpdate(summary);
  renderFooterVersion();
}

window.atmosCore?.extensionManager?.onChange?.(payload => showManagerSummary(payload?.summary));
Promise.resolve(window.atmosCore?.extensionManager?.status?.())
  .then(payload => showManagerSummary(payload?.summary))
  .catch(() => {});

loadSidebarFooterVersion();

document.addEventListener('pointerdown', event => {
  if (event.button !== 1) return;
  middleClick = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    startedAt: performance.now(), dragged: false,
  };
}, true);

document.addEventListener('pointermove', event => {
  if (!middleClick || event.pointerId !== middleClick.pointerId) return;
  if (Math.hypot(event.clientX - middleClick.x, event.clientY - middleClick.y) > MIDDLE_CLICK_MOVE_PX) {
    middleClick.dragged = true;
  }
}, true);

document.addEventListener('pointerup', event => {
  if (event.button !== 1 || !middleClick || event.pointerId !== middleClick.pointerId) return;
  const gesture = middleClick;
  middleClick = null;
  const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > MIDDLE_CLICK_MOVE_PX;
  if (!gesture.dragged && !moved && performance.now() - gesture.startedAt <= MIDDLE_CLICK_MAX_MS) toggleSettings();
}, true);

document.addEventListener('pointercancel', event => {
  if (middleClick?.pointerId === event.pointerId) middleClick = null;
}, true);

// The mouse back button does nothing in Atmos's own page (it used to switch
// panels). Chromium treats it as "go back" unless mousedown is cancelled,
// which would take the page or a frame back through its history. Pages in
// Atmos Browser are their own web contents and keep it.
for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  document.addEventListener(type, event => { if (event.button === 3) event.preventDefault(); });
}

sections().forEach(attachSidebarSection);
onStateLoaded(() => {
  const drawer = document.getElementById('settings-drawer');
  drawer?.classList.toggle('open', sidebarState.open);
  document.body.classList.toggle('drawer-open', sidebarState.open);
  restoreSidebarOrder();
  restoreSidebarOpenState();
  applySidebarPanelScopes();
  applySidebarSectionHeights();
});

window.addEventListener('atmos:active-panel-changed', applySidebarPanelScopes);
window.addEventListener('resize', applySidebarSectionHeights);

panel()?.addEventListener('wheel', event => event.stopPropagation(), { passive: true });



import { save, onStateLoaded } from '../persist.js';
import { createLifecycleScope } from './lifecycle.js';
import { sidebarState } from './sidebar-state.js';
import {
  attachSidebarSection, restoreSidebarOpenState, restoreSidebarOrder,
} from './sidebar-shell.js';

const sections   = new Map(); // id -> def (metadata for every registered widget, mounted or not)
const mountedEls = new Map(); // id -> section element, only present while mounted
const mountedScopes = new Map(); // id -> lifecycle scope

const CHEVRON_SVG = `<svg class="fin-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>`;

/**
 * Register (or re-register) a sidebar section.
 * @param {string} id - stable, unique — also used as the section's DOM id
 *   (`fin-section-<id>`) so drag-reorder persistence has something stable
 *   to key off, same as the static HTML sections rely on their own `id`.
 * @param {object} def
 * @param {number} [def.order=0] - sort position among dynamic sections.
 * @param {string} def.icon - SVG markup shown left of the label.
 * @param {string} def.label - section title text.
 * @param {string} [def.headerExtra] - extra markup in the label row (e.g.
 *   an inline add-input). Automatically wrapped in a `.fin-section-header-extra`
 *   div, which core uses to right-align it, hide it until the section is
 *   open, and exclude it from the open/close click target — so your own
 *   markup/classes inside headerExtra never need to be named in core.
 * @param {boolean} [def.defaultEnabled=true] - whether this widget shows by
 *   default the first time it's ever seen. Ignored on every subsequent load
 *   once the user has an explicit sidebar namespace entry.
 * @param {boolean} [def.resizable=true] - set false for fixed-content sections
 *   that should always use their natural height.
 * @param {number} [def.defaultHeight] - optional initial expanded body height
 *   in px. Without one, the section fits its content naturally.
 * @param {number} [def.resizeStep=28] - resize interval in px.
 * @param {number} [def.minHeight=28] - minimum user-resized body height.
 * @param {() => Array<{id?: string, label?: string, icon?: string, run?: Function, type?: string}>} [def.contextMenuItems]
 *   Synchronously returns fresh plugin settings each time the accordion menu opens.
 *   Core adds a Settings heading when nonempty. Use the shared openMenu item shape;
 *   plugins own action handling and persistence. Exceptions leave core actions available.
 * @param {(bodyEl: HTMLElement) => void} def.mount - build your content.
 *   Called once each time the section is (re)inserted into the DOM.
 * @param {(bodyEl: HTMLElement) => void} [def.unmount] - tear down anything
 *   mount() started (subscriptions, observers, timers). Called right before
 *   the section's DOM is removed. Optional, but strongly recommended for
 *   any mount() that subscribes to something ongoing — without it, that
 *   subscription outlives the widget being disabled.
 */
export function registerSection(id, def) {
  if (!id) { console.warn('[sidebar-registry] registerSection called without an id'); return; }
  if (sections.has(id)) { console.warn('[sidebar-registry] duplicate section id:', id, '— ignoring'); return; }
  sections.set(id, def);
  // Deferred until state has actually loaded — reading the sidebar namespace before
  // load() has populated it would mean every widget mounts as if freshly
  // seen (defaultEnabled) on every single page load, then immediately
  // unmounts again once load() resolves and the real enabled state is
  // known. onStateLoaded() calls its callback immediately if load() already
  // ran, so this is a no-op delay in the common case.
  onStateLoaded(() => _applyMountState(id));
}

function _applyMountState(id) {
  const def = sections.get(id);
  if (!def) return; // unregistered before state finished loading
  const enabled = sidebarState.enabled[id] ?? def.defaultEnabled ?? true;
  if (enabled) _mount(id, def);
}

/**
 * Enable or disable a registered widget without forgetting it. Persists the
 * choice to the Core-owned sidebar namespace and mounts/unmounts immediately —
 * this is what a future "customize sidebar" settings UI should call.
 */
export function setSectionEnabled(id, enabled) {
  const def = sections.get(id);
  if (!def) { console.warn('[sidebar-registry] setSectionEnabled called for unknown id:', id); return; }
  sidebarState.enabled[id] = !!enabled;
  save();
  if (enabled) _mount(id, def); else _unmount(id);
}

/** List every widget that's registered this session, mounted or not — for
 *  a future settings UI to render as a checklist. */
export function getRegisteredSections() {
  return [...sections.keys()].map(id => {
    const def = sections.get(id);
    return {
      id,
      label:   def.label || id,
      icon:    def.icon,
      order:   def.order ?? 0,
      enabled: sidebarState.enabled[id] ?? def.defaultEnabled ?? true,
      resizable: def.resizable !== false,
      defaultHeight: Number.isFinite(def.defaultHeight) ? def.defaultHeight : null,
      resizeStep: Number.isFinite(def.resizeStep) ? def.resizeStep : 28,
      minHeight: Number.isFinite(def.minHeight) ? def.minHeight : 28,
    };
  });
}

/** Permanently forget a widget — removes it from the sidebar and from the
 *  registry entirely (unlike setSectionEnabled(id, false), which keeps it
 *  around, just hidden, so it can be listed and re-enabled later). */
export function unregisterSection(id) {
  _unmount(id);
  sections.delete(id);
}

function _mount(id, def) {
  if (mountedEls.has(id)) return; // already mounted — avoid double-mounting

  const host = document.getElementById('sidebar-scroll-region');
  if (!host) { console.warn('[sidebar-registry] #sidebar-scroll-region not found in DOM'); return; }

  const section = document.createElement('div');
  section.className = 'fin-section';
  section.id = `fin-section-${id}`;
  if (def.resizable === false) section.dataset.resizable = 'false';
  if (Number.isFinite(def.defaultHeight)) section.dataset.defaultHeight = String(def.defaultHeight);
  if (Number.isFinite(def.resizeStep)) section.dataset.resizeStep = String(def.resizeStep);
  if (Number.isFinite(def.minHeight)) section.dataset.minHeight = String(def.minHeight);
  if (Array.isArray(def.showIn)) section.dataset.defaultScope = JSON.stringify(def.showIn);
  section.innerHTML = `
    <div class="fin-section-label">
      ${def.icon || ''}
      <span class="fin-section-name">${def.label || id}</span>
      ${def.headerExtra ? `<div class="fin-section-header-extra">${def.headerExtra}</div>` : ''}
      ${CHEVRON_SVG}
    </div>
    <div class="fin-section-body"></div>`;

  // Insert in `order` position among existing *dynamic* siblings only.
  // Static HTML sections (no `fin-section-` id, no registry entry) are not
  // candidates for this comparison — they're stable anchors we don't have
  // an ordering opinion about, not order:0. Treating them as order:0 would
  // let a dynamic section with a low/negative order jump in front of a
  // static section for the wrong reason (an implicit default, not a real
  // ordering decision). Ignoring them entirely means: dynamic sections sort
  // against each other by `order`, and — absent any saved drag order from
  // restoreSidebarOrder() — a newly-registered section lands after every
  // section (static or dynamic) currently in the panel.
  const dynamicSiblings = [...host.children].filter(el => el.id.startsWith('fin-section-'));
  const before = dynamicSiblings.find(el => {
    const otherId = el.id.replace(/^fin-section-/, '');
    const otherDef = sections.get(otherId);
    const otherOrder = otherDef?.order ?? 0;
    const ownOrder = def.order ?? 0;
    return otherOrder > ownOrder || (otherOrder === ownOrder && otherId.localeCompare(id) > 0);
  });
  host.insertBefore(section, before || null);
  mountedEls.set(id, section);

  const body = section.querySelector('.fin-section-body');
  const scope = createLifecycleScope(id, 'sidebar', { bodyEl: body });
  mountedScopes.set(id, scope);
  try {
    def.mount(body, scope.context);
  } catch (err) {
    console.error('[sidebar-registry] mount() failed for', id, err);
    scope.dispose();
    mountedScopes.delete(id);
    mountedEls.delete(id);
    section.remove();
    return;
  }

  // Same click-to-toggle + drag-to-reorder every static section gets.
  attachSidebarSection(section, { contextMenuItems: def.contextMenuItems });
  restoreSidebarOrder();
  restoreSidebarOpenState();
}

function _unmount(id) {
  const section = mountedEls.get(id);
  if (!section) return; // not currently mounted — nothing to do

  const def = sections.get(id);
  const scope = mountedScopes.get(id);
  try {
    def?.unmount?.(section.querySelector('.fin-section-body'), scope?.context);
  } catch (err) {
    console.error('[sidebar-registry] unmount() failed for', id, err);
  } finally {
    scope?.dispose();
    mountedScopes.delete(id);
  }

  section.remove();
  mountedEls.delete(id);
}

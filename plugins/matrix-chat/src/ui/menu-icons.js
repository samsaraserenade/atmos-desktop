// One outline icon system for every context-menu action. Icons deliberately
// use currentColor so hover/disabled states stay in sync with their label.
//
// Rendered with core's own .ctx-ico class (index.html / js/core/context-
// menu.js) rather than a plugin-local one: every action row built for Core's
// openMenu() (context-menu.js, room-list.js) goes through that shared sizing/
// opacity rule now, the same convention every other migrated plugin's menu
// icons use, so there's one icon-in-a-menu-row look across the whole app.
const PATHS = {
  reply: '<path d="M9 17 4 12l5-5v3h3c4 0 7 2 8 6-2-2-4-3-8-3H9v4Z"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  delete: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m9 7 1-3h4l1 3"/><path d="m6 7 1 14h10l1-14"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  background: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 3 3 2-2 6 5"/>',
  leave: '<path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  unlink: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/><path d="M4 4l16 16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="1.6"/><path d="m4 18 5-5 3 3 3-3 5 5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

export function menuIcon(name) {
  return `<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

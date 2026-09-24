/**
 * Audio Player's Library widget: the folders in the library, grouped under
 * the folder you picked, with file counts, per-folder rescan and remove,
 * and scan progress. Add Folder, Scan for New Folders and Rescan Library
 * are the buttons at the top and in the widget's header menu. The engine
 * does the scanning; this only shows it and asks.
 */
import atmos from 'atmos-sdk';
import * as player from './src/client.js';
import { audioState, onStateChange } from './src/state.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/panel.css', import.meta.url).href;
document.head.appendChild(style);
document.documentElement.style.height = 'auto';
document.body.style.height = 'auto';

const RESCAN_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/></svg>';
const FOLDER_ICON = '<svg class="lib-folder-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
const CHEVRON_ICON = '<svg class="lib-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

const call = (method, ...args) => player.call(method, ...args).catch(error => console.error(`[audio-player] ${method}:`, error));
const actions = {
  add: () => call('addFolder'),
  scanNew: () => call('scanForNewFolders'),
  rescanAll: () => call('rescanLibrary'),
};

await player.connect();
document.body.innerHTML = `
  <div class="ap-sidebar-options ap-sidebar-library">
    <div class="lib-actions-row">
      <button class="lib-icon-btn" data-action="rescanAll" title="Rescan library" aria-label="Rescan library">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 4v6h-6M1 20v-6h6M3.5 9A9 9 0 0117.9 5.6L23 10M1 14l5.1 4.4A9 9 0 0020.5 15"/></svg>
      </button>
      <button class="lib-icon-btn" data-action="scanNew" title="Scan for new folders" aria-label="Scan for new folders">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="10" cy="10" r="6"/><path d="M20 20l-4.35-4.35"/></svg>
      </button>
      <button class="lib-icon-btn lib-icon-btn--add" data-action="add" title="Add folder" aria-label="Add folder">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div id="lib-folder-list"></div>
    <span class="lib-empty-hint" id="lib-empty-hint">No folders added yet.</span>
    <div class="lib-status-row"><div class="lib-status" id="lib-status"></div></div>
    <div class="lib-progress-bar" id="lib-progress-bar"><div class="lib-progress-fill" id="lib-progress-fill"></div></div>
  </div>`;
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', event => { event.stopPropagation(); actions[button.dataset.action](); });
});
atmos.surface.setMenu([
  { id: 'add', label: 'Add Folder…', run: actions.add },
  { id: 'scan-new', label: 'Scan for New Folders', run: actions.scanNew },
  { id: 'rescan', label: 'Rescan Library', run: actions.rescanAll },
]).catch(() => {});

const $ = id => document.getElementById(id);
const expandedGroups = new Set(); // this session only, like any collapsed section

const folders = () => Array.isArray(audioState.electronFolders) ? audioState.electronFolders : [];

function trackCount(name) {
  let count = 0;
  for (const album of Object.values(player.library.albums)) {
    for (const track of album.tracks || []) if (track.key.startsWith(`${name}/`)) count++;
  }
  return count;
}

function folderRow(folder, label) {
  const count = trackCount(folder.name);
  const row = document.createElement('div');
  row.className = 'lib-folder-row';
  row.innerHTML = `${FOLDER_ICON}<span class="lib-folder-name"></span><span class="lib-folder-count"></span>` +
    `<button class="lib-rescan-row-btn" title="Rescan this folder">${RESCAN_ICON}</button>` +
    '<button class="lib-rm-btn" title="Remove folder">✕</button>';
  const name = row.querySelector('.lib-folder-name');
  name.textContent = label;
  name.title = folder.name;
  row.querySelector('.lib-folder-count').textContent = count > 0 ? (count === 1 ? '1 file' : `${count} files`) : '—';
  row.querySelector('.lib-rescan-row-btn').addEventListener('click', event => {
    event.stopPropagation();
    call('rescanFolder', folder.name, folder.path);
  });
  row.querySelector('.lib-rm-btn').addEventListener('click', event => {
    event.stopPropagation();
    call('removeFolder', folder.name, folder.path);
  });
  return row;
}

function groupHeader(key, label, leafNames, expanded, rootPath) {
  const total = leafNames.reduce((sum, name) => sum + trackCount(name), 0);
  const header = document.createElement('div');
  header.className = `lib-folder-row lib-group-header${expanded ? ' expanded' : ''}`;
  header.innerHTML = `${CHEVRON_ICON}${FOLDER_ICON}<span class="lib-folder-name"></span>` +
    '<span class="lib-group-badge"></span><span class="lib-folder-count"></span>' +
    `<button class="lib-rescan-row-btn" title="Rescan everything in this folder">${RESCAN_ICON}</button>`;
  const name = header.querySelector('.lib-folder-name');
  name.textContent = label;
  name.title = label;
  header.querySelector('.lib-group-badge').textContent = String(leafNames.length);
  header.querySelector('.lib-folder-count').textContent = total > 0 ? `${total} files` : '—';
  header.querySelector('.lib-rescan-row-btn').addEventListener('click', event => {
    event.stopPropagation(); // not also expand/collapse
    // The outermost header also finds new folders under the picked root.
    call('rescanFolders', leafNames, rootPath || null);
  });
  header.addEventListener('click', () => {
    if (expandedGroups.has(key)) expandedGroups.delete(key);
    else expandedGroups.add(key);
    render();
  });
  return header;
}

/** A tree of path segments; a node can be a container, a folder, or both. */
function segmentTree(list) {
  const root = { children: new Map() };
  for (const folder of list) {
    const segments = folder.name.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      if (!node.children.has(segment)) node.children.set(segment, { segment, children: new Map(), leaf: null });
      node = node.children.get(segment);
      if (index === segments.length - 1) node.leaf = folder;
    });
  }
  return root;
}

function leafNames(node) {
  let names = node.leaf ? [node.leaf.name] : [];
  node.children.forEach(child => { names = names.concat(leafNames(child)); });
  return names;
}

function renderChildren(node, keyPrefix, container) {
  node.children.forEach(child => {
    const childKey = `${keyPrefix}/${child.segment}`;
    if (child.children.size === 0) {
      container.appendChild(folderRow(child.leaf, child.segment));
      return;
    }
    const expanded = expandedGroups.has(childKey);
    const group = document.createElement('div');
    group.className = 'lib-group';
    group.appendChild(groupHeader(childKey, child.segment, leafNames(child), expanded));
    if (expanded) {
      const wrap = document.createElement('div');
      wrap.className = 'lib-group-children';
      // A folder with loose tracks of its own beside its subfolders.
      if (child.leaf) wrap.appendChild(folderRow(child.leaf, '— loose tracks'));
      renderChildren(child, childKey, wrap);
      group.appendChild(wrap);
    }
    container.appendChild(group);
  });
}

function render() {
  const list = $('lib-folder-list');
  list.innerHTML = '';
  // Group by the folder you picked, which always shows, even when it holds
  // only subfolders. Older entries without a root show as plain rows.
  const byRoot = new Map();
  const ungrouped = [];
  for (const folder of folders()) {
    if (!folder.rootPath) { ungrouped.push(folder); continue; }
    if (!byRoot.has(folder.rootPath)) byRoot.set(folder.rootPath, { rootLabel: folder.root, folders: [] });
    byRoot.get(folder.rootPath).folders.push(folder);
  }
  ungrouped.forEach(folder => list.appendChild(folderRow(folder, folder.name)));
  byRoot.forEach(({ rootLabel, folders: group }, rootPath) => {
    const rootOwn = group.find(folder => folder.name === rootLabel) || null;
    const nested = group.filter(folder => folder.name !== rootLabel);
    if (!nested.length) {
      if (rootOwn) list.appendChild(folderRow(rootOwn, rootLabel));
      return;
    }
    const expanded = expandedGroups.has(rootPath);
    const element = document.createElement('div');
    element.className = 'lib-group';
    element.appendChild(groupHeader(rootPath, rootLabel, group.map(folder => folder.name), expanded, rootPath));
    if (expanded) {
      const wrap = document.createElement('div');
      wrap.className = 'lib-group-children';
      if (rootOwn) wrap.appendChild(folderRow(rootOwn, '— loose tracks'));
      renderChildren(segmentTree(nested), rootPath, wrap);
      element.appendChild(wrap);
    }
    list.appendChild(element);
  });
  $('lib-empty-hint').style.display = folders().length ? 'none' : '';
}

function renderStatus() {
  const { msg, isErr, pct } = player.libraryStatus;
  const status = $('lib-status');
  status.textContent = msg || '';
  status.className = `lib-status${isErr ? ' err' : ''}`;
  const bar = $('lib-progress-bar');
  const fill = $('lib-progress-fill');
  bar.style.opacity = pct > 0 ? '1' : '0';
  fill.style.width = pct > 0 ? `${Math.round(pct * 100)}%` : '0%';
}

player.on('library', render);
player.on('status', renderStatus);
onStateChange(render);
render();
renderStatus();

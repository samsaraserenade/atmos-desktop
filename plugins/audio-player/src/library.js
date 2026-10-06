/**
 * Audio Player's music library, run by the engine (boot.js): folder
 * scanning through main.cjs, tag reading through the Media Metadata
 * library, album grouping. The Library widget shows the folders and the
 * panel shows the albums; both read what this saves (store.js) and ask the
 * engine to change it.
 *
 * Folders are persisted as absolute paths (audioState.electronFolders). On
 * every launch the engine re-walks them to rebuild the key → path map used
 * for playback.
 */
import atmos from 'atmos-sdk';
import { audioState, save } from './state.js';
import { saveLibraryMeta } from './store.js';
import { audioFs } from './fs-bridge.js';
import {
  albumKey as buildAlbumKey,
  cleanMetadataText,
  compareTracks,
  mergeSplitAlbums,
  metadataFlag,
  metadataNumber,
  metadataReleaseDate,
  normaliseMetadataText,
  stripFeaturedArtists,
} from './metadata-grouping.js';

import { readTags } from './media-metadata.js';

// Mirrors preload.js's own internal AUDIO_EXTS list (used by walkDir()) —
// kept as a separate, plugin-owned copy rather than reaching into preload's
// internals. electronFS.listDirTree() is a generic, extension-agnostic
// primitive; deciding *which* extensions count as "audio" is this plugin's
// business, not core's.
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'opus', 'wma'];

// ── Module state ──────────────────────────────────────────────────────────────

/** Map from fileKey → absolute file path, rebuilt on every scan. */
const _electronFiles = new Map();

/** Persisted folder list: [{ name: string, path: string }] */
let _electronFolders = [];

/** Albums (with covers) and folder names; saved in IndexedDB (store.js). */
export const library = { albums: {}, folders: [] };

/** Replace the library with what was saved (startup). */
export function setLibrary({ albums, folders } = {}) {
  library.albums = albums && typeof albums === 'object' ? albums : {};
  library.folders = Array.isArray(folders) ? folders : [];
  invalidateAlbumsCache();
}

// Views read the library from IndexedDB; they hear 'library-changed' once a
// change is saved, and 'library-status' for scan progress.
let _lastSave = Promise.resolve();
function persistLibrary() {
  _lastSave = saveLibraryMeta(library.albums, library.folders);
  return _lastSave;
}
let _revision = 0;
async function announce() {
  const revision = ++_revision;
  await _lastSave.catch(() => {});
  if (revision === _revision) atmos.events.emit('library-changed', { revision });
  for (const fn of [..._listeners]) {
    try { fn(); } catch (error) { console.error('[audio-player] library listener failed:', error); }
  }
}
const _listeners = new Set();
/** Engine-side: called after every library change. */
export function onLibraryUpdate(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

function _pathKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('und');
}

function _loadElectronFolders() {
  if (!Array.isArray(audioState.electronFolders)) return [];
  const seen = new Set();
  const folders = audioState.electronFolders.filter(folder => {
    const key = _pathKey(folder?.path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(folder => ({ ...folder }));
  // Saved before names were kept apart: a later folder with a name taken
  // gets its own, one no other folder has (its songs come back with its
  // next scan). reconnectFolders saves it.
  const names = new Set(folders.map(folder => folder.name));
  const used = new Set();
  for (const folder of folders) {
    if (used.has(folder.name)) {
      folder.name = _freeName(folder.name, names);
      names.add(folder.name);
    }
    used.add(folder.name);
  }
  return folders;
}

/**
 * A folder's name in the library is the start of its songs' ids
 * ("<name>/<file>"), so no two folders may share one: two music folders
 * each with an "Album" folder are "Album" and "Album (2)".
 */
function _freeName(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/** Whether `key` is a song of the folder `name`: directly inside it, not a folder within. */
function _inFolder(key, name) {
  return key.startsWith(name + '/') && !key.slice(name.length + 1).includes('/');
}

// The folders you picked (each entry's rootPath; older entries without one
// use their own path). The main process may read only inside these.
function _libraryRoots() {
  const seen = new Set();
  const roots = [];
  for (const folder of _electronFolders) {
    const root = folder.rootPath || folder.path;
    const key = _pathKey(root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

function _saveElectronFolders() {
  audioState.electronFolders = _electronFolders.map(folder => ({ ...folder }));
  save('electronFolders');
  // A removed folder stops being readable. (Only ever shrinks the main
  // process's list; adding happens in its folder dialog.)
  audioFs.keepFolders(_libraryRoots()).catch(error => console.warn('[audio-player] could not update the readable folders:', error));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strip featured/ft/feat suffixes so "Artist feat. X" and "Artist" share one key
function _stripFeat(str) {
  return stripFeaturedArtists(str);
}

// Normalize for grouping: lowercase + collapse whitespace
function _norm(str) {
  return normaliseMetadataText(str);
}

/**
 * Generate a stable album key.
 * Groups by: normalised(albumArtist || artist) + album name.
 * albumArtist (ID3 TPE2) is preferred so compilations / featured tracks
 * don't split into multiple album entries.
 */
export function albumKey(trackArtist, album, albumArtist, trackKey = '') {
  return buildAlbumKey(trackArtist, album, albumArtist, trackKey);
}

function picToDataUrl(picture) {
  if (!picture?.data) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const bytes = new Uint8Array(picture.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const fullDataUrl = `data:${picture.format};base64,${btoa(bin)}`;

      const img = new Image();
      img.onload = () => {
        try {
          const SIZE = 400;
          const c = document.createElement('canvas');
          c.width = SIZE; c.height = SIZE;
          const scale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
          const w = img.naturalWidth  * scale;
          const h = img.naturalHeight * scale;
          c.getContext('2d').drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
          resolve(c.toDataURL('image/jpeg', 0.88));
        } catch (_e) { resolve(fullDataUrl); }
      };
      img.onerror = () => resolve(fullDataUrl);
      img.src = fullDataUrl;
    } catch (_e) { resolve(null); }
  });
}

// ── Directory scanning ────────────────────────────────────────────────────────

/**
 * Walk the full tree under `rootPath` and decide which directories become
 * their own independently-rescannable library entries.
 *
 * Policy (owned entirely by this plugin, not preload.js):
 *   Any directory that directly contains at least one audio file becomes
 *   its own leaf entry — regardless of whether it ALSO has subfolders.
 *   Pure "container" directories (e.g. an Artist folder that holds only
 *   Album subfolders, no loose tracks of its own) are walked through but
 *   never become an entry themselves. This also resolves the "mixed"
 *   case for free: an Artist folder with a couple of loose singles
 *   alongside Album subfolders becomes its own entry for those loose
 *   tracks, in addition to each Album subfolder becoming its own entry —
 *   no separate pseudo-entry/special-casing needed.
 *
 * Returns [{ path, name }], where name is the path relative to rootPath
 * (posix-style, e.g. "ArtistA/Greatest Hits") — collision-safe at any
 * depth, unlike a bare last-path-segment. The picked root itself uses its
 * own last-segment name when it directly qualifies (relativePath === ''),
 * matching today's behavior for picking a single album folder directly.
 */
async function discoverLeafFolders(rootPath) {
  let tree = [];
  try {
    tree = await audioFs.listDirTree(rootPath, AUDIO_EXTENSIONS) || [];
  } catch (_e) { return []; }

  return tree
    .filter(d => d.hasMatchingFiles)
    .map(d => ({
      path: d.path,
      name: d.relativePath || d.path.replace(/\\/g, '/').split('/').pop(),
    }));
}

/**
 * Read only the files directly inside a registered leaf folder, populate _electronFiles,
 * and return an array of { key, fileUrl } entries ready for tag extraction.
 * Registered parent and child folders can legitimately coexist in the mixed-folder
 * layout, so recursively walking each one would import every child file twice.
 */
async function _scanElectronFolder(folderPath, folderName) {
  const entries = await _listFolder(folderPath, folderName);
  _useFiles(entries);
  return entries;
}

/** A folder's songs as { key, filePath }, read from disk; nothing kept yet. */
async function _listFolder(folderPath, folderName) {
  const filePaths = await audioFs.listFiles(folderPath, AUDIO_EXTENSIONS);
  return filePaths.map(fp => {
    const rel = fp.slice(folderPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    return { key: folderName + '/' + rel, filePath: fp };
  });
}

/** Keep these songs' paths for playback. */
function _useFiles(entries) {
  for (const { key, filePath } of entries) _electronFiles.set(key, filePath);
}

/** Drop the folders' songs from the albums (an album left empty goes) and from the paths kept. */
function _dropFolders(names) {
  Object.keys(library.albums).forEach(k => {
    const alb = library.albums[k];
    alb.tracks = alb.tracks.filter(t => !names.some(name => _inFolder(t.key, name)));
    if (!alb.tracks.length) delete library.albums[k];
  });
  invalidateAlbumsCache();
  for (const key of _electronFiles.keys()) {
    if (names.some(name => _inFolder(key, name))) _electronFiles.delete(key);
  }
}

// ── Metadata extraction ───────────────────────────────────────────────────────

const BATCH_SIZE = 2;

function _hasUsefulTags(tags) {
  return Boolean(tags && (tags.title || tags.artist || tags.album || tags.albumArtist || tags.track || tags.picture));
}

function _parseFallbackBytes(bytes) {
  if (!bytes || !window.jsmediatags) return Promise.resolve({});
  return new Promise(resolve => {
    window.jsmediatags.read(new Blob([bytes]), {
      onSuccess: tag => resolve(tag.tags || {}),
      onError: () => resolve({}),
    });
  });
}

async function _readTagsWithFallback(filePath) {
  const primary = await readTags(filePath);
  const supplementExt = filePath.split('.').pop().toLowerCase();
  const needsNativeSupplement = ['flac', 'ogg', 'opus', 'wav'].includes(supplementExt);
  if (_hasUsefulTags(primary) && !needsNativeSupplement) return primary;
  try {
    const fallback = await audioFs.readTagFallback(filePath);
    if (fallback?.tags && _hasUsefulTags(fallback.tags)) return { ...primary, ...fallback.tags, picture: primary.picture || fallback.tags.picture };
    if (fallback?.bytes) {
      const parsed = await _parseFallbackBytes(fallback.bytes);
      if (_hasUsefulTags(parsed)) return parsed;
    }
  } catch (_e) { /* retain the filename-based fallback below */ }
  return primary || {};
}

/**
 * Merge split compilation entries in-place.
 * When a compilation's TPE2 tags contain per-track artists instead of a
 * single album-level value, each track ends up with a unique album key.
 * This pass detects entries that share the same normalised album name and
 * collapses them into one "Various Artists" entry.
 * Exported so app.js can run it against the loaded cache on startup too.
 */
export function mergeCompilations(albumMap) {
  return mergeSplitAlbums(albumMap);
}

async function batchProcess(items, fn, onProgress) {
  let done = 0;
  const total = items.length;
  for (let i = 0; i < total; i += BATCH_SIZE) {
    await Promise.all(
      items.slice(i, i + BATCH_SIZE).map(async item => {
        await fn(item);
        onProgress(++done, total);
      })
    );
  }
}

/**
 * Read the files' tags and add their albums to the library. `replace`, if
 * given, runs just before they're added: a rescan drops what it replaces
 * only once the new set is read.
 */
async function buildFromFiles(fileEntries, { replace } = {}) {
  // A physical file must produce exactly one metadata record, even if stale
  // folder registrations or differently-cased Windows paths overlap.
  const uniqueByPath = new Map();
  for (const entry of fileEntries) {
    const pathKey = entry.filePath.replace(/\\/g, '/').toLocaleLowerCase('und');
    if (!uniqueByPath.has(pathKey)) uniqueByPath.set(pathKey, entry);
  }
  fileEntries = [...uniqueByPath.values()];

  const total    = fileEntries.length;
  const albumMap = {};
  const sidecarCache = new Map();
  const coverCache = new Map();

  setLibStatus(`Scanning 0 of ${total}…`);
  setLibProgress(0);

  await batchProcess(
    fileEntries,
    async ({ key, filePath }) => {
      const tags   = await _readTagsWithFallback(filePath);
      const artist      = cleanMetadataText(tags.artist, 'Unknown Artist');
      const albumArtist = cleanMetadataText(tags.albumArtist || tags.aART || tags['Album Artist'] || tags.TPE2);
      const album       = cleanMetadataText(tags.album, 'Unknown Album');
      const title       = cleanMetadataText(tags.title, key.split('/').pop().replace(/\.[^/.]+$/, ''));
      const num         = metadataNumber(tags.track || tags.TRCK);
      const disc        = metadataNumber(tags.disc || tags.disk || tags.TPOS);
      const compilation = metadataFlag(tags.compilation ?? tags.TCMP ?? tags.cpil);
      const rawDate     = tags.date || tags.year || tags.TDRC || tags.TYER;
      const releaseDate = metadataReleaseDate(rawDate);
      const year        = metadataNumber(rawDate);
      let picture       = tags.picture || null;
      if (!picture) {
        const directory = filePath.replace(/[\\/][^\\/]+$/, '');
        if (!sidecarCache.has(directory)) {
          sidecarCache.set(directory, audioFs.readCoverSidecar(filePath).catch(() => null));
        }
        picture = await sidecarCache.get(directory);
      }
      const k = albumKey(artist, album, albumArtist, key);
      // Share the in-flight conversion across tracks in the same album.
      if (picture && !coverCache.has(k)) {
        coverCache.set(k, picToDataUrl(picture).then(cover => {
          if (!cover) coverCache.delete(k);
          return cover;
        }));
      }
      const cover = coverCache.has(k) ? await coverCache.get(k) : null;

      // Display artist: prefer albumArtist so the card shows "Parcels" not "Parcels; Dean Dawson"
      const displayArtist = albumArtist
        ? _stripFeat(albumArtist) || albumArtist
        : artist;

      if (!albumMap[k]) albumMap[k] = { album, artist: displayArtist, year, releaseDate, cover: null, tracks: [] };
      if (!albumMap[k].cover && cover) albumMap[k].cover = cover;
      albumMap[k].tracks.push({ title, artist, albumArtist, num, disc, compilation, year, releaseDate, key });
    },
    (done, tot) => {
      setLibStatus(`Scanning ${done} of ${tot}…`);
      setLibProgress(done / tot);
    }
  );

  Object.values(albumMap).forEach(a => a.tracks.sort(compareTracks));

  mergeCompilations(albumMap);
  replace?.();
  Object.assign(library.albums, albumMap);
  invalidateAlbumsCache();
  setLibStatus(`✓ ${total} track${total !== 1 ? 's' : ''} imported`);
  setLibProgress(1);
  setTimeout(() => { setLibStatus(''); setLibProgress(0); }, 2500);

  persistLibrary();
  announce();
}

// ── Add / remove folders ──────────────────────────────────────────────────────

/**
 * Register a folder's metadata (path + name + which root folder it was
 * discovered under) without scanning it.
 *
 * `root`/`rootPath` describe the folder the user actually picked in the
 * dialog — needed so the UI can always show that folder, even when it's a
 * pure container with no audio files of its own (see library-view.js).
 * If this exact path is already registered, its root association is
 * backfilled in place (handles entries added before this existed, or
 * re-picking the same directory) rather than duplicating the entry.
 * Returns false in that case — caller should skip re-scanning it.
 */
function _registerFolderMeta(folderPath, folderName, root, rootPath) {
  const existing = _electronFolders.find(f => _pathKey(f.path) === _pathKey(folderPath));
  if (existing) {
    if (rootPath && existing.rootPath !== rootPath) {
      existing.root     = root;
      existing.rootPath = rootPath;
    }
    return null;
  }
  const name = _freeName(folderName, new Set(_electronFolders.map(f => f.name)));
  _electronFolders.push({ name, path: folderPath, root, rootPath });
  if (!library.folders.find(f => f.name === name))
    library.folders.push({ name });
  return { path: folderPath, name };
}

/**
 * Re-discover any NEW leaf folders that have appeared under `rootPath`
 * since it was last scanned — e.g. a new "Chet Baker" album dropped
 * straight into Music/ after Music/ was originally picked. Re-walks the
 * whole tree under rootPath (same discoverLeafFolders() used by
 * addFolder()) and registers any leaf not already known, via
 * _registerFolderMeta() — which already no-ops on paths it's seen before,
 * so this is safe to call on every rescan without duplicating entries.
 * Returns the newly-registered targets (path+name) so the caller can fold
 * them into whatever scan/build pass it's about to run; does NOT scan
 * their files itself and does NOT persist — caller is responsible for
 * calling _saveElectronFolders() if anything came back.
 */
async function _discoverNewLeaves(rootPath, rootLabel) {
  const newTargets = [];
  for (const t of await discoverLeafFolders(rootPath)) {
    const registered = _registerFolderMeta(t.path, t.name, rootLabel, rootPath);
    if (registered) newTargets.push(registered);
  }
  return newTargets;
}

export async function addFolder() {
  let folderPath;
  try {
    folderPath = await audioFs.chooseFolder();
  } catch (err) {
    setLibStatus('Dialog error: ' + (err?.message || String(err)), true);
    return;
  }
  if (!folderPath) return; // user cancelled

  // Discover every leaf folder anywhere under the picked directory — each
  // one becomes its own library entry (independently rescannable/removable
  // via rescanFolder()/removeFolder()), at whatever depth it actually sits
  // at (Artist/Album, Artist/Album/Disc, or a flat pile of tracks), instead
  // of only the immediate children of the picked directory. See
  // discoverLeafFolders() for the leaf/mixed-folder policy. Falls back to
  // registering the picked folder itself only when the Electron bridge
  // doesn't support the tree scan at all.
  let targets = await discoverLeafFolders(folderPath);
  if (!targets.length) {
    targets = [{ path: folderPath, name: folderPath.replace(/\\/g, '/').split('/').pop() }];
  }

  const rootLabel = folderPath.replace(/\\/g, '/').split('/').pop();

  const newTargets = [];
  let alreadyPresent = 0;
  for (const t of targets) {
    const registered = _registerFolderMeta(t.path, t.name, rootLabel, folderPath);
    if (registered) newTargets.push(registered);
    else alreadyPresent++;
  }

  // Save unconditionally — even a "nothing new" pass may have just
  // backfilled root info onto already-registered leaves above.
  _saveElectronFolders();
  announce();

  if (!newTargets.length) {
    setLibStatus(alreadyPresent
      ? 'Those folders are already in your library.'
      : 'No folders found.');
    return;
  }

  try {
    // Scan every new subfolder, then build once across the combined file
    // list — same pattern as reconnectFolders() — so the progress bar and
    // album-merge pass run a single time across all of them rather than
    // once per subfolder.
    const fileEntries = (await Promise.all(newTargets.map(t => _scanElectronFolder(t.path, t.name)))).flat();
    if (!fileEntries.length) {
      setLibStatus('No audio files found in that folder.');
      persistLibrary();
      return;
    }
    await buildFromFiles(fileEntries);
  } catch (err) {
    setLibStatus('Scan failed: ' + (err?.message || 'unknown error'), true);
  }
}

export async function removeFolder(name) {
  return removeFolderByPath(name, _electronFolders.find(f => f.name === name)?.path);
}

export async function removeFolderByPath(name, folderPath) {
  const targetPathKey = _pathKey(folderPath);
  if (!targetPathKey) return;
  // The folder's name as the library has it, not as the caller had it
  // (a name from before it changed is another folder's now).
  name = _electronFolders.find(f => _pathKey(f.path) === targetPathKey)?.name ?? name;

  // Remove tracks belonging to this folder from the album map
  Object.keys(library.albums).forEach(k => {
    const alb = library.albums[k];
    alb.tracks = alb.tracks.filter(t => !_inFolder(t.key, name));
    if (!alb.tracks.length) delete library.albums[k];
  });
  invalidateAlbumsCache();

  // Remove from persisted folder list and file map
  _electronFolders = _electronFolders.filter(f => _pathKey(f.path) !== targetPathKey);
  _saveElectronFolders();
  for (const key of _electronFiles.keys()) {
    if (_inFolder(key, name)) _electronFiles.delete(key);
  }

  if (!_electronFolders.some(f => f.name === name))
    library.folders = library.folders.filter(f => f.name !== name);
  persistLibrary();
  announce();
}

/**
 * Remove a folder you picked, with every folder from it (the Library
 * widget's header for it): one deleted whole, which the library keeps as
 * it would an unplugged drive's (R46).
 */
export async function removePickedFolder(rootPath) {
  const key = _pathKey(rootPath);
  if (!key) return;
  const gone = _electronFolders.filter(f => _pathKey(f.rootPath || f.path) === key);
  if (!gone.length) return;
  const names = gone.map(f => f.name);
  _dropFolders(names);
  _electronFolders = _electronFolders.filter(f => !gone.includes(f));
  _saveElectronFolders();
  library.folders = library.folders.filter(f => !names.includes(f.name) || _electronFolders.some(other => other.name === f.name));
  persistLibrary();
  announce();
}

// ── File resolution (for playback) ───────────────────────────────────────────

/** Returns a file:// URL for the given fileKey, or null if not found. */
export function resolveFile(fileKey) {
  const filePath = _electronFiles.get(fileKey);
  return filePath ? audioFs.mediaUrl(filePath) : null;
}

/** Returns the absolute OS path for a fileKey (for shell operations). */
export function getFilePath(fileKey) {
  return _electronFiles.get(fileKey) || null;
}

// ── Startup reconnect ─────────────────────────────────────────────────────────

/**
 * Called once on launch. Loads saved folder paths from localStorage, rebuilds
 * _electronFiles by walking each folder, then refreshes the UI.
 * No user interaction needed — Electron always has direct fs access.
 */
export async function reconnectFolders() {
  _electronFolders = _loadElectronFolders();
  // First launch with folder checks: the main process takes over the
  // folders this library already had (it ignores this on every later launch).
  try { await audioFs.adoptFolders(_libraryRoots()); }
  catch (error) { console.warn('[audio-player] could not hand over library folders:', error); }
  // Persist the normalized list so any legacy duplicate registrations are
  // repaired once rather than being loaded again on every launch (names
  // made distinct too: the Library widget acts by the saved list).
  const saved = Array.isArray(audioState.electronFolders) ? audioState.electronFolders : [];
  if (_electronFolders.length !== saved.length || _electronFolders.some((folder, i) => folder.name !== saved[i]?.name)) _saveElectronFolders();

  if (!_electronFolders.length) return;

  // Ensure library.folders reflects what's on disk
  for (const { name } of _electronFolders) {
    if (!library.folders.find(f => f.name === name))
      library.folders.push({ name });
  }

  // A folder deleted is a stale registration; one whose drive isn't there
  // is kept, and read once it is (R46).
  const available = [];
  for (const folder of _electronFolders) {
    if (await _isThere(folder)) available.push(folder);
  }
  if (available.length !== _electronFolders.length) {
    const availablePaths = new Set(available.map(f => _pathKey(f.path)));
    const vanished = _electronFolders.filter(f => !availablePaths.has(_pathKey(f.path)));
    const deleted = [];
    const seen = new Map();
    for (const folder of vanished) if (await _wasDeleted(folder, seen)) deleted.push(folder);
    for (const folder of deleted) await removeFolderByPath(folder.name, folder.path);
  }

  await Promise.all(available.map(({ name, path: folderPath }) =>
    _scanElectronFolder(folderPath, name).catch(() => [])
  ));

  announce();
}

// ── Public getters ────────────────────────────────────────────────────────────

// getAlbums() rebuilds + sorts the whole library on every call, and it's
// called very frequently (grid render, context menus, background art, etc).
// Cache the sorted result and only recompute when the album map actually
// changes — callers must go through invalidateAlbumsCache() (or the
// mutation points below already do) whenever library.albums is edited.
let _albumsCache = null;

/** Call after any mutation to library.albums so getAlbums() recomputes. */
export function invalidateAlbumsCache() { _albumsCache = null; }

export function getAlbums() {
  if (_albumsCache) return _albumsCache;
  _albumsCache = Object.entries(library.albums)
    .map(([key, val]) => ({ key, ...val }))
    .sort((a, b) =>
      (_norm(a.artist) + _norm(a.album)).localeCompare(_norm(b.artist) + _norm(b.album))
    );
  return _albumsCache;
}

export function hasLibrary() {
  return Object.keys(library.albums).length > 0;
}

// ── Status (shown by the Library widget) ─────────────────────────────────────

let _status = { msg: '', isErr: false, pct: 0 };
let _statusQueued = false;
function _sendStatus() {
  if (_statusQueued) return;
  _statusQueued = true;
  // Coalesce a burst of progress updates into one event.
  setTimeout(() => {
    _statusQueued = false;
    atmos.events.emit('library-status', { ..._status });
  }, 50);
}
export const getLibraryStatus = () => ({ ..._status });

function setLibStatus(msg, isErr = false) {
  _status = { ..._status, msg, isErr };
  _sendStatus();
}

function setLibProgress(pct) {
  _status = { ..._status, pct: Math.max(0, Math.min(1, Number(pct) || 0)) };
  _sendStatus();
}

/** Whether the folder is there to read (an I/O error: try, and see). */
async function _isThere(folder) {
  try { return await audioFs.directoryExists(folder.path); }
  catch (_e) { return true; }
}

/**
 * Whether a folder that isn't there was deleted: the folder you picked (its
 * drive) is there, and so is another folder from it, but this one isn't.
 * One whose drive isn't there (unplugged, a share that's down) is kept,
 * songs and all, and comes back with it (R46); so is one whose picked
 * folder is there with nothing of it (a mount point stays, empty, while
 * its drive is away), and a folder you picked itself, which can't be told
 * apart. `seen` keeps, for one pass, whether each picked folder has one.
 */
async function _wasDeleted(folder, seen = new Map()) {
  const root = folder.rootPath;
  if (!root || _pathKey(root) === _pathKey(folder.path)) return false;
  try {
    if (await audioFs.directoryExists(folder.path) || !await audioFs.directoryExists(root)) return false;
    const key = _pathKey(root);
    if (!seen.has(key)) seen.set(key, _anyThere(_electronFolders.filter(other => _pathKey(other.rootPath) === key)));
    return await seen.get(key);
  } catch (_e) { return false; } // an I/O error is not proof that the folder was deleted
}

async function _anyThere(folders) {
  for (const folder of folders) if (await audioFs.directoryExists(folder.path)) return true;
  return false;
}

async function _pruneMissingFolders() {
  const missing = [];
  const seen = new Map();
  for (const folder of _electronFolders) {
    if (await _wasDeleted(folder, seen)) missing.push(folder);
  }
  for (const folder of missing) await removeFolderByPath(folder.name, folder.path);
  return missing;
}

// Event wiring for #lib-add-btn / #lib-rescan-btn lives in panel-settings.js;
// this module no longer assumes that markup exists at evaluation time.

/**
 * Rescan a set of folders together in one batch — same drop/rewalk/merge
 * pattern as rescanFolder(), just scoped to multiple names at once instead
 * of one, and building the album map a single time across all of them
 * (mirrors rescanLibrary()'s batching). Used by group-header rescan
 * buttons to rescan every leaf folder nested under a dropdown in one go.
 *
 * `rootPath`, when provided (the outermost "folder you picked" header
 * passes its own root; nested container headers don't), also
 * re-discovers brand-new leaf folders anywhere under that root before
 * scanning — e.g. a new album folder dropped into Music/ since it was
 * last picked/rescanned — and folds them into the same batch, instead of
 * only re-reading the folders already known. New leaves are registered
 * via _discoverNewLeaves()/_registerFolderMeta() so they also become
 * their own independently rescannable/removable entries going forward,
 * same as if they'd been there the day the root was first added.
 */
export async function rescanFolders(names, rootPath) {
  const missing = await _pruneMissingFolders();
  names = names.filter(name => _electronFolders.some(f => f.name === name));
  if (rootPath && missing.some(f => _pathKey(f.rootPath) === _pathKey(rootPath)) &&
      !_electronFolders.some(f => _pathKey(f.rootPath) === _pathKey(rootPath))) {
    setLibStatus('That folder is no longer on disk, so it was removed from the library.');
    return;
  }
  let allNames = names;

  if (rootPath) {
    const knownRoot = _electronFolders.find(f => f.rootPath === rootPath);
    const rootLabel = knownRoot ? knownRoot.root : rootPath.replace(/\\/g, '/').split('/').pop();
    const newTargets = await _discoverNewLeaves(rootPath, rootLabel);
    if (newTargets.length) {
      allNames = names.concat(newTargets.map(t => t.name));
      _saveElectronFolders();
    }
  }

  if (!allNames.length) return;

  setLibStatus(`Rescanning ${allNames.length} folder${allNames.length !== 1 ? 's' : ''}…`);

  // Read every folder first: one that can't be read leaves them all as
  // they were (R26). One that isn't there (its drive) is left as it is.
  const present = [];
  for (const name of allNames) {
    const folder = _electronFolders.find(f => f.name === name);
    if (folder && await _isThere(folder)) present.push(name);
  }
  allNames = present;
  if (!allNames.length) { setLibStatus('Those folders aren\'t there now.'); return; }
  const allEntries = [];
  for (const name of allNames) {
    const folder = _electronFolders.find(f => f.name === name);
    if (!folder) continue;
    try {
      allEntries.push(...await _listFolder(folder.path, name));
    } catch (err) {
      setLibStatus('Scan failed: ' + (err?.message || 'unknown error'), true);
      return;
    }
  }
  const replace = () => { _dropFolders(allNames); _useFiles(allEntries); };

  if (!allEntries.length) {
    replace();
    setLibStatus('No audio files found.');
    persistLibrary();
    announce();
    return;
  }

  await buildFromFiles(allEntries, { replace });
}

/**
 * Rescan a single folder in isolation — strips only that folder's tracks
 * from library.albums (same key-prefix scoping as removeFolder()),
 * then re-walks and re-tags just that folder's files. Everything else in
 * the library is left untouched, so this is cheap even on a large library.
 */
export async function rescanFolder(name, folderPath) {
  const folder = _electronFolders.find(f => folderPath ? _pathKey(f.path) === _pathKey(folderPath) : f.name === name);
  if (!folder) {
    setLibStatus(`"${name}" is not in your library.`, true);
    return;
  }
  name = folder.name; // as the library has it (removeFolderByPath)

  setLibStatus(`Rescanning "${name}"…`);

  try {
    if (!await audioFs.directoryExists(folder.path)) {
      if (!await _wasDeleted(folder)) {
        setLibStatus(`"${name}" isn't there now (is its drive connected?).`, true);
        return;
      }
      await removeFolderByPath(folder.name, folder.path);
      setLibStatus(`Removed missing folder "${name}" from the library.`);
      return;
    }
    // Read first; the folder's songs (and the paths kept for them, so a
    // file gone since doesn't linger) are replaced only once the new set
    // is read. A folder that can't be read is left as it was (R26).
    const fileEntries = await _listFolder(folder.path, name);
    const replace = () => { _dropFolders([name]); _useFiles(fileEntries); };
    if (!fileEntries.length) {
      replace();
      setLibStatus(`No audio files found in "${name}".`);
      persistLibrary();
      announce();
      return;
    }
    await buildFromFiles(fileEntries, { replace });
  } catch (err) {
    setLibStatus('Scan failed: ' + (err?.message || 'unknown error'), true);
  }
}

/**
 * Scan every known root for brand-new leaf folders ONLY — e.g. a new
 * "Chet Baker" album dropped into Music/ since it was added. Does NOT
 * touch any folder already in the library: nothing is dropped from
 * library.albums, nothing already-known gets re-walked or re-read.
 * Cheap and additive, unlike rescanFolder()/rescanFolders()/rescanLibrary()
 * (which all drop-then-rewalk whatever they're scoped to) — this is purely
 * "find what's new and import just that."
 */
export async function scanForNewFolders() {
  if (!_electronFolders.length) {
    setLibStatus('No folders to scan.'); return;
  }

  await _pruneMissingFolders();
  if (!_electronFolders.length) {
    setLibStatus('No folders to scan.'); return;
  }

  const roots = new Map(); // rootPath -> rootLabel
  _electronFolders.forEach(({ root, rootPath }) => {
    if (rootPath && !roots.has(rootPath)) roots.set(rootPath, root);
  });
  if (!roots.size) {
    setLibStatus('No folders to scan.'); return;
  }

  const newTargets = [];
  for (const [rootPath, rootLabel] of roots) {
    newTargets.push(...await _discoverNewLeaves(rootPath, rootLabel));
  }

  if (!newTargets.length) {
    setLibStatus('No new folders found.');
    setTimeout(() => setLibStatus(''), 2000);
    return;
  }

  // _discoverNewLeaves already registered these via _registerFolderMeta —
  // persist + refresh the sidebar right away so the new folders show up
  // (with a "—" track count) even before tagging finishes.
  _saveElectronFolders();
  announce();

  setLibStatus(`Found ${newTargets.length} new folder${newTargets.length !== 1 ? 's' : ''} — scanning…`);

  try {
    const fileEntries = (await Promise.all(newTargets.map(t => _scanElectronFolder(t.path, t.name)))).flat();
    if (!fileEntries.length) {
      setLibStatus(`Found ${newTargets.length} new folder${newTargets.length !== 1 ? 's' : ''}, but no audio files inside.`);
      persistLibrary();
      return;
    }
    await buildFromFiles(fileEntries);
  } catch (err) {
    setLibStatus('Scan failed: ' + (err?.message || 'unknown error'), true);
  }
}

/**
 * Wipe all saved album metadata and re-read every tag from disk.
 * This is the correct fix when the grouping logic changes and the IndexedDB
 * cache contains stale / incorrectly-split album entries.
 */
export async function rescanLibrary() {
  if (!_electronFolders.length) {
    setLibStatus('No folders to rescan.'); return;
  }

  const missing = await _pruneMissingFolders();
  if (!_electronFolders.length) {
    setLibStatus(missing.length
      ? 'Missing folders were removed; the library is now empty.'
      : 'No folders to rescan.');
    return;
  }

  // Re-discover any brand-new leaf folders under every picked root before
  // wiping and rebuilding — e.g. a new album folder dropped into Music/
  // since it was added. Without this, "Rescan All" would only ever
  // re-read files inside folders it already knows about; it would never
  // notice a new sibling folder, since that gap lives in what gets
  // registered in the first place, not in how a known folder is re-walked.
  const roots = new Map(); // rootPath -> rootLabel
  _electronFolders.forEach(({ root, rootPath }) => {
    if (rootPath && !roots.has(rootPath)) roots.set(rootPath, root);
  });
  let discoveredAny = false;
  for (const [rootPath, rootLabel] of roots) {
    if ((await _discoverNewLeaves(rootPath, rootLabel)).length) discoveredAny = true;
  }
  if (discoveredAny) _saveElectronFolders();

  // Collect every file across all folders first: one that can't be read
  // leaves the library as it was (R26). One that isn't there (its drive)
  // keeps its songs as they are (R46).
  const present = [];
  for (const folder of _electronFolders) if (await _isThere(folder)) present.push(folder);
  const allThere = present.length === _electronFolders.length;
  const allEntries = [];
  for (const { name, path: folderPath } of present) {
    try {
      allEntries.push(...await _listFolder(folderPath, name));
    } catch (err) {
      setLibStatus('Scan error: ' + (err?.message || 'unknown'), true);
      return;
    }
  }

  // Then start from a clean slate, once the new set is read (keeping the
  // songs of folders that aren't there).
  const replace = () => {
    if (allThere) library.albums = {};
    else _dropFolders(present.map(folder => folder.name));
    invalidateAlbumsCache();
    _useFiles(allEntries);
  };

  if (!allEntries.length) {
    // Read, and nothing there: that's the library now.
    replace();
    persistLibrary();
    announce();
    setLibStatus('No audio files found.'); return;
  }

  await buildFromFiles(allEntries, { replace });
}

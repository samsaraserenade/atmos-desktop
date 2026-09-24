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
  return audioState.electronFolders.filter(folder => {
    const key = _pathKey(folder?.path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _saveElectronFolders() {
  audioState.electronFolders = _electronFolders.map(folder => ({ ...folder }));
  save('electronFolders');
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
  const filePaths = await audioFs.listFiles(folderPath, AUDIO_EXTENSIONS);
  return filePaths.map(fp => {
    const rel = fp.slice(folderPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    const key = folderName + '/' + rel;
    _electronFiles.set(key, fp);
    return { key, filePath: fp };
  });
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

async function buildFromFiles(fileEntries) {
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
    return false;
  }
  _electronFolders.push({ name: folderName, path: folderPath, root, rootPath });
  if (!library.folders.find(f => f.name === folderName))
    library.folders.push({ name: folderName });
  return true;
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
    if (_registerFolderMeta(t.path, t.name, rootLabel, rootPath)) newTargets.push(t);
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
    if (_registerFolderMeta(t.path, t.name, rootLabel, folderPath)) newTargets.push(t);
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

  // Remove tracks belonging to this folder from the album map
  Object.keys(library.albums).forEach(k => {
    const alb = library.albums[k];
    alb.tracks = alb.tracks.filter(t => !t.key.startsWith(name + '/'));
    if (!alb.tracks.length) delete library.albums[k];
  });
  invalidateAlbumsCache();

  // Remove from persisted folder list and file map
  _electronFolders = _electronFolders.filter(f => _pathKey(f.path) !== targetPathKey);
  _saveElectronFolders();
  for (const key of _electronFiles.keys()) {
    if (key.startsWith(name + '/')) _electronFiles.delete(key);
  }

  if (!_electronFolders.some(f => f.name === name))
    library.folders = library.folders.filter(f => f.name !== name);
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
  // Persist the normalized list so any legacy duplicate registrations are
  // repaired once rather than being loaded again on every launch.
  if (_electronFolders.length !== (audioState.electronFolders?.length || 0)) _saveElectronFolders();

  if (!_electronFolders.length) return;

  // Ensure library.folders reflects what's on disk
  for (const { name } of _electronFolders) {
    if (!library.folders.find(f => f.name === name))
      library.folders.push({ name });
  }

  // Missing folders are stale registrations, not a launch-breaking error.
  const available = [];
  for (const folder of _electronFolders) {
    try {
      if (await audioFs.directoryExists(folder.path)) available.push(folder);
    } catch (_e) { /* leave temporarily inaccessible folders untouched */ available.push(folder); }
  }
  if (available.length !== _electronFolders.length) {
    const availablePaths = new Set(available.map(f => _pathKey(f.path)));
    const vanished = _electronFolders.filter(f => !availablePaths.has(_pathKey(f.path)));
    for (const folder of vanished) await removeFolderByPath(folder.name, folder.path);
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

async function _pruneMissingFolders() {
  const missing = [];
  for (const folder of _electronFolders) {
    try {
      if (!await audioFs.directoryExists(folder.path)) missing.push(folder);
    } catch (_e) { /* an I/O error is not proof that the folder was deleted */ }
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

  allNames.forEach(name => {
    Object.keys(library.albums).forEach(k => {
      const alb = library.albums[k];
      alb.tracks = alb.tracks.filter(t => !t.key.startsWith(name + '/'));
      if (!alb.tracks.length) delete library.albums[k];
    });
  });
  invalidateAlbumsCache();

  for (const key of _electronFiles.keys()) {
    if (allNames.some(name => key.startsWith(name + '/'))) _electronFiles.delete(key);
  }

  setLibStatus(`Rescanning ${allNames.length} folder${allNames.length !== 1 ? 's' : ''}…`);

  const allEntries = [];
  for (const name of allNames) {
    const folder = _electronFolders.find(f => f.name === name);
    if (!folder) continue;
    try {
      allEntries.push(...await _scanElectronFolder(folder.path, name));
    } catch (err) {
      setLibStatus('Scan failed: ' + (err?.message || 'unknown error'), true);
      return;
    }
  }

  if (!allEntries.length) {
    setLibStatus('No audio files found.');
    persistLibrary();
    announce();
    return;
  }

  await buildFromFiles(allEntries);
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

  // Drop this folder's tracks from every album (mirrors removeFolder()'s
  // scoping); albums left with zero tracks are dropped entirely so a
  // renamed/moved file doesn't leave a stale empty album card behind.
  Object.keys(library.albums).forEach(k => {
    const alb = library.albums[k];
    alb.tracks = alb.tracks.filter(t => !t.key.startsWith(name + '/'));
    if (!alb.tracks.length) delete library.albums[k];
  });
  invalidateAlbumsCache();

  // Drop stale path entries for this folder before re-walking it, so a
  // file removed from disk since the last scan doesn't linger in
  // _electronFiles with a dead path.
  for (const key of _electronFiles.keys()) {
    if (key.startsWith(name + '/')) _electronFiles.delete(key);
  }

  setLibStatus(`Rescanning "${name}"…`);

  try {
    if (!await audioFs.directoryExists(folder.path)) {
      await removeFolderByPath(folder.name, folder.path);
      setLibStatus(`Removed missing folder "${name}" from the library.`);
      return;
    }
    const fileEntries = await _scanElectronFolder(folder.path, name);
    if (!fileEntries.length) {
      setLibStatus(`No audio files found in "${name}".`);
      persistLibrary();
      announce();
      return;
    }
    await buildFromFiles(fileEntries);
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

  // Clear stale data so the merge logic starts from a clean slate
  library.albums = {};
  invalidateAlbumsCache();
  persistLibrary();

  setLibStatus('Clearing cache…');

  // Collect every file across all folders
  const allEntries = [];
  for (const { name, path: folderPath } of _electronFolders) {
    try {
      const entries = await _scanElectronFolder(folderPath, name);
      allEntries.push(...entries);
    } catch (err) {
      setLibStatus('Scan error: ' + (err?.message || 'unknown'), true);
      return;
    }
  }

  if (!allEntries.length) {
    setLibStatus('No audio files found.'); return;
  }

  await buildFromFiles(allEntries);
}

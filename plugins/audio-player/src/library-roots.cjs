'use strict';
/**
 * The folders Audio Player may read: the ones you picked in its folder
 * dialog, and nothing else.
 *
 * The main process (main.cjs) runs with your account's rights, so it could
 * read anywhere; this keeps it to your library. Every path a frame sends —
 * listing a folder, reading tags or a cover, streaming a track, showing a
 * file in Explorer — must sit inside one of these folders.
 *
 * - add(): only from the native folder dialog (you chose it).
 * - keepOnly(): the frame reports which folders the library still uses after
 *   a change; anything else is forgotten. It can only shrink the list.
 * - adopt(): once, when this list is first created, the folders a library
 *   already had are taken over, so existing libraries keep working.
 *
 * Stored as JSON in Atmos's data folder (audio-player/library-folders.json).
 */

function createLibraryRoots({ fs, path, file }) {
  let roots = null;   // absolute, resolved paths
  let existed = false;

  function load() {
    if (roots) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      roots = Array.isArray(saved?.folders) ? saved.folders.filter(value => typeof value === 'string' && path.isAbsolute(value)) : [];
      existed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[audio-player] library folder list unreadable; starting empty:', error.message);
      roots = [];
      existed = error.code !== 'ENOENT';
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, folders: roots }, null, 2));
    fs.renameSync(temporary, file);
    existed = true;
  }

  const same = (a, b) => path.relative(a, b) === '';
  const insideRoot = (target, root) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const clean = value => (typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null);

  return {
    list() { load(); return [...roots]; },

    add(folder) {
      load();
      const resolved = clean(folder);
      if (!resolved) throw new Error('A valid absolute folder path is required.');
      if (!roots.some(root => same(root, resolved))) { roots.push(resolved); persist(); }
      return resolved;
    },

    /** Forget every folder not in `folders` (never adds one). */
    keepOnly(folders) {
      load();
      const keep = (Array.isArray(folders) ? folders : []).map(clean).filter(Boolean);
      const next = roots.filter(root => keep.some(folder => same(root, folder)));
      if (next.length !== roots.length) { roots = next; persist(); }
      return [...roots];
    },

    /** One-time handover of an existing library's folders. */
    adopt(folders) {
      load();
      if (existed) return { adopted: false, folders: [...roots] };
      for (const folder of (Array.isArray(folders) ? folders : []).map(clean).filter(Boolean)) {
        if (!roots.some(root => same(root, folder))) roots.push(folder);
      }
      persist();
      return { adopted: true, folders: [...roots] };
    },

    /** Whether `target` (a file or folder) is inside one of the folders. */
    contains(target) {
      load();
      const resolved = clean(target);
      return Boolean(resolved) && roots.some(root => insideRoot(resolved, root));
    },

    /** The resolved path, or an error naming why it was refused. */
    check(target) {
      const resolved = clean(target);
      if (!resolved) throw new Error('A valid absolute path is required.');
      if (!this.contains(resolved)) throw new Error('That path is not in your music library.');
      return resolved;
    },
  };
}

module.exports = { createLibraryRoots };

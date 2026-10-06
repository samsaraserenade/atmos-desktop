// Stand-ins for what src/library.js uses (tests/library.test.mjs): Atmos,
// the saved state, IndexedDB, main.cjs's file handlers and tag reading.
// `disk.folders` is the music on disk: folder path -> file names in it.
export const disk = { folders: new Map(), unreadable: new Set(), chosen: null };
export const saves = [];
export const audioState = { electronFolders: [] };
export const save = () => {};
export const saveLibraryMeta = async (albums, folders) => { saves.push(JSON.parse(JSON.stringify({ albums, folders }))); };
export const readTags = async filePath => {
  const parts = filePath.split('/');
  return { title: parts.at(-1).replace(/\.\w+$/, ''), artist: 'Artist', album: parts.at(-2) };
};
export default { events: { emit() {} }, invoke: async () => {} };

const inside = (root, folder) => folder === root || folder.startsWith(`${root}/`);
export const audioFs = {
  chooseFolder: async () => disk.chosen,
  keepFolders: async () => {},
  adoptFolders: async () => {},
  directoryExists: async folder => disk.folders.has(folder) || [...disk.folders.keys()].some(other => other.startsWith(`${folder}/`)),
  listDirTree: async root => [...disk.folders.keys()].filter(folder => inside(root, folder)).map(folder => ({
    path: folder, relativePath: folder === root ? '' : folder.slice(root.length + 1), hasMatchingFiles: disk.folders.get(folder).length > 0,
  })),
  listFiles: async folder => {
    if (disk.unreadable.has(folder)) throw new Error('EACCES: permission denied');
    if (!disk.folders.has(folder)) throw new Error('ENOENT');
    return disk.folders.get(folder).map(name => `${folder}/${name}`);
  },
  readCoverSidecar: async () => null,
  readTagFallback: async () => null,
  mediaUrl: filePath => `media:${filePath}`,
};

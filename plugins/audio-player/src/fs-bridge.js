// Audio Player's own main-process handlers (main.cjs): folder dialogs,
// directory walks, tag fallbacks, "show in folder".
import atmos from 'atmos-sdk';

const invoke = (name, ...args) => atmos.invoke('plugin:audio-player', name, ...args);

export const audioFs = {
  /** The native folder dialog; the folder you pick becomes readable (main.cjs). */
  chooseFolder: () => invoke('choose-folder'),
  /** Tell the main process which picked folders the library still uses; it forgets the rest. */
  keepFolders: folders => invoke('keep-folders', folders),
  /** Once per install: hand over the folders an existing library already had. */
  adoptFolders: folders => invoke('adopt-folders', folders),
  chooseCover: mediaPath => invoke('choose-cover', mediaPath),
  directoryExists: folderPath => invoke('directory-exists', folderPath),
  listDirTree: (folderPath, extensions) => invoke('list-dir-tree', folderPath, extensions),
  listFiles: (folderPath, extensions) => invoke('list-files', folderPath, extensions),
  readCoverSidecar: filePath => invoke('read-cover-sidecar', filePath),
  readTagFallback: filePath => invoke('read-tag-fallback', filePath),
  showItem: filePath => invoke('show-item', filePath),
  /** A file on disk as the URL Audio Player's resource provider serves it at. */
  mediaUrl(filePath) {
    const segments = String(filePath).replace(/\\/g, '/').split('/').map(encodeURIComponent);
    return `atmos-resource://audio-player-media/${segments.join('/')}`;
  },
};

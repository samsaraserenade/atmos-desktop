// Hydrate shared prerequisites first, then restore exactly one playback source.
// User interaction or plugin disposal supersedes an outstanding startup restore.
export async function restorePlayback({ saved, loadCache, restoreLibrary, loadFiles,
  restoreFiles, restoreLibraryTrack, isCurrent, reportError }) {
  const libraryReady = restoreLibrary().catch(reportError);
  await loadCache().catch(reportError);
  if (saved.trackKey) {
    await libraryReady;
    if (isCurrent()) await restoreLibraryTrack(saved.trackKey, saved.trackPos, isCurrent);
  } else {
    const files = await loadFiles();
    if (isCurrent()) restoreFiles(files, saved.trackIdx, saved.trackPos);
    await libraryReady;
  }
}

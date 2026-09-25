/** Owns staged files, preview URLs and the lifetime of a send batch. */
export function createComposerController({ createUrl = file => URL.createObjectURL(file), revokeUrl = url => URL.revokeObjectURL(url) } = {}) {
  let pending = [];
  let sequence = 0;
  let disposed = false;
  let busy = false;
  const owned = new Set();
  function release(item) {
    if (item.previewUrl && owned.delete(item.previewUrl)) revokeUrl(item.previewUrl);
  }
  function clear() {
    pending.forEach(release);
    pending = [];
  }
  return {
    get pending() { return pending; },
    get busy() { return busy; },
    get disposed() { return disposed; },
    add(files) {
      if (disposed) return;
      for (const file of files) {
        const previewUrl = /^(image|video)\//.test(file.type) ? createUrl(file) : null;
        if (previewUrl) owned.add(previewUrl);
        pending.push({ id: ++sequence, file, previewUrl });
      }
    },
    remove(id) {
      const index = pending.findIndex(item => item.id === id);
      if (index !== -1) release(pending.splice(index, 1)[0]);
    },
    clear,
    take() { const batch = pending; pending = []; return batch; },
    release,
    async run(work) {
      if (disposed || busy) return;
      busy = true;
      const assertActive = () => {
        if (disposed) throw new DOMException('The room view was closed.', 'AbortError');
      };
      try { return await work(assertActive); }
      finally { busy = false; }
    },
    dispose() {
      disposed = true;
      clear();
      for (const url of owned) revokeUrl(url);
      owned.clear();
    },
  };
}

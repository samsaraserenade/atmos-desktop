// Blob URLs need leases: eviction must not revoke an image while a viewer or
// save operation is using it. Only actively leased bytes can exceed the budget.
export class MediaUrlCache {
  constructor({ maxBytes = 64 * 1024 * 1024, maxEntries = 12 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.bytes = 0;
  }
  remove(key, entry) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    entry.discarded = true;
    if (!entry.refs && entry.url) URL.revokeObjectURL(entry.url);
  }
  trim() {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      if (!entry.refs) this.remove(key, entry);
    }
  }
  clear() {
    for (const [key, entry] of this.entries) this.remove(key, entry);
  }
  async acquire(key, load) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { refs: 0, bytes: 0, url: null, discarded: false };
      this.entries.set(key, entry);
      entry.promise = Promise.resolve().then(load).then(blob => {
        if (entry.discarded) throw new Error('Media cache cleared');
        entry.url = URL.createObjectURL(blob);
        entry.bytes = blob.size;
        this.bytes += entry.bytes;
        this.trim();
        return entry.url;
      }).catch(error => { this.remove(key, entry); throw error; });
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    entry.refs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.refs--;
      if (entry.discarded && !entry.refs && entry.url) URL.revokeObjectURL(entry.url);
      this.trim();
    };
    try { return { url: await entry.promise, release }; }
    catch (error) { release(); throw error; }
  }
}

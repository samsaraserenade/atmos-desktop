// Promise-aware LRU. Pending work is entry-bounded; resolved buffers are
// byte-bounded. Eviction never invalidates a value already held by a caller.
export class BoundedCache {
  constructor({ maxBytes = Infinity, maxEntries = 256, ttl = Infinity } = {}) {
    Object.assign(this, { maxBytes, maxEntries, ttl });
    this.entries = new Map();
    this.bytes = 0;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.time >= this.ttl) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  has(key) { return this.get(key) !== undefined; }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  set(key, value) {
    this.delete(key);
    const entry = { value, bytes: 0, time: Date.now() };
    this.entries.set(key, entry);
    const trim = () => {
      while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
        this.delete(this.entries.keys().next().value);
      }
    };
    trim();
    Promise.resolve(value).then(result => {
      if (this.entries.get(key) !== entry) return;
      entry.bytes = result?.byteLength || 0;
      this.bytes += entry.bytes;
      if (entry.bytes > this.maxBytes || result == null) this.delete(key);
      trim();
    }, () => {
      if (this.entries.get(key) === entry) this.delete(key);
    });
  }
}

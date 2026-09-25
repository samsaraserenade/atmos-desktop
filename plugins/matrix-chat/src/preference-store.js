/** Read through to persisted state, including hydration after module loading. */
export function createPreference(state, key, normalize, save) {
  const listeners = new Set();
  const get = () => normalize(state[key]);
  return {
    get,
    set(value) {
      const next = normalize(value);
      if (Object.is(next, get())) return;
      state[key] = next;
      save();
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) listener(next);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

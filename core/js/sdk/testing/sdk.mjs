/**
 * What `import atmos from 'atmos-sdk'` gives in a Node test (register.mjs):
 * the fake installFakeAtmos() installed last, looked up on every use, so
 * each test can install its own.
 */
const current = () => {
  if (!globalThis.__atmosFake) throw new Error('No fake Atmos installed: call installFakeAtmos() (.atmos-sdk/testing/fake-atmos.mjs) before importing code that uses atmos-sdk');
  return globalThis.__atmosFake;
};

/** A namespace (atmos.state, …) whose members are the current fake's. */
const namespace = name => new Proxy({}, {
  get: (_, key) => current()[name][key],
  has: (_, key) => key in current()[name],
  ownKeys: () => Reflect.ownKeys(current()[name]),
  getOwnPropertyDescriptor: (_, key) => ({ ...Reflect.getOwnPropertyDescriptor(current()[name], key), configurable: true }),
});

const atmos = new Proxy({}, {
  get: (_, key) => current()[key],
  has: (_, key) => key in current(),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_, key) => ({ ...Reflect.getOwnPropertyDescriptor(current(), key), configurable: true }),
});
export default atmos;

export const SDK_VERSION = '1.2.0';
export const extension = namespace('extension');
export const surface = namespace('surface');
export const state = namespace('state');
export const events = namespace('events');
export const appearance = namespace('appearance');
export const contextMenu = namespace('contextMenu');
export const clipboard = namespace('clipboard');
export const panel = namespace('panel');
export const wallpaper = namespace('wallpaper');
export const audio = namespace('audio');
export const location = namespace('location');
export const lifecycle = namespace('lifecycle');
export const notifications = namespace('notifications');
export const drawer = namespace('drawer');
export const legacy = namespace('legacy');
export const web = namespace('web');
export const ready = Promise.resolve();
export const invoke = (...args) => current().invoke(...args);
export const listen = (...args) => current().listen(...args);
export const call = (...args) => current().call(...args);
export const expose = (...args) => current().expose(...args);
export const library = (...args) => current().library(...args);
export const fetch = (...args) => current().fetch(...args);
export const background = (...args) => current().background(...args);

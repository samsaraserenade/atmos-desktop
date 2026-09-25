// Stand-in for atmos-sdk in tests/oauth.test.mjs: `handlers` plays the
// plugin's main process (main.cjs) for each invoke channel.
export const handlers = {};
export const calls = [];
export default {
  invoke: async (target, name, ...args) => {
    calls.push({ target, name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`no fake handler for ${name}`);
    return handler(...args);
  },
  state: { get: async () => ({}), set: async () => {} },
};

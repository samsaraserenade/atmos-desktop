/** Node module hook (register.mjs): 'atmos-sdk' is sdk.mjs beside this file. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'atmos-sdk') return { url: new URL('./sdk.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}

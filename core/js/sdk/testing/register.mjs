/**
 * Makes `import atmos from 'atmos-sdk'` work in Node tests: the import
 * resolves to sdk.mjs beside this file, which hands out whatever fake
 * installFakeAtmos() installed last.
 *
 *   node --import ./.atmos-sdk/testing/register.mjs --test tests/
 *
 * MIT licence, like the SDK.
 */
import { register } from 'node:module';

register(new URL('./resolve.mjs', import.meta.url));

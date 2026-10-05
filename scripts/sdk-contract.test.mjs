// The fake Atmos (core/js/sdk/testing/fake-atmos.mjs) against the SDK
// contract: the same calls scripts/e2e/contract.cjs makes in a real Atmos,
// with the same expected report (scripts/sdk-contract/expected.json).
// When Atmos changes what a call gives, change expected.json from the e2e
// run, and this shows where the fake must follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeAtmos } from '../core/js/sdk/testing/fake-atmos.mjs';
import { runContract } from './sdk-contract/contract.js';

const expected = JSON.parse(fs.readFileSync(new URL('./sdk-contract/expected.json', import.meta.url), 'utf8'));
const PERMISSIONS = {
  all: { invokes: ['service:audio', 'service:wallpaper', 'service:location', 'service:now-playing'], browser: ['notifications'] },
  none: {},
};

for (const declared of ['all', 'none']) {
  test(`the fake gives what Atmos gives, declaring ${declared}`, async () => {
    const atmos = createFakeAtmos({ extension: { id: `contract-${declared}` }, permissions: PERMISSIONS[declared] });
    const quiet = console.error;
    console.error = () => {}; // refused subscriptions are logged, as in Atmos
    try {
      assert.deepEqual(await runContract(atmos, { declared }), expected[declared]);
    } finally {
      console.error = quiet;
    }
  });
}

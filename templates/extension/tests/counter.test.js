// Runs in Node, with a fake Atmos standing in for the real one:
//   npm test   (node --import ./.atmos-sdk/testing/register.mjs --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAtmos } from '../.atmos-sdk/testing/fake-atmos.mjs';

const { getCount, increment, reset, onCount } = await import('../src/counter.js');

test('the count starts at 0, goes up, and is saved', async () => {
  const atmos = installFakeAtmos();
  assert.equal(await getCount(), 0);
  assert.equal(await increment(), 1);
  assert.equal(await increment(), 2);
  assert.equal(atmos.fake.state.count, 2);
  await reset();
  assert.equal(await getCount(), 0);
});

test('another frame changing it is heard', () => {
  const atmos = installFakeAtmos({ state: { count: 5 } });
  const seen = [];
  const stop = onCount(count => seen.push(count));
  atmos.fake.setState({ count: 6 });
  stop();
  atmos.fake.setState({ count: 7 });
  assert.deepEqual(seen, [6]);
});

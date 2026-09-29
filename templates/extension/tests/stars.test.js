import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAtmos } from '../.atmos-sdk/testing/fake-atmos.mjs';

const { loadStars, REPO } = await import('../src/stars.js');
const URL_ = `https://api.github.com/repos/${REPO}`;

test('reads the star count from GitHub through atmos.fetch()', async () => {
  const atmos = installFakeAtmos({
    permissions: { network: ['api.github.com'] },
    fetch: { [URL_]: { json: { stargazers_count: 42 } } },
  });
  assert.equal(await loadStars(), 42);
  assert.equal(atmos.fake.requests[0].headers.get('accept'), 'application/vnd.github+json');
});

test('a failed answer is an error, not a number', async () => {
  installFakeAtmos({ permissions: { network: ['api.github.com'] }, fetch: { [URL_]: { status: 403, json: { message: 'rate limited' } } } });
  await assert.rejects(loadStars(), /GitHub answered 403/);
});

test('without api.github.com in "permissions.network", Atmos refuses', async () => {
  installFakeAtmos({ permissions: { network: [] }, fetch: { [URL_]: { json: { stargazers_count: 1 } } } });
  await assert.rejects(loadStars(), { name: 'AtmosPermissionError' });
});

// Finance's main process: the CoinGecko relay the watchlist uses, and no
// longer anything for local connection plugins (Finance reads the VPS).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const activate = require('../main.cjs');
assert.match(activate.toString(), /const pruneNetworkCache = now =>/,
  'the renderer network relay must prune expired cached responses');

async function run() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-main-'));
  const handlers = new Map();
  const providers = new Map();
  try {
    await activate({
      app: { getPath: name => name === 'userData' ? userData : null },
      handle: (name, handler) => handlers.set(name, handler),
      registerResourceProvider: (name, handler) => providers.set(name, handler),
    });
    assert.deepEqual([...handlers.keys()].sort(), ['network:fetch', 'vps:connect', 'vps:disconnect', 'vps:fetch', 'vps:status', 'vps:test']);
    assert.equal(providers.size, 0, 'no connection plugin files are served any more');
    assert.equal(fs.existsSync(path.join(userData, 'connections')), false, 'no connections folder is created');
    const networkFetch = handlers.get('network:fetch');
    await assert.rejects(() => networkFetch({}, { url: 'https://example.com/not-allowed' }), /not allowed/);
    await assert.rejects(() => networkFetch({}, { url: 'https://rpc.ankr.com/multichain' }), /not allowed/);
    await assert.rejects(() => networkFetch({}, { url: 'https://api.coingecko.com/api/v3/ping', method: 'POST' }), /not allowed/);
    console.log('Passed: Finance main process relays CoinGecko only and serves no connectors');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

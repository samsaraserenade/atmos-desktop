const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const activate = require('../main.cjs');
const main = readFileSync(`${__dirname}/../main.cjs`, 'utf8');
const remote = readFileSync(`${__dirname}/../src/remote.js`, 'utf8');
const registry = readFileSync(`${__dirname}/../src/registry.js`, 'utf8');
const chart = readFileSync(`${__dirname}/../src/total-chart.js`, 'utf8');

assert.equal(activate.isTailscaleIpv4('100.64.0.1'), true);
assert.equal(activate.isTailscaleIpv4('100.127.255.254'), true);
for (const address of ['203.0.113.10', '100.63.255.255', '100.128.0.1', 'example.com']) {
  assert.equal(activate.isTailscaleIpv4(address), false, `${address} must not pass the Tailscale allowlist`);
}

const base = 'http://100.64.0.1:8787';
assert.equal(activate.requireVpsRoute('/v1/portfolio', base).pathname, '/v1/portfolio');
assert.equal(activate.requireVpsRoute('/v1/history?resolution=1h', base).pathname, '/v1/history');
for (const route of ['//evil.example/v1/portfolio', '/health', '/v1/admin']) {
  assert.throws(() => activate.requireVpsRoute(route, base), /Unsupported/);
}

assert.doesNotMatch(remote, /Authorization|Bearer|\.token\b/,
  'the renderer-side module must never receive or handle the bearer token');
assert.match(main, /return server \? \{ configured: true, address: server\.baseUrl, protected: server\.protected \} : \{ configured: false \}/,
  'the renderer learns whether a server is set and its address, never the token');
assert.match(registry, /if \(_remoteMode\) return;[\s\S]*?const liveIds/,
  'remote mode must not duplicate VPS history into local connector history');
assert.match(registry, /if \(_remoteMode\)[\s\S]*?startVpsPortfolio/,
  'the portfolio comes from the VPS');
assert.doesNotMatch(registry, /connectAll|loadPlugins|_buildPluginAPI|connections:list/,
  'the desktop runs no connection plugins of its own');
assert.match(registry, /if \(!_remoteMode\) \{\s*mountConnectionForm\(mount\);/,
  'without a server the Connections widget offers the pairing form');
assert.match(registry, /Collected privately by your portfolio server/,
  'remote sources should render a read-only connection body');
assert.match(chart, /if \(!isRemotePortfolioMode\(\)\) return combined;[\s\S]*?return getRemoteTotalHistory\(\)\.map/,
  'the chart should use only authoritative VPS history in remote mode');
assert.match(chart, /onRemoteTotalHistoryUpdate\(replaceHistoryFromVps\)/,
  'the chart should redraw when refreshed VPS history arrives');
assert.match(chart, /if \(isRemotePortfolioMode\(\)\) \{[\s\S]*?return;[\s\S]*?const settled/,
  'VPS mode must not append local samples after authoritative history');
assert.match(remote, /setInterval\(refreshHistory, 60_000\)/,
  'VPS history should retry and refresh after startup');
assert.match(remote, /const stop = \(\) => \{ stopped = true; timers\.forEach\(clearInterval\); \};/,
  'the reader stops when the user disconnects or switches servers');
assert.match(chart, /const STARTUP_COLLECTION_BUFFER_MS = 0/,
  'the retired local-connection startup delay must remain disabled');

console.log('Passed: VPS bridge is private, constrained, and authoritative');

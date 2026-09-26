const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const read = file => readFileSync(path.join(__dirname, '..', file), 'utf8');

// Finance runs in frames and installs nothing anywhere: no connector globals
// and no replacement window.fetch.
for (const file of ['frame-engine.js', 'frame-panel.js', 'src/host/frame.js', 'src/host/mirror.js', 'src/host/widget.js']) {
  const source = read(file);
  assert.doesNotMatch(source, /window\.(binanceAPI|portfolioTrackerAPI)\s*=/, file);
  assert.doesNotMatch(source, /window\.fetch\s*=/, file);
}
// The watchlist asks for CoinGecko through Finance's own main process, via the SDK.
const network = read('src/network.js');
assert.match(network, /invokeFinance as invoke/);
assert.match(network, /'network:fetch'/);
assert.match(read('src/host/frame.js'), /atmos\.invoke\(SELF, channel/);
assert.doesNotMatch(read('markets/src/watchlist-data.js'), /(?<![\w.])fetch\(/);

console.log('Passed: Finance uses explicit, extension-scoped network calls');

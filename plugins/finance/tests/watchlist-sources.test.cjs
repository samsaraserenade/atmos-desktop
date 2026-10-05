'use strict';
// Where the watchlist's live prices come from (markets/src/watchlist-data.js):
// Binance first every session, CoinGecko only for what Binance doesn't list
// and never asked more than once a minute, nor for ten minutes after it
// refuses. Before 1.0.10 two Binance failures (at login, before the network
// was up) moved a coin to CoinGecko for good; with CoinGecko then refusing
// the connection, no current price loaded at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function synthetic(context, exports) {
  const names = Object.keys(exports);
  return new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, exports[name]);
  }, { context });
}

async function load(file, context, imports) {
  const module = new vm.SourceTextModule(read(file), { context, identifier: file });
  await module.link(specifier => {
    const target = imports[specifier];
    if (!target) throw new Error(`${file}: unexpected import '${specifier}'`);
    return target;
  });
  await module.evaluate();
  return module.namespace;
}

const BINANCE = { SOL: 118.69, BTC: 64000, ETH: 3100, ADA: 0.41, XMR: 118.7 };
// Pairs Binance no longer trades (status BREAK): they still answer, frozen.
const DELISTED = new Set(['XMR']);

/**
 * watchlist-data.js with a fake network: Binance lists BINANCE (unless
 * `binanceDown`), CoinGecko answers or refuses with a 403 (`coinGeckoRefuses`),
 * DexScreener knows nothing. `holdings` are what the portfolio server
 * reports: { SYMBOL: price }. `requests` records every URL asked for.
 */
async function watchlist({ state, binanceDown = false, coinGeckoRefuses = false, holdings = {} }) {
  const clock = { now: 1_000_000 };
  const network = { binanceDown, coinGeckoRefuses, requests: [] };
  class FakeDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, Date: FakeDate });
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const financeFetch = async input => {
    const url = new URL(String(input));
    network.requests.push(url.href);
    if (url.hostname === 'api.binance.com') {
      // Binance answers an unknown symbol with a 400 and no CORS headers: to a frame, a network error.
      if (network.binanceDown) throw new TypeError('Failed to fetch');
      // Every pair's price, delisted ones too (the listing read once a session).
      if (url.pathname.endsWith('/ticker/price')) return answer(200, Object.entries(BINANCE).map(([symbol, price]) => ({ symbol: `${symbol}USDT`, price: String(price) })));
      const wanted = url.searchParams.get('symbols')
        ? JSON.parse(url.searchParams.get('symbols'))
        : [url.searchParams.get('symbol')];
      const known = wanted.map(pair => pair.replace(/USDT$/, '')).filter(symbol => symbol in BINANCE);
      if (known.length !== wanted.length) throw new TypeError('Failed to fetch');
      const items = known.map(symbol => ({
        symbol: `${symbol}USDT`, lastPrice: String(BINANCE[symbol]), priceChangePercent: '1.5',
        closeTime: DELISTED.has(symbol) ? clock.now - 20 * 86_400_000 : clock.now,
      }));
      return answer(200, url.searchParams.get('symbols') ? items : items[0]);
    }
    if (url.hostname === 'api.coingecko.com') {
      if (network.coinGeckoRefuses) return answer(403, null);
      if (url.pathname.endsWith('/search')) return answer(200, { coins: [] });
      const ids = url.searchParams.get('ids').split(',');
      return answer(200, Object.fromEntries(ids.map(id => [id, { usd: 1, usd_24h_change: 0 }])));
    }
    if (url.hostname === 'api.dexscreener.com') return answer(200, { pairs: [] });
    throw new Error(`unexpected request ${url.href}`);
  };
  const watchlistState = { tickers: [], activeT: null, tickerSource: {}, cgIdCache: {}, ...structuredClone(state) };
  const module = await load('markets/src/watchlist-data.js', context, {
    '../../src/host/persist.js': synthetic(context, { save() {}, flushPendingSave() {} }),
    '../../src/network.js': synthetic(context, { financeFetch }),
    '../../src/host/frame.js': synthetic(context, { atmos: {}, isEngine: () => true, SELF: 'plugin:finance' }),
    '../persist.js': synthetic(context, { watchlistState }),
    '../../src/totals.js': synthetic(context, {
      getPortfolioComposition: () => ({ total: 0 }),
      getSpotScopePositions: () => Object.entries(holdings).map(([symbol, price]) => ({
        symbol, value: 100, holdings: [{ connectionId: 'vps', holding: { symbol, price, currency: 'USD' } }],
      })),
      STABLECOIN_SYMBOLS: new Set(['USDT', 'USDC']),
    }),
  });
  return { module, state: watchlistState, network, clock };
}

const coinGeckoCalls = network => network.requests.filter(url => url.includes('api.coingecko.com/api/v3/simple/price')).length;

test('coins stuck on CoinGecko go back to Binance at the start of a session', async () => {
  const { module, state, network } = await watchlist({
    coinGeckoRefuses: true,
    state: {
      tickers: ['SOL', 'BTC', 'XMR', 'DRIFT'],
      tickerSource: { SOL: 'coingecko', BTC: 'coingecko', XMR: 'coingecko', DRIFT: 'coingecko' },
      cgIdCache: { SOL: 'solana', BTC: 'bitcoin', XMR: 'monero', DRIFT: 'drift-protocol' },
    },
  });
  await module.fetchTickers();
  assert.deepEqual({ ...state.tickerSource }, { SOL: 'binance', BTC: 'binance', XMR: 'coingecko', DRIFT: 'coingecko' },
    'Binance trades SOL and BTC; its XMR pair is delisted, and DRIFT keeps its cached CoinGecko id (no search)');
  assert.equal(module.tickerData.SOL.price, 118.69);
  assert.equal(module.tickerData.XMR, undefined, 'never the frozen price of a pair Binance no longer trades');
  assert.equal(network.requests.filter(url => url.includes('/search')).length, 0);
});

test('a pair Binance stops trading mid-session is dropped at once', async () => {
  const { module, state } = await watchlist({ state: { tickers: ['XMR', 'SOL'], tickerSource: { XMR: 'binance', SOL: 'binance' }, cgIdCache: { XMR: 'monero' } } });
  // The session's first poll re-probes CoinGecko choices only; XMR's saved
  // "binance" is asked for with SOL, and comes back frozen.
  await module.fetchTickers();
  assert.equal(state.tickerSource.XMR, 'coingecko');
  assert.equal(module.tickerData.XMR.price, 1, 'from CoinGecko');
  assert.equal(module.tickerData.SOL.price, 118.69);
});

test('a coin you hold falls back to your portfolio server\'s price when no market source answers', async () => {
  const { module, network, clock } = await watchlist({
    coinGeckoRefuses: true,
    holdings: { XMR: 352.34, PRCL: 0.0098, THL: 1, USDT: 1 },
    state: { tickers: ['XMR', 'PRCL', 'THL', 'SOL'], tickerSource: {}, cgIdCache: { XMR: 'monero', PRCL: 'parcl', THL: 'thala', USDT: 'tether' } },
  });
  await module.fetchTickers();
  assert.deepEqual({ ...module.tickerData.XMR }, { price: 352.34, change: null, source: 'portfolio' });
  assert.equal(module.tickerData.PRCL.price, 0.0098);
  assert.equal(module.tickerData.THL, undefined, 'a price of exactly 1 is the server\'s "unknown"…');
  assert.equal(module.tickerData.USDT.price, 1, '…except for a stablecoin');
  assert.equal(module.tickerData.SOL.price, 118.69, 'a market price where there is one');
  // CoinGecko answering again replaces the server's price with a market one (and a 24h change).
  network.coinGeckoRefuses = false;
  clock.now += 11 * 60_000;
  await module.fetchTickers();
  assert.deepEqual({ ...module.tickerData.XMR }, { price: 1, change: 0 });
});

test('CoinGecko is asked at most once a minute, and not for ten minutes after it refuses', async () => {
  const { module, network, clock } = await watchlist({
    coinGeckoRefuses: true,
    state: { tickers: ['SOL', 'DRIFT', 'PRCL'], tickerSource: { SOL: 'binance', DRIFT: 'coingecko', PRCL: 'coingecko' }, cgIdCache: { DRIFT: 'drift-protocol', PRCL: 'parcl' } },
  });
  await module.fetchTickers();
  assert.equal(coinGeckoCalls(network), 1, 'one request for both CoinGecko coins');
  assert.equal(module.tickerData.SOL.price, 118.69, 'Binance prices load whatever CoinGecko does');
  for (let i = 0; i < 20; i++) { clock.now += 15_000; await module.fetchTickers(); } // five minutes of polling
  assert.equal(coinGeckoCalls(network), 1, 'refused: left alone');
  network.coinGeckoRefuses = false;
  clock.now += 6 * 60_000; // past the ten-minute pause
  await module.fetchTickers();
  assert.equal(coinGeckoCalls(network), 2);
  assert.equal(module.tickerData.DRIFT.price, 1);
  for (let i = 0; i < 3; i++) { clock.now += 15_000; await module.fetchTickers(); }
  assert.equal(coinGeckoCalls(network), 2, 'answering: not every 15 s…');
  clock.now += 15_000;
  await module.fetchTickers();
  assert.equal(coinGeckoCalls(network), 3, '…but once a minute');
});

test('Binance failing moves a coin to CoinGecko for ten minutes, not for good', async () => {
  const { module, state, network, clock } = await watchlist({
    binanceDown: true,
    state: { tickers: ['SOL'], tickerSource: { SOL: 'binance' }, cgIdCache: { SOL: 'solana' } },
  });
  await module.fetchTickers();
  clock.now += 15_000;
  await module.fetchTickers();
  assert.equal(state.tickerSource.SOL, 'coingecko', 'two failures in a row');
  network.binanceDown = false;
  clock.now += 5 * 60_000;
  await module.fetchTickers();
  assert.equal(state.tickerSource.SOL, 'coingecko', 'not yet');
  clock.now += 6 * 60_000;
  await module.fetchTickers();
  assert.equal(state.tickerSource.SOL, 'binance', 'tried again after ten minutes, and back');
  assert.equal(module.tickerData.SOL.price, 118.69);
});

test('while CoinGecko can\'t be asked, an unknown coin waits rather than taking a DexScreener lookalike', async () => {
  const { module, state, network } = await watchlist({
    coinGeckoRefuses: true,
    state: { tickers: ['WEN'], tickerSource: {}, cgIdCache: {} },
  });
  await module.fetchTickers();
  assert.equal(state.tickerSource.WEN, undefined);
  assert.equal(network.requests.filter(url => url.includes('dexscreener')).length, 0);
  network.coinGeckoRefuses = false;
  // Paused for ten minutes after the refusal; then CoinGecko says it has no such coin, and DexScreener is tried.
  const later = await watchlist({ state: { tickers: ['WEN'], tickerSource: {}, cgIdCache: {} } });
  await later.module.fetchTickers();
  assert.ok(later.network.requests.some(url => url.includes('dexscreener')), 'CoinGecko answering "none": DexScreener is the last resort, as before');
});

test('a coin Binance doesn\'t list isn\'t asked about one by one: its listing is read once a session', async () => {
  const { module, state, network } = await watchlist({
    state: { tickers: ['SOL', 'WEN', 'DRIFT', 'USDT'], tickerSource: {}, cgIdCache: { WEN: 'wen-4', DRIFT: 'drift-protocol', USDT: 'tether' } },
  });
  await module.fetchTickers();
  await module.fetchTickers();
  const asked = pair => network.requests.filter(url => url.includes(`ticker/24hr?symbol=${pair}`)).length;
  assert.equal(network.requests.filter(url => url.endsWith('/api/v3/ticker/price')).length, 1, 'the listing, once');
  assert.deepEqual([asked('WENUSDT'), asked('DRIFTUSDT'), asked('USDTUSDT')], [0, 0, 0], 'no refusals (a CORS error each in the console)');
  assert.equal(asked('SOLUSDT'), 1, 'a listed coin is asked as before');
  assert.deepEqual({ ...state.tickerSource }, { SOL: 'binance', WEN: 'coingecko', DRIFT: 'coingecko', USDT: 'coingecko' });
});

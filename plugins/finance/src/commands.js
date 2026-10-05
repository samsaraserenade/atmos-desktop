/**
 * Finance's rev/ commands in Atmos's command bar (SDK 1.3), declared in
 * extension.json ("contributes.commands") and answered here, in the
 * background frame (frame-engine.js), so they work whichever panel is
 * showing. The chart they change is the panel's: they ask for it the way
 * the watchlist widget does (requestPanelAction), which opens Finance, and
 * frame-panel.js does it there.
 *
 *   chart <symbol> [exchange] [timeframe]   a market chart: rev/chart BTC 4h
 *   timeframe <timeframe>                   the main chart's timeframe (every chart, with its option)
 *   portfolio [total|spot|perp|<coin>]      a portfolio chart: rev/portfolio sol
 *
 * Timeframes are typed as the charts' toolbar shows them (1m, 4H, 1D, 1W,
 * 1M for a month) or spelled out (4h, 1mo, 1w); `m` alone is minutes, `M`
 * a month. Rows and results are plain text: Atmos draws them.
 *
 * `deps` (frame-engine.js; the tests pass stand-ins):
 *   requestPanelAction(action, { show })   ask the panel (opening it unless show is false)
 *   watchlist()                  the watchlist's symbols ("BTC")
 *   held()                       symbols in your portfolio (none in private mode)
 *   coins()                      coins with a portfolio chart of their own (none in private mode)
 *   privateMode()                whether balances are hidden (what you hold isn't listed)
 *   recent()                     recent chart queries ("BTCUSDT coinbase 1m candles")
 *   chartCount()                 how many charts the panel shows (1–4)
 *   currentTimeframe()           the market chart's timeframe, when it's showing; else null
 *   hasMarketData()              whether Market Data (market charts' data) is installed
 */
import atmos from 'atmos-sdk';
import { KNOWN_EXCHANGES, normalizeSymbol } from '../markets/src/symbols.js';
import { coinSection, isPortfolioSection, sectionCoin } from './chart-sections.js';

const MAX_ROWS = 8;

/** Charting's timeframes (services/charting/toolbar.js CHART_INTERVALS), with what each is called. */
export const TIMEFRAMES = Object.freeze([
  ['auto', 'Auto', 'automatic candles'],
  ['1m', '1m', '1 minute'], ['3m', '3m', '3 minutes'], ['5m', '5m', '5 minutes'],
  ['10m', '10m', '10 minutes'], ['15m', '15m', '15 minutes'], ['30m', '30m', '30 minutes'],
  ['1h', '1H', '1 hour'], ['2h', '2H', '2 hours'], ['4h', '4H', '4 hours'],
  ['6h', '6H', '6 hours'], ['8h', '8H', '8 hours'], ['12h', '12H', '12 hours'],
  ['1d', '1D', '1 day'], ['2d', '2D', '2 days'], ['3d', '3D', '3 days'], ['5d', '5D', '5 days'],
  ['1w', '1W', '1 week'], ['2w', '2W', '2 weeks'],
  ['1mo', '1M', '1 month'], ['3mo', '3M', '3 months'], ['6mo', '6M', '6 months'], ['1y', '1Y', '1 year'],
].map(([value, label, name]) => Object.freeze({ value, label, name })));
const BY_VALUE = new Map(TIMEFRAMES.map(item => [item.value, item]));

/** A timeframe's value ('4h', '1mo') from what's typed ('4H', '4h', '4 hours' as one word "4hours", '1M'), or null. */
export function parseTimeframe(token) {
  const text = String(token ?? '').trim();
  if (/^auto$/i.test(text)) return 'auto';
  const match = /^(\d{1,2})(mo|mon|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|y|yrs?|years?)$/i.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2];
  const minutes = `${count}m`;
  let value;
  if (/^(mo|mon|months?)$/i.test(unit)) value = `${count}mo`;
  // TradingView's capital M is a month (1M, 3M, 6M); one that isn't (30M) is minutes.
  else if (unit === 'M') value = BY_VALUE.has(`${count}mo`) ? `${count}mo` : minutes;
  else if (/^(m|mins?|minutes?)$/i.test(unit)) value = minutes;
  else value = `${count}${unit[0].toLowerCase()}`;
  return BY_VALUE.has(value) ? value : null;
}

export const timeframeLabel = value => BY_VALUE.get(value)?.label || String(value);

/** Timeframes for what's typed: the one it means, then those whose name or label starts so. */
export function matchTimeframes(query) {
  const text = String(query ?? '').trim();
  if (!text) return [...TIMEFRAMES];
  const exact = parseTimeframe(text);
  const lower = text.toLowerCase();
  const rest = TIMEFRAMES.filter(item => item.value !== exact
    && (item.label.toLowerCase().startsWith(lower) || item.name.startsWith(lower) || item.value.startsWith(lower)));
  return [...(exact ? [BY_VALUE.get(exact)] : []), ...rest];
}

/** A symbol the charts can take: what the market query parser reads as one (2–15 letters and digits). */
const SYMBOL = /^[A-Z0-9]{2,15}$/;

/**
 * rev/chart's arguments: a symbol, any exchanges, a timeframe, in any order.
 *   { symbol: 'BTCUSDT' | null, base: 'BTC', exchanges, interval, unknown }
 * `unknown`, words that are none of these (past the symbol).
 */
export function parseChartArgs(args) {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  let interval = null;
  const exchanges = [];
  const rest = [];
  for (const word of words) {
    const timeframe = parseTimeframe(word);
    if (timeframe) { interval = timeframe; continue; }
    const exchange = KNOWN_EXCHANGES.find(name => name === word.toLowerCase());
    if (exchange) { if (!exchanges.includes(exchange)) exchanges.push(exchange); continue; }
    rest.push(word);
  }
  // Two characters at least (one letter is the start of a name, not a symbol).
  const symbol = rest.length && rest[0].replace(/[^A-Za-z0-9]/g, '').length >= 2 ? normalizeSymbol(rest[0]) : null;
  const sane = SYMBOL.test(symbol || '');
  return { symbol: sane ? symbol : null, base: sane ? baseOf(symbol) : '', typed: rest[0] || '', exchanges, interval, unknown: rest.slice(1) };
}

/** A pair as the watchlist widget opens one: "BTC" → "BTCUSDT", "1INCH" → "1INCHUSDT"; a pair as it is. */
export function pairOf(ticker) {
  const value = String(ticker ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value) return null;
  const pair = value.endsWith('USDT') && value.length > 4 ? value : `${value}USDT`;
  return SYMBOL.test(pair) ? pair : null;
}

/** "BTCUSDT" → "BTC"; anything else as it is. */
function baseOf(symbol) {
  if (!symbol) return '';
  return symbol.endsWith('USDT') && symbol.length > 4 ? symbol.slice(0, -4) : symbol;
}

const exchangeName = name => name[0].toUpperCase() + name.slice(1);
// Not charts of their own: what other coins are priced in.
const STABLE = new Set(['USDT', 'USDC', 'USD', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'EUR', 'GBP']);

/** The words Tab types for a symbol with what else was typed: "BTC coinbase 4H". */
function completion(base, { exchanges, interval }) {
  return [base, ...exchanges, ...(interval ? [timeframeLabel(interval)] : [])].join(' ');
}

/** What a chart is called in the bar: "BTC", "BTC · Coinbase", "BTC · Coinbase on 4H". */
function chartTitle(base, { exchanges, interval }) {
  const where = exchanges.length ? ` · ${exchanges.map(exchangeName).join(', ')}` : '';
  return `${base}${where}${interval ? ` on ${timeframeLabel(interval)}` : ''}`;
}

const NO_MARKET_DATA = 'Market charts need Market Data. Install it in Settings → Extensions.';

/** rev/portfolio's charts besides your coins, and the words that name each. */
const SECTIONS = Object.freeze([
  { section: 'total', title: 'Total', sub: 'Your whole portfolio', words: ['total', 'portfolio', 'all', 'balance'] },
  { section: 'spot', title: 'Spot', sub: 'Your spot holdings', words: ['spot'] },
  { section: 'perp', title: 'Perp', sub: 'Your perp accounts', words: ['perp', 'perps', 'futures'] },
]);

/** What a portfolio chart is called in a result: "your portfolio", "your SOL holdings". */
function sectionName(section) {
  const coin = sectionCoin(section);
  if (coin) return `your ${coin} holdings`;
  return section === 'spot' ? 'your Spot balance' : section === 'perp' ? 'your Perp balance' : 'your portfolio';
}

const capitalized = text => text[0].toUpperCase() + text.slice(1);

export function handleCommands(deps) {
  /**
   * Symbols to offer, each once, as the pair a chart opens: the
   * watchlist's (as its widget opens them), then yours, then recent
   * charts' (as they were charted). No stablecoins.
   */
  async function knownSymbols() {
    const out = new Map();
    const add = (pair, where) => {
      const base = baseOf(pair);
      if (pair && SYMBOL.test(pair) && !STABLE.has(base) && !out.has(base)) out.set(base, { base, pair, where });
    };
    for (const ticker of await deps.watchlist()) add(pairOf(ticker), 'Watchlist');
    for (const ticker of await deps.held()) add(pairOf(ticker), 'In your portfolio');
    for (const query of await deps.recent()) add(String(query).trim().split(/\s+/)[0].toUpperCase(), 'Recent');
    return [...out.values()];
  }

  // Alt+Enter in the bar (`go: false`): Finance isn't opened; its chart
  // changes now if it's showing, else when it next shows.
  const show = go => ({ show: go !== false });

  atmos.commands.handle('chart', async ({ args, value, go }) => {
    if (!(await deps.hasMarketData())) throw new Error(NO_MARKET_DATA);
    const parsed = parseChartArgs(args);
    if (parsed.unknown.length) throw new Error(`rev/chart takes a symbol, an exchange and a timeframe; “${parsed.unknown[0]}” isn’t one.`);
    // A row's value is its pair; what's typed gives the rest. A symbol typed
    // in full is the pair you have, if you have one (FARTCOIN: FARTCOINUSDT).
    let chosen = typeof value === 'string' && SYMBOL.test(value) ? value : null;
    if (!chosen && parsed.symbol) {
      const typed = parsed.typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
      chosen = (await knownSymbols()).find(item => item.base === typed || item.pair === parsed.symbol)?.pair || parsed.symbol;
    }
    if (!chosen) throw new Error('Type a symbol: rev/chart BTC 4h.');
    const base = baseOf(chosen);
    await deps.requestPanelAction({ type: 'open-market', query: [chosen, ...parsed.exchanges].join(' '), interval: parsed.interval }, show(go));
    return { done: go === false ? `${chartTitle(base, parsed)} in Finance.` : `Showing ${chartTitle(base, parsed)}.` };
  }, {
    suggest: async ({ args }) => {
      if (!(await deps.hasMarketData())) return [{ note: NO_MARKET_DATA }];
      const parsed = parseChartArgs(args);
      if (parsed.unknown.length) return [{ note: `rev/chart takes a symbol, an exchange and a timeframe; “${parsed.unknown[0]}” isn’t one.` }];
      const typed = parsed.typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const exact = item => item.base === typed || item.pair === parsed.symbol;
      // The one typed first, then those that start so; any other symbol the
      // exchanges trade, typed in full, after them.
      const rows = (await knownSymbols()).filter(item => !typed || item.base.startsWith(typed) || exact(item))
        .sort((a, b) => Number(exact(b)) - Number(exact(a)));
      if (parsed.symbol && !rows.some(exact)) rows.push({ base: parsed.base, pair: parsed.symbol, where: 'Any symbol the exchanges trade' });
      if (!rows.length) return [{ note: 'Type a symbol: rev/chart BTC 4h.' }];
      return rows.slice(0, MAX_ROWS).map(({ base, pair, where }) => ({
        title: chartTitle(base, parsed),
        sub: where,
        action: 'Show',
        value: pair,
        complete: completion(base, parsed),
      }));
    },
  });

  /**
   * rev/portfolio's charts for what's typed: Total, Spot and Perp by name,
   * then your coins (none listed in private mode), those named exactly first.
   */
  async function portfolioCharts(args) {
    const typed = String(args ?? '').trim().toLowerCase();
    const coins = (await deps.coins()).map(symbol => String(symbol));
    const charts = [
      ...SECTIONS.filter(item => !typed || item.words.some(word => word.startsWith(typed)))
        .map(item => ({ ...item, exact: item.words.includes(typed) })),
      ...coins.filter(symbol => !typed || symbol.toLowerCase().startsWith(typed))
        .map(symbol => ({ section: coinSection(symbol), title: symbol, sub: `What your ${symbol} has been worth`, exact: symbol.toLowerCase() === typed })),
    ];
    return charts.sort((a, b) => Number(b.exact) - Number(a.exact));
  }

  async function noPortfolioChart(args) {
    const typed = String(args ?? '').trim();
    // Private mode: whether you hold it isn't said either way.
    if (await deps.privateMode()) return `Coins aren’t listed while balances are hidden. Try total, spot or perp.`;
    return `You don’t hold “${typed}”. Try total, spot, perp or a coin you hold.`;
  }

  atmos.commands.handle('portfolio', async ({ args, value, go }) => {
    // A row's value is its chart; else what's typed (nothing: the total).
    const section = isPortfolioSection(value) ? value
      : String(args ?? '').trim() ? (await portfolioCharts(args))[0]?.section : 'total';
    // A coin's row listed before balances were hidden doesn't name it now.
    if (!section || (sectionCoin(section) && (await deps.privateMode()))) throw new Error(await noPortfolioChart(args));
    await deps.requestPanelAction({ type: 'portfolio-section', section }, show(go));
    const name = sectionName(section);
    return { done: go === false ? `${capitalized(name)} in Finance.` : `Showing ${name}.` };
  }, {
    suggest: async ({ args }) => {
      const charts = await portfolioCharts(args);
      if (!charts.length) return [{ note: await noPortfolioChart(args) }];
      return charts.slice(0, MAX_ROWS).map(({ section, title, sub }) => ({ title, sub, action: 'Show', value: section, complete: title }));
    },
  });

  atmos.commands.handle('timeframe', async ({ args, value, options, go }) => {
    const chosen = typeof value === 'string' && BY_VALUE.has(value) ? value : null;
    if (!chosen && !String(args ?? '').trim()) throw new Error('Type a timeframe: 1m, 4H, 1D, 1W…');
    const interval = chosen || matchTimeframes(args)[0]?.value;
    if (!interval) throw new Error(`There’s no “${String(args).trim()}” timeframe. Try 1m, 4H, 1D or 1W.`);
    const every = options?.every === true && (await deps.chartCount()) > 1;
    await deps.requestPanelAction({ type: 'chart-timeframe', interval, every }, show(go));
    return { done: every ? `Every Finance chart on ${timeframeLabel(interval)}.` : `Finance’s chart on ${timeframeLabel(interval)}.` };
  }, {
    suggest: async ({ args, options }) => {
      const now = await deps.currentTimeframe();
      const items = matchTimeframes(args);
      const rows = items.slice(0, MAX_ROWS).map(item => ({
        title: item.label,
        sub: item.value === now ? `${item.name} · now` : item.name,
        action: 'Set',
        value: item.value,
        complete: item.label,
      }));
      const result = { rows: rows.length ? rows : [{ note: `There’s no “${String(args).trim()}” timeframe. Try 1m, 4H, 1D or 1W.` }] };
      if ((await deps.chartCount()) > 1) result.options = [{ id: 'every', type: 'toggle', label: 'every chart', value: options?.every === true }];
      return result;
    },
  });
}

/**
 * The Finance panel frame: the portfolio and markets charts (panel.js),
 * mirroring the engine frame's data (src/host/mirror.js).
 */
import { createContext, handlePanelActions, setRole } from './src/host/frame.js';

setRole('panel');
const context = createContext();
// Market Data is optional: decided before anything mounts (src/host/market-data.js).
await (await import('./src/host/market-data.js')).checkMarketData();
const { startView } = await import('./src/host/mirror.js');
await startView(context);
await import('./panel.js');
const { getRegisteredPanel } = await import('./src/host/panel-registry.js');
const { queueMarketQuery } = await import('./markets/src/session.js');

const root = document.createElement('div');
root.className = 'finance-frame-root';
root.style.height = '100%'; // the panel fills its surface
document.body.append(root);
const panel = getRegisteredPanel('portfolio-tracker');
panel.mount(root, context);
context.onCleanup(() => panel.unmount?.(root));

const { TIMEFRAMES } = await import('./src/commands.js');
const { isPortfolioSection } = await import('./src/chart-sections.js');
const { setPortfolioSection } = await import('./src/total-chart.js');
const { portfolioState } = await import('./persist.js');
const { hasMarketData } = await import('./src/host/market-data.js');
const { consumePendingInterval } = await import('./markets/src/session.js');
const TIMEFRAME_VALUES = new Set(TIMEFRAMES.map(item => item.value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_MS = 10_000;

/**
 * Set a chart's timeframe as its toolbar does: a market chart takes it from
 * an event (its toolbar is only wired once it has candles; it keeps the
 * timeframe over the one Charting restores), the portfolio chart from its
 * own button.
 */
function setTimeframe(chartRoot, interval) {
  const market = chartRoot.querySelector('.mq-market');
  if (market) {
    market.dispatchEvent(new CustomEvent('finance:chart-interval', { bubbles: true, detail: { interval } }));
    return;
  }
  chartRoot.querySelector(`[data-interval="${interval}"]`)?.click();
}

/** The main chart, once it's the one the panel is on (not the one it's leaving), and with `every` the layout's others too. */
function chartsNow(every) {
  const stage = root.querySelector('.finance-chart-stage');
  const markets = portfolioState.chartMode === 'markets' && hasMarketData();
  const main = stage && (markets ? stage.querySelector('.mq-market') : !stage.querySelector('.mq-market') && stage.querySelector('[data-interval]'));
  if (!main) return null;
  if (!every) return [stage];
  const wanted = Math.max(0, Number(root.querySelector('.finance-chart-grid')?.dataset.count || 1) - 1);
  const extras = [...root.querySelectorAll('.finance-extra-chart')].filter(chart => chart.querySelector('.mq-market, [data-interval]'));
  return extras.length >= wanted ? [stage, ...extras] : null;
}

async function until(test) {
  for (let waited = 0; waited < WAIT_MS; waited += 100) {
    const value = test();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

// Widgets and rev/ commands (src/commands.js, answered in the engine frame)
// ask the panel for things: a symbol's chart, a portfolio chart, a
// timeframe. One at a time, in order (handlePanelActions), each done before
// the next.
context.onCleanup(handlePanelActions(async action => {
  const interval = TIMEFRAME_VALUES.has(action.interval) ? action.interval : null;
  if (action.type === 'open-market') {
    // A chart showing runs the query (and timeframe) at once; one still to
    // open takes them as it mounts.
    queueMarketQuery(action.query, { interval });
    document.dispatchEvent(new CustomEvent('atmos:chart-mode', { detail: { mode: 'markets' } }));
    const shown = await until(() => root.querySelector('.finance-chart-stage .mq-market'));
    // It didn't open (no Market Data): the timeframe isn't kept for later.
    if (!shown) consumePendingInterval();
  } else if (action.type === 'portfolio-section' && isPortfolioSection(action.section)) {
    // rev/portfolio: Total, Spot, Perp or a coin, on the main chart.
    setPortfolioSection(action.section);
    document.dispatchEvent(new CustomEvent('atmos:chart-mode', { detail: { mode: 'portfolio' } }));
  } else if (action.type === 'chart-timeframe' && interval) {
    const every = action.every === true;
    // Late or not, the charts there are set (a missing extra chart isn't waited for past WAIT_MS).
    const charts = await until(() => chartsNow(every)) || [root.querySelector('.finance-chart-stage'), ...(every ? root.querySelectorAll('.finance-extra-chart') : [])].filter(Boolean);
    for (const chartRoot of charts) setTimeframe(chartRoot, interval);
  }
}));

import { portfolioState } from '../persist.js';
import { renderExchangeList } from './registry.js';
import {
  setSamsaraOverlayEnabled,
  setSamsaraMaEnabled, setSamsaraIndividualMaEnabled, setSamsaraMaOpacity,
  setSamsaraRsiEnabled,
  setSamsaraSessionsEnabled, setSamsaraCandleColoringEnabled,
  setSamsaraCandleColorBasis, setCashInvestedPaneVisible,
} from './total-chart.js';

// The chart's right-click menu uses the Atmos SDK's menu items (`checked`
// for a tick, `type: 'select'` for a dropdown). Values are read when the menu opens, so it always reflects the
// latest persisted/shared indicator state without keeping a second UI model.
export function indicatorContextMenuItems() {
  const toggle = (id, label, checked, apply) => ({
    id, label, checked, run: () => apply(!checked),
  });
  const opacity = Math.max(0, Math.min(100, Math.round(Number(portfolioState.samsaraMaOpacity) || 0)));
  const opacityOptions = [...new Set([0, 20, 40, 60, 80, 100, opacity])].sort((a, b) => a - b)
    .map(value => ({ value: String(value), label: `${value}%` }));
  return [
    toggle('finance.cash-invested', 'Cash / Invested', portfolioState.cashInvestedPaneVisible !== false, setCashInvestedPaneVisible),
    { type: 'separator' },
    toggle('finance.samsara-overlay', 'Samsara Overlay', !!portfolioState.samsaraOverlayEnabled, setSamsaraOverlayEnabled),
    toggle('finance.samsara-ma', 'Moving Averages', !!portfolioState.samsaraMaEnabled, setSamsaraMaEnabled),
    ...[
      ['MA 1 · EMA 50', 'samsaraMa1Enabled'], ['MA 2 · EMA 100', 'samsaraMa2Enabled'],
      ['MA 3 · EMA 150', 'samsaraMa3Enabled'], ['MA 4 · EMA 200', 'samsaraMa4Enabled'],
      ['MA 5 · HMA 100', 'samsaraMa5Enabled'],
    ].map(([label, key], index) => toggle(`finance.samsara-ma-${index + 1}`, label, !!portfolioState[key], value => setSamsaraIndividualMaEnabled(index, value))),
    { id: 'finance.samsara-ma-opacity', type: 'select', label: 'MA Opacity', value: String(opacity), options: opacityOptions, run: value => setSamsaraMaOpacity(Number(value)) },
    toggle('finance.samsara-rsi', 'RSI OB/OS', !!portfolioState.samsaraRsiEnabled, setSamsaraRsiEnabled),
    toggle('finance.samsara-sessions', 'Sessions', !!portfolioState.samsaraSessionsEnabled, setSamsaraSessionsEnabled),
    toggle('finance.samsara-candles', 'Candle Colors', !!portfolioState.samsaraCandleColoringEnabled, setSamsaraCandleColoringEnabled),
    { id: 'finance.samsara-candle-basis', type: 'select', label: 'Candle Color Basis', value: portfolioState.samsaraCandleColorBasis || 'session', options: [
      ['session', 'Market Session'], ['consensus', 'All Moving Averages'], ['ma1', 'MA 1 · EMA 50'],
      ['ma2', 'MA 2 · EMA 100'], ['ma3', 'MA 3 · EMA 150'], ['ma4', 'MA 4 · EMA 200'], ['ma5', 'MA 5 · HMA 100'],
    ].map(([value, label]) => ({ value, label })), run: setSamsaraCandleColorBasis },
  ];
}

export function mountPortfolioConnections(body, context) {
  body.innerHTML = '<div id="exchange-mount"></div>';
  renderExchangeList(context);
}

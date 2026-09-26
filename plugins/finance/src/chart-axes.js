import { portfolioState } from '../persist.js';

// Axis scales and their grids are independent of pointer hover feedback.
export function chartAxisOptions() {
  return {
    showTimeAxis: portfolioState.timeAxisVisible !== false,
    showPriceAxis: portfolioState.priceAxisVisible !== false,
    showCrosshair: true, showHoverLabels: true, showTimeHoverLabel: true,
    gridColor: 'rgba(var(--ink-rgb),.09)',
    padding: { top: 8, right: 56, bottom: 22, left: 4 },
  };
}

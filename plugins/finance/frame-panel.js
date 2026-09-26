/**
 * The Finance panel frame: the portfolio and markets charts (panel.js),
 * mirroring the engine frame's data (src/host/mirror.js).
 */
import { createContext, handlePanelActions, setRole } from './src/host/frame.js';

setRole('panel');
const context = createContext();
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

// Widgets ask the panel for things, e.g. a watchlist symbol's chart.
context.onCleanup(handlePanelActions(action => {
  if (action.type !== 'open-market') return;
  queueMarketQuery(action.query);
  document.dispatchEvent(new CustomEvent('atmos:chart-mode', { detail: { mode: 'markets' } }));
}));

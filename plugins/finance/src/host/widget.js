/**
 * Starts one Finance sidebar widget frame (frame-widget-*.js): mirror the
 * engine, load the widget definitions (sidebar.js, markets/sidebar.js),
 * mount this one, and give Atmos its header menu.
 */
import { atmos, createContext, setRole } from './frame.js';

export async function startWidget(id) {
  setRole(`widget:${id}`);
  const context = createContext();
  const { startView } = await import('./mirror.js');
  await startView(context);
  await import('../../sidebar.js');
  const { getRegisteredSection } = await import('./sidebar-registry.js');
  const { onExternalStateChange, onLocalStateChange } = await import('./persist.js');
  const def = getRegisteredSection(id);
  if (!def) throw new Error(`Finance has no widget '${id}'`);

  const body = document.createElement('div');
  body.className = 'finance-frame-root';
  document.body.append(body);
  await def.mount(body, context);

  if (typeof def.contextMenuItems === 'function') {
    // Atmos shows the items last sent, and they depend on settings (ticks,
    // "Remove imported font"), so resend them whenever settings change here
    // or in another frame, including after an action that finishes later
    // (a font import waits for the file picker).
    let last = '';
    const refreshMenu = () => {
      const items = def.contextMenuItems() || [];
      const json = JSON.stringify(items);
      if (json === last) return;
      last = json;
      atmos.surface.setMenu(items).catch(() => {});
    };
    refreshMenu();
    context.onCleanup(onExternalStateChange(refreshMenu));
    context.onCleanup(onLocalStateChange(refreshMenu));
  }
}

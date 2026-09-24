/**
 * Every extension frame starts here (see /__atmos/frame.html): connect to
 * Atmos, then load the surface's entry file (panel.js, sidebar.js, …).
 */
import { __connect } from 'atmos-sdk';

const init = await __connect();
try {
  await import(init.entry);
} catch (error) {
  console.error(`[atmos] ${init.extension.kind} '${init.extension.id}' ${init.surface.type} failed to load:`, error);
}

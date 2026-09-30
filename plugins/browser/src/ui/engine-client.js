/**
 * The views' way into the engine, which runs in Atmos Browser's background
 * frame (boot.js). The panel, the widgets and the settings page are frames
 * on the same origin, so they call it directly (atmos.background()).
 *
 * Objects from the engine belong to the background frame's realm
 * (Array.isArray works; instanceof doesn't). A listener given to the engine
 * outlives this frame unless removed, so every subscription made here is
 * removed as the frame goes (pagehide).
 */
import atmos from 'atmos-sdk';

async function findEngine() {
  const background = await atmos.background();
  const deadline = Date.now() + 20000;
  while (!background.__browserEngine) {
    if (Date.now() > deadline) throw new Error('Atmos Browser’s background frame did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await background.__browserEngine.ready;
  return background.__browserEngine;
}

export const engine = await findEngine();

const live = new Set();
addEventListener('pagehide', () => { for (const remove of [...live]) remove(); });

/** engine.subscribe(fn), removed when this frame goes. Returns the remover. */
export function follow(fn) {
  const off = engine.subscribe(fn);
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    live.delete(remove);
    try { off(); } catch { /* the engine is going too */ }
  };
  live.add(remove);
  return remove;
}

/** Something of this frame's the engine holds (the panel's attachment), let go as the frame goes. */
export function hold(release) {
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    live.delete(remove);
    try { release(); } catch { /* the engine is going too */ }
  };
  live.add(remove);
  return remove;
}

// The panel: a glass card with a counter kept in atmos.state, which every
// frame of this extension shares (the sidebar widget shows it too).
import atmos from 'atmos-sdk';
import { getCount, increment, reset, onCount } from './src/counter.js';

document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./styles.css', import.meta.url).href }));
document.body.innerHTML = `
  <main class="hello-panel">
    <section class="hello-card" data-atmos-glass="panel">
      <h1></h1>
      <p>Clicks are saved in <code>atmos.state</code>, so they survive a restart and show in the sidebar widget too. Right-click for a menu.</p>
      <button type="button" class="hello-count"></button>
    </section>
  </main>`;
document.querySelector('h1').textContent = 'Hello from {{name}}';

const button = document.querySelector('.hello-count');
const show = count => { button.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`; };
show(await getCount());
button.addEventListener('click', async () => show(await increment()));

// Another frame changed it (the widget, or a second copy of this panel).
atmos.lifecycle.onCleanup(onCount(show));

// Atmos draws the frosted glass behind every element marked data-atmos-glass
// ("glass": true on the panel in extension.json).
atmos.lifecycle.onCleanup(atmos.surface.trackGlass());

// Menus are Atmos's own: the frame sends plain data, Atmos draws them.
document.addEventListener('contextmenu', event => {
  event.preventDefault();
  atmos.contextMenu.open(event.clientX, event.clientY, [
    { id: 'reset', label: 'Reset the count', run: async () => { await reset(); show(0); } },
  ]);
});

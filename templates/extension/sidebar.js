// The sidebar widget: the shared count, and Atmos's stars on GitHub, asked
// for through atmos.fetch() (which works for APIs without CORS headers too).
import atmos from 'atmos-sdk';
import { getCount, onCount } from './src/counter.js';
import { loadStars, REPO } from './src/stars.js';

const HALF_AN_HOUR = 30 * 60 * 1000;

document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./styles.css', import.meta.url).href }));
document.body.innerHTML = `
  <div class="hello-widget">
    <div class="hello-row"><span>Clicks</span><strong class="hello-clicks"></strong></div>
    <div class="hello-row"><span></span><strong class="hello-stars">…</strong></div>
  </div>`;
document.querySelector('.hello-row:last-child span').textContent = REPO.split('/')[1];

const clicks = document.querySelector('.hello-clicks');
const stars = document.querySelector('.hello-stars');
clicks.textContent = String(await getCount());
atmos.lifecycle.onCleanup(onCount(count => { clicks.textContent = String(count); }));

// A widget's frame comes and goes with its section, so keep the last answer
// in state and only ask GitHub again when it is old.
async function refresh({ force = false } = {}) {
  const saved = await atmos.state.get();
  if (!force && Number.isFinite(saved.stars) && Date.now() - (saved.starsAt || 0) < HALF_AN_HOUR) {
    stars.textContent = `★ ${saved.stars.toLocaleString()}`;
    return;
  }
  try {
    const count = await loadStars(atmos.lifecycle.signal);
    stars.textContent = `★ ${count.toLocaleString()}`;
    await atmos.state.update({ stars: count, starsAt: Date.now() });
  } catch (error) {
    if (error.name !== 'AbortError') stars.textContent = 'out of reach';
  }
}
refresh();
atmos.lifecycle.setInterval(refresh, HALF_AN_HOUR);

// Items Atmos adds to the widget header's right-click menu.
atmos.surface.setMenu([{ id: 'refresh', label: 'Ask GitHub again', run: () => refresh({ force: true }) }]);

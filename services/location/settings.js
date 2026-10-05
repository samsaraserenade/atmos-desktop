/**
 * Location's section of Settings → Appearance: where you are, Detect,
 * Clear, and a place search. The location is kept in atmos.state; the
 * background frame (boot.js) publishes it.
 *
 * Detect asks Atmos first (atmos.location.allowDetect, which checks the
 * click landed here): this frame may use the browser's location only for a
 * moment after that, never otherwise.
 */
import atmos from 'atmos-sdk';
import { cleanLocation, placeName, placesFrom, reverseUrl, searchUrl } from './src/location.js';

document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./assets/settings.css', import.meta.url).href }));

document.body.innerHTML = `
  <section class="atmos-section">
    <div class="atmos-row">
      <span class="atmos-label">Your Location <small id="loc-current"></small></span>
      <span class="atmos-control">
        <button type="button" class="atmos-button" id="loc-detect">Detect</button>
        <button type="button" class="atmos-button" id="loc-clear">Clear</button>
      </span>
    </div>
    <div class="atmos-row">
      <span class="atmos-label">Search</span>
      <span class="atmos-control">
        <form id="loc-search" class="loc-search" role="search">
          <input type="search" id="loc-query" class="atmos-input" placeholder="City or town" maxlength="60" autocomplete="off" aria-label="Search for a place">
          <button type="submit" class="atmos-button">Find</button>
        </form>
      </span>
    </div>
    <div id="loc-results" class="loc-results" role="listbox" aria-label="Places found"></div>
    <div id="loc-status" class="atmos-status" role="status" hidden></div>
  </section>`;

const $ = id => document.getElementById(id);
const current = $('loc-current');
const detect = $('loc-detect');
const clear = $('loc-clear');
const results = $('loc-results');
const status = $('loc-status');

function say(message, kind = '') {
  status.textContent = message;
  status.className = `atmos-status${kind ? ` ${kind}` : ''}`;
  status.hidden = !message;
}

let location = null;
function render() {
  current.textContent = location ? location.label : 'Not set. Atmos only reads your location when you press Detect';
  clear.hidden = !location;
}
/**
 * Shown here at once (Atmos tells a frame only of other frames' changes);
 * boot.js hears it and publishes. A choice made here stands over the
 * location Atmos kept before 0.21, so it's marked as taken over.
 */
async function save(next) {
  location = cleanLocation(next);
  render();
  await atmos.state.update({ location, tookEarlier: true });
}

atmos.state.get().then(saved => { location = cleanLocation(saved?.location); render(); }).catch(() => render());
atmos.state.onChange(next => { location = cleanLocation(next?.location); render(); });

/** The browser's position, once Atmos has let this frame ask for it. */
function position() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This computer can’t tell where it is.')); return; }
    navigator.geolocation.getCurrentPosition(
      found => resolve(found.coords),
      error => reject(new Error({ 1: 'Permission denied.', 2: 'Position unavailable.', 3: 'It took too long.' }[error.code] || 'Detection failed.')),
      { timeout: 8000 },
    );
  });
}

detect.addEventListener('click', async () => {
  detect.disabled = true;
  detect.textContent = 'Detecting…';
  say('');
  try {
    if (!(await atmos.location.allowDetect())) throw new Error('Atmos didn’t let it detect.');
    const { latitude: lat, longitude: lon } = await position();
    let label = null;
    try { label = placeName(await (await atmos.fetch(reverseUrl(lat, lon))).json()); } catch { /* the coordinates, then */ }
    const next = cleanLocation({ mode: 'auto', lat, lon, label });
    await save(next);
    say(`Set to ${next.label}`, 'ok');
  } catch (error) {
    say(error.message, 'err');
  } finally {
    detect.disabled = false;
    detect.textContent = 'Detect';
  }
});

clear.addEventListener('click', () => { save(null).catch(error => say(error.message, 'err')); say(''); });

$('loc-search').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('loc-query').value.trim();
  if (!query) return;
  results.replaceChildren();
  say('Searching…');
  let places;
  try {
    places = placesFrom(await (await atmos.fetch(searchUrl(query))).json());
  } catch {
    say('Search failed. Check your connection.', 'err');
    return;
  }
  if (!places.length) { say('No places found.', 'err'); return; }
  say('');
  for (const place of places) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'loc-result';
    item.setAttribute('role', 'option');
    const name = Object.assign(document.createElement('span'), { className: 'loc-result-name', textContent: place.name });
    const sub = Object.assign(document.createElement('span'), { className: 'loc-result-sub', textContent: place.sub });
    item.append(name, sub);
    item.addEventListener('click', () => {
      save({ mode: 'manual', lat: place.lat, lon: place.lon, label: place.name }).catch(error => say(error.message, 'err'));
      results.replaceChildren();
      $('loc-query').value = '';
      say('');
    });
    results.append(item);
  }
});

render();

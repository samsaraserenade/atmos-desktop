/**
 * Location's section of Settings → Appearance: the current location, detect,
 * reset, and search. The logic lives in index.js (no DOM); this only wires
 * the controls. Rows use the Appearance page's shared classes.
 */
import './styles.js';
import { registerSettingsPanel } from 'atmos-core/core/settings-registry.js';
import {
  detectLocation, getLocation, onLocationChange, resetLocation, searchLocations, setLocation,
} from './index.js';

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const row = (label, control, hint = '') =>
  `<div class="sa-row"><span class="sa-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="sa-control">${control}</span></div>`;

registerSettingsPanel('location', {
  label: 'Location',
  category: 'Appearance',
  order: 10, // after Wallpaper (5)

  mount(bodyEl, context) {
    bodyEl.innerHTML = `
      ${row('Your Location', `
        <button type="button" class="sa-btn loc-detect">Detect</button>
        <button type="button" class="sa-btn loc-reset">Clear</button>`, '<span class="loc-current"></span>')}
      ${row('Search', `
        <form class="loc-search" role="search">
          <input type="search" class="loc-query" placeholder="City or town" maxlength="60" autocomplete="off" aria-label="Search for a place">
          <button type="submit" class="sa-btn">Find</button>
        </form>`)}
      <div class="loc-results" role="listbox" aria-label="Places found"></div>
      <div class="loc-status sa-status" role="status"></div>`;

    const current = bodyEl.querySelector('.loc-current');
    const detect = bodyEl.querySelector('.loc-detect');
    const reset = bodyEl.querySelector('.loc-reset');
    const form = bodyEl.querySelector('.loc-search');
    const query = bodyEl.querySelector('.loc-query');
    const results = bodyEl.querySelector('.loc-results');
    const status = bodyEl.querySelector('.loc-status');

    const setStatus = (message, type = '') => {
      status.textContent = message;
      status.className = `loc-status sa-status${type ? ` ${type}` : ''}`;
    };
    const render = () => {
      const location = getLocation();
      const set = location.lat !== null;
      current.textContent = set ? (location.label || 'Custom') : 'Not set. Shared with extensions that ask for it';
      reset.hidden = !set;
    };

    context.listen(detect, 'click', async () => {
      detect.disabled = true;
      detect.textContent = 'Detecting…';
      setStatus('');
      try {
        const location = await detectLocation();
        if (!context.signal.aborted) setStatus(`Set to ${location.label}`, 'ok');
      } catch (error) {
        if (!context.signal.aborted) setStatus(error.message, 'err');
      } finally {
        if (!context.signal.aborted) { detect.disabled = false; detect.textContent = 'Detect'; }
      }
    });

    context.listen(reset, 'click', () => { resetLocation(); setStatus(''); });

    context.listen(form, 'submit', async event => {
      event.preventDefault();
      const text = query.value.trim();
      if (!text) return;
      results.innerHTML = '';
      setStatus('Searching…');
      let places;
      try {
        places = await searchLocations(text);
      } catch {
        if (!context.signal.aborted) setStatus('Search failed. Check your connection.', 'err');
        return;
      }
      if (context.signal.aborted) return;
      if (!places.length) { setStatus('No places found.', 'err'); return; }
      setStatus('');
      for (const place of places) {
        const sub = [place.admin1, place.country].filter(Boolean).join(', ');
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'loc-result';
        item.setAttribute('role', 'option');
        item.innerHTML = `<span class="loc-result-name">${escapeHtml(place.name)}</span><span class="loc-result-sub">${escapeHtml(sub)}</span>`;
        context.listen(item, 'click', () => {
          setLocation(place);
          results.innerHTML = '';
          query.value = '';
          setStatus('');
        });
        results.appendChild(item);
      }
    });

    onLocationChange(render, { signal: context.signal });
    render();
  },
});

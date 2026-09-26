// Wallpaper's section of Settings → Appearance. Uses the Appearance page's
// shared row classes (.sa-row, .sa-slider…, styled in Core's index.html).
import { wallpaperState } from './persist.js';
import { getPersistentState, removeWallpaper, setState, setWallpaper, subscribe } from './engine.js';

const adjustments = [
  ['opacity', 'Opacity', 0, 100, '%'],
  ['parallaxStrength', 'Parallax', 0, 100, '%'],
  ['glassBlur', 'Blur', 0, 50, 'px'],
  ['glassSaturation', 'Saturation', 0, 200, '%'],
  ['vignette', 'Vignette', 0, 100, '%'],
  ['brightness', 'Brightness', 10, 100, '%'],
  ['contrast', 'Contrast', 50, 150, '%'],
  ['hue', 'Hue', -180, 180, '°'],
];

const row = (label, control, hint = '') =>
  `<div class="sa-row"><span class="sa-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="sa-control">${control}</span></div>`;

export function mountControls(body, context) {
  body.innerHTML = `
    ${row('Image', `
      <button type="button" class="sa-btn wallpaper-choose">Choose…</button>
      <button type="button" class="sa-btn wallpaper-remove">Remove</button>`, '<span class="wallpaper-image-status"></span>')}
    ${row('Mode', `
      <span class="sa-segmented" role="radiogroup" aria-label="Wallpaper mode">
        <button type="button" role="radio" data-wallpaper-mode="transparent">See-through</button><button type="button" role="radio" data-wallpaper-mode="wallpaper">Wallpaper</button>
      </span>`, 'See-through shows your desktop behind Atmos')}
    ${row('Transparent Window', `
      <button type="button" class="sa-btn wallpaper-window-restart" hidden>Restart</button>
      <label class="sm-toggle" title="Takes effect after a restart">
        <input type="checkbox" class="wallpaper-window-effects" aria-label="Transparent window">
        <span class="sm-toggle-track"><span class="sm-toggle-thumb"></span></span>
      </label>`, '<span class="wallpaper-window-status">Checking…</span>')}
    <details class="sa-details">
      <summary>Adjustments <small>opacity, blur, colour</small></summary>
      ${adjustments.map(([key, label, min, max]) => row(label, `
        <span class="sa-slider">
          <input type="range" class="crange" data-wallpaper-key="${key}" min="${min}" max="${max}" step="1" aria-label="Wallpaper ${label.toLowerCase()}">
          <output></output>
        </span>`)).join('')}
    </details>
    <input class="wallpaper-file" type="file" accept="image/*" hidden>`;

  const input = body.querySelector('.wallpaper-file');
  const removeButton = body.querySelector('.wallpaper-remove');
  const imageStatus = body.querySelector('.wallpaper-image-status');
  const effectsToggle = body.querySelector('.wallpaper-window-effects');
  const effectsStatus = body.querySelector('.wallpaper-window-status');
  const restartButton = body.querySelector('.wallpaper-window-restart');

  // Image
  const renderImage = () => {
    const image = getPersistentState().image;
    const hasImage = !!image;
    imageStatus.textContent = hasImage ? 'Your own image' : 'None';
    removeButton.hidden = !hasImage;
  };
  context.listen(body.querySelector('.wallpaper-choose'), 'click', () => input.click());
  context.listen(removeButton, 'click', async () => {
    removeButton.disabled = true;
    try { await removeWallpaper(); }
    catch (error) { console.error('[wallpaper] remove failed:', error); }
    finally { removeButton.disabled = false; }
  });
  context.listen(input, 'change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) await setWallpaper(file);
  });

  // Mode
  const modeButtons = [...body.querySelectorAll('[data-wallpaper-mode]')];
  const renderMode = () => {
    for (const button of modeButtons) {
      const on = button.dataset.wallpaperMode === wallpaperState.mode;
      button.classList.toggle('active', on);
      button.setAttribute('aria-checked', String(on));
    }
  };
  for (const button of modeButtons) {
    context.listen(button, 'click', () => setState({ mode: button.dataset.wallpaperMode }));
  }

  // Transparent window (a main-process setting; takes effect after a restart)
  const renderWindowEffects = effects => {
    effectsToggle.checked = effects.configured === true;
    const pending = effects.active !== effects.configured;
    effectsStatus.textContent = pending ? 'Restart to apply' : effects.active ? 'On' : 'Off: a normal window';
    restartButton.hidden = !pending;
  };
  if (window.atmosCore?.getWindowEffects) {
    window.atmosCore.getWindowEffects().then(effects => {
      if (!context.signal.aborted) renderWindowEffects(effects);
    }).catch(() => {
      if (context.signal.aborted) return;
      effectsToggle.disabled = true;
      effectsStatus.textContent = 'Unavailable';
    });
    context.listen(effectsToggle, 'change', async () => {
      effectsToggle.disabled = true;
      try { renderWindowEffects(await window.atmosCore.setTransparentWindow(effectsToggle.checked)); }
      catch { effectsStatus.textContent = 'Could not save'; }
      finally { effectsToggle.disabled = false; }
    });
    context.listen(restartButton, 'click', () => window.atmosCore.restartAtmos());
  } else {
    effectsToggle.checked = true;
    effectsToggle.disabled = true;
    effectsStatus.textContent = 'On';
  }

  // Adjustments
  const sliders = [...body.querySelectorAll('[data-wallpaper-key]')];
  const renderSliders = () => {
    for (const slider of sliders) {
      if (slider === document.activeElement) continue;
      const [key, , , , unit] = adjustments.find(([id]) => id === slider.dataset.wallpaperKey);
      slider.value = String(wallpaperState[key]);
      slider.nextElementSibling.textContent = `${wallpaperState[key]}${unit}`;
    }
  };
  for (const slider of sliders) {
    const [key, , , , unit] = adjustments.find(([id]) => id === slider.dataset.wallpaperKey);
    context.listen(slider, 'input', () => {
      const value = Number(slider.value);
      slider.nextElementSibling.textContent = `${value}${unit}`;
      setState({ [key]: value });
    });
  }

  subscribe(() => { renderImage(); renderMode(); renderSliders(); }, { signal: context.signal });
}

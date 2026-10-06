// Wallpaper's section of Settings → Appearance. Uses the Appearance page's
// shared row classes (.sa-row, .sa-slider…, styled in Core's index.html).
import { wallpaperState } from './persist.js';
import { imageKind, removeWallpaper, restorePrevious, setState, setWallpaper, subscribe, useDefaultWallpaper } from './engine.js';

const adjustments = [
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
      <button type="button" class="sa-btn wallpaper-restore" hidden>Restore previous</button>
      <button type="button" class="sa-btn wallpaper-choose">Choose…</button>
      <button type="button" class="sa-btn wallpaper-default">Use default</button>
      <button type="button" class="sa-btn wallpaper-remove">Remove</button>`, '<span class="wallpaper-image-status"></span>')}
    <details class="sa-details">
      <summary>Adjustments <small>parallax, blur, colour</small></summary>
      ${adjustments.map(([key, label, min, max]) => row(label, `
        <span class="sa-slider">
          <input type="range" class="crange" data-wallpaper-key="${key}" min="${min}" max="${max}" step="1" aria-label="Wallpaper ${label.toLowerCase()}">
          <output></output>
        </span>`)).join('')}
    </details>
    <input class="wallpaper-file" type="file" accept="image/*" hidden>`;

  const input = body.querySelector('.wallpaper-file');
  const removeButton = body.querySelector('.wallpaper-remove');
  const defaultButton = body.querySelector('.wallpaper-default');
  const restoreButton = body.querySelector('.wallpaper-restore');
  const imageStatus = body.querySelector('.wallpaper-image-status');

  // Image
  const renderImage = () => {
    const kind = imageKind();
    // An extension's image: say whose, and offer what it replaced.
    const setBy = wallpaperState.setBy ? wallpaperState.setByName || wallpaperState.setBy : null;
    imageStatus.textContent = setBy ? `Set by ${setBy}`
      : kind === 'own' ? 'Your own image' : kind === 'default' ? 'The Atmos default' : 'None';
    restoreButton.hidden = !(setBy && wallpaperState.previous);
    restoreButton.title = wallpaperState.previous === 'own' ? 'Put back your own image'
      : wallpaperState.previous === 'default' ? 'Put back the Atmos default' : 'Go back to no wallpaper';
    defaultButton.hidden = kind === 'default';
    removeButton.hidden = kind === 'none';
  };
  context.listen(restoreButton, 'click', async () => {
    restoreButton.disabled = true;
    try { await restorePrevious(); }
    catch (error) { console.error('[wallpaper] restore failed:', error); imageStatus.textContent = error.message.replace(/^wallpaper: /, ''); }
    finally { restoreButton.disabled = false; }
  });
  context.listen(defaultButton, 'click', async () => {
    defaultButton.disabled = true;
    try { await useDefaultWallpaper(); }
    catch (error) { console.error('[wallpaper] reset failed:', error); }
    finally { defaultButton.disabled = false; }
  });
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

  subscribe(() => { renderImage(); renderSliders(); }, { signal: context.signal });
}

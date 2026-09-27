import { registerBootHook } from 'atmos-core/core/boot-registry.js';
import { provideCapability } from 'atmos-core/core/renderer-capabilities.js';
import { registerSurface } from 'atmos-core/core/surface-registry.js';
import { registerContextMenuItem } from 'atmos-core/core/context-menu-registry.js';
import { wallpaperApi, initialize, mount, setWallpaper } from './engine.js';
import { mountWallpaperInteraction } from './interaction.js';

const styleUrl = new URL('./styles.css', import.meta.url).href;
const icon = '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function chooseWallpaper() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => input.files?.[0] && setWallpaper(input.files[0]), { once: true });
  input.click();
}

registerBootHook('wallpaper', {
  order: -100,
  async run(context) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = styleUrl;
    document.head.appendChild(link);
    context.onCleanup(() => link.remove());
    await mountWallpaperInteraction(context);

    context.onCleanup(registerSurface('wallpaper', {
      layer: 'workspace-background',
      mount,
    }));
    context.onCleanup(provideCapability('visual.wallpaper', wallpaperApi, { owner: 'wallpaper' }));
    context.onCleanup(registerContextMenuItem('wallpaper.choose', {
      order: -100,
      label: 'Set Wallpaper…',
      icon,
      run: chooseWallpaper,
    }));

    await initialize();

    context.listen(window, 'keydown', async event => {
      if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v')) return;
      event.preventDefault();
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find(value => value.startsWith('image/'));
          if (!type) continue;
          await setWallpaper(new File([await item.getType(type)], 'pasted-wallpaper', { type }));
          break;
        }
      } catch (error) {
        console.warn('[wallpaper] clipboard image could not be applied:', error.message);
      }
    });
  },
});

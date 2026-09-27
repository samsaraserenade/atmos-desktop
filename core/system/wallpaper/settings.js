import { registerSettingsPanel } from 'atmos-core/core/settings-registry.js';
import { mountControls } from './controls.js';

registerSettingsPanel('wallpaper', {
  label: 'Wallpaper',
  category: 'Appearance',
  order: 5,
  mount: mountControls,
});

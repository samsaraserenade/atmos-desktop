// Audio Player's panel frame ("Music"): the player bar and library browser.
// On the full workspace Atmos shows it in a drawer ("drawer" in extension.json).
import { mountPlayer } from './src/player-view.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/panel.css', import.meta.url).href;
document.head.appendChild(style);

await mountPlayer();

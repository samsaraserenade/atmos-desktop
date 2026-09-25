/**
 * Matrix Chat's account widget ("Matrix Account"): saved accounts, your
 * profile, this device's security and log out, always open in the sidebar
 * rather than on a settings page (ui/settings-menu.js). The ping sound is
 * the rev/notifications command.
 */
import atmos from 'atmos-sdk';
import { hasSession, onAccountChange } from './src/ui/engine.js';
import { renderSettingsDashboard } from './src/ui/settings-menu.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/styles.css', import.meta.url).href;
document.head.appendChild(style);
document.body.classList.add('mx-frame', 'mx-frame-account');
// The widget's height follows its content; Atmos scrolls the section.
document.documentElement.style.height = 'auto';
document.body.style.height = 'auto';

const root = document.createElement('div');
root.className = 'mx-atmos-account';
document.body.appendChild(root);

let cleanup = null;

function render() {
  try { cleanup?.(); } catch (error) { console.error('[matrix-chat] account widget cleanup failed:', error); }
  cleanup = null;
  if (!hasSession()) {
    root.innerHTML = `
      <div class="mx-rooms-signed-out">
        <span>Not signed in</span>
        <button type="button">Open Chat</button>
      </div>`;
    root.querySelector('button').addEventListener('click', () => atmos.panel.show().catch(() => {}));
    return;
  }
  cleanup = renderSettingsDashboard(root, { onLogout: render }) || null;
}

// Signing in or out, or switching account: show that account.
onAccountChange(render);
addEventListener('pagehide', () => { try { cleanup?.(); } catch { /* going anyway */ } });

render();

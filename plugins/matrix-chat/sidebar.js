/**
 * Matrix Chat's main sidebar widget ("Matrix Chat"): invites, then one list
 * of collapsible groups: Direct Messages, each space (its rooms, and the
 * ones you haven't joined), Other rooms. Creating and joining are rev/
 * commands in the message bar; your account is its own widget ("Matrix
 * Account", sidebar-account.js). Choosing a room opens it in the Chat panel (through the
 * engine's shared view, then atmos.panel.show()).
 * Shows beside the Chat panel by default ("showIn"); the widget's header
 * menu can pin it anywhere.
 */
import atmos from 'atmos-sdk';
import { hasSession, onAccountChange, onViewChange, currentView, showRoom } from './src/ui/engine.js';
import { renderRoomList } from './src/ui/room-list.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/styles.css', import.meta.url).href;
document.head.appendChild(style);
document.body.classList.add('mx-frame', 'mx-frame-rooms');
// The widget's height follows its content; Atmos scrolls the section.
document.documentElement.style.height = 'auto';
document.body.style.height = 'auto';

const root = document.createElement('div');
root.className = 'mx-atmos-rooms';
document.body.appendChild(root);

let listCleanup = null;

function renderSignedOut() {
  root.innerHTML = `
    <div class="mx-rooms-signed-out">
      <span>Not signed in</span>
      <button type="button">Open Chat</button>
    </div>`;
  root.querySelector('button').addEventListener('click', () => atmos.panel.show().catch(() => {}));
}

function renderSignedIn() {
  root.innerHTML = '<div class="mx-rooms-body"></div>';
  const view = currentView();
  listCleanup = renderRoomList(root.querySelector('.mx-rooms-body'), {
    activeRoomId: view.type === 'room' ? view.roomId : null,
    onSelectRoom: room => {
      showRoom(room.roomId);
      atmos.panel.show().catch(() => {});
    },
  }) || null;
}

function render() {
  try { listCleanup?.(); } catch (error) { console.error('[matrix-chat] room list cleanup failed:', error); }
  listCleanup = null;
  if (hasSession()) renderSignedIn();
  else renderSignedOut();
}

// The panel opening a room highlights it here.
onViewChange(view => listCleanup?.update?.(view.type === 'room' ? view.roomId : null));
onAccountChange(() => {
  // Signed in/out: rebuild. Switching between saved accounts: the list resets itself.
  const signedIn = !!root.querySelector('.mx-rooms-body');
  if (signedIn !== hasSession()) render();
});
addEventListener('pagehide', () => { try { listCleanup?.(); } catch { /* going anyway */ } });

// Space reordering inside the list must not start Atmos's widget drag.
for (const type of ['dragstart', 'dragend', 'dragover', 'dragleave', 'drop']) {
  root.addEventListener(type, event => event.stopPropagation());
}

render();

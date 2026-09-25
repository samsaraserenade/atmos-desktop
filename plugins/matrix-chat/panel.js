/**
 * Matrix Chat's panel frame ("Chat"): sign-in while logged out; then the
 * open room, straight away. Which room is kept by the engine (engine.view),
 * so the sidebar widget (sidebar.js) can open one here, and the panel
 * reopens the last one. With none open it shows an empty timeline and the
 * message bar (ui/empty-view.js). Creating, joining and the like are rev/
 * commands in the message bar (ui/command-bar.js); account settings are the
 * Matrix Account sidebar widget (sidebar-account.js).
 */
import atmos from 'atmos-sdk';
import {
  hasSession, getRooms, onAccountChange, onSync, onViewChange, currentView, onPanelRequest, takePanelRequest,
} from './src/ui/engine.js';
import { renderLogin } from './src/ui/login.js';
import { renderRoomView } from './src/ui/room-view.js';
import { renderEmptyView } from './src/ui/empty-view.js';

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/styles.css', import.meta.url).href;
document.head.appendChild(style);
document.body.classList.add('mx-frame', 'mx-frame-panel');

atmos.surface.trackGlass();

const contentEl = document.createElement('div');
contentEl.className = 'mx-panel-root';
document.body.appendChild(contentEl);
let layoutEl = null;
let mainEl = null;
let mainCleanup = null;
let loginCleanup = null;
let shown = null; // what mainEl shows: { type: 'none' } | { type: 'room', roomId }
let pendingRoomId = null; // a room to show once sync has it

/** Act on what the sidebar widget (or a command) asked for. */
function handleRequest() {
  if (!mainEl) return;
  const request = takePanelRequest();
  if (!request) return;
  if (request.action === 'command') mainCleanup?.fill?.(request.text, { parentSpaceId: request.parentSpaceId });
}

function teardownMain() {
  try { mainCleanup?.(); } catch (error) { console.error('[matrix-chat] view cleanup failed:', error); }
  mainCleanup = null;
}

function showLogin() {
  teardownMain();
  loginCleanup?.();
  layoutEl = mainEl = shown = null;
  pendingRoomId = null;
  contentEl.innerHTML = '';
  loginCleanup = renderLogin(contentEl, { onSuccess: () => { if (!mainEl) enterLayout(); } }) || null;
}

function enterLayout() {
  loginCleanup?.();
  loginCleanup = null;
  contentEl.innerHTML = '';
  layoutEl = document.createElement('div');
  layoutEl.className = 'mx-layout';
  mainEl = document.createElement('div');
  mainEl.className = 'mx-main';
  layoutEl.appendChild(mainEl);
  contentEl.appendChild(layoutEl);
  shown = null;
  follow(currentView());
  handleRequest();
}

function showEmptyView({ opening = false } = {}) {
  teardownMain();
  shown = { type: 'none', opening };
  delete layoutEl.dataset.atmosGlass; // the empty view and its bar carry it
  mainCleanup = renderEmptyView(mainEl, { opening }) || null;
}

function showRoomView(room) {
  teardownMain();
  shown = { type: 'room', roomId: room.roomId };
  pendingRoomId = null;
  delete layoutEl.dataset.atmosGlass; // the room view and composer carry it
  mainCleanup = renderRoomView(mainEl, room) || null;
}

/** Show what the engine's view says: a room once sync has it, or nothing. */
function follow(view) {
  if (!mainEl) return;
  if (view.type === 'room') {
    if (shown?.type === 'room' && shown.roomId === view.roomId) return;
    const room = getRooms().find(candidate => candidate.roomId === view.roomId);
    if (room) { showRoomView(room); return; }
    // Not synced yet (just after start): the room when it arrives.
    pendingRoomId = view.roomId;
    if (shown?.type !== 'none' || !shown.opening) showEmptyView({ opening: true });
    return;
  }
  pendingRoomId = null;
  if (shown?.type !== 'none' || shown.opening) showEmptyView();
}

onViewChange(follow);
onPanelRequest(handleRequest);

onSync(state => {
  if (!['PREPARED', 'SYNCING'].includes(state) || !pendingRoomId || !mainEl) return;
  const room = getRooms().find(candidate => candidate.roomId === pendingRoomId);
  if (room && currentView().roomId === pendingRoomId) showRoomView(room);
  // The last room is gone (left from another device, say): show nothing.
  else if (!room && shown?.opening) showEmptyView();
});

// A sign-out (or a revoked token) shows sign-in; a switch to another saved
// account shows its last room (the engine resets the view).
onAccountChange(({ userId } = {}) => {
  if (!hasSession()) showLogin();
  else if (!mainEl) enterLayout();
  else if (userId) { shown = null; follow(currentView()); }
});

addEventListener('pagehide', () => {
  teardownMain();
  loginCleanup?.();
});

if (hasSession()) enterLayout();
else showLogin();


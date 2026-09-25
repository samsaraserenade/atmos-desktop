/**
 * The Chat panel with no room open (first sign-in, or after leaving the
 * last one): an empty timeline and the message bar, which takes rev/
 * commands to open, join or create something.
 */
import { showRoom } from './engine.js';
import { attachCommandBar } from './command-bar.js';

export function renderEmptyView(contentEl, { opening = false } = {}) {
  contentEl.innerHTML = `
    <div class="mx-room-view mx-empty-view" data-atmos-glass="panel" data-atmos-glass-inset="0 0 54 0">
      <div class="mx-timeline mx-empty-timeline">
        <div class="mx-empty-view-hint">
          ${opening ? '<p>Opening your last room…</p>' : `<p>No room open.</p>
          <p>Pick one in Matrix Chat in the sidebar, or type <kbd>rev/</kbd> below to open, join or create one.</p>`}
        </div>
      </div>
      <div class="mx-composer" data-atmos-glass="shell">
        <input type="text" class="mx-empty-view-input" placeholder="Type rev/ to open, join or create a room…" autocomplete="off" spellcheck="false">
      </div>
    </div>`;
  const input = contentEl.querySelector('.mx-empty-view-input');
  const composerEl = contentEl.querySelector('.mx-composer');
  const commandBar = attachCommandBar({ input, composerEl, onOpenRoom: roomId => showRoom(roomId) });
  // Enter without a command: there's nowhere to send a message yet.
  const onKeyDown = event => {
    if (event.key !== 'Enter' || commandBar.active() || !input.value.trim()) return;
    event.preventDefault();
    commandBar.fill(`rev/go ${input.value.trim()}`);
  };
  input.addEventListener('keydown', onKeyDown);
  const cleanup = () => {
    commandBar.dispose();
    input.removeEventListener('keydown', onKeyDown);
  };
  cleanup.fill = commandBar.fill;
  return cleanup;
}

/**
 * The Chat panel with no room open (first sign-in, or after leaving the
 * last one): an empty timeline and the message bar. rev/ commands are
 * Atmos's command bar's, which opens over this bar (ui/command-handlers.js
 * answers Matrix Chat's); anything else typed and entered is a room to open
 * (rev/go).
 */
import atmos from 'atmos-sdk';
import { isCommand } from './commands.js';

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
  const stopCommandBar = atmos.commands.bar(composerEl);
  const stopCommandField = atmos.commands.field(input);
  // Enter: there's nowhere to send a message yet, so it's a room to open,
  // handed over as if typed (atmos.commands.field): rev/go and the name.
  const onKeyDown = event => {
    if (event.key !== 'Enter' || event.isComposing || !input.value.trim()) return;
    event.preventDefault();
    if (!isCommand(input.value)) input.value = `rev/go ${input.value.trim()}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.addEventListener('keydown', onKeyDown);
  return () => {
    stopCommandBar();
    stopCommandField();
    input.removeEventListener('keydown', onKeyDown);
  };
}

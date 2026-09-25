/**
 * Frames can't show confirm() or alert(), so a destructive menu action asks
 * again in a second Atmos menu at the same spot, and a failure is said there
 * too.
 */
import atmos from 'atmos-sdk';

/** Resolves true if "confirmLabel" was chosen. */
export async function confirmInMenu(x, y, question, confirmLabel, icon) {
  let confirmed = false;
  await atmos.contextMenu.open(x, y, [
    { type: 'meta', label: question },
    { type: 'separator' },
    { id: 'confirm', label: confirmLabel, icon, run: () => { confirmed = true; } },
    { id: 'cancel', label: 'Cancel' },
  ]).catch(() => {});
  return confirmed;
}

export function tellInMenu(x, y, message) {
  atmos.contextMenu.open(x, y, [{ type: 'meta', label: String(message).slice(0, 120) }]).catch(() => {});
}

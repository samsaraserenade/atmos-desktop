/**
 * Stands in for Atmos Core's context-menu.js inside Finance's frames: the
 * menu is still Atmos's, opened at frame coordinates through the SDK.
 */
import { atmos } from './frame.js';

export function openMenu(x, y, items, { onClose } = {}) {
  atmos.contextMenu.open(x, y, items).finally(() => onClose?.());
}

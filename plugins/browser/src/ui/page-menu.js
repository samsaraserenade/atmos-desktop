/**
 * The menu for a right-click in a page (Core sends what was under the
 * pointer; Atmos draws the menu, so it sits over the page like any other).
 */
import atmos from 'atmos-sdk';
import { isPageUrl } from '../address.js';

const short = (text, length = 32) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
};

/** The items for `params` (Electron's context-menu params, as Core passes them) in `tab`. */
export function pageMenuItems(params, tab, { engine, searchName = 'the web' }) {
  const id = tab.id;
  const items = [];
  const section = list => { if (list.length) { if (items.length) items.push({ type: 'separator' }); items.push(...list); } };
  const newTab = (url, isPrivate = tab.private) => engine.newTab({ url, private: isPrivate, after: id, opener: id, select: false });
  const flags = params.editFlags || {};

  if (params.linkURL && isPageUrl(params.linkURL)) {
    section([
      { id: 'link-new-tab', label: tab.private ? 'Open link in new private tab' : 'Open link in new tab', run: () => newTab(params.linkURL) },
      ...(tab.private ? [] : [{ id: 'link-private', label: 'Open link in private tab', run: () => newTab(params.linkURL, true) }]),
      { id: 'link-copy', label: 'Copy link address', run: () => atmos.clipboard.writeText(params.linkURL) },
      { id: 'link-save', label: 'Save link as…', run: () => engine.download(id, params.linkURL) },
    ]);
  } else if (params.linkURL) {
    section([{ id: 'link-copy', label: 'Copy link address', run: () => atmos.clipboard.writeText(params.linkURL) }]);
  }

  const media = params.mediaType;
  if (media === 'image' && params.srcURL) {
    section([
      ...(isPageUrl(params.srcURL) ? [{ id: 'image-new-tab', label: 'Open image in new tab', run: () => newTab(params.srcURL) }] : []),
      { id: 'image-save', label: 'Save image as…', run: () => engine.download(id, params.srcURL) },
      ...(params.hasImageContents !== false ? [{ id: 'image-copy', label: 'Copy image', run: () => engine.copyImage(id, params.x, params.y) }] : []),
      ...(isPageUrl(params.srcURL) ? [{ id: 'image-copy-address', label: 'Copy image address', run: () => atmos.clipboard.writeText(params.srcURL) }] : []),
    ]);
  } else if ((media === 'video' || media === 'audio') && params.srcURL && isPageUrl(params.srcURL)) {
    const what = media === 'video' ? 'video' : 'audio';
    section([
      { id: 'media-new-tab', label: `Open ${what} in new tab`, run: () => newTab(params.srcURL) },
      { id: 'media-save', label: `Save ${what} as…`, run: () => engine.download(id, params.srcURL) },
      { id: 'media-copy-address', label: `Copy ${what} address`, run: () => atmos.clipboard.writeText(params.srcURL) },
    ]);
  }

  if (params.isEditable) {
    section([
      ...(flags.canUndo ? [{ id: 'undo', label: 'Undo', run: () => engine.edit(id, 'undo') }] : []),
      ...(flags.canRedo ? [{ id: 'redo', label: 'Redo', run: () => engine.edit(id, 'redo') }] : []),
      ...(flags.canCut ? [{ id: 'cut', label: 'Cut', run: () => engine.edit(id, 'cut') }] : []),
      ...(flags.canCopy ? [{ id: 'copy', label: 'Copy', run: () => engine.edit(id, 'copy') }] : []),
      ...(flags.canPaste ? [{ id: 'paste', label: 'Paste', run: () => engine.edit(id, 'paste') }] : []),
      ...(flags.canSelectAll ? [{ id: 'select-all', label: 'Select all', run: () => engine.edit(id, 'selectAll') }] : []),
    ]);
  } else if (params.selectionText) {
    const selection = params.selectionText;
    section([
      { id: 'copy', label: 'Copy', run: () => engine.edit(id, 'copy') },
      { id: 'search', label: `Search ${searchName} for “${short(selection)}”`, run: () => {
        const tabView = engine.newTab({ private: tab.private, after: id, opener: id });
        void engine.navigate(tabView.id, `? ${selection}`);
      } },
    ]);
  }

  if (!items.length) {
    section([
      ...(tab.canGoBack ? [{ id: 'back', label: 'Back', run: () => engine.back(id) }] : []),
      ...(tab.canGoForward ? [{ id: 'forward', label: 'Forward', run: () => engine.forward(id) }] : []),
      { id: 'reload', label: 'Reload', run: () => engine.reload(id) },
    ]);
    section([
      ...(tab.private ? [] : [{ id: 'bookmark', label: tab.bookmarked ? 'Remove bookmark' : 'Bookmark this page', run: () => engine.toggleBookmark(id) }]),
      { id: 'copy-address', label: 'Copy page address', run: () => atmos.clipboard.writeText(tab.url) },
      { id: 'print', label: 'Print…', run: () => engine.print(id) },
    ]);
  }
  return items;
}

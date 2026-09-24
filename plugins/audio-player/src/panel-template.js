// js/plugins/audio-player/src/panel-template.js
// -----------------------------------------------------------------------------
// Owns the audio player's DOM, in two groups:
//
//   1. The drawer's bar (#ap-bar) and browser (#ap-content) markup — album
//      art, transport, seek bar, volume, library browser.
//   2. Overlays (#ap-overlays): the file input and the cover-editor backdrop
//      and modal, outside the drawer's flex layout.
//
// The album/track right-click menus are Atmos menus built on demand
// (atmos.contextMenu, see player-view.js), so there is no markup for them.
//
// Idempotent: safe to call more than once (checks for a marker element
// before writing).
// -----------------------------------------------------------------------------

const PANEL_BAR_HTML = `
    <div id="mp-left">
      <div id="mp-track-meta">
        <div id="mp-track-name">No track loaded</div>
        <div id="mp-track-sub">Click to search</div>
        <div id="mp-search-row">
          <input id="mp-lib-search" type="text" placeholder="Search library…" autocomplete="off" spellcheck="false">
          <button id="mp-search-clear" title="Clear search">✕</button>
        </div>
      </div>
    </div>
    <div id="mp-spine">
      <div id="mp-controls">
        <button class="mp-ctrl-btn xs" id="mp-shuffle-btn" title="Shuffle">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>
        </button>
        <button class="mp-ctrl-btn sm" id="mp-prev-btn" title="Previous">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
        </button>
        <button class="mp-ctrl-btn lg" id="mp-pp-main">
          <svg id="mp-pp-icon-play" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <svg id="mp-pp-icon-pause" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <button class="mp-ctrl-btn sm" id="mp-next-btn" title="Next">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 4V8z"/><rect x="16" y="6" width="2" height="12"/></svg>
        </button>
        <button class="mp-ctrl-btn xs" id="mp-repeat-btn" title="Repeat">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
        </button>
      </div>
      <div id="mp-seek-row">
        <span id="mp-cur-fs">0:00</span>
        <div id="mp-seek-track">
          <div id="mp-seek-fill"></div>
          <div id="mp-seek-thumb"></div>
          <canvas id="mp-viz-canvas"></canvas>
          <input type="range" id="mp-seek-input" min="0" max="100" value="0" step="0.1">
        </div>
        <span id="mp-dur-fs">0:00</span>
      </div>
      <div id="mp-right">
        <span class="mp-vol-icon" id="mp-mute-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
        </span>
        <div id="mp-vol-track">
          <div id="mp-vol-fill"></div>
          <input type="range" id="mp-vol-input" min="0" max="100" value="100">
        </div>
        <span id="mp-vol-pct">100%</span>
        <button id="mp-bar-back" style="display:none">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          Albums
        </button>
      </div>
    </div>
`;

const PANEL_CONTENT_HTML = `
    <div id="mp-browser">
      <div id="mp-browser-header">
        <button id="mp-browser-back" style="display:none">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          Albums
        </button>
        <span id="mp-browser-title">Library</span>
        <div id="mp-browser-tabs">
          <button class="mp-btab active" id="mp-btab-lib">Library</button>
        </div>
        <span id="mp-browser-count"></span>
      </div>
      <div id="mp-album-grid"></div>
      <div id="mp-track-list"></div>
    </div>
`;

const PANEL_EXTRAS_HTML = `
<input type="file" id="music-upload" accept="audio/*" multiple>

<!-- Cover Art Editor backdrop -->
<div id="cover-editor-backdrop"></div>

<!-- Cover Art Editor modal -->
<div id="cover-editor-modal">
  <div class="cover-editor-header">
    <span class="cover-editor-header-label">Edit Cover Art</span>
    <button id="cover-editor-close" title="Close">✕</button>
  </div>
  <div id="cover-editor-drop-zone">
    <img id="cover-editor-preview" alt="" style="display:none">
    <div id="cover-editor-placeholder">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--ink-rgb, 255,255,255),0.9)" stroke-width="1.4">
        <rect x="3" y="3" width="18" height="18" rx="2.5"/>
        <circle cx="8.5" cy="8.5" r="1.5" fill="rgba(var(--ink-rgb, 255,255,255),0.9)" stroke="none"/>
        <path d="M3 16l5-5 4 4 3-3 6 6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="cover-editor-ph-label">Drop image or click to browse</span>
      <span class="cover-editor-ph-sub">JPEG · PNG · WEBP</span>
    </div>
  </div>
  <input type="file" id="cover-editor-file-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
  <div class="cover-editor-info">
    <span id="cover-editor-title"></span>
    <span id="cover-editor-artist"></span>
  </div>
  <div id="cover-editor-status"></div>
  <div class="cover-editor-footer">
    <button class="cover-editor-btn" id="cover-editor-cancel">Cancel</button>
    <button class="cover-editor-btn primary" id="cover-editor-save" disabled>Save</button>
  </div>
</div>
`;

export function injectPanelMarkup(bar, content, extras) {
  if (bar.querySelector('#mp-left')) return;
  if (!bar || !content || !extras) throw new Error('[audio-player] panel mount points are required');
  bar.innerHTML = PANEL_BAR_HTML;
  content.innerHTML = PANEL_CONTENT_HTML;
  extras.insertAdjacentHTML('beforeend', PANEL_EXTRAS_HTML);
}

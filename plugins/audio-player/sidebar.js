/**
 * Audio Player's "Now Playing" widget: cover, title, artist, length and a
 * progress line, following the engine wherever the panel is. Click the cover
 * to play/pause; drag up/down for volume, left for restart/previous, right
 * for next.
 */
import * as player from './src/client.js';

const { togglePlay, setVolume, playPrev, playNext, getAlbums } = player;

{
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./assets/sidebar.css', import.meta.url).href;
  document.head.appendChild(link);
}

/** What the widget shows, from the engine and the Audio service. */
function getEngineSnapshot() {
  const track = player.currentTrack();
  return {
    playing: player.playback.playing,
    trackName: track?.name ?? null,
    trackKey: track?.key ?? null,
    trackCount: player.engine.playlist.length,
    currentTime: player.currentTime(),
    duration: player.playback.duration,
    volume: player.engine.vol,
  };
}

const $ = id => document.getElementById(id);

const PLACEHOLDER_COVER_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmtTime = s => {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const PLAY_ICON  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';

// ── Track metadata (artist + cover) ────────────────────────────────────────────
// Only library-sourced tracks (scanned via library.js) carry a `key` at all —
// ad-hoc uploads never do, so they fall through to the placeholder/no-artist
// state below, correctly (there's no metadata to find, not a bug).
//
// getAlbums() is itself cached in library.js and cheap, but render() runs on
// every onEngineUpdate() tick (many times/sec during playback) — gate the
// actual .find() scan on the track key changing, not on every tick, so a
// large library isn't re-scanned dozens of times a second for no reason.

let _lastPaintedTrackKey; // undefined = never painted yet, distinct from null ("no key")

function _paintTrackMeta(trackKey) {
  if (trackKey === _lastPaintedTrackKey) return;
  _lastPaintedTrackKey = trackKey;

  const coverEl  = $('ap-mini-cover-img');
  const artistEl = $('ap-mini-artist');
  if (!coverEl || !artistEl) return;

  const alb = trackKey ? getAlbums().find(a => a.tracks.some(t => t.key === trackKey)) : null;

  artistEl.textContent = alb?.artist || '';
  artistEl.classList.toggle('ap-mini-artist-hidden', !alb?.artist);
  coverEl.innerHTML    = alb?.cover ? `<img src="${alb.cover}" alt="">` : PLACEHOLDER_COVER_ICON;
}

// ── Title marquee ─────────────────────────────────────────────────────────────
// Only slides when the title actually overflows its box — measured directly
// (scrollWidth vs clientWidth) rather than guessed from character count, since
// that has to hold for any font/zoom. Gated on the text actually changing so
// a many-times-a-second render() tick isn't re-measuring layout every time.

let _lastMarqueeText;
let _lastName;
let _lastPlaying;
let _lastHasTracks;
let _lastDurationText;
let _lastProgress = -1;

function _updateMarquee() {
  const wrap = $('ap-mini-track-wrap');
  const span = $('ap-mini-track');
  if (!wrap || !span) return;
  if (span.textContent === _lastMarqueeText) return;
  _lastMarqueeText = span.textContent;

  const overflow = span.scrollWidth - wrap.clientWidth;
  if (overflow > 2) {
    wrap.style.setProperty('--ap-marquee-dist', overflow + 'px');
    wrap.classList.add('is-sliding');
  } else {
    wrap.classList.remove('is-sliding');
    wrap.style.removeProperty('--ap-marquee-dist');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const nameEl = $('ap-mini-track');
  const ppIcon = $('ap-mini-pp-icon');
  const durEl  = $('ap-mini-dur');
  const fillEl = $('ap-mini-seek-fill');
  if (!nameEl || !ppIcon || !durEl || !fillEl) return; // section not mounted

  const snap = getEngineSnapshot();

  const name = snap.trackName || 'No track loaded';
  if (name !== _lastName) {
    _lastName = name;
    nameEl.textContent = name;
    nameEl.classList.toggle('ap-mini-empty', !snap.trackName);
    _updateMarquee();
  }

  _paintTrackMeta(snap.trackKey);

  if (snap.playing !== _lastPlaying) {
    _lastPlaying = snap.playing;
    ppIcon.innerHTML = snap.playing ? PAUSE_ICON : PLAY_ICON;
  }
  const hasTracks = !!snap.trackCount;
  if (hasTracks !== _lastHasTracks) {
    _lastHasTracks = hasTracks;
    $('ap-mini-cover')?.classList.toggle('ap-mini-btn-disabled', !hasTracks);
  }

  const durationText = fmtTime(snap.duration);
  if (durationText !== _lastDurationText) {
    _lastDurationText = durationText;
    durEl.textContent = durationText;
  }

  // Quarter-percent quantization prevents imperceptible sub-pixel compositor
  // updates on every engine notification. transform avoids relayout entirely.
  const pct = snap.duration ? Math.min(100, Math.max(0, (snap.currentTime / snap.duration) * 100)) : 0;
  const progress = Math.round(pct * 4) / 400;
  if (progress !== _lastProgress) {
    _lastProgress = progress;
    fillEl.style.transform = `scaleX(${progress})`;
  }
}

// ── Registration ──────────────────────────────────────────────────────────────


const GESTURE_AXIS_THRESHOLD = 8;
const GESTURE_TRACK_THRESHOLD = 48;

function _bindCoverGestures(cover, context) {
  let drag = null;
  let suppressClick = false;
  let feedbackTimer = null;

  const feedback = $('ap-mini-gesture-feedback');

  const showFeedback = (text, committed = false) => {
    if (!feedback) return;
    clearTimeout(feedbackTimer);
    feedback.textContent = text;
    feedback.classList.add('is-visible');
    feedback.classList.toggle('is-committed', committed);
    if (committed) feedbackTimer = setTimeout(() => {
      feedback.classList.remove('is-visible', 'is-committed');
    }, 650);
  };

  const hideFeedback = () => {
    clearTimeout(feedbackTimer);
    feedback?.classList.remove('is-visible', 'is-committed');
  };

  context.listen(cover, 'pointerdown', event => {
    if (event.button !== 0 || !getEngineSnapshot().trackCount) return;
    const snap = getEngineSnapshot();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startVolume: Number.isFinite(snap.volume) ? snap.volume : 100,
      axis: null,
    };
    cover.setPointerCapture(event.pointerId);
  });

  context.listen(cover, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.axis && Math.hypot(dx, dy) >= GESTURE_AXIS_THRESHOLD) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      cover.classList.add('is-gesture-dragging');
      suppressClick = true;
    }

    if (drag.axis === 'vertical') {
      event.preventDefault();
      const range = Math.max(80, cover.clientHeight * 0.75);
      const volume = Math.min(100, Math.max(0, drag.startVolume - (dy / range) * 100));
      setVolume(volume);
      showFeedback(`Volume ${Math.round(volume)}%`);
    } else if (drag.axis === 'horizontal') {
      event.preventDefault();
      if (Math.abs(dx) < GESTURE_TRACK_THRESHOLD) {
        showFeedback(dx < 0 ? 'Swipe left for previous' : 'Swipe right for next');
      } else if (dx < 0) {
        showFeedback(getEngineSnapshot().currentTime > 3 ? 'Restart track' : 'Previous track');
      } else {
        showFeedback('Next track');
      }
    }
  });

  const finishGesture = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    cover.classList.remove('is-gesture-dragging');

    if (current.axis === 'horizontal') {
      const dx = event.clientX - current.startX;
      if (Math.abs(dx) >= GESTURE_TRACK_THRESHOLD) {
        if (dx < 0) {
          const restarting = getEngineSnapshot().currentTime > 3;
          playPrev();
          showFeedback(restarting ? 'Restarted' : 'Previous track', true);
        } else {
          playNext();
          showFeedback('Next track', true);
        }
      } else {
        hideFeedback();
      }
    } else if (current.axis === 'vertical') {
      showFeedback(`Volume ${Math.round(getEngineSnapshot().volume)}%`, true);
    }

    if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
  };

  context.listen(cover, 'pointerup', finishGesture);
  context.listen(cover, 'pointercancel', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    cover.classList.remove('is-gesture-dragging');
    hideFeedback();
    setTimeout(() => { suppressClick = false; }, 0);
  });
  context.listen(cover, 'click', event => {
    event.stopPropagation();
    if (suppressClick) return;
    togglePlay();
  });

  context.onCleanup(() => {
    clearTimeout(feedbackTimer);
    drag = null;
  });
}

// A frame lives as long as its widget, so listeners need no cleanup.
const context = {
  listen: (target, type, handler, options) => target.addEventListener(type, handler, options),
  onCleanup: () => {},
};

await player.connect();
document.body.innerHTML = `
  <div class="ap-mini-widget">
    <div id="ap-mini-cover" class="ap-mini-cover" title="Click: play/pause · Drag up/down: volume · Drag left: restart/previous · Drag right: next">
      <span id="ap-mini-cover-img" class="ap-mini-cover-img">${PLACEHOLDER_COVER_ICON}</span>

      <span class="ap-mini-pp-overlay">
        <span class="ap-mini-pp-icon-circle"><span id="ap-mini-pp-icon" class="ap-mini-pp-icon"></span></span>
      </span>

      <span id="ap-mini-gesture-feedback" class="ap-mini-gesture-feedback" aria-live="polite"></span>

      <span class="ap-mini-cover-info">
        <span id="ap-mini-track-wrap" class="ap-mini-track-wrap"><span id="ap-mini-track" class="ap-mini-track"></span></span>
        <span class="ap-mini-meta-row">
          <span id="ap-mini-artist" class="ap-mini-artist"></span>
          <span id="ap-mini-dur" class="ap-mini-dur">0:00</span>
        </span>
      </span>

      <div id="ap-mini-seek-track" class="ap-mini-seek-track">
        <div id="ap-mini-seek-fill" class="ap-mini-seek-fill"></div>
      </div>
    </div>
  </div>`;

_bindCoverGestures($('ap-mini-cover'), context);

// The same title can go from fitting to overflowing when the sidebar is resized.
new ResizeObserver(() => { _lastMarqueeText = undefined; _updateMarquee(); }).observe($('ap-mini-cover'));

player.on('engine', render);
player.on('playback', render);
player.on('library', () => { _lastPaintedTrackKey = undefined; render(); });
// Progress moves between the service's time updates while playing.
setInterval(() => { if (player.playback.playing && !document.hidden) render(); }, 1000);
render();

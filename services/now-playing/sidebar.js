/**
 * The Now Playing widget: what's playing in Atmos, from Music, a tab in
 * Atmos Browser or any extension that plays something (atmos.nowPlaying). Cover, title, artist,
 * length and a progress line; with two or more sessions, small dots along
 * the top to switch between them (none with one).
 *
 * Click the cover to play/pause; drag up/down for volume, left for
 * restart/previous, right for next: each only when the session takes it.
 * Which session shows: src/choose.js (the one you started last), except
 * that it doesn't change under the pointer: a click or drag acts on what
 * you saw when you pressed.
 */
import atmos from 'atmos-sdk';
import { chooseSession, pickExpired, positionNow, formatTime, subtitle, sourceLabel } from './src/choose.js';

{
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./assets/sidebar.css', import.meta.url).href;
  document.head.appendChild(link);
}

const PLACEHOLDER_COVER_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const PLAY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';

document.body.innerHTML = `
  <div class="np-widget">
    <div id="np-cover" class="np-cover">
      <span id="np-cover-img" class="np-cover-img">${PLACEHOLDER_COVER_ICON}</span>
      <span class="np-pp-overlay"><span class="np-pp-icon-circle"><span id="np-pp-icon" class="np-pp-icon"></span></span></span>
      <span id="np-gesture-feedback" class="np-gesture-feedback" aria-live="polite"></span>
      <div id="np-dots" class="np-dots" role="tablist" aria-label="What's playing" hidden></div>
      <span class="np-cover-info">
        <span id="np-track-wrap" class="np-track-wrap"><span id="np-track" class="np-track"></span></span>
        <span class="np-meta-row">
          <span class="np-who"><span id="np-artist" class="np-artist"></span><span id="np-community" class="np-community" hidden>· community</span></span>
          <span id="np-dur" class="np-dur"></span>
        </span>
      </span>
      <div class="np-seek-track"><div id="np-seek-fill" class="np-seek-fill"></div></div>
    </div>
  </div>`;

const $ = id => document.getElementById(id);
const cover = $('np-cover');
const dotsEl = $('np-dots');

let sessions = [];
let pick = null;      // { id, at }: one chosen with the dots
let shown = null;     // the session showing

// What shows doesn't change under the pointer: while it moves over the
// widget, and for HOLD_MS after (leaving the frame, Chromium may send
// nothing at all, so the hold lapses by itself). And a press just after it
// changed by itself is ignored: it was meant for what showed before.
const HOLD_MS = 1500;
const SETTLE_MS = 500;
let pointerAt = -Infinity; // last pointer movement over the widget
let changedAt = -Infinity; // when what shows last changed by itself
let holdTimer = null;

const can = (action, session = shown) => !!session?.actions?.includes(action);
/** Ask `session`'s extension (the one showing when the gesture began). */
const control = (action, value, session = shown) => {
  if (!session || session.id !== shown?.id || !can(action, session)) return;
  atmos.nowPlaying.control(session.id, action, value).catch(error => console.warn('[now-playing]', error.message));
};

// ── Artwork ─────────────────────────────────────────────────────────────────
// A Blob Atmos made from the image's bytes (PNG, JPEG, WebP or GIF, never
// SVG), arriving as a new copy with every update: its object URL is kept
// while the image's key (from its bytes) stays the same.
let artKey;
let artUrl = null;
function paintArtwork(session) {
  const art = session?.artwork instanceof Blob ? session.artwork : null;
  const key = art ? session.artworkKey || `${art.type}|${art.size}` : null;
  if (key === artKey) return;
  artKey = key;
  if (artUrl) { URL.revokeObjectURL(artUrl); artUrl = null; }
  const holder = $('np-cover-img');
  holder.classList.remove('np-cover-icon');
  if (!art) { holder.innerHTML = PLACEHOLDER_COVER_ICON; return; }
  const src = artUrl = URL.createObjectURL(art);
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  // An image that won't decode shows the placeholder rather than a broken one.
  img.addEventListener('error', () => { if (artKey === key) holder.innerHTML = PLACEHOLDER_COVER_ICON; }, { once: true });
  // A site's icon (a tab with no artwork of its own): small, in the middle, not stretched.
  img.addEventListener('load', () => { if (artKey === key) holder.classList.toggle('np-cover-icon', img.naturalWidth <= 64); }, { once: true });
  img.src = src;
  holder.replaceChildren(img);
}

// ── Title marquee ───────────────────────────────────────────────────────────
// Slides only when the title overflows its box, measured, not guessed.
let marqueeText;
function updateMarquee() {
  const wrap = $('np-track-wrap');
  const span = $('np-track');
  if (span.textContent === marqueeText) return;
  marqueeText = span.textContent;
  const overflow = span.scrollWidth - wrap.clientWidth;
  wrap.classList.toggle('is-sliding', overflow > 2);
  if (overflow > 2) wrap.style.setProperty('--np-marquee-dist', `${overflow}px`);
  else wrap.style.removeProperty('--np-marquee-dist');
}

// ── Dots: one per session, only with two or more ──────────────────────────
let dotsKey;
function paintDots() {
  const key = sessions.length < 2 ? '' : `${sessions.map(session => `${session.id}\t${session.title}\t${dotLabel(session)}`).join('\n')}#${shown?.id}`;
  if (key === dotsKey) return;
  dotsKey = key;
  dotsEl.hidden = sessions.length < 2;
  if (dotsEl.hidden) { dotsEl.replaceChildren(); return; }
  dotsEl.replaceChildren(...sessions.map(session => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'np-dot';
    dot.dataset.id = session.id;
    const active = session.id === shown?.id;
    dot.classList.toggle('is-active', active);
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-selected', String(active));
    dot.title = [session.title, dotLabel(session)].filter(Boolean).join(' · ');
    dot.setAttribute('aria-label', dot.title);
    return dot;
  }));
}
/** Where a dot's session plays and who plays it. */
function dotLabel(session) {
  return [session.from, sourceLabel(session)].filter(Boolean).join(' · ');
}
// The background frame (boot.js: Space, rev/play) acts on what shows here.
const sharePick = () => atmos.events.emit('pick', pick).catch(() => {});
dotsEl.addEventListener('click', event => {
  event.stopPropagation();
  const dot = event.target.closest('.np-dot');
  if (!dot) return;
  pick = { id: dot.dataset.id, at: Date.now() };
  sharePick();
  render({ picked: true });
});
dotsEl.addEventListener('pointerdown', event => event.stopPropagation());
dotsEl.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const index = sessions.findIndex(session => session.id === shown?.id);
  const next = sessions[(index + (event.key === 'ArrowRight' ? 1 : sessions.length - 1)) % sessions.length];
  if (!next) return;
  pick = { id: next.id, at: Date.now() };
  sharePick();
  render({ picked: true });
  dotsEl.querySelector(`.np-dot[data-id="${CSS.escape(next.id)}"]`)?.focus();
});

// ── Rendering ───────────────────────────────────────────────────────────────
let last = {};
function paint(field, value, apply) {
  if (last[field] === value) return;
  last[field] = value;
  apply(value);
}

function render({ picked = false } = {}) {
  if (pickExpired(sessions, pick)) pick = null;
  // Under the pointer (or mid-gesture), what shows stays while it's there:
  // nothing slips in between seeing it and clicking it.
  const holding = drag || performance.now() - pointerAt < HOLD_MS;
  const held = !picked && holding && shown ? sessions.find(session => session.id === shown.id) : null;
  const before = shown?.id;
  shown = held || chooseSession(sessions, pick);
  if (!picked && shown?.id !== before) changedAt = performance.now();
  paintDots();
  paintArtwork(shown);
  paint('title', shown?.title || 'Nothing playing', value => {
    $('np-track').textContent = value;
    $('np-track').classList.toggle('np-empty', !shown);
    updateMarquee();
  });
  paint('subtitle', subtitle(shown), value => {
    $('np-artist').textContent = value;
    $('np-artist').classList.toggle('np-artist-hidden', !value);
  });
  // A community extension's session, marked where a long artist can't push it out.
  paint('community', shown?.source?.community === true, value => { $('np-community').hidden = !value; });
  paint('playing', !!shown?.playing, value => { $('np-pp-icon').innerHTML = value ? PAUSE_ICON : PLAY_ICON; });
  paint('toggle', can('toggle'), value => cover.classList.toggle('np-cover-inert', !value));
  paint('hint', hint(), value => { cover.title = value; });
  paint('duration', Number.isFinite(shown?.duration) && shown.duration > 0 ? formatTime(shown.duration) : '', value => { $('np-dur').textContent = value; });
  const progress = shown && shown.duration > 0 ? Math.round(Math.min(1, positionNow(shown) / shown.duration) * 400) / 400 : 0;
  paint('progress', progress, value => { $('np-seek-fill').style.transform = `scaleX(${value})`; });
}

/** What the cover does, in its tooltip: only what the session takes. */
function hint() {
  if (!shown) return '';
  const parts = [];
  if (can('toggle')) parts.push('Click: play/pause');
  if (can('volume')) parts.push('Drag up/down: volume');
  if (can('previous')) parts.push('Drag left: restart/previous');
  if (can('next')) parts.push('Drag right: next');
  return parts.join(' · ');
}

// ── Gestures on the cover ───────────────────────────────────────────────────
const AXIS_THRESHOLD = 8;
const TRACK_THRESHOLD = 48;
const feedback = $('np-gesture-feedback');
let feedbackTimer = null;
let drag = null;
let suppressClick = false;

function showFeedback(text, committed = false) {
  clearTimeout(feedbackTimer);
  feedback.textContent = text;
  feedback.classList.add('is-visible');
  feedback.classList.toggle('is-committed', committed);
  if (committed) feedbackTimer = setTimeout(() => feedback.classList.remove('is-visible', 'is-committed'), 650);
}
function hideFeedback() {
  clearTimeout(feedbackTimer);
  feedback.classList.remove('is-visible', 'is-committed');
}

function pointerHere() {
  pointerAt = performance.now();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { if (!drag) render(); }, HOLD_MS + 20);
}
cover.addEventListener('pointerover', pointerHere);
cover.addEventListener('pointermove', pointerHere);
cover.addEventListener('pointerout', event => {
  if (cover.contains(event.relatedTarget)) return;
  pointerAt = -Infinity;
  if (!drag) render();
});

let pressed = null; // the session showing when the button went down: a click is for it
cover.addEventListener('pointerdown', event => {
  pressed = null;
  if (event.button !== 0 || !shown || performance.now() - changedAt < SETTLE_MS) return;
  pointerHere();
  pressed = shown;
  drag = { pointerId: event.pointerId, session: shown, startX: event.clientX, startY: event.clientY, startVolume: Number.isFinite(shown.volume) ? shown.volume : 100, axis: null, volume: null };
  cover.setPointerCapture(event.pointerId);
});

cover.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.axis && Math.hypot(dx, dy) >= AXIS_THRESHOLD) {
    drag.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    cover.classList.add('is-gesture-dragging');
    suppressClick = true;
  }
  if (drag.axis === 'vertical' && can('volume', drag.session)) {
    event.preventDefault();
    const range = Math.max(80, cover.clientHeight * 0.75);
    const volume = Math.round(Math.min(100, Math.max(0, drag.startVolume - (dy / range) * 100)));
    if (volume !== drag.volume) { drag.volume = volume; sendVolume(volume, drag.session); }
    showFeedback(`Volume ${volume}%`);
  } else if (drag.axis === 'horizontal' && (can('next', drag.session) || can('previous', drag.session))) {
    event.preventDefault();
    if (Math.abs(dx) < TRACK_THRESHOLD) showFeedback(dx < 0 ? (can('previous') ? 'Swipe left for previous' : '') : (can('next') ? 'Swipe right for next' : ''));
    else if (dx < 0) showFeedback(can('previous') ? (positionNow(shown) > 3 ? 'Restart' : 'Previous') : '');
    else showFeedback(can('next') ? 'Next' : '');
    if (!feedback.textContent) hideFeedback();
  }
});

// A drag's volume, ten times a second at most, and always where it ended.
const VOLUME_EVERY_MS = 100;
let volumeSentAt = -Infinity;
let volumeNext = null;
let volumeTimer = null;
function sendVolume(value, session) {
  volumeNext = { value, session };
  const wait = volumeSentAt + VOLUME_EVERY_MS - performance.now();
  if (wait <= 0) flushVolume();
  else if (!volumeTimer) volumeTimer = setTimeout(flushVolume, wait);
}
function flushVolume() {
  clearTimeout(volumeTimer);
  volumeTimer = null;
  if (!volumeNext) return;
  const { value, session } = volumeNext;
  volumeNext = null;
  volumeSentAt = performance.now();
  control('volume', value, session);
}

function finishGesture(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const current = drag;
  flushVolume();
  drag = null;
  cover.classList.remove('is-gesture-dragging');
  if (current.axis === 'horizontal') {
    const dx = event.clientX - current.startX;
    if (Math.abs(dx) >= TRACK_THRESHOLD && dx < 0 && can('previous', current.session)) {
      const restarting = positionNow(current.session) > 3;
      control('previous', null, current.session);
      showFeedback(restarting ? 'Restarted' : 'Previous', true);
    } else if (Math.abs(dx) >= TRACK_THRESHOLD && dx > 0 && can('next', current.session)) {
      control('next', null, current.session);
      showFeedback('Next', true);
    } else hideFeedback();
  } else if (current.axis === 'vertical' && current.volume !== null) {
    showFeedback(`Volume ${current.volume}%`, true);
  } else hideFeedback();
  if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
}
cover.addEventListener('pointerup', finishGesture);
cover.addEventListener('pointercancel', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  flushVolume();
  drag = null;
  cover.classList.remove('is-gesture-dragging');
  hideFeedback();
  setTimeout(() => { suppressClick = false; }, 0);
});
cover.addEventListener('click', event => {
  event.stopPropagation();
  const session = pressed;
  pressed = null;
  if (suppressClick || !session) return;
  control('toggle', null, session);
});

// The same title can go from fitting to overflowing when the sidebar is resized.
new ResizeObserver(() => { marqueeText = undefined; updateMarquee(); }).observe(cover);

atmos.nowPlaying.sessions(list => {
  sessions = Array.isArray(list) ? list : [];
  render();
});
// The progress line moves on while playing.
setInterval(() => { if (shown?.playing && !document.hidden) render(); }, 1000);
render();

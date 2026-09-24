/**
 * Audio Player's panel: the player bar and the library browser, drawn in
 * the panel's frame. On the full workspace the frame lives in a drawer that
 * Atmos slides up from the bottom (atmos.drawer); in a tile or floating
 * window the drawer is pinned open.
 *
 * Everything here is display and input. Playback, the playlist and the
 * library belong to the engine (src/engine.js, the boot frame); this view
 * follows it through client.js and sends every action there.
 *
 * Ported from the in-page media.js: the seek bar and waveform, volume,
 * transport, album grid, track lists, library search, album and track
 * menus and the cover editor keep their behaviour.
 */
import atmos from 'atmos-sdk';
import { audioState, save, onStateChange } from './state.js';
import * as player from './client.js';
import { openCoverEditor, initCoverEditor } from './cover-editor.js';
import { applyCoverSize, applyCoverSaturation, applyDimAmount, applyDisplayPreferences } from './panel-settings.js';
import { injectPanelMarkup } from './panel-template.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

// ── Drawer ──────────────────────────────────────────────────────────────────
// Atmos moves the drawer; this view only hears whether it is open (the bar
// shows) and expanded (the browser shows). Pinned open in tiles and windows.

let mediaOpen = false;
let browserOpen = false;
let firstDrawerState = true;

function drawerState() {
  return atmos.drawer.state || { open: true, expanded: true, locked: true, barPlacement: 'top' };
}

function applyDrawerState() {
  const state = drawerState();
  const drawer = document.querySelector('.ap-drawer');
  drawer?.classList.toggle('locked', !!state.locked);
  if (drawer) drawer.dataset.barPlacement = state.barPlacement === 'bottom' ? 'bottom' : 'top';
  const open = !!(state.locked || state.open);
  const expanded = !!(state.locked || state.expanded);
  const first = firstDrawerState;
  firstDrawerState = false;

  if (open !== mediaOpen || first) {
    mediaOpen = open;
    if (open) startVizLoop(true);
    else { browserOpen = false; stopVizLoop(); }
  }
  if (expanded !== browserOpen || first) {
    browserOpen = expanded;
    if (expanded) requestAnimationFrame(renderBrowser);
  }
}

function openBrowser() {
  browserOpen = true;
  atmos.drawer.expand().catch(() => {});
  renderBrowser();
}

// ── Seek style and colours ──────────────────────────────────────────────────

function applySeekStyle(value) {
  audioState.seekStyle = value;
  if (value !== 'waveform' && audioState.fullBarWaveform) {
    audioState.fullBarWaveform = false;
    applyFullBarWaveform();
  }
  document.body.classList.toggle('seek-viz', value !== 'classic');
  applySeekFill();
  if (value === 'classic') stopVizLoop();
  else startVizLoop(true);
  updateProgress();
  save('seekStyle', 'fullBarWaveform');
}

function applyFullBarWaveform() {
  document.body.classList.toggle('mp-full-waveform', !!audioState.fullBarWaveform);
}

const SEEK_COLOR_MODES = ['gradient', 'solid', 'auto'];
const SEEK_COLOR_LABELS = { gradient: 'Gradient', solid: 'Solid', auto: 'Auto' };
const DEFAULT_STOPS = ['#c084fc', '#818cf8', '#38bdf8'];

function toHex6(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const short = String(color).match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return '#c084fc';
}

function openSeekMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const docked = drawerState().barPlacement === 'bottom';
  atmos.contextMenu.open(event.clientX, event.clientY, [
    { type: 'heading', label: 'Waveform Appearance' },
    { id: 'wave-dock', type: 'toggle', label: 'Dock Player', checked: docked, run: checked => {
      atmos.drawer.setBarPlacement(checked ? 'bottom' : 'top').catch(() => {});
    } },
    { id: 'wave-enabled', type: 'toggle', label: 'Waveform', checked: audioState.seekStyle === 'waveform', run: checked => applySeekStyle(checked ? 'waveform' : 'classic') },
    { id: 'wave-full', type: 'toggle', label: 'Full Bar', checked: !!audioState.fullBarWaveform, run: checked => {
      audioState.fullBarWaveform = checked;
      if (checked && audioState.seekStyle !== 'waveform') applySeekStyle('waveform');
      applyFullBarWaveform();
      save('fullBarWaveform');
    } },
    { id: 'wave-fps', type: 'number', label: 'Refresh Rate', min: 1, max: 1000, step: 1, value: Math.max(1, Math.min(1000, Math.round(audioState.waveformFps || 5))), suffix: 'fps', run: value => {
      audioState.waveformFps = Math.max(1, Math.min(1000, Math.round(value)));
      vizNextPaintAt = 0;
      startVizLoop(true);
      save('waveformFps');
    } },
    { id: 'wave-mode', type: 'select', label: 'Colour Mode', value: audioState.seekColor.mode, closeOnChange: false,
      options: SEEK_COLOR_MODES.map(value => ({ value, label: SEEK_COLOR_LABELS[value] })), run: value => {
        audioState.seekColor.mode = value;
        invalidateGradCache();
        applySeekFill();
        save('seekColor');
        if (value === 'auto') void resampleWallpaperColors();
      } },
    { id: 'wave-gradient', type: 'colors', label: 'Gradient', values: audioState.seekColor.stops.map(toHex6), run: values => {
      audioState.seekColor.stops = values;
      invalidateGradCache();
      applySeekFill();
      save('seekColor');
    } },
    { id: 'wave-solid', type: 'colors', label: 'Solid Colour', values: [toHex6(audioState.seekColor.solid)], run: values => {
      audioState.seekColor.solid = values[0];
      invalidateGradCache();
      applySeekFill();
      save('seekColor');
    } },
  ]).catch(error => console.error('[audio-player] seek menu:', error));
}

/** Three colours from the lower part of the wallpaper, for the "Auto" colour mode. */
async function resampleWallpaperColors(summary = null) {
  let url = summary?.thumbnail;
  if (!summary) {
    try { url = (await atmos.wallpaper.get())?.thumbnail; } catch { url = null; }
  }
  if (!url) return;
  const stops = await new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const W = 300;
        const H = 20;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        // The lower part of the image, roughly where the bar sits.
        context.drawImage(image, 0, image.height * 0.55, image.width, image.height * 0.45, 0, 0, W, H);
        resolve([40, 150, 260].map(x => {
          const data = context.getImageData(x, 10, 1, 1).data;
          return `#${[data[0], data[1], data[2]].map(value => Math.min(255, value).toString(16).padStart(2, '0')).join('')}`;
        }));
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
  if (!stops) return;
  audioState.seekColor.autoStops = stops;
  invalidateGradCache();
  if (audioState.seekColor.mode === 'auto') applySeekFill();
}

function applySeekFill() {
  const { mode, stops, solid, autoStops } = audioState.seekColor;
  let fill;
  if (mode === 'auto') fill = `linear-gradient(90deg, ${(autoStops?.length >= 2 ? autoStops : DEFAULT_STOPS).join(', ')})`;
  else if (mode === 'gradient' && Array.isArray(stops) && stops.length >= 2) fill = `linear-gradient(90deg, ${stops.join(', ')})`;
  else fill = solid || '#ffffff';
  document.documentElement.style.setProperty('--seek-fill', fill);
}

// ── Waveform canvas ─────────────────────────────────────────────────────────

let vizCanvas = null;
let vizContext = null;
let vizW = 0;
let vizH = 0;
let gradCache = null;
let gradCacheKey = '';
let idlePath = null;
let idlePathW = 0;
let idlePathH = 0;
let waveformInk = '255,255,255';

function seekPaint(context, W) {
  const { mode, stops, solid, autoStops } = audioState.seekColor;
  if (mode === 'solid') return solid || '#ffffff';
  const colours = mode === 'auto'
    ? (autoStops?.length >= 2 ? autoStops : DEFAULT_STOPS)
    : (Array.isArray(stops) && stops.length >= 2 ? stops : DEFAULT_STOPS);
  const key = `${colours.join(',')}|${W}`;
  if (gradCache && gradCacheKey === key) return gradCache;
  const gradient = context.createLinearGradient(0, 0, W, 0);
  colours.forEach((colour, index) => gradient.addColorStop(index / (colours.length - 1), colour));
  gradCache = gradient;
  gradCacheKey = key;
  return gradient;
}

function roundRect(context, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  if (context.roundRect) context.roundRect(x, y, w, h, radius);
  else context.rect(x, y, w, h);
}

function syncWaveformAppearance() {
  waveformInk = getComputedStyle(document.documentElement).getPropertyValue('--ink-rgb').trim() || '255,255,255';
  drawViz();
}

function drawWaveform(context, W, H) {
  context.clearRect(0, 0, W, H);
  const duration = player.playback.duration;
  const pct = duration ? player.currentTime() / duration : 0;
  const playedX = pct * W;
  const mid = H / 2;
  const paint = seekPaint(context, W);
  const data = player.waveform.data;

  if (!data) {
    // Idle: a faint sine wave, recomputed only when the size changes.
    if (!idlePath || idlePathW !== W || idlePathH !== H) {
      idlePath = new Path2D();
      idlePath.moveTo(0, mid);
      for (let x = 1; x <= W; x++) idlePath.lineTo(x, mid + Math.sin(x * 0.035) * H * 0.12);
      idlePathW = W;
      idlePathH = H;
    }
    context.strokeStyle = `rgba(${waveformInk},0.06)`;
    context.lineWidth = 1;
    context.stroke(idlePath);
    return;
  }

  // Roughly one bar per 4.5px at any width, never more bars than samples.
  const rawBins = data.length;
  const bins = Math.max(40, Math.min(rawBins, Math.round(W / 4.5)));
  const pxPerBin = W / bins;
  const barW = Math.max(1, pxPerBin * 0.65);
  const halfGap = (pxPerBin - barW) / 2;
  const max = player.waveform.max || 1;
  for (let i = 0; i < bins; i++) {
    const start = Math.floor((i * rawBins) / bins);
    const end = Math.max(start + 1, Math.floor(((i + 1) * rawBins) / bins));
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    const amplitude = sum / (end - start);
    const x = i * pxPerBin + halfGap;
    const h = Math.max(1, (amplitude / max) * H * 0.44);
    context.fillStyle = x + barW / 2 < playedX ? paint : `rgba(${waveformInk},0.07)`;
    context.beginPath();
    roundRect(context, x, mid - h, barW, h * 2, barW * 0.5);
    context.fill();
  }

  // Playhead.
  context.strokeStyle = `rgba(${waveformInk},0.55)`;
  context.lineWidth = 1.5;
  context.shadowColor = `rgba(${waveformInk},0.25)`;
  context.shadowBlur = 5;
  context.beginPath();
  context.moveTo(playedX, mid - H * 0.38);
  context.lineTo(playedX, mid + H * 0.38);
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = `rgb(${waveformInk})`;
  context.shadowColor = `rgba(${waveformInk},0.4)`;
  context.shadowBlur = 7;
  context.beginPath();
  context.arc(playedX, mid, 3.5, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
}

function drawViz() {
  if (!vizContext || !vizW || !vizH) return;
  if (audioState.seekStyle === 'waveform') drawWaveform(vizContext, vizW, vizH);
}

function watchCanvas() {
  vizCanvas = $('mp-viz-canvas');
  if (!vizCanvas) return;
  vizContext = vizCanvas.getContext('2d');
  new ResizeObserver(entries => {
    for (const entry of entries) {
      const nextW = Math.round(entry.contentRect.width);
      const nextH = Math.round(entry.contentRect.height);
      if (!nextW || !nextH || (nextW === vizW && nextH === vizH)) continue;
      vizW = nextW;
      vizH = nextH;
      vizCanvas.width = nextW;
      vizCanvas.height = nextH;
      gradCache = null;
      gradCacheKey = '';
      idlePath = null;
      startVizLoop(true);
    }
  }).observe(vizCanvas);
}

// Paint only while something can visibly change, at most at the chosen rate.
let vizRaf = null;
let vizNextPaintAt = 0;
let vizForce = false;

const vizInterval = () => 1000 / Math.max(1, Math.min(1000, Number(audioState.waveformFps) || 5));
const canPaintViz = () => !!(vizCanvas?.isConnected && !document.hidden && mediaOpen && audioState.seekStyle !== 'classic');

function vizTick(timestamp) {
  vizRaf = null;
  if (!canPaintViz()) { vizForce = false; return; }
  const interval = vizInterval();
  if (vizForce || !vizNextPaintAt || timestamp + 0.5 >= vizNextPaintAt) {
    drawViz();
    if (vizForce || !vizNextPaintAt) vizNextPaintAt = timestamp + interval;
    else do { vizNextPaintAt += interval; } while (vizNextPaintAt <= timestamp + 0.5);
  }
  vizForce = false;
  if (canPaintViz() && player.playback.playing) vizRaf = requestAnimationFrame(vizTick);
}

function startVizLoop(force = false) {
  if (!canPaintViz()) return;
  if (force) vizForce = true;
  if (vizRaf === null) vizRaf = requestAnimationFrame(vizTick);
}

function stopVizLoop() {
  if (vizRaf !== null) cancelAnimationFrame(vizRaf);
  vizRaf = null;
  vizNextPaintAt = 0;
  vizForce = false;
}

function invalidateGradCache() {
  gradCache = null;
  gradCacheKey = '';
  startVizLoop(true);
}

// ── Bar ─────────────────────────────────────────────────────────────────────

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

let trackNotice = '';

function syncTrack() {
  const track = player.currentTrack();
  const name = $('mp-track-name');
  const sub = $('mp-track-sub');
  if (!name || !sub) return;
  name.textContent = track ? track.name : 'No track loaded';
  sub.textContent = trackNotice || (track
    ? `Track ${player.engine.trackIdx + 1} of ${player.engine.playlist.length}`
    : 'Click disc to load files');
}

function setPlaying(on) {
  const play = $('mp-pp-icon-play');
  const pause = $('mp-pp-icon-pause');
  if (play && pause) {
    play.style.display = on ? 'none' : '';
    pause.style.display = on ? '' : 'none';
  }
  if (on && mediaOpen) startVizLoop();
  else stopVizLoop();
  drawViz();
}

function updateProgress() {
  const duration = player.playback.duration;
  const time = player.currentTime();
  const pct = duration ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0;
  document.querySelectorAll('.mp-tl-row.active').forEach(row => row.style.setProperty('--track-progress', `${pct}%`));
  const input = $('mp-seek-input');
  if (!input) return;
  input.value = pct;
  $('mp-cur-fs').textContent = fmt(time);
  $('mp-dur-fs').textContent = fmt(duration);
  if (audioState.seekStyle === 'classic') {
    $('mp-seek-fill').style.width = `${pct}%`;
    $('mp-seek-thumb').style.left = `${pct}%`;
  } else {
    startVizLoop(seeking);
  }
}

function updateModeButtons() {
  $('mp-shuffle-btn')?.classList.toggle('active-mode', player.engine.shuffleOn);
  const repeat = $('mp-repeat-btn');
  if (!repeat) return;
  const mode = player.engine.repeatMode;
  repeat.classList.toggle('active-mode', mode !== 'none');
  repeat.title = mode === 'all' ? 'Repeat All' : mode === 'one' ? 'Repeat One' : 'Repeat';
}

const VOLUME_ICONS = {
  mute: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  low: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>',
  high: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
};

function paintVolume(volume) {
  const fill = $('mp-vol-fill');
  const pct = $('mp-vol-pct');
  const input = $('mp-vol-input');
  const icon = $('mp-mute-btn');
  if (!fill || !pct || !input || !icon) return;
  fill.style.width = `${volume}%`;
  pct.textContent = `${Math.round(volume)}%`;
  input.value = volume;
  icon.innerHTML = volume === 0 ? VOLUME_ICONS.mute : volume < 50 ? VOLUME_ICONS.low : VOLUME_ICONS.high;
}

// Seek and volume bars compute the position from the pointer directly
// (the range inputs' own mapping is disabled).
let seeking = false;
function seekTo(clientX) {
  const duration = player.playback.duration;
  if (!duration) return;
  const rect = $('mp-seek-track').getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  void player.seek(duration * pct);
  updateProgress();
}

let volumeDragging = false;
function volumeTo(clientX) {
  const rect = $('mp-vol-track').getBoundingClientRect();
  const volume = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100;
  paintVolume(volume);
  void player.setVolume(volume);
}

// ── Library search ──────────────────────────────────────────────────────────

let lastQuery = '';

function openSearch() {
  const meta = $('mp-track-meta');
  const input = $('mp-lib-search');
  meta.classList.add('searching');
  input.value = lastQuery;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    input.classList.add('active');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }));
  applySearch(lastQuery);
  updateClearButton();
}

function closeSearch() {
  $('mp-lib-search').classList.remove('active');
  setTimeout(() => {
    $('mp-track-meta').classList.remove('searching');
    updateClearButton();
  }, 200);
}

function updateClearButton() {
  $('mp-search-clear')?.classList.toggle('visible', !!$('mp-lib-search')?.value.trim());
}

/** Filter album cards: artist, album, or any track title. */
function applySearch(query) {
  const grid = $('mp-album-grid');
  if (!grid) return;
  const q = query.toLowerCase();
  grid.querySelectorAll('.mp-alb-card').forEach(card => {
    const match = !q
      || (card.dataset.artist || '').toLowerCase().includes(q)
      || (card.dataset.album || '').toLowerCase().includes(q)
      || (card.dataset.tracks || '').toLowerCase().includes(q);
    card.style.display = match ? '' : 'none';
  });
}

/** A character typed while the drawer is open starts a library search. */
function typeToSearch(key) {
  if (!mediaOpen) return;
  if (!browserOpen) openBrowser();
  lastQuery += key;
  const input = $('mp-lib-search');
  if (input) input.value = lastQuery;
  openSearch();
}

// ── Album browser ───────────────────────────────────────────────────────────

let activeAlbumKey = null;
let gridSignature = null;
let gridScrollTop = 0;
const glowCache = new Map(); // albumKey -> { coverSig, color }

/** Which album the Queue widget shows instead of the queue (null: the queue). */
function selectAlbum(albumKey) {
  activeAlbumKey = albumKey;
  atmos.events.emit('album-selected', { albumKey }).catch(() => {});
  renderAlbumTracksIfOpen();
}

function sampleAlbumGlow(card, image, albumKey, coverSig) {
  if (!image.complete || !image.naturalWidth || !card.isConnected) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const px = data.length / 4;
    const average = (r + g + b) / (px * 3);
    const boost = channel => Math.min(255, Math.round((channel / px - average) * 1.8 + average));
    const color = `rgba(${boost(r)},${boost(g)},${boost(b)},0.55)`;
    card.style.setProperty('--alb-glow', color);
    glowCache.set(albumKey, { coverSig, color });
    canvas.width = 0;
    canvas.height = 0;
  } catch { /* decode failure */ }
}

function initAlbumGlow(card, album, grid) {
  if (!album.cover) return;
  const coverSig = album.cover.length + album.cover.slice(-24);
  const cached = glowCache.get(album.key);
  if (cached?.coverSig === coverSig) {
    card.style.setProperty('--alb-glow', cached.color);
    return;
  }
  const image = card.querySelector('img');
  let timer = null;
  // A short hover delay, so covers passing under a still pointer during a
  // fast scroll don't each start canvas work.
  card.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!grid.classList.contains('is-scrolling') && card.matches(':hover')) sampleAlbumGlow(card, image, album.key, coverSig);
    }, 180);
  });
  card.addEventListener('pointerleave', () => { clearTimeout(timer); timer = null; });
}

function sortedAlbums() {
  const albums = [...player.getAlbums()];
  const text = value => String(value || '').trim().toLocaleLowerCase();
  const titleOrder = (a, b) => text(a.album).localeCompare(text(b.album)) || text(a.artist).localeCompare(text(b.artist));
  const artistOrder = (a, b) => text(a.artist).localeCompare(text(b.artist)) || titleOrder(a, b);
  const dateValue = album => {
    const match = String(album.releaseDate || album.year || '').match(/^(\d{4})(?:-(\d{1,2}))?/);
    return match ? Number(match[1]) * 100 + Number(match[2] || 0) : null;
  };
  const yearOrder = direction => (a, b) => {
    const ay = dateValue(a);
    const by = dateValue(b);
    if (ay == null && by == null) return artistOrder(a, b);
    if (ay == null) return 1;
    if (by == null) return -1;
    return direction * (ay - by) || artistOrder(a, b);
  };
  const sorters = { artist: artistOrder, album: titleOrder, 'year-desc': yearOrder(-1), 'year-asc': yearOrder(1) };
  return albums.sort(sorters[audioState.albumGridSort] || artistOrder);
}

function renderBrowser() {
  const browser = $('mp-browser');
  if (!browser) return;
  const tabs = $('mp-browser-tabs');
  if (tabs) tabs.style.display = player.hasLibrary() ? '' : 'none';
  renderAlbumGrid();
  browser.classList.add('docked');
}

function renderAlbumGrid() {
  const grid = $('mp-album-grid');
  const list = $('mp-track-list');
  if (!grid || !list) return;
  grid.style.display = 'grid';
  list.style.display = 'none';

  const albums = sortedAlbums();
  // Rebuilding the grid is the expensive part; skip it when the album set
  // hasn't changed, unless the live grid somehow lost its cards.
  const signature = `${audioState.albumGridSort}|${albums.map(album => `${album.key}:${album.cover ? album.cover.length + album.cover.slice(-24) : '0'}`).join('|')}`;
  const rebuild = signature !== gridSignature || (albums.length > 0 && !grid.querySelector('.mp-alb-card'));
  gridSignature = signature;
  if (!rebuild) return;

  if (glowCache.size) {
    const live = new Set(albums.map(album => album.key));
    for (const key of glowCache.keys()) if (!live.has(key)) glowCache.delete(key);
  }
  grid.innerHTML = '';
  if (!albums.length) {
    grid.innerHTML = '<div style="color:rgba(var(--ink-rgb, 255,255,255),0.2);font-size:0.68rem;letter-spacing:0.08em;padding:20px 4px;align-self:center;">No albums yet — add a folder in the Library widget</div>';
    return;
  }
  for (const album of albums) {
    const card = document.createElement('div');
    card.className = 'mp-alb-card';
    card.dataset.artist = album.artist || '';
    card.dataset.album = album.album || '';
    card.dataset.tracks = (album.tracks || []).map(track => track.title).join(' ');
    card.innerHTML =
      `<div class="mp-alb-cover">${album.cover
        ? `<img src="${escapeHtml(album.cover)}" alt="" loading="lazy" decoding="async">`
        : '<span style="font-size:2rem;opacity:0.4">💿</span>'}</div>` +
      `<div class="mp-alb-name">${escapeHtml(album.album)}</div>` +
      `<div class="mp-alb-artist">${escapeHtml(album.artist)}</div>`;
    initAlbumGlow(card, album, grid);
    card.addEventListener('click', () => selectAlbum(activeAlbumKey === album.key ? null : album.key));
    card.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      selectAlbum(album.key);
      void playAlbum(album, 0);
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      openAlbumMenu(event.clientX, event.clientY, album);
    });
    grid.appendChild(card);
  }
  // Bottom padding for the scroll area at any column count.
  const spacer = document.createElement('div');
  spacer.style.cssText = 'grid-column:1/-1;height:20px;flex-shrink:0;';
  grid.appendChild(spacer);
  if (lastQuery) applySearch(lastQuery);
}

// Kept for parity with the in-page browser: nothing shows album tracks in the
// panel itself any more (the Queue widget does), but a stale album
// selection is cleared when the album disappears.
function renderAlbumTracksIfOpen() {
  if (activeAlbumKey && !player.getAlbums().some(album => album.key === activeAlbumKey)) activeAlbumKey = null;
}

async function playAlbum(album, index) {
  trackNotice = '';
  const ok = await player.playAlbum(album.key, index);
  if (!ok) {
    // Keep the library usable if folders are still reconnecting or a path
    // disappeared.
    trackNotice = 'Track unavailable — rescan the library';
    syncTrack();
    setTimeout(() => { trackNotice = ''; syncTrack(); }, 4000);
  }
  return ok;
}

// ── Menus ───────────────────────────────────────────────────────────────────

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M3 12h14M3 18h10" stroke-linecap="round"/><circle cx="19" cy="18" r="3"/><path d="M19 15v3" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2.5" stroke-linecap="round"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M3 16l5-5 4 4 3-3 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01" stroke-linecap="round"/></svg>',
  track: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
};

// Menu actions run while the Atmos page has focus, so copy through Atmos.
const copyText = text => { if (text) atmos.clipboard.writeText(text).catch(() => {}); };
const showInFolder = filePath => { if (filePath) atmos.invoke('plugin:audio-player', 'show-item', filePath).catch(() => {}); };

function openAlbumMenu(x, y, album) {
  const trackCount = album.tracks.length;
  atmos.contextMenu.open(x, y, [
    { id: 'alb-play', label: 'Play Album', icon: ICON.play, run: () => playAlbum(album, 0) },
    { id: 'alb-queue', label: 'Add to Queue', icon: ICON.queue, run: () => player.queueAlbum(album.key) },
    { type: 'separator' },
    { id: 'alb-copy-path', label: 'Copy Folder Path', icon: ICON.copy, run: async () => copyText(await player.call('albumFolder', album.key)) },
    { id: 'alb-show-folder', label: 'Show in Explorer', icon: ICON.folder, run: async () => showInFolder(await player.call('mediaPathForAlbum', album.key)) },
    { id: 'alb-edit-cover', label: 'Edit Cover Art', icon: ICON.cover, run: () => openCoverEditor(album) },
    { type: 'separator' },
    { type: 'heading', label: 'Cover Appearance' },
    { id: 'cover-labels', type: 'toggle', label: 'Album Labels', checked: !audioState.albumLabelsHidden, run: checked => {
      audioState.albumLabelsHidden = !checked;
      document.body.classList.toggle('album-labels-hidden', audioState.albumLabelsHidden);
      save('albumLabelsHidden');
    } },
    { id: 'cover-sort', type: 'select', label: 'Grid Sort', value: audioState.albumGridSort || 'artist', closeOnChange: false, options: [
      { value: 'artist', label: 'Artist A–Z' }, { value: 'album', label: 'Album A–Z' },
      { value: 'year-desc', label: 'Release date newest' }, { value: 'year-asc', label: 'Release date oldest' },
    ], run: value => {
      audioState.albumGridSort = value;
      save('albumGridSort');
      renderBrowser();
    } },
    { id: 'cover-dim', type: 'range', label: 'Cover Dim', min: 0, max: 100, step: 5, value: audioState.albumDim ?? 50, suffix: '%', zeroLabel: 'Off', run: value => {
      audioState.albumDim = value;
      applyDimAmount(value);
      save('albumDim');
    } },
    { id: 'cover-size', type: 'range', label: 'Cover Size', min: 60, max: 180, step: 4, value: audioState.albumCoverSize ?? 160, suffix: 'px', run: value => {
      audioState.albumCoverSize = value;
      applyCoverSize(value);
      save('albumCoverSize');
    } },
    { id: 'cover-saturation', type: 'range', label: 'Saturation', min: 0, max: 200, step: 1, value: audioState.albumCoverSaturation ?? 100, suffix: '%', run: value => {
      audioState.albumCoverSaturation = value;
      applyCoverSaturation(value);
      save('albumCoverSaturation');
    } },
    { type: 'separator' },
    { type: 'meta', label: `${album.artist}  ·  ${trackCount} track${trackCount !== 1 ? 's' : ''}`, icon: ICON.info },
  ]).catch(error => console.error('[audio-player] album menu:', error));
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wire() {
  const seekTrack = $('mp-seek-track');
  $('mp-seek-input').style.pointerEvents = 'none';
  seekTrack.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    seeking = true;
    seekTo(event.clientX);
  });
  seekTrack.addEventListener('contextmenu', openSeekMenu);
  seekTrack.addEventListener('touchstart', event => {
    event.preventDefault();
    seeking = true;
    seekTo(event.touches[0].clientX);
  }, { passive: false });
  document.addEventListener('mousemove', event => {
    if (seeking) seekTo(event.clientX);
    if (volumeDragging) volumeTo(event.clientX);
  });
  document.addEventListener('mouseup', () => { seeking = false; volumeDragging = false; });
  document.addEventListener('touchmove', event => {
    if (!event.touches[0]) return;
    if (seeking) seekTo(event.touches[0].clientX);
    if (volumeDragging) volumeTo(event.touches[0].clientX);
  }, { passive: true });
  document.addEventListener('touchend', () => { seeking = false; volumeDragging = false; });

  const upload = $('music-upload');
  upload.addEventListener('change', event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) void player.playFiles(files).then(renderBrowser);
  });
  // Right-click on the track name opens the file picker.
  $('mp-track-meta').addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    upload.click();
  });

  $('mp-track-name').addEventListener('click', event => { event.stopPropagation(); openSearch(); });
  $('mp-track-sub').addEventListener('click', event => { event.stopPropagation(); openSearch(); });
  const search = $('mp-lib-search');
  search.addEventListener('input', event => {
    lastQuery = event.target.value.trim();
    applySearch(lastQuery);
    updateClearButton();
  });
  search.addEventListener('blur', () => setTimeout(closeSearch, 150));
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    lastQuery = '';
    search.value = '';
    applySearch('');
    closeSearch();
  });
  search.addEventListener('click', event => event.stopPropagation());
  $('mp-search-clear').addEventListener('mousedown', event => event.preventDefault());
  $('mp-search-clear').addEventListener('click', event => {
    event.stopPropagation();
    search.value = '';
    lastQuery = '';
    search.focus();
    applySearch('');
    updateClearButton();
  });
  // Typing in the panel (focus not in a field) searches the library; typing
  // on the workspace while the drawer is open arrives from Atmos.
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1 || !event.key.trim()) return;
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    typeToSearch(event.key);
  });
  atmos.drawer.onKey(({ key }) => typeToSearch(key));

  $('mp-pp-main').addEventListener('click', event => { event.stopPropagation(); void player.togglePlay(); });
  $('mp-prev-btn').addEventListener('click', event => { event.stopPropagation(); void player.playPrev(); });
  $('mp-next-btn').addEventListener('click', event => { event.stopPropagation(); void player.playNext(); });
  $('mp-shuffle-btn').addEventListener('click', event => { event.stopPropagation(); void player.toggleShuffle(); });
  $('mp-repeat-btn').addEventListener('click', event => { event.stopPropagation(); void player.cycleRepeat(); });
  $('mp-mute-btn').addEventListener('click', event => {
    event.stopPropagation();
    const volume = player.engine.vol > 0 ? 0 : 100;
    paintVolume(volume);
    void player.setVolume(volume);
  });
  $('mp-vol-input').style.pointerEvents = 'none';
  $('mp-vol-track').addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    volumeDragging = true;
    volumeTo(event.clientX);
  });
  $('mp-vol-track').addEventListener('touchstart', event => {
    event.preventDefault();
    volumeDragging = true;
    volumeTo(event.touches[0].clientX);
  }, { passive: false });

  for (const id of ['mp-btab-lib', 'mp-browser-back', 'mp-bar-back']) {
    $(id)?.addEventListener('click', event => { event.stopPropagation(); selectAlbum(null); renderBrowser(); });
  }

  // While the grid scrolls, card hover transitions pause (less paint).
  const grid = $('mp-album-grid');
  let scrollTimer = null;
  grid.addEventListener('scroll', () => {
    grid.classList.add('is-scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => grid.classList.remove('is-scrolling'), 150);
    gridScrollTop = grid.scrollTop;
  }, { passive: true });

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopVizLoop(); else startVizLoop(true); });
}

function applyTracklistLayout() {
  const browser = $('mp-browser');
  if (!browser) return;
  const width = Math.max(180, Math.min(420, Number(audioState.tracklistWidth) || 246));
  browser.style.setProperty('--mp-tracklist-width', `${width}px`);
  browser.classList.toggle('tracklist-collapsed', !!audioState.tracklistCollapsed);
}

/** Before frames the drawer's position and "Dock Player" were Audio Player's; hand them to Atmos once. */
async function handOverDrawer() {
  if (audioState.drawerHandedOver || drawerState().locked) return;
  try {
    if (Number.isFinite(audioState.drawerPlacement)) await atmos.drawer.setPlacement(audioState.drawerPlacement);
    if (audioState.audioBarPlacement === 'bottom') await atmos.drawer.setBarPlacement('bottom');
    audioState.drawerHandedOver = true;
    save('drawerHandedOver');
  } catch (error) {
    console.warn('[audio-player] could not hand the drawer position to Atmos:', error.message);
  }
}

export async function mountPlayer() {
  await player.connect();
  const bar = document.createElement('div');
  bar.id = 'ap-bar';
  bar.className = 'audio-player-panel-bar';
  const content = document.createElement('div');
  content.id = 'ap-content';
  const drawer = document.createElement('div');
  drawer.className = 'ap-drawer';
  drawer.append(bar, content);
  const extras = document.createElement('div');
  extras.id = 'ap-overlays';
  document.body.replaceChildren(drawer, extras);
  injectPanelMarkup(bar, content, extras);
  // The browser scrolls itself; wheel over it doesn't move the drawer.
  content.dataset.atmosDrawerScroll = '';

  applyDisplayPreferences();
  applyFullBarWaveform();
  document.body.classList.toggle('seek-viz', audioState.seekStyle !== 'classic');
  applySeekFill();
  applyTracklistLayout();
  syncWaveformAppearance();
  atmos.appearance.onChange(() => requestAnimationFrame(syncWaveformAppearance));
  watchCanvas();
  wire();
  initCoverEditor();

  syncTrack();
  paintVolume(player.engine.vol);
  updateModeButtons();
  setPlaying(player.playback.playing);
  updateProgress();

  player.on('engine', () => {
    syncTrack();
    paintVolume(player.engine.vol);
    updateModeButtons();
    if (browserOpen) renderBrowser();
  });
  player.on('playback', () => {
    setPlaying(player.playback.playing);
    updateProgress();
  });
  player.on('waveform', () => startVizLoop(true));
  player.on('library', () => {
    renderAlbumTracksIfOpen();
    if (browserOpen) renderBrowser();
  });
  atmos.events.on('album-selected', ({ albumKey } = {}) => { activeAlbumKey = albumKey ?? null; });
  onStateChange(() => {
    applyDisplayPreferences();
    applyFullBarWaveform();
    document.body.classList.toggle('seek-viz', audioState.seekStyle !== 'classic');
    applySeekFill();
    invalidateGradCache();
    if (browserOpen) renderBrowser();
  });

  applyDrawerState();
  atmos.drawer.onChange(applyDrawerState);
  if (browserOpen) {
    renderBrowser();
    requestAnimationFrame(() => { const grid = $('mp-album-grid'); if (grid) grid.scrollTop = gridScrollTop; });
  }
  await handOverDrawer();

  atmos.wallpaper.onChange(summary => { void resampleWallpaperColors(summary); });
}


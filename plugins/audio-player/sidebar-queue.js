/**
 * Audio Player's Queue widget: the current playlist, or the tracks of the
 * album selected in the panel's grid (with a back arrow to the queue).
 * Click a row to play it; right-click for Play / Add to Queue / Copy File
 * Path / Show in Explorer.
 */
import atmos from 'atmos-sdk';
import * as player from './src/client.js';

const TRACK_PLAYING_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><circle cx="8" cy="8" r="1.35"/><path d="M8 2.25v2M13.75 8h-2"/></svg>`;
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M3 12h14M3 18h10" stroke-linecap="round"/><circle cx="19" cy="18" r="3"/><path d="M19 15v3" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  track: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
};

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./assets/panel.css', import.meta.url).href;
document.head.appendChild(style);
// Only the widget's own rules apply here; the panel's full-height layout doesn't.
document.documentElement.style.height = 'auto';
document.body.style.height = 'auto';

await player.connect();
document.body.innerHTML = '<div id="mp-side-queue" class="ap-sidebar-queue"></div>';
const list = document.getElementById('mp-side-queue');

let activeAlbumKey = null;
let signature = null;

function row(number, title, active, onClick, onMenu) {
  const element = document.createElement('div');
  element.className = `mp-tl-row${active ? ' active' : ''}`;
  element.innerHTML =
    '<div class="mp-tl-icon-wrap"><span class="mp-tl-num"></span>' +
    `<span class="mp-tl-disc">${TRACK_PLAYING_ICON}</span></div>` +
    '<span class="mp-tl-name"></span>';
  element.querySelector('.mp-tl-num').textContent = number;
  element.querySelector('.mp-tl-name').textContent = title;
  element.addEventListener('click', onClick);
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    onMenu(event);
  });
  return element;
}

function isPlaying(track) {
  const current = player.currentTrack();
  return !!current && (track.key ? current.key === track.key : current.name === track.title);
}

function renderAlbum(album) {
  const next = `album|${album.key}|${player.engine.trackKey}|${player.engine.trackIdx}|${album.tracks.length}`;
  if (next === signature) return;
  signature = next;
  list.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'mp-queue-header';
  header.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const back = document.createElement('button');
  back.style.cssText = 'background:none;border:none;color:rgba(var(--ink-rgb, 255,255,255),0.35);font-size:0.8rem;cursor:pointer;padding:0;line-height:1;flex-shrink:0;';
  back.textContent = '←';
  back.title = 'Back to queue';
  back.addEventListener('click', event => {
    event.stopPropagation();
    atmos.events.emit('album-selected', { albumKey: null }).catch(() => {});
    activeAlbumKey = null;
    render();
  });
  const title = document.createElement('span');
  title.textContent = album.album;
  title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  header.append(back, title);
  list.appendChild(header);
  album.tracks.forEach((track, index) => {
    const number = `${track.disc > 1 ? `${track.disc}.` : ''}${track.num || index + 1}`;
    list.appendChild(row(number, track.title, isPlaying(track),
      () => { void player.playAlbum(album.key, index); },
      event => openTrackMenu(event.clientX, event.clientY, { title: track.title, key: track.key })));
  });
}

function renderQueue() {
  const next = `queue|${player.engine.trackIdx}|${player.engine.playlist.map(track => track.key || track.name).join(',')}`;
  if (next === signature) return;
  signature = next;
  list.innerHTML = '';
  if (!player.engine.playlist.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-queue-empty';
    empty.textContent = 'No tracks loaded';
    list.appendChild(empty);
    return;
  }
  player.engine.playlist.forEach((track, index) => {
    list.appendChild(row(String(index + 1), track.name, index === player.engine.trackIdx,
      () => { void player.loadIndex(index); },
      event => openTrackMenu(event.clientX, event.clientY, { title: track.name, key: track.key })));
  });
  const active = list.querySelector('.active');
  if (active) requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest' }));
}

function render() {
  if (activeAlbumKey) {
    const album = player.getAlbums().find(candidate => candidate.key === activeAlbumKey);
    if (album) { renderAlbum(album); updateProgress(); return; }
    activeAlbumKey = null;
  }
  renderQueue();
  updateProgress();
}

function updateProgress() {
  const duration = player.playback.duration;
  const pct = duration ? Math.max(0, Math.min(100, (player.currentTime() / duration) * 100)) : 0;
  list.querySelectorAll('.mp-tl-row.active').forEach(element => element.style.setProperty('--track-progress', `${pct}%`));
}

function openTrackMenu(x, y, track) {
  const copyPath = async () => {
    const filePath = track.key ? await player.call('filePath', track.key) : null;
    if (filePath) atmos.clipboard.writeText(filePath).catch(() => {});
  };
  const showInFolder = async () => {
    const filePath = track.key ? await player.call('filePath', track.key) : null;
    if (filePath) atmos.invoke('plugin:audio-player', 'show-item', filePath).catch(() => {});
  };
  atmos.contextMenu.open(x, y, [
    { type: 'meta', label: track.title || 'Track', icon: ICON.track },
    { type: 'separator' },
    { id: 'trk-play', label: 'Play', icon: ICON.play, run: () => player.playTrack(track.key, track.title) },
    { id: 'trk-queue', label: 'Add to Queue', icon: ICON.queue, run: () => player.queueTrack(track.key) },
    { type: 'separator' },
    { id: 'trk-copy-path', label: 'Copy File Path', icon: ICON.copy, run: copyPath },
    { id: 'trk-show', label: 'Show in Explorer', icon: ICON.folder, run: showInFolder },
  ]).catch(error => console.error('[audio-player] track menu:', error));
}

atmos.events.on('album-selected', ({ albumKey } = {}) => {
  activeAlbumKey = albumKey ?? null;
  signature = null;
  render();
});
player.on('engine', render);
player.on('library', () => { signature = null; render(); });
player.on('playback', updateProgress);
setInterval(() => { if (player.playback.playing && !document.hidden) updateProgress(); }, 1000);
render();

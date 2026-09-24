/**
 * Audio: playback that belongs to Atmos rather than to a panel.
 *
 * Every extension that plays audio gets its own channel: one <audio>
 * element living in the Atmos page for the whole session, so playback
 * carries on through panel switches, layout changes and frame reloads. The
 * extension decides what to play (its queue, its library); a channel only
 * loads a source, plays, pauses, seeks, sets the volume and reports back.
 *
 * Channels are keyed by owner ("plugin:audio-player"), so two extensions
 * never interrupt each other. Framed extensions reach their channel through
 * the SDK (atmos.audio); page code through the `media.audio` capability.
 */

const hostId = 'atmos-audio-host';
const channels = new Map(); // owner -> channel

function host() {
  let element = document.getElementById(hostId);
  if (!element) {
    element = document.createElement('div');
    element.id = hostId;
    element.hidden = true;
    document.body.appendChild(element);
  }
  return element;
}

const finite = value => (Number.isFinite(value) ? value : 0);

function createChannel(owner) {
  const element = document.createElement('audio');
  element.preload = 'auto';
  element.dataset.owner = owner;
  host().appendChild(element);

  const listeners = new Set();
  let source = null;        // the caller's own label for what is loaded (a track key, say)
  let objectUrl = null;     // for Blob sources
  let revision = 0;         // a newer load() supersedes an older one's pending seek/play
  let lastError = null;

  const snapshot = type => Object.freeze({
    type,
    source,
    playing: !element.paused && !element.ended,
    currentTime: finite(element.currentTime),
    duration: finite(element.duration),
    volume: element.volume,
    ended: element.ended,
    error: lastError,
  });
  const emit = type => {
    const value = snapshot(type);
    for (const fn of [...listeners]) {
      try { fn(value); } catch (error) { console.error('[audio] listener failed:', error); }
    }
  };

  element.addEventListener('play', () => emit('play'));
  element.addEventListener('pause', () => emit('pause'));
  element.addEventListener('ended', () => emit('ended'));
  element.addEventListener('timeupdate', () => emit('time'));
  element.addEventListener('seeked', () => emit('time'));
  element.addEventListener('loadedmetadata', () => emit('loaded'));
  element.addEventListener('durationchange', () => emit('loaded'));
  element.addEventListener('volumechange', () => emit('volume'));
  element.addEventListener('error', () => {
    if (!element.getAttribute('src')) return;
    lastError = element.error?.message || `media error ${element.error?.code ?? ''}`.trim();
    emit('error');
  });

  function releaseObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  async function safePlay() {
    try { await element.play(); return true; }
    catch (error) {
      // A pause or new source interrupting play() is expected, not a failure.
      if (error?.name !== 'AbortError') {
        lastError = error?.message || String(error);
        emit('error');
      }
      return false;
    }
  }

  return {
    /**
     * Load a source: a URL string (the caller has checked it) or a Blob.
     * options: { id, position, play }. Resolves once the source is set.
     */
    load(value, { id = null, position = 0, play = false } = {}) {
      const request = ++revision;
      lastError = null;
      releaseObjectUrl();
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        objectUrl = URL.createObjectURL(value);
        element.src = objectUrl;
      } else {
        element.src = String(value);
      }
      source = id == null ? null : String(id);
      const start = Math.max(0, Number(position) || 0);
      if (start > 0) {
        element.addEventListener('loadedmetadata', () => {
          if (request === revision) element.currentTime = Math.min(start, finite(element.duration) || start);
        }, { once: true });
      }
      emit('source');
      if (play) void safePlay();
      return snapshot('source');
    },
    play: () => safePlay(),
    pause() { element.pause(); },
    seek(seconds) {
      const target = Math.max(0, Number(seconds) || 0);
      element.currentTime = finite(element.duration) ? Math.min(target, element.duration) : target;
    },
    setVolume(value) {
      element.volume = Math.max(0, Math.min(1, Number(value)));
    },
    stop() {
      ++revision;
      element.pause();
      element.removeAttribute('src');
      element.load();
      releaseObjectUrl();
      source = null;
      lastError = null;
      emit('source');
    },
    state: () => snapshot('state'),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The channel belonging to `owner` ("plugin:<id>" or "service:<id>"). */
export function channel(owner) {
  if (typeof owner !== 'string' || !owner) throw new TypeError('audio: a channel needs an owner');
  if (!channels.has(owner)) channels.set(owner, createChannel(owner));
  return channels.get(owner);
}

/** Owners that have a channel, and whether each is playing. */
export function listChannels() {
  return [...channels].map(([owner, value]) => ({ owner, playing: value.state().playing }));
}

export const audioApi = Object.freeze({ channel, listChannels });

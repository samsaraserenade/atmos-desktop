import atmos from 'atmos-sdk';
import { getClient, getUserId, onAccountChange, onSync, onTimeline } from './client.js';
import { getNotificationSound, onNotificationSoundChanged } from './preferences.js';

let initialized = false;
let prepared = false;
const seen = new Set();

function remember(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  return true;
}

function isMessage(event) {
  if (event.getType() !== 'm.room.message') return false;
  const content = event.getContent() || {};
  return !content['m.relates_to']?.rel_type;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

// Build the short two-tone ping as PCM once.
function createPingBlob() {
  const sampleRate = 24000;
  const duration = 0.24;
  const sampleCount = Math.ceil(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.008);
    const release = Math.max(0, 1 - t / duration) ** 2;
    const first = Math.sin(2 * Math.PI * 740 * t);
    const second = t >= 0.055 ? 0.75 * Math.sin(2 * Math.PI * 990 * (t - 0.055)) : 0;
    const sample = Math.max(-1, Math.min(1, (first + second) * attack * release * 0.16));
    view.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// The ping plays through Atmos's Audio service, on Matrix Chat's own
// channel, so it sounds whether or not the chat panel is open and needs no
// unlocking gesture here (the Atmos page has had one).
let pingBlob = null;

async function playPing() {
  if (!getNotificationSound()) return;
  try {
    pingBlob ||= createPingBlob();
    await atmos.audio.load(pingBlob, { id: 'ping', play: true });
  } catch (err) {
    console.warn('[matrix-chat] notification sound unavailable', err);
  }
}

async function handleTimeline(event, room, toStartOfTimeline) {
  if (!prepared || toStartOfTimeline || !room || event.getSender() === getUserId()) return;
  const eventId = event.getId?.();
  if (!remember(eventId)) return;

  try {
    if (event.isEncrypted?.()) await event.getDecryptionPromise?.();
  } catch {
    // A failed decryption is still a real event, but it cannot be classified
    // accurately as a message or mention, so don't emit a misleading alert.
    return;
  }
  if (!isMessage(event) || event.isDecryptionFailure?.()) return;

  const client = getClient();
  const actions = client?.getPushActionsForEvent?.(event);
  if (!actions?.notify) return;
  // Matrix's push rules are the source of truth. The previous extra DM/mention
  // heuristic could reject an event that Matrix had already marked notify=true,
  // which produced a desktop toast in the old path but no in-app sound.
  playPing();
}

export function initNotifications() {
  if (initialized) return;
  initialized = true;
  // Turning the ping on plays one, so you hear it works right away.
  onNotificationSoundChanged(enabled => { if (enabled) void playPing(); });
  onSync(state => {
    if (state === 'PREPARED' || state === 'SYNCING') prepared = true;
  });
  onAccountChange(() => {
    prepared = false;
    seen.clear();
  });
  onTimeline((event, room, toStart) => void handleTimeline(event, room, toStart));
}

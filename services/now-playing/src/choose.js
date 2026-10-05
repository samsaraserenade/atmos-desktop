/**
 * Which session Now Playing shows, and where its playback is now. Pure, so
 * it's tested alone (tests/choose.test.mjs).
 *
 * Sessions come from Atmos (atmos.nowPlaying.sessions): each with
 * `playingSince` (when it last started playing, null while paused) and
 * `lastActive` (when it last played). The rule, as phones and Windows do:
 *
 *   1. the one you picked with the dots, until something starts after that;
 *   2. else the one playing that started last (Music, then a video: the video);
 *   3. else the one that played last (paused: still there to resume).
 */

/**
 * Whether a pick from the dots is over: its session ended, or another
 * started after it. Over is over: a pick doesn't come back when that one
 * pauses again.
 */
export function pickExpired(sessions, pick) {
  if (!pick) return false;
  if (!sessions?.some(session => session.id === pick.id)) return true;
  return sessions.some(session => session.id !== pick.id && session.playing && Number.isFinite(session.playingSince) && session.playingSince > pick.at);
}

/** The session to show, or null when there's none. `pick`: { id, at } from the dots, or null. */
export function chooseSession(sessions, pick = null) {
  if (!sessions?.length) return null;
  if (pick && !pickExpired(sessions, pick)) return sessions.find(session => session.id === pick.id);
  const playing = sessions.filter(session => session.playing && Number.isFinite(session.playingSince));
  const newest = playing.reduce((best, session) => (!best || session.playingSince > best.playingSince ? session : best), null);
  if (newest) return newest;
  return sessions.reduce((best, session) => (!best || (session.lastActive ?? 0) > (best.lastActive ?? 0) ? session : best), null);
}

/** Seconds into it now: moved on from when Atmos heard it, while playing; within its length. */
export function positionNow(session, now = Date.now()) {
  if (!session || !Number.isFinite(session.position)) return 0;
  const moved = session.playing && Number.isFinite(session.positionAt) ? Math.max(0, now - session.positionAt) / 1000 : 0;
  const at = session.position + moved;
  return Number.isFinite(session.duration) && session.duration > 0 ? Math.min(at, session.duration) : at;
}

/** "3:07", "1:02:05". */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Who plays it, as Atmos says: a community extension marked as one, so none passes for Music. */
export function sourceLabel(session) {
  const name = session?.source?.name || '';
  return name && session.source.community ? `${name} · community` : name;
}

/**
 * The line under the title: the artist and where it plays, else who plays
 * it; a community extension's name always, after the rest. (The widget
 * adds "· community" beside it, where nothing pushes it out of view.)
 */
export function subtitle(session) {
  // Where it plays, always, as Chrome's media controls say (a tab's site:
  // no page passes for Music by its artist alone).
  const what = [session?.artist, session?.from].filter(Boolean).join(' · ');
  const name = session?.source?.name || '';
  if (session?.source?.community) return [what, name].filter(Boolean).join(' · ');
  return what || name;
}

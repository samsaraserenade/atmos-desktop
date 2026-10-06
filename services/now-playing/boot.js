// Now Playing's background frame: play/pause, next and previous for
// whatever the widget shows (src/choose.js), from anywhere in Atmos: Space
// (outside fields and buttons) and rev/play (also rev/pause), rev/next,
// rev/previous. Music, a tab in Atmos Browser or any extension's session,
// through its own controls (atmos.nowPlaying.control).
import atmos from 'atmos-sdk';
import { chooseSession, pickExpired } from './src/choose.js';

let sessions = [];
let pick = null; // { id, at }: one chosen with the widget's dots
atmos.nowPlaying.sessions(list => {
  sessions = Array.isArray(list) ? list : [];
  if (pickExpired(sessions, pick)) pick = null;
});
atmos.events.on('pick', value => { pick = value && typeof value.id === 'string' ? value : null; });

/** What the widget shows, and that it takes `action`. */
function current(action) {
  const session = chooseSession(sessions, pick);
  if (!session) throw new Error('Nothing is playing in Atmos. Start something first: a song (rev/song), a video, …');
  if (!session.actions?.includes(action)) {
    throw new Error(`${session.title || 'What’s playing'} can’t ${action === 'toggle' ? 'be paused from here' : `skip to the ${action === 'next' ? 'next' : 'previous'} one`}.`);
  }
  return session;
}

const named = session => session.title || session.source?.name || 'it';

async function toggle() {
  const session = current('toggle');
  await atmos.nowPlaying.control(session.id, 'toggle');
  return { done: session.playing ? `Paused ${named(session)}.` : `Playing ${named(session)}.` };
}

async function skip(action) {
  const session = current(action);
  await atmos.nowPlaying.control(session.id, action);
  return { done: action === 'next' ? 'Next.' : 'Previous.' };
}

atmos.surface.onKey(({ code }) => {
  if (code === 'Space') toggle().catch(error => console.warn('[now-playing]', error.message));
});
atmos.commands.handle('play', () => toggle());
atmos.commands.handle('next', () => skip('next'));
atmos.commands.handle('previous', () => skip('previous'));

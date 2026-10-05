/**
 * What a tab shows in Atmos's Now Playing (engine.js publishes it), or null:
 * a loaded tab whose page is playing, or has played something it said
 * (its Media Session) since it loaded. A muted video playing by itself on a
 * page never sounded, so it isn't one; nor is a crashed page.
 *
 * The page's own words, as Core checked them (atmos.web 'media'), else the
 * tab's title; the site it plays on; its artwork (Core drew it again), else
 * the site's icon. Its controls are what the page takes.
 */
import { isPageUrl, siteName } from './address.js';

const ACTIONS = ['toggle', 'next', 'previous', 'seek'];

/** Whether `title` is just an address, or none (as engine.js's isAddress). */
function bareAddress(title, url) {
  const bare = value => String(value || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  return !title || title === 'about:blank' || title === url || bare(title) === bare(url) || /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(title);
}

export function nowPlayingSession(tab, state, { favicon = null, startedByUser = true } = {}) {
  if (!tab || !state?.live || state.error || !isPageUrl(tab.url)) return null;
  const media = state.media && typeof state.media === 'object' ? state.media : null;
  if (!state.audible && !(media && state.heard)) return null;
  const site = siteName(tab.url) || null;
  const named = bareAddress(tab.title, tab.url) ? '' : String(tab.title);
  const number = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  return {
    title: (media?.title || named || site || 'A tab').slice(0, 200),
    artist: media?.artist || null,
    album: media?.album || null,
    from: site,
    artwork: (typeof media?.artwork === 'string' && media.artwork) || favicon || null,
    duration: number(media?.duration),
    position: number(media?.position),
    playing: media ? media.playing === true : state.audible === true,
    actions: Array.isArray(media?.actions) ? ACTIONS.filter(action => media.actions.includes(action)) : [],
    // A page that began playing by itself (not the tab you're on, nothing
    // you did in it just before): Now Playing shows it only when nothing
    // else plays, so a page can't take the widget from Music.
    startedByUser: startedByUser === true,
  };
}

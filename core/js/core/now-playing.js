/**
 * What each extension is playing, on its way to the Now Playing service
 * (atmos.nowPlaying, SDK 1.4). Core only passes sessions along and controls
 * back: the service (services/now-playing) decides which one shows and
 * draws it. Core is in the middle because a service can't tell who called
 * it or answer one extension alone: here each session is stamped with the
 * extension that set it, checked field by field, and a control reaches
 * only that extension, and only if it said it takes that control.
 *
 * Only the Now Playing service sees every session; an extension sees its
 * own controls, never what others play.
 *
 * Any extension may publish, community ones included, so nothing here
 * trusts what it's given: each session is checked (sdk/now-playing-checks.mjs:
 * plain text, artwork read by its bytes and passed on as a Blob made here);
 * an extension has 16 sessions and 4 MB of artwork at most, and past 20
 * updates a second the latest of each waits for the next second (none is
 * refused: a volume drag ends where it ended). The service hears at most
 * 10 lists a second, however many come in.
 *
 * And a community extension can't take the widget by itself: what it
 * starts counts as started (shown before what played already) only just
 * after you clicked in it (the main process saw the click land on its
 * frame) or used its controls in the widget. Otherwise it shows only when
 * nothing else plays.
 */

import { normalizeSession, readArtwork, sessionKey, text } from '../sdk/now-playing-checks.mjs';

export { ACTIONS, MAX_ARTWORK_BYTES, normalizeSession, readArtwork, sessionKey, sniffImage } from '../sdk/now-playing-checks.mjs';

const MAX_NAME = 60;
const MAX_SESSIONS = 16;                       // per extension (a browser's tabs, say)
const MAX_ARTWORK_TOTAL = 4 * 1024 * 1024;     // all of one extension's
const MAX_SETS_PER_SECOND = 20;                // per extension; more wait for the next second
const NOTIFY_EVERY_MS = 100;                   // the service hears a list this often at most
// Paused for less than this and playing again isn't "starting": it keeps
// its place, so a session can't jump ahead by flicking play on and off.
export const RESUME_GRACE_MS = 3000;
// A community extension's start counts if you used it this recently.
export const USED_RECENTLY_MS = 5000;

// ── The hub ─────────────────────────────────────────────────────────────────

/**
 * `send(owner, payload)` delivers a control to an extension's frames;
 * `clickedJustNow(owner)` resolves whether your last click, a moment ago,
 * was in one of its frames; `now()` is the clock and `later(fn, ms)` a
 * timer. set/clear/forget come from publishers, watch/control from the Now
 * Playing service.
 */
export function createNowPlayingHub({ send, clickedJustNow = async () => false, now = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const sessions = new Map(); // "<owner>|<key>" -> session as the service sees it
  const kept = new Map();     // the same id -> { since, pausedAt, bytes, artworkInput }: what the service doesn't see
  const chains = new Map();   // owner -> its last set/clear, so they apply in order
  const eras = new Map();     // owner -> bumped when its frames stop: a set still reading its artwork lands nowhere
  const rates = new Map();    // owner -> { at, count }: this second's updates
  const waiting = new Map();  // owner -> Map(id -> { source, key, input, session, settle }): past the budget, for the next second
  const flushing = new Set(); // owners with a timer for what's waiting
  const controlled = new Map(); // owner -> when the widget last sent it a control
  const watchers = new Set();

  const list = () => [...sessions.values()].map(session => ({ ...session, source: { ...session.source }, actions: [...session.actions] }));

  // The service hears a change at once, then at most every NOTIFY_EVERY_MS.
  let pending = false;
  let lastNotified = -Infinity;
  const notify = () => {
    pending = false;
    lastNotified = now();
    const current = list();
    for (const fn of [...watchers]) {
      try { fn(current); } catch (error) { console.error('[now-playing] watcher failed:', error); }
    }
  };
  const changed = () => {
    if (pending) return;
    pending = true;
    const wait = lastNotified + NOTIFY_EVERY_MS - now();
    if (wait > 0) later(notify, wait); else queueMicrotask(notify);
  };

  const ownedBy = owner => [...sessions.values()].filter(session => session.source.id === owner);
  const queue = (owner, job) => {
    const era = eras.get(owner) ?? 0;
    const run = (chains.get(owner) ?? Promise.resolve()).then(() => job(() => (eras.get(owner) ?? 0) === era));
    chains.set(owner, run.catch(() => {}));
    return run;
  };
  const drop = (owner, key) => {
    let gone = false;
    for (const [id, session] of sessions) {
      if (session.source.id === owner && (key === null || session.key === key)) { sessions.delete(id); kept.delete(id); gone = true; }
    }
    if (gone) changed();
  };
  /** What's waiting for the next second, for one key or all: it won't be set. */
  const unwait = (owner, key) => {
    const list = waiting.get(owner);
    if (!list) return;
    for (const [id, item] of list) {
      if (key === null || item.key === key) { list.delete(id); item.settle(); }
    }
  };

  /** Put a checked session in, once its artwork is read. */
  const apply = (source, id, key, input, session) => queue(source.id, async current => {
    const owner = source.id;
    const previous = sessions.get(id);
    const before = kept.get(id);
    const art = previous?.artworkKey && typeof input.artwork === 'string' && input.artwork === before?.artworkInput
      ? { blob: previous.artwork, key: previous.artworkKey, bytes: before.bytes }
      : await readArtwork(input.artwork);
    if (!current()) return;
    if (!previous && ownedBy(owner).length >= MAX_SESSIONS) {
      throw new RangeError(`an extension shows ${MAX_SESSIONS} sessions in Now Playing at most`);
    }
    const others = ownedBy(owner).filter(item => item.id !== id).reduce((sum, item) => sum + (kept.get(item.id)?.bytes ?? 0), 0);
    if (art && others + art.bytes > MAX_ARTWORK_TOTAL) throw new RangeError('an extension’s Now Playing artwork is 4 MB at most, all together');
    // When it last started playing: the service shows the one you started
    // last. Still playing, or paused only a moment: the same start. A
    // community extension's start, unless you just used it (clicked in it,
    // or used its controls in the widget): 0, before anything else that plays.
    const resumed = before?.since != null && before.pausedAt != null && now() - before.pausedAt < RESUME_GRACE_MS;
    const starts = session.playing && !previous?.playing && !resumed;
    // (An official extension says so itself when a start wasn't the user's:
    // Atmos Browser's page that began playing by itself, startedByUser false.)
    const used = !starts || (source.community !== true && input.startedByUser !== false)
      || now() - (controlled.get(owner) ?? -Infinity) < USED_RECENTLY_MS
      || await Promise.resolve(clickedJustNow(owner)).catch(() => false);
    if (!current()) return;
    const at = now();
    const playingSince = !session.playing ? null
      : previous?.playing ? previous.playingSince
        : resumed ? before.since
          : used ? at : 0;
    sessions.set(id, {
      id, key, source: { id: owner, name: text(source.name, MAX_NAME) || owner, community: source.community === true },
      ...session,
      artwork: previous?.artworkKey === art?.key && previous?.artwork ? previous.artwork : art?.blob ?? null,
      artworkKey: art?.key ?? null,
      positionAt: at,
      playingSince,
      // Last played (or set, if never): what shows when nothing plays.
      lastActive: session.playing || !previous ? at : previous.lastActive,
    });
    kept.set(id, {
      since: session.playing ? playingSince : before?.since ?? null,
      pausedAt: session.playing ? null : previous?.playing ? at : before?.pausedAt ?? null,
      bytes: art?.bytes ?? 0,
      artworkInput: typeof input.artwork === 'string' ? input.artwork : null,
    });
    changed();
  });

  /** The next second: what waited goes in, the newest of each. */
  const flush = owner => {
    flushing.delete(owner);
    const list = waiting.get(owner);
    waiting.delete(owner);
    if (!list?.size) return;
    rates.set(owner, { at: now(), count: list.size });
    for (const [id, item] of list) apply(item.source, id, item.key, item.input, item.session).then(() => item.settle(), item.settle);
  };

  return {
    /**
     * An extension says what it plays under `key` (its tabs, say; 'main' by
     * default). `source`: { id, name, community }, from Core, never from
     * the extension. Resolves once it's in, or once a newer one replaced it
     * before it got in; rejects with what's wrong.
     */
    set(source, key, input) {
      const owner = source.id;
      const id = `${owner}|${sessionKey(key)}`;
      const session = normalizeSession(input);
      const at = now();
      let rate = rates.get(owner);
      if (!rate || at - rate.at >= 1000) rates.set(owner, rate = { at, count: 0 });
      const queued = waiting.get(owner);
      if (rate.count < MAX_SETS_PER_SECOND && !queued?.size) {
        rate.count += 1;
        return apply(source, id, key, input, session);
      }
      // Past the budget: this waits for the next second, replacing what
      // waited for the same session.
      const list = queued ?? new Map();
      waiting.set(owner, list);
      const before = list.get(id);
      if (!before && list.size >= MAX_SESSIONS) throw new RangeError(`an extension shows ${MAX_SESSIONS} sessions in Now Playing at most`);
      return new Promise((resolve, reject) => {
        before?.settle();
        list.delete(id); // in the order they were last asked
        list.set(id, { source, key, input, session, settle: error => (error ? reject(error) : resolve()) });
        if (!flushing.has(owner)) {
          flushing.add(owner);
          later(() => flush(owner), Math.max(0, rate.at + 1000 - at));
        }
      });
    },
    /** One session gone (`key`), or all of the extension's (no key), after any set before it. */
    clear(owner, key = null) {
      unwait(owner, key);
      return queue(owner, async current => { if (current()) drop(owner, key); });
    },
    /** The extension stopped: its sessions go now, and any set on its way with them. */
    forget(owner) {
      eras.set(owner, (eras.get(owner) ?? 0) + 1);
      unwait(owner, null);
      rates.delete(owner);
      controlled.delete(owner);
      drop(owner, null);
    },
    /** The Now Playing service: fn(sessions) now and on every change. */
    watch(fn) {
      watchers.add(fn);
      try { fn(list()); } catch (error) { console.error('[now-playing] watcher failed:', error); }
      return () => watchers.delete(fn);
    },
    /**
     * The Now Playing service asks a session's extension to do something it
     * said it takes. seek: seconds; volume: 0–100.
     */
    control(id, action, value = null) {
      const session = typeof id === 'string' ? sessions.get(id) : null;
      if (!session) throw new Error('that Now Playing session has ended');
      if (!session.actions.includes(action)) throw new TypeError(`${session.source.name} doesn’t take “${String(action).slice(0, 20)}” from Now Playing`);
      let amount = null;
      if (action === 'seek') {
        if (!Number.isFinite(value) || value < 0) throw new TypeError('seek to a number of seconds, 0 or more');
        amount = session.duration == null ? value : Math.min(value, session.duration);
      } else if (action === 'volume') {
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError('volume is 0–100');
        amount = value;
      }
      // You used it: what it starts now counts as started.
      controlled.set(session.source.id, now());
      send(session.source.id, { key: session.key, action, value: amount });
    },
    get size() { return sessions.size; },
  };
}

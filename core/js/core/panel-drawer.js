/**
 * The drawer a panel can live in: a strip that slides up from the bottom of
 * the full workspace. The panel's frame draws what is inside (a bar and,
 * below it, a browser); Core moves it, and everything around it stays
 * pass-through. Wheel or swipe outside the frame's scrolling area moves it
 * between three resting points:
 *
 *   HIDDEN — fully below the workspace
 *   BAR    — only the bar is visible
 *   open   — anywhere above BAR, up to fully expanded (free-floating)
 *
 * A spring/friction model decides where a gesture settles. Positions are
 * measured from the top of the surface: 0 is fully open, BAR = the
 * workspace height minus the bar, HIDDEN = BAR + 70. Placement is the
 * size-independent form that is saved: 0 = open, 1 = BAR, 2 = hidden.
 *
 * Bar placement 'top' moves the whole drawer (bar leading); 'bottom' keeps
 * the bar docked at the bottom and reveals the browser upward with a clip.
 *
 * Audio Player's drawer (plugins/audio-player/src/drawer.js before it moved
 * into frames) is where this came from. Kept free of Atmos imports so it can
 * be tested on its own; extension-frame-host.js wires it to a frame.
 */

export const BAR_PLACEMENTS = Object.freeze(['top', 'bottom']);

const FRICTION   = 0.93;  // high friction — gentle, controlled movement
const SPRING_K   = 0.12;  // soft spring
const SPRING_D   = 0.80;
const VEL_THRESH = 1.5;
const HIDDEN_GAP = 70;    // travel below BAR before the bar is fully hidden

/**
 * @param {object} els
 * @param {HTMLElement} els.surface  the pass-through surface filling the workspace
 * @param {HTMLElement} els.drawer   the moving element (holds the frame)
 * @param {object} options
 * @param {number} options.barHeight           the bar's height in px
 * @param {number} [options.placement]         saved placement (0–2); default 1
 * @param {'top'|'bottom'} [options.barPlacement]
 * @param {(state) => void} [options.onState]  open/expanded/placement changes
 * @param {(visible: number) => void} [options.onVisible]  visible browser height, every frame it changes
 * @param {(placement: number) => void} [options.onSettle] a gesture came to rest
 */
export function createPanelDrawer({ surface, drawer }, {
  barHeight = 54, placement = 1, barPlacement = 'top', onState, onVisible, onSettle,
} = {}) {
  let pos = null;
  let vel = 0;
  let raf = null;
  let snapsCache = null;
  let bar = 'top';
  // Set when a caller asks for a specific snap (open/close/expand/collapse).
  // While set, the settle logic honours it instead of inferring intent from
  // decayed velocity. Cleared as soon as the user takes over (wheel/swipe).
  let explicitTarget = null;
  let open = false;
  let expanded = false;
  let lastVisible = -1;
  let disposed = false;

  const snaps = () => {
    if (snapsCache) return snapsCache;
    const height = Math.max(0, Math.ceil(surface.clientHeight) - barHeight);
    return (snapsCache = [height + HIDDEN_GAP, height]);
  };
  const invalidate = () => { snapsCache = null; };

  function apply(y) {
    if (bar === 'bottom') {
      // Keep the drawer still and reveal it from the bottom.
      drawer.style.transform = 'none';
      drawer.style.clipPath = `inset(${Math.max(0, y)}px 0 0 0)`;
    } else {
      drawer.style.clipPath = 'none';
      drawer.style.transform = `translateY(${y}px)`;
    }
    const visible = Math.max(0, Math.round(surface.clientHeight - y - barHeight));
    if (visible !== lastVisible) {
      lastVisible = visible;
      surface.style.setProperty('--atmos-drawer-visible-h', `${visible}px`);
      onVisible?.(visible);
    }
  }

  function state() {
    return Object.freeze({ open, expanded, placement: getPlacement(), barPlacement: bar, locked: false });
  }
  const emit = () => { if (!disposed) onState?.(state()); };

  function setClasses() {
    drawer.classList.toggle('open', open);
    drawer.classList.toggle('expanded', expanded);
  }

  function sync(y) {
    const [HIDDEN, BAR] = snaps();
    const nextOpen = y < HIDDEN - 15;
    const nextExpanded = y < BAR - 15 && nextOpen;
    if (nextOpen === open && nextExpanded === expanded) return;
    open = nextOpen;
    expanded = nextExpanded;
    setClasses();
    emit();
  }

  function tick() {
    const [HIDDEN, BAR] = snaps();
    vel *= FRICTION;
    pos += vel;

    // Reaching the top is a terminal snap, not an elastic collision.
    if (pos < 0)      { pos = 0;      vel = 0; }
    if (pos > HIDDEN) { pos = HIDDEN; vel = 0; }

    // Between HIDDEN and BAR apply heavy extra drag so the drawer always
    // slows to a decision rather than shooting through.
    if (pos > BAR && pos < HIDDEN) vel *= 0.80;

    if (Math.abs(vel) < VEL_THRESH) {
      if (pos <= BAR) {
        // Above BAR: free float, just stop.
        if (Math.abs(vel) < 0.15) return settle(pos);
      } else {
        // Transition zone: snap to HIDDEN or BAR. An explicit request wins
        // over the momentum heuristic, which is for organic movement.
        const target = explicitTarget !== null
          ? explicitTarget
          : (pos > BAR + (HIDDEN - BAR) * 0.82) ? HIDDEN : BAR;
        vel = (vel + (target - pos) * SPRING_K) * SPRING_D;
        if (Math.abs(pos - target) < 0.4 && Math.abs(vel) < 0.2) return settle(target);
      }
    }

    apply(pos);
    // While gliding to a requested snap, the state the command set stands;
    // only free (wheel, swipe) movement redraws open/expanded as it goes.
    if (explicitTarget === null) sync(pos);
    raf = requestAnimationFrame(tick);
  }

  function settle(y) {
    pos = y;
    vel = 0;
    explicitTarget = null;
    raf = null;
    apply(pos);
    sync(pos);
    if (!disposed) onSettle?.(getPlacement());
  }

  function pin(y) {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    explicitTarget = null;
    vel = 0;
    pos = y;
    apply(y);
    sync(y);
  }

  function nudgeTo(target) {
    if (disposed) return;
    if (pos === null) pos = snaps()[0];
    explicitTarget = target;
    vel = (target - pos) * 0.18;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** 0 = fully open, 1 = BAR, 2 = hidden; fractions are free-floating positions. */
  function getPlacement() {
    if (!Number.isFinite(pos)) return null;
    const [HIDDEN, BAR] = snaps();
    if (pos <= BAR) return BAR > 0 ? Math.max(0, Math.min(1, pos / BAR)) : 0;
    const transition = HIDDEN - BAR;
    return transition > 0 ? Math.max(1, Math.min(2, 1 + (pos - BAR) / transition)) : 1;
  }

  function setPlacement(value) {
    if (disposed || !Number.isFinite(value)) return;
    const [HIDDEN, BAR] = snaps();
    const normalized = Math.max(0, Math.min(2, value));
    pin(normalized <= 1 ? normalized * BAR : BAR + (normalized - 1) * (HIDDEN - BAR));
  }

  function setBarPlacement(value) {
    if (!BAR_PLACEMENTS.includes(value)) throw new TypeError(`bar placement must be one of ${BAR_PLACEMENTS.join(', ')}`);
    if (value === bar) return;
    bar = value;
    drawer.dataset.barPlacement = value;
    if (pos !== null) apply(pos);
    emit();
  }

  /** A wheel turn outside the frame's scrolling area. */
  function wheel(rawDeltaY, deltaMode = 0) {
    if (disposed || !Number.isFinite(rawDeltaY)) return;
    const [, BAR] = snaps();
    if (pos === null) pos = snaps()[0];
    explicitTarget = null; // the user is driving; let momentum decide
    const delta = deltaMode === 1 ? rawDeltaY * 33 : rawDeltaY;
    const nudge = delta * 0.012;
    // Below BAR, cap upward velocity so one burst stops at BAR first.
    if (pos > BAR && nudge < 0) {
      const maxVelToReachBar = (pos - BAR) * 0.18;
      vel = Math.max(vel + nudge, -maxVelToReachBar);
    } else {
      vel += nudge;
    }
    vel = Math.max(-16, Math.min(16, vel));
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** Keep the saved placement when the workspace changes size. */
  function resized() {
    const keep = getPlacement();
    invalidate();
    if (Number.isFinite(keep)) setPlacement(keep);
  }

  /** Raise to BAR (open, not expanded). */
  function openDrawer() {
    const changed = !open;
    open = true;
    setClasses();
    if (changed) emit();
    nudgeTo(snaps()[1]);
  }

  /** Drop fully out of view. */
  function closeDrawer() {
    const changed = open || expanded;
    open = false;
    expanded = false;
    setClasses();
    if (changed) emit();
    nudgeTo(snaps()[0]);
  }

  /** Raise fully open (implies open). */
  function expandDrawer() {
    const changed = !open || !expanded;
    open = true;
    expanded = true;
    setClasses();
    if (changed) emit();
    nudgeTo(0);
  }

  /** Back down to BAR (stays open). */
  function collapseDrawer() {
    const changed = expanded;
    expanded = false;
    setClasses();
    if (changed) emit();
    nudgeTo(snaps()[1]);
  }

  function dispose() {
    if (disposed) return;
    // Keep a drawer that is still gliding where it currently is.
    if (raf) onSettle?.(getPlacement());
    disposed = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  bar = BAR_PLACEMENTS.includes(barPlacement) ? barPlacement : 'top';
  drawer.dataset.barPlacement = bar;
  // Start hidden, then go to the saved placement.
  pin(snaps()[0]);
  setPlacement(Number.isFinite(placement) ? placement : 1);

  return {
    state, getPlacement, setPlacement, setBarPlacement, wheel, resized,
    open: openDrawer, close: closeDrawer, expand: expandDrawer, collapse: collapseDrawer,
    dispose,
    get barPlacement() { return bar; },
    get isOpen() { return open; },
  };
}

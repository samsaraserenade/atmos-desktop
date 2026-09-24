/**
 * Recently used panels and the mouse back-button gesture: a quick press
 * cycles through panels, holding it opens Task View.
 */

// Wired by panel-registry.js; kept as callbacks so this module does not
// import the registry back.
let _registry = { isRegistered: () => false, ids: () => [], activeId: () => null, activate() {} };

export function bindPanelHistory(registry) { _registry = registry; }

// MRU stack of ids the panel has *left*, most-recently-left first. Replaces
// what used to be a single `_previousId` slot — same idea (activate() pushes
// the outgoing id onto it), just deep enough to walk further back than one
// step. getPreviousPanelPluginId()/activatePreviousPanelPlugin() below keep
// treating index 0 as "the" previous plugin, so nothing that already called
// those two changes behavior — this is additive, for cyclePanelPlugin().
let _history = [];

// Deliberately small — this is a "recently used" list for a quick-switch
// gesture, not a full session log. Trimmed on every push, and pruned of
// unregistered ids lazily (see liveHistory()) rather than eagerly on
// unregister, since there's no unregisterPanelPlugin() for it to hook into
// today.
const _MAX_HISTORY = 8;

export function liveHistory() {
  return _history.filter(id => _registry.isRegistered(id));
}

export function pushHistory(id) {
  if (id === null) return;
  _history = [id, ..._history.filter(existing => existing !== id)].slice(0, _MAX_HISTORY);
}

// ── Mouse back button → cycle / hold for Task View ────────────────────────
// Button 3 is "back" on a standard 5-button mouse (4 is "forward" — left
// alone here, same as before). A quick press cycles; holding opens the visual
// Task View without changing the active plugin.
//
// Recently used panels stay first, preserving the quick back-and-forth
// behavior, then any registered panels that have not been opened yet are
// appended in registration order. Registration itself is lightweight;
// activatePanelPlugin() still mounts only the panel selected by the user.
// Repeated presses within _CYCLE_WINDOW_MS continue through the same fixed
// snapshot, while a longer pause starts a fresh cycle from the active panel.
//
// The snapshot is taken once, at the first press of a burst, rather than
// re-read from live _history on every step — re-reading would make each
// step's target keep shifting under you as activatePanelPlugin() mutates
// _history on every switch. Stepping through a fixed snapshot means a long
// burst eventually wraps back around to the plugin you started the burst
// on, which mirrors Alt-Tab's own "cycle all the way through and end up
// back where you began" behavior and doubles as an easy way to bail out of
// a burst you didn't mean to start.
const _CYCLE_WINDOW_MS = 650;

let _cycleSnapshot = null; // ids array for the current burst, or null between bursts
let _cycleStep     = 0;
let _cycleTimer    = null;

function _endCycleSession() {
  _cycleTimer = null;
  _cycleSnapshot = null;
  _cycleStep = 0;
}

function cyclePanelPlugin() {
  if (_cycleTimer === null) {
    // First press of a new burst — put the active panel first, followed by
    // live MRU history, then every registered panel that has not appeared
    // in either. This makes never-before-opened panels immediately reachable.
    const activeId = _registry.activeId();
    const base = activeId !== null ? [activeId] : [];
    const recent = liveHistory().filter(id => id !== activeId);
    const included = new Set([...base, ...recent]);
    const remaining = _registry.ids().filter(id => !included.has(id));
    _cycleSnapshot = [...base, ...recent, ...remaining];
    _cycleStep = 0;
  }

  clearTimeout(_cycleTimer);
  _cycleTimer = setTimeout(_endCycleSession, _CYCLE_WINDOW_MS);

  if (!_cycleSnapshot || _cycleSnapshot.length < 2) return; // nothing to cycle to

  _cycleStep = (_cycleStep + 1) % _cycleSnapshot.length;
  _registry.activate(_cycleSnapshot[_cycleStep]);
}

// `mousedown`/`mouseup`, not `click`/`auxclick`: browsers and Electron's
// default window behavior treat buttons 3/4 as page-navigation history, and
// preventDefault() only stops that if it starts on mousedown.
//
// Wired at module scope (not behind a boot hook) because, same as this
// registry's lazy element lookup, the listener itself doesn't touch
// the DOM until it actually fires — by which point boot has long finished.
const _TASK_VIEW_HOLD_MS = 100;
let _backButtonDown = false;
let _backButtonHeld = false;
let _backButtonHoldTimer = null;

function _clearBackButtonHold() {
  clearTimeout(_backButtonHoldTimer);
  _backButtonHoldTimer = null;
}

document.addEventListener('mousedown', event => {
  if (event.button !== 3 || _backButtonDown) return;
  event.preventDefault();
  _backButtonDown = true;
  _backButtonHeld = false;
  _backButtonHoldTimer = setTimeout(() => {
    _backButtonHoldTimer = null;
    if (!_backButtonDown) return;
    _backButtonHeld = true;
    window.dispatchEvent(new CustomEvent('atmos:open-task-view', {
      detail: { source: 'mouse-back-hold' },
    }));
  }, _TASK_VIEW_HOLD_MS);
});

document.addEventListener('mouseup', event => {
  if (event.button !== 3 || !_backButtonDown) return;
  event.preventDefault();
  _clearBackButtonHold();
  _backButtonDown = false;
  if (!_backButtonHeld) cyclePanelPlugin();
  _backButtonHeld = false;
});

document.addEventListener('auxclick', event => {
  if (event.button === 3) event.preventDefault();
});

window.addEventListener('blur', () => {
  _clearBackButtonHold();
  _backButtonDown = false;
  _backButtonHeld = false;
});

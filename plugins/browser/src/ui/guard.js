/**
 * What the browser draws over a page for the user to answer (a site's
 * permission question, a link to another program, a blocked pop-up or
 * download, a finished download's Open) takes no answer the moment it
 * appears. The page decides when that is and knows where it's drawn, so it
 * could make it appear under the pointer between two quick clicks the user
 * is making on the page, and the second would land on Allow. Chrome guards
 * its prompts the same way.
 *
 *   wait   an answer counts only GUARD_MS after the prompt appeared; one
 *          that comes sooner is taken for the user's clicking on the page
 *          and starts the wait again
 *   move   a mouse click counts only once the pointer has moved over the
 *          prompt since it appeared (a prompt appearing under a still
 *          pointer gets no pointer move); keys and taps need only the wait
 */
export const GUARD_MS = 500;

export function createGuard({ ms = GUARD_MS, now = () => performance.now() } = {}) {
  let readyAt = 0;
  let moved = true;
  return {
    /** The prompt just appeared, or now asks something else: wait again. */
    arm() {
      readyAt = now() + ms;
      moved = false;
    },
    /** A pointermove over the prompt: a mouse that really moved (a page can't move it). */
    pointer(event) {
      if (event?.pointerType !== 'mouse' || event.movementX || event.movementY) moved = true;
    },
    /** Whether this click (or key) is an answer; one that comes too soon starts the wait again. */
    accepts(event) {
      const time = now();
      if (time < readyAt) {
        readyAt = time + ms;
        return false;
      }
      return !(event?.pointerType === 'mouse' && !moved);
    },
  };
}

/** `button` answers through `guard`: `run` only for a click (or key) it accepts. */
export function guardedClick(guard, button, run) {
  button.addEventListener('click', event => {
    if (!guard.accepts(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    run(event);
  });
}

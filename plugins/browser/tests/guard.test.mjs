// The guard on what the browser asks over a page (src/ui/guard.js): no
// answer the moment a prompt appears, nor a mouse click before the pointer
// has moved onto it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, GUARD_MS } from '../src/ui/guard.js';

const mouse = (movementX = 0, movementY = 0) => ({ pointerType: 'mouse', movementX, movementY });
const key = { pointerType: '' };
const touch = { pointerType: 'touch' };

test('an answer counts only once the prompt has been up a moment; an early one starts the wait again', () => {
  let clock = 1000;
  const guard = createGuard({ now: () => clock });
  guard.arm();
  assert.equal(guard.accepts(key), false, 'at once');
  clock += GUARD_MS - 1;
  assert.equal(guard.accepts(key), false, 'just before');
  // That early click was taken for the user still clicking the page: the wait starts again.
  clock += 2;
  assert.equal(guard.accepts(key), false, 'the wait started again');
  clock += GUARD_MS;
  assert.equal(guard.accepts(key), true);
  assert.equal(guard.accepts(touch), true, 'a tap needs only the wait');
});

test('a mouse click counts only after the pointer moved over the prompt (not a prompt appearing under a still pointer)', () => {
  let clock = 1000;
  const guard = createGuard({ now: () => clock });
  guard.arm();
  clock += GUARD_MS + 1;
  assert.equal(guard.accepts(mouse()), false, 'no move yet');
  guard.pointer(mouse(0, 0));
  assert.equal(guard.accepts(mouse()), false, 'a pointer event without movement (the page drawn under it)');
  guard.pointer(mouse(3, -1));
  assert.equal(guard.accepts(mouse()), true);
  // A new question: wait, and move, again.
  guard.arm();
  clock += GUARD_MS + 1;
  assert.equal(guard.accepts(mouse()), false);
  assert.equal(guard.accepts(key), true, 'the keyboard needs no pointer');
});

test('never armed (nothing asked yet): no wait', () => {
  const guard = createGuard({ now: () => 5 });
  assert.equal(guard.accepts(key), true);
  assert.equal(guard.accepts(mouse()), true);
});

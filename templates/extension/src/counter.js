// The count, in atmos.state: small JSON shared by every frame of this
// extension and saved by Atmos. (Two frames clicking at the same moment can
// lose one click; keep anything that matters in one frame, such as boot.js.)
import atmos from 'atmos-sdk';

export async function getCount() {
  return (await atmos.state.get()).count ?? 0;
}

export async function increment() {
  const count = (await getCount()) + 1;
  await atmos.state.update({ count });
  return count;
}

export async function reset() {
  await atmos.state.update({ count: 0 });
}

/** Calls fn(count) when another frame changes it. Returns the unsubscribe. */
export function onCount(fn) {
  return atmos.state.onChange(state => fn(state.count ?? 0));
}

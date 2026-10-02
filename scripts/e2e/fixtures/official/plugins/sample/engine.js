import atmos from 'atmos-sdk';

/** Counts the starts in atmos.state, so a check can see the state is kept. */
export async function start() {
  const state = await atmos.state.get();
  await atmos.state.update({ starts: (state.starts ?? 0) + 1 });
}

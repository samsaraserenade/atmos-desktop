/**
 * Which song plays next in the queue. `ended`: the song ended by itself,
 * so repeat one plays it again, and at the end of the queue repeat off
 * stops (null). Not ended (Next pressed): always another song, going round
 * at the end. Shuffled, any other song at random.
 */
export function nextIndex({ index, length, repeatMode, shuffleOn, ended = false, random = Math.random }) {
  if (!(length > 0)) return null;
  if (ended && repeatMode === 'one') return index;
  const atEnd = shuffleOn ? length === 1 : index + 1 >= length;
  if (atEnd && ended && repeatMode === 'none') return null;
  if (!shuffleOn) return atEnd ? 0 : index + 1;
  if (length === 1) return 0;
  let next;
  do { next = Math.floor(random() * length); } while (next === index);
  return next;
}

/**
 * Which panel Atmos opens on (panel-registry.js), decided as panels register:
 *
 *   2  one of the extensions Atmos ships with (core/built-in-extensions.json:
 *      Atmos Browser), so the browser is what a new Atmos opens on;
 *   1  a panel whose manifest says "default": true;
 *   0  any other, the first registered.
 *
 * A higher rank takes over. Two claims of the same rank keep the first
 * registered, and the other is reported, not refused: before 0.18 a second
 * "default": true threw, and the second extension's panel was lost.
 *
 * @param {{ id: string, rank: number } | null} current  the default so far
 * @param {{ id: string, builtIn?: boolean, declared?: boolean }} panel  the panel registering
 * @returns {{ id: string, rank: number, ignored: string | null }}  the default now, and a claim passed over
 */
export function nextDefault(current, { id, builtIn = false, declared = false }) {
  const rank = builtIn === true ? 2 : declared === true ? 1 : 0;
  if (!current || rank > current.rank) return { id, rank, ignored: null };
  return { id: current.id, rank: current.rank, ignored: rank > 0 && rank === current.rank ? id : null };
}

/**
 * What a portfolio server before 0.8 leaves out of a holding. It doesn't say
 * a holding's group (meta.group), and the oldest don't say a Hyperliquid
 * cash row's instrument either. Only Hyperliquid had either, so this is the
 * one place Finance knows its name; the server does the same for the rows it
 * stored (server.py _legacy_meta). Delete this once no server that old is
 * left.
 */

const LEGACY_GROUPED_SOURCE = 'hyperliquid-wallet';

/** The group an old server's holding belongs to, or null. */
export function legacyGroup(sourceId, holding) {
  if (sourceId !== LEGACY_GROUPED_SOURCE || holding?.meta?.group) return null;
  if (holding?.meta?.account === 'earn') return 'earn';
  return ['perp', 'perp-cash'].includes(holding?.meta?.instrument) ? 'perp' : null;
}

/** Whether a holding that says no instrument is in an old Hyperliquid account's Perp balance. */
export function legacyIsPerp(sourceId, holding) {
  return /hyperliquid/i.test(sourceId) &&
    (holding?.kind === 'cash' || /\bperp\b/i.test(holding?.symbol || ''));
}

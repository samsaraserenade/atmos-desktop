/**
 * Who really sent a message, and whose identity changed.
 *
 * Encryption keeps a server from reading messages, but it only protects you
 * if you can tell when something is off: a message from a device its owner
 * never verified, from a device that no longer exists, sent unencrypted in
 * an encrypted room, or from someone whose keys suddenly changed (which is
 * what a hijacked account or a meddling homeserver looks like). This turns
 * the SDK's verdicts into short warnings for the timeline and the room view.
 *
 * Messages from people you simply haven't verified show nothing — the SDK
 * only raises those when they matter (non-strict mode), as Element does.
 */

// matrix-js-sdk's EventShieldColour and EventShieldReason (crypto-api):
// numeric enums its bundle's index doesn't re-export. Order pinned by
// tests/trust.test.mjs against the SDK source.
export const SHIELD_COLOUR = Object.freeze({ NONE: 0, GREY: 1, RED: 2 });
export const SHIELD_REASON_TEXT = Object.freeze([
  /* UNKNOWN */ 'Atmos can\'t confirm who sent this.',
  /* UNVERIFIED_IDENTITY */ 'Sent by someone you haven\'t verified.',
  /* UNSIGNED_DEVICE */ 'Sent from a device its owner hasn\'t verified.',
  /* UNKNOWN_DEVICE */ 'Sent from an unknown or deleted device.',
  /* AUTHENTICITY_NOT_GUARANTEED */ 'Restored from key backup, so who sent it can\'t be confirmed.',
  /* MISMATCHED_SENDER_KEY */ 'The sender doesn\'t match how this was encrypted. It may be forged.',
  /* SENT_IN_CLEAR */ 'Sent without encryption.',
  /* VERIFICATION_VIOLATION */ 'The sender\'s verified identity has changed.',
  /* MISMATCHED_SENDER */ 'The sender doesn\'t match how this was encrypted. It may be forged.',
]);

const MESSAGE_TYPES = new Set(['m.room.message', 'm.sticker']);

/** The SDK's EventEncryptionInfo as a warning: null, or { level: 'warning' | 'danger', text }. */
export function describeShield(info) {
  if (!info || info.shieldColour === SHIELD_COLOUR.NONE || info.shieldColour == null) return null;
  return {
    level: info.shieldColour === SHIELD_COLOUR.RED ? 'danger' : 'warning',
    text: SHIELD_REASON_TEXT[info.shieldReason] || SHIELD_REASON_TEXT[0],
  };
}

export function createTrustService(runtime) {
  const client = runtime.client;
  const crypto = () => client.getCrypto?.() || null;

  /** A warning for one timeline event, or null. */
  async function eventTrust(event) {
    const api = crypto();
    if (!api || !event || event.status != null || event.isRedacted?.() || event.isState?.()) return null;
    if (!MESSAGE_TYPES.has(event.getType())) return null;
    if (!event.isEncrypted()) {
      // Anyone can post in the clear, even in an encrypted room; say so.
      const encryptedRoom = await api.isEncryptionEnabledInRoom(event.getRoomId());
      runtime.assertCurrent();
      return encryptedRoom ? { level: 'danger', text: 'Sent without encryption in an encrypted room.' } : null;
    }
    if (event.isDecryptionFailure?.()) return null; // already shown as unreadable
    const info = await api.getEncryptionInfoForEvent(event);
    runtime.assertCurrent();
    return describeShield(info);
  }

  /** Room members whose cryptographic identity changed since you last saw it. */
  async function identityChanges(room) {
    const api = crypto();
    if (!api || !room) return [];
    const self = client.getUserId();
    const members = (room.getJoinedMembers?.() || []).filter(member => member.userId !== self).slice(0, 200);
    const changed = [];
    for (const member of members) {
      const status = await api.getUserVerificationStatus(member.userId);
      if (status?.needsUserApproval) {
        changed.push({ userId: member.userId, name: member.name || member.userId, wasVerified: Boolean(status.wasCrossSigningVerified?.()) });
      }
    }
    runtime.assertCurrent();
    return changed;
  }

  /** Accept someone's new identity once you've been told about it. */
  async function acceptIdentityChange(userId) {
    const api = crypto();
    if (!api) throw new Error('matrix-chat: encryption is not ready');
    const status = await api.getUserVerificationStatus(userId);
    // Someone you had verified: stop requiring the old verification (you can
    // verify them again later). Otherwise: remember the new identity.
    if (status.wasCrossSigningVerified?.() && !status.isCrossSigningVerified?.()) await api.withdrawVerificationRequirement(userId);
    else await api.pinCurrentUserIdentity(userId);
    runtime.assertCurrent();
  }

  return { eventTrust, identityChanges, acceptIdentityChange };
}

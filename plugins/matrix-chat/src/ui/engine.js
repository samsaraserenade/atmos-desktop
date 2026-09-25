/**
 * The views' way into the Matrix engine, which runs in Matrix Chat's
 * background frame (boot.js). The panel and the Rooms widget are frames on
 * the same origin, so they call its functions and read its live SDK objects
 * (rooms, events) directly; nothing is copied across.
 *
 * Two things to keep in mind in the views:
 *   - Objects from the engine belong to the background frame's realm, so
 *     `x instanceof Array` (or Error, Blob…) is false for them here. Use
 *     Array.isArray and duck typing.
 *   - Listeners given to the engine outlive this frame unless removed. Every
 *     on…() here is tracked and removed when the frame goes away (pagehide),
 *     whatever the view's own cleanup did.
 */
import atmos from 'atmos-sdk';

async function findEngine() {
  const background = await atmos.background();
  const deadline = Date.now() + 20000;
  while (!background.__matrixEngine) {
    if (Date.now() > deadline) throw new Error('Matrix Chat\'s background frame did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return background.__matrixEngine;
}

export const engine = await findEngine();

const live = new Set();
function tracked(subscribe) {
  return fn => {
    const off = subscribe(fn);
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      live.delete(remove);
      try { off?.(); } catch { /* the engine is going too */ }
    };
    live.add(remove);
    return remove;
  };
}
addEventListener('pagehide', () => { for (const remove of [...live]) remove(); });

const c = engine.client;
const p = engine.preferences;

// Subscriptions (tracked).
export const onRoom = tracked(c.onRoom);
export const onTimeline = tracked(c.onTimeline);
export const onTimelineReset = tracked(c.onTimelineReset);
export const onDecrypted = tracked(c.onDecrypted);
export const onSync = tracked(c.onSync);
export const onReceipt = tracked(c.onReceipt);
export const onUnreadNotifications = tracked(c.onUnreadNotifications);
export const onLocalEcho = tracked(c.onLocalEcho);
export const onAccountChange = tracked(c.onAccountChange);
export const onDeviceTrustChange = tracked(c.onDeviceTrustChange);
export const onTrustChange = tracked(c.onTrustChange);
export const onNotificationSoundChanged = tracked(p.onNotificationSoundChanged);
export const onViewChange = tracked(engine.view.subscribe);
export const onPanelRequest = tracked(engine.view.subscribeRequests);

// Everything else is called straight through.
export const {
  acceptDirectRequest, acceptIdentityChange, acceptInvite, acknowledgeRecoveryKey, addFriend, cancelSignIn, getPendingRecoveryKey, getSecureMessagingStatus, getEventTrust, getIdentityChanges, saveTextFile, setUpSecureMessaging, getAccountManagementUrl, getSignInOptions, loginWithOAuth, openLink, addToSpace, browsePublicRooms, canAddToSpace,
  createRoom, createSpace, declineInvite, getInvites, getRoomPermissions, getSpaceChildren, inviteToRoom, joinByAddress, joinSpaceRoom,
  removeFromSpace, removeRoomAvatar, setRoomAvatar, setRoomName, crossSignThisDevice, decryptAttachmentFile,
  editTextMessage, fetchAvatarBytes, fetchMediaBytes, fetchOwnProfile, getCurrentDeviceVerification,
  getDirectRoomIds, getDisplayName, getEventById, getHomeserverUrl, getReadReceipts, getRooms,
  getSavedAccounts, getSessionIssue, getSignInNotice, getUserId, hasSession, importRoomKeyFile, invalidateEventCache,
  joinPublicRoom, leaveRoom, login, logout, markRoomRead, paginateBack, redactEvent, removeAccount,
  requestCurrentDeviceVerification, restoreFromRecoveryKey, sendFileMessage, sendReaction,
  sendTextMessage, stripReplyFallback, switchAccount, updateOwnProfile,
} = c;

export const {
  getNotificationSound, setNotificationSound,
} = p;

export const { relationsForEvent } = engine.relations;
export const { matrixState, save } = engine.state;

/** What the panel shows ({ type: 'none' } or { type: 'room', roomId }), shared by the panel and the sidebar widget. */
export const currentView = () => engine.view.get();
export const showRoom = roomId => engine.view.showRoom(roomId);
export const showNone = () => engine.view.showNone();
/** Ask the panel to act: { action: 'command', text, parentSpaceId } puts text in its message bar. */
export const askPanel = request => engine.view.ask(request);
export const takePanelRequest = () => engine.view.takeRequest();

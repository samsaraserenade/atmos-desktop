/**
 * The Matrix Account widget's contents (sidebar-account.js): from the top,
 *
 *   1. your saved accounts, to switch between or add one;
 *   2. your profile (picture, display name) and, for accounts whose
 *      homeserver manages them, a link to that account page;
 *   3. security: one card for where this device stands — set up secure
 *      messaging (new account), save the recovery key, confirm it's you
 *      (a new sign-in on an account that has encryption), or verified;
 *   4. log out (press and hold).
 *
 * The ping sound is the rev/notifications command (ui/command-bar.js).
 */

import {
  acknowledgeRecoveryKey, crossSignThisDevice, fetchAvatarBytes, fetchOwnProfile, getAccountManagementUrl,
  getCurrentDeviceVerification, getDisplayName, getHomeserverUrl, getPendingRecoveryKey, getSavedAccounts,
  getSecureMessagingStatus, getUserId, importRoomKeyFile, logout, onDeviceTrustChange, openLink, removeAccount,
  requestCurrentDeviceVerification, restoreFromRecoveryKey, saveTextFile, setUpSecureMessaging, switchAccount,
  updateOwnProfile,
} from './engine.js';
import { renderLogin } from './login.js';
export * from './engine.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const plainError = (error, fallback) => String(error?.message || fallback).replace(/^matrix-chat:\s*/, '');

// ── Avatars ──
// Inactive saved accounts have no live Matrix client, so their avatar can't
// be downloaded through the active account. A small copy is cached while
// each account is active.
const ACCOUNT_AVATAR_STORAGE_PREFIX = 'matrix-chat:account-avatar:';
const accountAvatarStorageKey = userId => `${ACCOUNT_AVATAR_STORAGE_PREFIX}${encodeURIComponent(userId)}`;

function loadCachedAccountAvatar(userId) {
  try {
    const value = localStorage.getItem(accountAvatarStorageKey(userId));
    return value?.startsWith('data:image/') ? value : null;
  } catch {
    return null;
  }
}

function saveCachedAccountAvatar(userId, value) {
  try {
    // A 48px avatar is tiny; the ceiling keeps a malformed response from
    // filling the plugin's storage.
    if (value?.startsWith('data:image/') && value.length < 200_000) localStorage.setItem(accountAvatarStorageKey(userId), value);
  } catch { /* the live avatar still shows */ }
}

function avatarMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/png';
}

function avatarDataUrl(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not cache avatar'));
    reader.readAsDataURL(new Blob([bytes], { type: avatarMime(bytes) }));
  });
}

/** Initial and hue for an account's fallback avatar. */
function initialAndHue(userId) {
  const label = userId || '?';
  const initial = (label.replace(/^@/, '').trim()[0] || '?').toUpperCase();
  let hue = 0;
  for (const c of label) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return { initial, hue };
}

const avatarInner = (url, initial) => (url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(initial));

// ── Markup ──
function switcherHtml(accounts, activeId) {
  return `
    <div class="mx-settings-switcher" role="list" aria-label="Accounts">
      ${accounts.map(account => {
        const isActive = account.userId === activeId;
        const { initial, hue } = initialAndHue(account.userId);
        return `
          <div class="mx-settings-switcher-item${isActive ? ' active' : ''}" role="listitem" data-action="${isActive ? '' : 'switch-account'}" data-user-id="${escapeHtml(account.userId)}" title="${escapeHtml(isActive ? `${account.userId} (signed in)` : `Switch to ${account.userId}`)}">
            <div class="mx-settings-switcher-avatar" style="--mx-avatar-hue: ${hue}">${avatarInner(loadCachedAccountAvatar(account.userId), initial)}</div>
            ${isActive ? '' : `<button type="button" class="mx-settings-switcher-remove" data-action="remove-account" data-user-id="${escapeHtml(account.userId)}" aria-label="Remove ${escapeHtml(account.userId)} from this device" title="Remove from this device">&times;</button>`}
          </div>`;
      }).join('')}
      <button type="button" class="mx-settings-switcher-add" data-action="toggle-add-account" aria-expanded="false" aria-label="Add another account" title="Add another account">+</button>
    </div>
    <div class="mx-settings-switcher-status" aria-live="polite"></div>
    <div class="mx-settings-add-account" hidden><div class="mx-settings-add-account-inner"></div></div>`;
}

function profileHtml({ userId, displayName, homeserver, accountUrl }) {
  const { initial, hue } = initialAndHue(userId);
  return `
    <div class="mx-acct-profile">
      <div class="mx-settings-account">
        <button type="button" class="mx-settings-avatar mx-settings-avatar-edit" data-action="choose-avatar" style="--mx-avatar-hue: ${hue}" aria-label="Change profile picture" title="Change profile picture">${avatarInner(loadCachedAccountAvatar(userId), initial)}<span aria-hidden="true">Edit</span></button>
        <div class="mx-settings-account-info">
          <input class="mx-settings-account-name mx-settings-profile-name" value="${escapeHtml(displayName)}" maxlength="255" autocomplete="nickname" aria-label="Display name" title="Edit display name">
          <div class="mx-settings-account-id">${escapeHtml(userId)}</div>
          <div class="mx-acct-meta">
            ${homeserver ? `<span>${escapeHtml(homeserver.replace(/^https?:\/\//, ''))}</span>` : ''}
            ${accountUrl ? `<button type="button" class="mx-acct-link" data-action="manage-account" title="Password, email and devices, in your browser">Manage account ↗</button>` : ''}
          </div>
        </div>
        <button type="button" class="mx-settings-profile-save" data-action="save-profile" aria-label="Save profile" title="Save profile" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4 4L19 6.5"/></svg></button>
      </div>
      <input type="file" class="mx-settings-avatar-input" accept="image/*" hidden>
      <div class="mx-settings-profile-status" aria-live="polite"></div>
    </div>`;
}

function securityHtml() {
  return `
    <section class="mx-acct-security" data-view="checking" aria-label="Security">
      <div class="mx-acct-heading">Security</div>

      <div class="mx-acct-card" data-card="checking"><div class="mx-acct-copy">Checking this device…</div></div>

      <div class="mx-acct-card" data-card="setup" hidden>
        <div class="mx-acct-title">Set up secure messaging</div>
        <div class="mx-acct-copy">Create the keys that protect your encrypted chats. You'll get a recovery key to keep, for signing in on other devices.</div>
        <button type="button" class="mx-acct-primary" data-action="setup-secure-messaging">Set up</button>
      </div>

      <div class="mx-acct-card" data-card="key" hidden>
        <div class="mx-acct-title">Save your recovery key</div>
        <div class="mx-acct-copy">You'll need it to read your messages on a new device. Keep it somewhere safe, like a password manager. Atmos won't show it again.</div>
        <code class="mx-settings-recovery-key" aria-label="Recovery key"></code>
        <div class="mx-acct-actions">
          <button type="button" class="mx-acct-secondary" data-action="copy-recovery-key">Copy</button>
          <button type="button" class="mx-acct-secondary" data-action="save-recovery-key">Save as file</button>
        </div>
        <label class="mx-acct-check"><input type="checkbox" data-action="confirm-recovery-key"> I've saved my recovery key</label>
        <button type="button" class="mx-acct-primary" data-action="finish-recovery-key" disabled>Done</button>
      </div>

      <div class="mx-acct-card" data-card="confirm" hidden>
        <div class="mx-acct-title">Confirm it's you</div>
        <div class="mx-acct-copy">This is a new sign-in. Enter your recovery key to unlock your encrypted messages here, or approve it from another device you're signed in on.</div>
        <input type="password" class="mx-acct-input" data-field="recovery" placeholder="Recovery key" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Recovery key">
        <div class="mx-acct-actions">
          <button type="button" class="mx-acct-primary" data-action="submit-recovery-key">Confirm</button>
          <button type="button" class="mx-acct-secondary" data-action="verify-device">Use another device</button>
        </div>
        <button type="button" class="mx-acct-link" data-action="import-key-file">Import a key file instead</button>
        <input type="file" class="mx-settings-recovery-file-input" accept=".txt,.key,text/plain" hidden>
        <div class="mx-settings-sas" hidden>
          <div class="mx-acct-title">Do these emoji match?</div>
          <div class="mx-acct-copy">Compare them with the ones on your other device.</div>
          <div class="mx-settings-sas-emoji"></div>
          <div class="mx-acct-actions">
            <button type="button" class="mx-acct-primary" data-action="sas-match">They match</button>
            <button type="button" class="mx-acct-secondary" data-action="sas-mismatch">They don't</button>
          </div>
        </div>
      </div>

      <div class="mx-acct-card mx-acct-verified" data-card="verified" hidden>
        <div>
          <div class="mx-acct-title">This device</div>
          <div class="mx-acct-device-id"></div>
        </div>
        <span class="mx-settings-device-badge verified">Verified</span>
      </div>

      <div class="mx-acct-status" aria-live="polite"></div>
    </section>`;
}

/**
 * Render the widget into `container`. onLogout runs after logout() has
 * ended the session. Returns a cleanup function, which stays valid across
 * the widget redrawing itself (after removing an account, say).
 */
export function renderSettingsDashboard(container, { onLogout } = {}) {
  let current = null;
  const redraw = () => {
    current?.();
    current = drawDashboard(container, { onLogout, redraw });
  };
  redraw();
  return () => { current?.(); current = null; };
}

function drawDashboard(container, { onLogout, redraw }) {
  container.innerHTML = '';
  const userId = getUserId();
  const accountUrl = getAccountManagementUrl();
  const root = document.createElement('div');
  root.className = 'mx-settings-menu mx-settings-menu-embedded mx-acct';
  root.innerHTML = `
    ${switcherHtml(getSavedAccounts(), userId)}
    ${profileHtml({ userId, displayName: getDisplayName(userId) || userId || 'Unknown user', homeserver: getHomeserverUrl(), accountUrl })}
    ${securityHtml()}
    <button type="button" class="mx-settings-logout" data-action="logout" title="Press and hold to log out"><span>Log out</span><span class="mx-settings-hold-hint">Hold</span></button>
  `;
  container.appendChild(root);

  const $ = selector => root.querySelector(selector);
  const alive = () => root.isConnected;
  const rerender = () => { if (alive()) redraw(); };
  const cleanups = [];

  // ── Accounts ──
  const switcherStatus = $('.mx-settings-switcher-status');
  const addAccountWrap = $('.mx-settings-add-account');
  const addToggle = $('[data-action="toggle-add-account"]');
  let loginCleanup = null;
  function toggleAddAccount() {
    const open = addAccountWrap.hidden;
    addAccountWrap.hidden = !open;
    addToggle.setAttribute('aria-expanded', String(open));
    // Built when opened, so the homeserver isn't probed every time the widget draws.
    if (open && !loginCleanup) loginCleanup = renderLogin($('.mx-settings-add-account-inner'), { showSavedAccounts: false, onSuccess: rerender }) || (() => {});
    if (open) addAccountWrap.querySelector('input')?.focus();
  }
  cleanups.push(() => loginCleanup?.());

  function switchTo(item) {
    item.style.pointerEvents = 'none';
    switcherStatus.classList.remove('mx-settings-switcher-status-error');
    switcherStatus.textContent = 'Switching account…';
    switchAccount(item.dataset.userId).then(rerender).catch(error => {
      console.error('[matrix-chat] account switch failed', error);
      if (!alive()) return;
      switcherStatus.textContent = plainError(error, 'Could not switch accounts.');
      switcherStatus.classList.add('mx-settings-switcher-status-error');
      item.style.pointerEvents = '';
    });
  }

  // ── Profile ──
  const nameInput = $('.mx-settings-profile-name');
  const avatarInput = $('.mx-settings-avatar-input');
  const profileSave = $('.mx-settings-profile-save');
  const profileStatus = $('.mx-settings-profile-status');
  const savedName = nameInput.value;
  let selectedAvatarFile = null;
  let nameEdited = false;
  const showProfileStatus = (text, error = false) => {
    profileStatus.textContent = text;
    profileStatus.classList.toggle('mx-settings-profile-status-error', error);
  };
  const updateSaveButton = () => { profileSave.hidden = !selectedAvatarFile && nameInput.value.trim() === savedName; };

  nameInput.addEventListener('input', () => { nameEdited = true; updateSaveButton(); });
  nameInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !profileSave.hidden) saveProfile(); });
  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) {
      showProfileStatus(file.size > 10 * 1024 * 1024 ? 'Profile pictures must be 10 MB or smaller.' : 'Choose an image file.', true);
      avatarInput.value = '';
      return;
    }
    selectedAvatarFile = file;
    showProfileStatus('Save to use this picture.');
    updateSaveButton();
    const reader = new FileReader();
    reader.onload = () => {
      if (!alive()) return;
      $('.mx-settings-avatar').innerHTML = `<img src="${escapeHtml(reader.result)}" alt=""><span aria-hidden="true">Edit</span>`;
    };
    reader.readAsDataURL(file);
  });

  function saveProfile() {
    const nextName = nameInput.value.trim();
    if (!nextName) { showProfileStatus('Display name can\'t be empty.', true); return; }
    profileSave.disabled = nameInput.disabled = true;
    showProfileStatus('Saving…');
    updateOwnProfile({ displayName: nextName, avatarFile: selectedAvatarFile })
      .then(() => {
        if (!alive()) return;
        if (selectedAvatarFile) saveCachedAccountAvatar(userId, $('.mx-settings-avatar img')?.src);
        showProfileStatus('Saved.');
        setTimeout(rerender, 350);
      })
      .catch(error => {
        if (!alive()) return;
        showProfileStatus(plainError(error, 'Could not update your profile.'), true);
        profileSave.disabled = nameInput.disabled = false;
      });
  }

  if (userId) {
    fetchOwnProfile()
      .then(({ displayName }) => { if (alive() && !nameEdited && getUserId() === userId && displayName) nameInput.value = displayName; })
      .catch(() => { /* keep what's shown */ });
    fetchAvatarBytes(userId, 48)
      .then(async bytes => {
        const url = await avatarDataUrl(bytes);
        saveCachedAccountAvatar(userId, url);
        if (!alive() || selectedAvatarFile) return;
        $('.mx-settings-avatar').innerHTML = `<img src="${escapeHtml(url)}" alt=""><span aria-hidden="true">Edit</span>`;
        const own = $('.mx-settings-switcher-item.active .mx-settings-switcher-avatar');
        if (own) own.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
      })
      .catch(() => { /* no avatar: keep the initial */ });
  }

  // ── Security ──
  const security = $('.mx-acct-security');
  const securityStatus = $('.mx-acct-status');
  const recoveryInput = $('[data-field="recovery"]');
  const recoveryKeyEl = $('.mx-settings-recovery-key');
  const confirmSaved = $('[data-action="confirm-recovery-key"]');
  const finishSetup = $('[data-action="finish-recovery-key"]');
  const sasPanel = $('.mx-settings-sas');
  const sasEmoji = $('.mx-settings-sas-emoji');
  const keyFileInput = $('.mx-settings-recovery-file-input');
  let busy = false;
  let roomKeyFile = null; // an exported room-key file waiting for its password
  let verificationRequest = null;
  let verifier = null;
  let sasCallbacks = null;
  let verificationStarting = false;
  const startedVerifiers = new WeakSet();
  const refreshTimers = new Set();

  const say = (text, error = false) => {
    securityStatus.textContent = text || '';
    securityStatus.classList.toggle('mx-acct-status-error', error);
  };

  function show(view) {
    security.dataset.view = view;
    for (const card of security.querySelectorAll('[data-card]')) card.hidden = card.dataset.card !== view;
  }

  function showRecoveryKey(key) {
    recoveryKeyEl.textContent = key;
    confirmSaved.checked = false;
    finishSetup.disabled = true;
    show('key');
  }

  /** Which card applies: a key still to save, set-up, confirm, or verified. */
  async function refreshSecurity() {
    if (busy) return;
    const pendingKey = getPendingRecoveryKey();
    if (pendingKey) { showRecoveryKey(pendingKey); return; }
    try {
      const [status, device] = await Promise.all([getSecureMessagingStatus(), getCurrentDeviceVerification()]);
      if (!alive() || busy || getPendingRecoveryKey()) return;
      $('.mx-acct-device-id').textContent = device.deviceId;
      show(status.needsSetup ? 'setup' : (device.verified ? 'verified' : 'confirm'));
    } catch (error) {
      if (!alive()) return;
      show('checking');
      say(plainError(error, 'Couldn\'t check this device.'), true);
    }
  }

  function scheduleRefreshes() {
    for (const delay of [500, 1500, 3500, 7000]) {
      const timer = setTimeout(() => { refreshTimers.delete(timer); if (alive()) refreshSecurity(); }, delay);
      refreshTimers.add(timer);
    }
  }

  async function runBusy(button, work) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try { await work(); } finally {
      busy = false;
      if (button && alive()) button.disabled = false;
    }
  }

  const setUp = button => runBusy(button, async () => {
    say('Setting up…');
    try {
      const { recoveryKey } = await setUpSecureMessaging();
      if (!alive()) return;
      say('');
      showRecoveryKey(recoveryKey);
    } catch (error) {
      if (alive()) say(plainError(error, 'Could not set up secure messaging.'), true);
    }
  });

  async function copyRecoveryKey() {
    try {
      await navigator.clipboard.writeText(recoveryKeyEl.textContent);
      say('Copied.');
    } catch {
      say('Couldn\'t copy. Select the key and copy it instead.', true);
    }
  }

  async function saveRecoveryKey() {
    const text = `Matrix recovery key for ${userId || 'your account'}\n\n${recoveryKeyEl.textContent}\n\nKeep this safe. It unlocks your encrypted messages on new devices.\n`;
    try {
      if (await saveTextFile('Matrix recovery key.txt', text) && alive()) say('Saved.');
    } catch (error) {
      if (alive()) say(plainError(error, 'Could not save the file.'), true);
    }
  }

  function finishRecoveryKey() {
    recoveryKeyEl.textContent = '';
    say('');
    acknowledgeRecoveryKey(); // → device trust change → refreshSecurity()
  }

  // Confirm with the recovery key: verify this device first (quick), then
  // bring back message history from the key backup (can take a while).
  const confirmWithKey = button => runBusy(button, async () => {
    const value = recoveryInput.value.trim();
    if (roomKeyFile) { await importKeyFile(value); return; }
    if (!value) { say('Enter your recovery key.', true); recoveryInput.focus(); return; }
    recoveryInput.disabled = true;
    say('Checking your recovery key…');
    try {
      await crossSignThisDevice(value);
      if (!alive()) return;
      say('Confirmed. Restoring your message history…');
      try {
        await restoreFromRecoveryKey(value);
        if (alive()) say('');
      } catch (error) {
        if (alive()) say(`This device is verified, but message history couldn't be restored: ${plainError(error, 'unknown error')}`, true);
      }
      recoveryInput.value = '';
      scheduleRefreshes(); // once this finishes, the card turns to Verified
    } catch (error) {
      if (alive()) say(plainError(error, 'That recovery key didn\'t work.'), true);
    } finally {
      if (alive()) recoveryInput.disabled = false;
    }
  });

  async function importKeyFile(password) {
    say('Importing…');
    try {
      await importRoomKeyFile(roomKeyFile, password);
      if (!alive()) return;
      roomKeyFile = null;
      recoveryInput.value = '';
      recoveryInput.placeholder = 'Recovery key';
      say('Message keys imported from the file. Confirm with your recovery key or another device to verify this device.');
    } catch (error) {
      if (alive()) say(plainError(error, 'Could not import that file.'), true);
    }
  }

  keyFileInput.addEventListener('change', async () => {
    const file = keyFileInput.files?.[0];
    keyFileInput.value = '';
    if (!file) return;
    try {
      const contents = await file.text();
      if (/-----BEGIN MEGOLM SESSION DATA-----/.test(contents)) {
        // An exported message-key file: its own export password unlocks it.
        roomKeyFile = contents;
        recoveryInput.value = '';
        recoveryInput.placeholder = 'The file\'s export password';
        say('Enter the password this file was exported with, then Confirm.');
        recoveryInput.focus();
        return;
      }
      if (contents.trim().startsWith('[')) {
        roomKeyFile = contents;
        await runBusy(null, () => importKeyFile(''));
        return;
      }
      // A saved recovery key, like Atmos's "Save as file".
      const key = contents.split('\n').map(line => line.trim()).find(line => /^[1-9A-HJ-NP-Za-km-z]{4}( [1-9A-HJ-NP-Za-km-z]{4}){5,}$/.test(line)) || contents.trim();
      recoveryInput.value = key;
      await confirmWithKey($('[data-action="submit-recovery-key"]'));
    } catch (error) {
      say(plainError(error, 'Could not read that file.'), true);
    }
  });

  // Confirm from another device: emoji comparison (SAS).
  function showSas(callbacks) {
    sasCallbacks = callbacks;
    const emoji = callbacks?.sas?.emoji || [];
    sasEmoji.innerHTML = emoji.map(([symbol, name]) => `<div class="mx-settings-sas-item"><span>${escapeHtml(symbol)}</span><small>${escapeHtml(name)}</small></div>`).join('');
    sasPanel.hidden = false;
    say('Compare the emoji on both devices.');
  }

  async function advanceVerification() {
    if (!verificationRequest || verificationStarting) return;
    const phase = verificationRequest.phase;
    if (phase === 3 && !verifier) {
      verificationStarting = true;
      try { verifier = await verificationRequest.startVerification('m.sas.v1'); } finally { verificationStarting = false; }
    }
    if (phase === 4 && !verifier) verifier = verificationRequest.verifier;
    if (verifier && !startedVerifiers.has(verifier)) {
      startedVerifiers.add(verifier);
      verifier.on('show_sas', showSas);
      verifier.on('cancel', () => {
        if (!alive()) return;
        sasPanel.hidden = true;
        say('Verification was cancelled.', true);
      });
      verifier.verify().catch(error => {
        if (!alive() || verificationRequest?.phase === 5) return;
        say(plainError(error, 'Verification couldn\'t be completed.'), true);
      });
    }
    if (phase === 5) {
      sasPanel.hidden = true;
      say('Verification was cancelled.', true);
    } else if (phase === 6) {
      sasPanel.hidden = true;
      say('');
      await refreshSecurity();
      scheduleRefreshes();
    }
  }

  async function verifyWithAnotherDevice() {
    if (verificationRequest?.pending) return;
    sasPanel.hidden = true;
    say('Sending a request…');
    try {
      verificationRequest = await requestCurrentDeviceVerification();
      verificationRequest.on('change', advanceVerification);
      say('Accept the request on your other device.');
      await advanceVerification();
    } catch (error) {
      say(plainError(error, 'Couldn\'t start verification.'), true);
    }
  }

  recoveryInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') confirmWithKey($('[data-action="submit-recovery-key"]'));
  });
  confirmSaved.addEventListener('change', () => { finishSetup.disabled = !confirmSaved.checked; });
  cleanups.push(onDeviceTrustChange(() => { if (alive()) refreshSecurity(); }));
  refreshSecurity();

  // ── Clicks ──
  const actions = {
    'switch-account': item => switchTo(item),
    'remove-account': button => { removeAccount(button.dataset.userId); rerender(); },
    'toggle-add-account': () => toggleAddAccount(),
    'choose-avatar': () => avatarInput.click(),
    'save-profile': () => saveProfile(),
    'manage-account': () => { if (accountUrl) openLink(accountUrl).catch(error => console.warn('[matrix-chat] could not open the account page:', error)); },
    'setup-secure-messaging': button => setUp(button),
    'copy-recovery-key': () => copyRecoveryKey(),
    'save-recovery-key': () => saveRecoveryKey(),
    'finish-recovery-key': () => finishRecoveryKey(),
    'submit-recovery-key': button => confirmWithKey(button),
    'verify-device': () => verifyWithAnotherDevice(),
    'import-key-file': () => keyFileInput.click(),
    'sas-match': button => {
      if (!sasCallbacks) return;
      button.disabled = true;
      say('Confirming…');
      sasCallbacks.confirm().catch(error => {
        if (!alive()) return;
        say(plainError(error, 'Couldn\'t confirm verification.'), true);
        button.disabled = false;
      });
    },
    'sas-mismatch': () => { sasCallbacks?.mismatch(); sasPanel.hidden = true; say('Cancelled: the emoji didn\'t match.', true); },
  };
  root.addEventListener('click', event => {
    // The remove × sits inside a switcher item, so the closest action wins.
    const target = event.target.closest('[data-action]');
    const run = target && actions[target.dataset.action];
    if (run) run(target);
  });

  // Log out takes a press and hold: a bar fills the button, letting go early cancels.
  const LOGOUT_HOLD_MS = 900;
  const logoutBtn = $('[data-action="logout"]');
  logoutBtn.style.setProperty('--mx-hold-ms', `${LOGOUT_HOLD_MS}ms`);
  let logoutTimer = null;
  const cancelLogout = () => {
    clearTimeout(logoutTimer);
    logoutTimer = null;
    logoutBtn.classList.remove('mx-holding');
  };
  logoutBtn.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cancelLogout();
    logoutBtn.classList.add('mx-holding');
    logoutTimer = setTimeout(() => {
      logoutTimer = null;
      logoutBtn.classList.remove('mx-holding');
      logout();
      onLogout?.();
    }, LOGOUT_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) logoutBtn.addEventListener(type, cancelLogout);

  function cleanup() {
    cancelLogout();
    refreshTimers.forEach(clearTimeout);
    refreshTimers.clear();
    verificationRequest?.off?.('change', advanceVerification);
    verifier?.off?.('show_sas', showSas);
    for (const fn of cleanups.splice(0)) { try { fn?.(); } catch { /* going anyway */ } }
    root.remove();
  }
  return cleanup;
}

/**
 * js/plugins/matrix-chat/src/ui/login.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The sign-in view. What it offers depends on the homeserver:
 *
 *   - OAuth homeservers (matrix.org and others on the Matrix Authentication
 *     Service): "Continue" and "Create an account" open the server's own page
 *     in the system browser; Atmos waits, with Cancel, until the browser comes
 *     back (see client.js loginWithOAuth). Password sign-in stays available
 *     behind a link where the server still allows it.
 *   - Everything else: the classic username/email + password form.
 *
 * The (i) button explains what a Matrix account is and where to get one, for
 * people arriving at Atmos without one.
 *
 * Like the other ui/*.js modules, this owns its own markup via a single
 * innerHTML write. Returns a cleanup function that cancels a browser sign-in
 * still waiting when the view goes away.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  cancelSignIn, getSavedAccounts, getSessionIssue, getSignInNotice, getSignInOptions, login, loginWithOAuth,
  openLink, removeAccount, switchAccount,
} from './engine.js';

const DEFAULT_HOMESERVER = 'https://matrix.org';
const PROBE_DELAY_MS = 450;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

const hostOf = url => String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const errorText = (err, fallback) => err?.data?.error || err?.message || fallback;

export function renderLogin(contentEl, { onSuccess, showSavedAccounts = true }) {
  const sessionIssue = getSessionIssue();
  const signInNotice = getSignInNotice();
  const savedAccounts = showSavedAccounts ? getSavedAccounts() : [];
  contentEl.innerHTML = `
    <div class="mx-login${showSavedAccounts ? '' : ' mx-login-compact'}">
      <div class="mx-login-card">
      <header class="mx-login-header">
        <div class="mx-login-header-row">
          <h3 class="mx-login-title">Your conversations.<br>Your space.</h3>
          <button type="button" class="mx-login-info-btn" data-action="toggle-info" aria-expanded="false" aria-controls="mx-login-info" title="What's a Matrix account?">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/></svg>
            <span class="mx-sr-only">What's a Matrix account?</span>
          </button>
        </div>
        <p class="mx-login-subtitle">Sign in to pick up where you left off.</p>
      </header>
      <section id="mx-login-info" class="mx-login-info" hidden>
        <h4>What's a Matrix account?</h4>
        <p>Atmos Chat runs on <strong>Matrix</strong>, an open network for messaging. Your account lives on a <em>homeserver</em>, not inside Atmos, a bit like an email address lives with its provider. The same account works in any Matrix app.</p>
        <ul>
          <li><strong>New to Matrix?</strong> Choose <em>Create an account</em>. Your homeserver's sign-up page opens in your browser. matrix.org is free.</li>
          <li><strong>Already have an account</strong> (from Element or another app)? Sign in with it here.</li>
          <li><strong>Using a different server?</strong> Change the homeserver at the bottom first.</li>
        </ul>
        <p class="mx-login-info-note">Signing in happens on your homeserver's own page, so Atmos never sees your password there.</p>
        <button type="button" class="mx-login-link" data-action="learn-more">Learn more about Matrix ↗</button>
      </section>
      ${signInNotice ? `<div class="mx-login-session-notice" role="status">${escapeHtml(signInNotice)}</div>` : ''}
      ${sessionIssue ? `
        <div class="mx-login-session-notice" role="status">
          ${escapeHtml(sessionIssue.userId || 'Your saved account')} was signed out because its session is no longer valid.
        </div>
      ` : ''}
      ${savedAccounts.length ? `
        <div class="mx-login-saved">
          <div class="mx-login-saved-label">Use another saved account</div>
          ${savedAccounts.map(account => `
            <div class="mx-login-saved-row">
              <button type="button" class="mx-login-saved-account" data-action="switch-saved-account" data-user-id="${escapeHtml(account.userId)}">
                <span>${escapeHtml(account.userId)}</span>
                <small>${escapeHtml(hostOf(account.homeserver))}</small>
              </button>
              <button type="button" class="mx-login-saved-remove" data-action="remove-saved-account" data-user-id="${escapeHtml(account.userId)}" aria-label="Remove ${escapeHtml(account.userId)} from this device">&times;</button>
            </div>
          `).join('')}
          <div id="mx-login-switch-error" class="mx-error" style="display:none"></div>
        </div>
        <div class="mx-login-divider"><span>or sign in</span></div>
      ` : ''}
      <p class="mx-login-status" data-part="checking" role="status">Checking homeserver…</p>
      <div class="mx-login-actions" data-part="oauth" hidden>
        <button type="button" class="mx-btn primary" data-action="oauth-continue">Sign in</button>
        <button type="button" class="mx-btn mx-login-secondary" data-action="oauth-create">Create an account</button>
        <button type="button" class="mx-login-link" data-action="show-password" hidden>Sign in with a password instead</button>
      </div>
      <div class="mx-login-waiting" data-part="waiting" hidden role="status">
        <p class="mx-login-waiting-title">Continue in your browser</p>
        <p class="mx-login-waiting-text"></p>
        <button type="button" class="mx-btn mx-login-secondary" data-action="oauth-cancel">Cancel</button>
      </div>
      <div class="mx-login-password" data-part="password" hidden>
        <label class="mx-field">
          <span>Account or email</span>
          <input type="text" id="mx-login-user" placeholder="Username, @you:server, or email" autocomplete="username" autocapitalize="none" spellcheck="false">
        </label>
        <label class="mx-field">
          <span>Password</span>
          <input type="password" id="mx-login-pass" autocomplete="current-password">
        </label>
        <button id="mx-login-submit" class="mx-btn primary">Sign in</button>
        <button type="button" class="mx-login-link" data-action="show-oauth" hidden>Back</button>
        <p class="mx-login-signup-note" data-part="signup-note" hidden></p>
      </div>
      <label class="mx-field mx-homeserver-field">
        <span>Homeserver</span>
        <input type="url" id="mx-login-homeserver" value="${DEFAULT_HOMESERVER}" autocomplete="url" aria-label="Homeserver" spellcheck="false">
      </label>
      <div id="mx-login-error" class="mx-error" role="alert" style="display:none"></div>
      </div>
    </div>
  `;

  const $ = selector => contentEl.querySelector(selector);
  const part = name => contentEl.querySelector(`[data-part="${name}"]`);
  const homeserverInput = $('#mx-login-homeserver');
  const userInput = $('#mx-login-user');
  const passInput = $('#mx-login-pass');
  const submitBtn = $('#mx-login-submit');
  const errorEl = $('#mx-login-error');
  const switchErrorEl = $('#mx-login-switch-error');
  const infoBtn = $('[data-action="toggle-info"]');
  const infoEl = $('#mx-login-info');

  let options = null;       // getSignInOptions() result for the current homeserver
  let probeCount = 0;
  let probeTimer = null;
  let mode = 'checking';    // 'checking' | 'oauth' | 'password' | 'waiting'
  let busy = false;
  let disposed = false;

  const alive = () => !disposed && contentEl.contains(submitBtn);

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = message ? 'block' : 'none';
  }

  function setMode(next) {
    mode = next;
    part('checking').hidden = next !== 'checking';
    part('oauth').hidden = next !== 'oauth';
    part('waiting').hidden = next !== 'waiting';
    part('password').hidden = next !== 'password';
    homeserverInput.disabled = next === 'waiting';
    const host = hostOf(options?.homeserver || homeserverInput.value);

    $('[data-action="oauth-continue"]').textContent = `Continue with ${host}`;
    $('[data-action="oauth-create"]').hidden = !options?.signUp;
    $('[data-action="show-password"]').hidden = !options?.password;
    $('[data-action="show-oauth"]').hidden = !options?.oauth;

    // Password-only homeservers: say where accounts come from, since this
    // screen can't create one there.
    const note = part('signup-note');
    note.hidden = next !== 'password' || Boolean(options?.oauth);
    note.textContent = options && !options.oauth
      ? `New to Matrix? ${host} doesn't let apps like Atmos create accounts. Create one on its website, or switch the homeserver to matrix.org.`
      : '';
  }

  async function probe() {
    clearTimeout(probeTimer);
    const count = ++probeCount;
    const value = homeserverInput.value.trim();
    options = null;
    showError('');
    if (!value) { setMode('password'); return; }
    setMode('checking');
    part('checking').textContent = `Checking ${hostOf(value)}…`;
    try {
      const result = await getSignInOptions(value);
      if (!alive() || count !== probeCount) return;
      options = result;
      setMode(result.oauth ? 'oauth' : 'password');
    } catch (err) {
      if (!alive() || count !== probeCount) return;
      // Offline or a typo: fall back to the password form so nothing is blocked.
      setMode('password');
      showError(errorText(err, 'Couldn\'t reach that homeserver.'));
    }
  }

  async function startOAuth(createAccount) {
    if (busy || !options?.oauth) return;
    busy = true;
    showError('');
    const host = hostOf(options.homeserver);
    part('waiting').querySelector('.mx-login-waiting-text').textContent = createAccount
      ? `${host}'s sign-up page is open in your browser. Create your account there, then come back. You'll be signed in here automatically.`
      : `${host}'s sign-in page is open in your browser. Sign in there, then come back. You'll be signed in here automatically.`;
    setMode('waiting');
    try {
      await loginWithOAuth(options.homeserver, { createAccount });
      if (alive()) onSuccess();
    } catch (err) {
      if (!alive()) return;
      setMode('oauth');
      if (err?.code !== 'cancelled' && err?.name !== 'AbortError') showError(errorText(err, 'Sign-in failed.'));
    } finally {
      busy = false;
    }
  }

  async function submitPassword() {
    if (busy) return;
    const homeserver = options?.homeserver || homeserverInput.value.trim();
    const user = userInput.value.trim();
    const pass = passInput.value;

    if (!homeserver || !user || !pass) {
      showError('All fields are required.');
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    showError('');

    try {
      await login(homeserver, user, pass);
      if (alive()) onSuccess();
    } catch (err) {
      // matrix-js-sdk errors carry a homeserver-provided message at
      // err.data.error (e.g. "Invalid password") — fall back to
      // err.message for network-level failures that never reach the
      // homeserver at all.
      if (alive()) showError(errorText(err, 'Sign-in failed.'));
    } finally {
      busy = false;
      if (alive()) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign in';
      }
    }
  }

  contentEl.querySelectorAll('[data-action="switch-saved-account"]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (switchErrorEl) switchErrorEl.style.display = 'none';
      try {
        await switchAccount(button.dataset.userId);
        onSuccess();
      } catch (err) {
        if (!button.isConnected) return;
        button.disabled = false;
        if (switchErrorEl) {
          switchErrorEl.textContent = errorText(err, 'Could not switch accounts.');
          switchErrorEl.style.display = 'block';
        }
      }
    });
  });

  contentEl.querySelectorAll('[data-action="remove-saved-account"]').forEach(button => {
    button.addEventListener('click', () => {
      removeAccount(button.dataset.userId);
      button.closest('.mx-login-saved-row')?.remove();
    });
  });

  infoBtn.addEventListener('click', () => {
    infoEl.hidden = !infoEl.hidden;
    infoBtn.setAttribute('aria-expanded', String(!infoEl.hidden));
  });
  $('[data-action="learn-more"]').addEventListener('click', () => {
    openLink('https://matrix.org/').catch(err => showError(errorText(err, 'Couldn\'t open the link.')));
  });

  $('[data-action="oauth-continue"]').addEventListener('click', () => startOAuth(false));
  $('[data-action="oauth-create"]').addEventListener('click', () => startOAuth(true));
  $('[data-action="oauth-cancel"]').addEventListener('click', () => cancelSignIn());
  $('[data-action="show-password"]').addEventListener('click', () => { setMode('password'); userInput.focus(); });
  $('[data-action="show-oauth"]').addEventListener('click', () => setMode('oauth'));

  submitBtn.addEventListener('click', submitPassword);
  passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPassword();
  });

  homeserverInput.addEventListener('input', () => {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(probe, PROBE_DELAY_MS);
  });
  homeserverInput.addEventListener('change', probe);

  probe();

  return () => {
    disposed = true;
    clearTimeout(probeTimer);
    if (mode === 'waiting') cancelSignIn();
  };
}

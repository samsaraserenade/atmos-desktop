/**
 * The portfolio server connection, in the Portfolio Connections widget:
 * a form to pair with a server when none is set up, and the server's
 * address with Disconnect once one is. The address and token go straight to
 * Finance's main process (main.cjs), which checks the server, seals the
 * token with the system's secure storage and never hands it back; the
 * engine frame then starts reading the new server.
 */
import { testServer, connectServer, disconnectServer, requestEngineReconnect } from './remote.js';
import { isPrivate, MASK } from './privacy.js';

const STYLE_ID = 'finance-connection-form-styles';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .fin-conn { display:flex; flex-direction:column; gap:8px; padding:10px 12px 12px; font-size:.66rem; color:rgba(var(--ink-rgb),.62); }
    .fin-conn p { margin:0; line-height:1.45; }
    .fin-conn-field { display:flex; flex-direction:column; gap:3px; }
    .fin-conn-field span { color:rgba(var(--ink-rgb),.45); font-size:.6rem; letter-spacing:.02em; }
    .fin-conn textarea, .fin-conn input {
      box-sizing:border-box; width:100%; padding:6px 8px; border:1px solid rgba(var(--ink-rgb),.12); border-radius:6px;
      outline:0; resize:none; color:rgb(var(--ink-rgb)); background:rgba(var(--ink-rgb),.05);
      font:500 .66rem/1.35 var(--app-font-family, "Segoe UI", sans-serif);
    }
    .fin-conn textarea { font-family:ui-monospace, Consolas, monospace; word-break:break-all; }
    .fin-conn textarea:focus, .fin-conn input:focus { border-color:rgba(var(--ink-rgb),.3); background:rgba(var(--ink-rgb),.08); }
    .fin-conn details summary { cursor:pointer; color:rgba(var(--ink-rgb),.5); }
    .fin-conn details[open] summary { margin-bottom:6px; }
    .fin-conn details .fin-conn-field + .fin-conn-field { margin-top:6px; }
    .fin-conn-actions { display:flex; gap:6px; justify-content:flex-end; }
    .fin-conn button {
      height:24px; padding:0 10px; border:1px solid rgba(var(--ink-rgb),.14); border-radius:6px; cursor:pointer;
      color:rgba(var(--ink-rgb),.8); background:transparent; font:600 .62rem var(--app-font-family, "Segoe UI", sans-serif);
    }
    .fin-conn button:hover:not(:disabled) { background:rgba(var(--ink-rgb),.08); color:rgb(var(--ink-rgb)); }
    .fin-conn button.is-primary { border-color:rgba(var(--ink-rgb),.3); background:rgba(var(--ink-rgb),.1); color:rgb(var(--ink-rgb)); }
    .fin-conn button:disabled { opacity:.45; cursor:default; }
    .fin-conn-status { min-height:1.45em; }
    .fin-conn-note { color:rgba(var(--ink-rgb),.42); font-size:.6rem; }
    .fin-conn-status.is-error { color:var(--color-negative, #f87171); }
    .fin-conn-status.is-ok { color:var(--color-positive, #4ade80); }
    .fin-conn-server { display:flex; align-items:center; gap:8px; }
    .fin-conn-server span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  `;
  document.head.appendChild(style);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function field(label, control) {
  const wrap = element('label', 'fin-conn-field');
  wrap.append(element('span', null, label), control);
  return wrap;
}

function ago(timestamp) {
  const ms = Date.now() - Number(timestamp);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 90_000) return 'just now';
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} hours ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

function describeServer(result) {
  const host = (() => { try { return new URL(result.address).host; } catch { return result.address; } })();
  const sources = `${result.sources} source${result.sources === 1 ? '' : 's'}`;
  const updated = result.lastUpdate ? ago(result.lastUpdate) : null;
  return `${host}: ${sources}${updated ? `, updated ${updated}` : ''}.`;
}

/** No server yet: pair with one. */
export function mountConnectionForm(mount) {
  injectStyles();
  const root = element('div', 'fin-conn');
  const intro = element('p', null, 'Finance reads your portfolio from a portfolio server: one you run yourself, or a hosted one. Paste the pairing code it gave you.');
  const code = element('textarea');
  code.rows = 3;
  code.placeholder = 'atmos-finance:…';
  code.spellcheck = false;
  code.autocomplete = 'off';

  const manual = element('details');
  manual.append(element('summary', null, 'Use an address and token instead'));
  const address = element('input');
  address.type = 'url';
  address.placeholder = 'https:// address of your server';
  address.spellcheck = false;
  const token = element('input');
  token.type = 'password';
  token.autocomplete = 'off';
  token.placeholder = 'Token';
  manual.append(field('Server address', address), field('Token', token));

  const status = element('p', 'fin-conn-status');
  status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'fin-conn-actions');
  const testButton = element('button', null, 'Test');
  const connectButton = element('button', 'is-primary', 'Connect');
  testButton.type = connectButton.type = 'button';
  actions.append(testButton, connectButton);
  const note = element('p', 'fin-conn-note', 'Finance only reads. Values are estimates from third-party prices and can be late or wrong; nothing here is financial advice. Give your server read-only API keys.');
  root.append(intro, field('Pairing code', code), manual, actions, status, note);
  mount.appendChild(root);

  const request = () => code.value.trim()
    ? { code: code.value }
    : { baseUrl: address.value, token: token.value };
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = 'fin-conn-status' + (kind ? ` is-${kind}` : '');
  };
  const busy = value => { testButton.disabled = connectButton.disabled = value; };
  const hasInput = () => !!(code.value.trim() || (address.value.trim() && token.value.trim()));

  testButton.addEventListener('click', async () => {
    if (!hasInput()) { setStatus('Paste a pairing code, or enter an address and token.', 'error'); return; }
    busy(true); setStatus('Checking…');
    try {
      const result = await testServer(request());
      setStatus(result.ok ? `Found ${describeServer(result)}` : result.error, result.ok ? 'ok' : 'error');
    } catch (error) { setStatus(error.message, 'error'); }
    finally { busy(false); }
  });
  connectButton.addEventListener('click', async () => {
    if (!hasInput()) { setStatus('Paste a pairing code, or enter an address and token.', 'error'); return; }
    busy(true); setStatus('Connecting…');
    try {
      const result = await connectServer(request());
      if (!result.ok) { setStatus(result.error, 'error'); return; }
      code.value = token.value = '';
      setStatus(`Connected to ${describeServer(result)} Loading your portfolio…`, 'ok');
      await requestEngineReconnect();
    } catch (error) { setStatus(error.message, 'error'); }
    finally { busy(false); }
  });
}

/** A server is set up: show it, and let the user disconnect. */
export function mountConnectionFooter(mount, connection) {
  injectStyles();
  const root = element('div', 'fin-conn');
  const row = element('div', 'fin-conn-server');
  const host = (() => { try { return new URL(connection.address).host; } catch { return connection.address || 'your server'; } })();
  const label = element('span', null, `Server: ${isPrivate() ? MASK : host}`);
  label.title = isPrivate() ? '' : connection.address || '';
  const disconnect = element('button', null, 'Disconnect');
  disconnect.type = 'button';
  row.append(label, disconnect);
  root.append(row);
  if (connection.protected === false) {
    root.append(element('p', null, 'This system has no secure storage, so the token is saved without encryption, readable only by your user account.'));
  }
  mount.appendChild(root);

  let armed = false;
  disconnect.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      disconnect.textContent = 'Click again to disconnect';
      setTimeout(() => { armed = false; disconnect.textContent = 'Disconnect'; }, 4_000);
      return;
    }
    disconnect.disabled = true;
    try {
      await disconnectServer();
      await requestEngineReconnect();
    } catch (error) {
      console.warn('[finance] disconnect failed:', error.message);
      disconnect.disabled = false;
    }
  });
}
